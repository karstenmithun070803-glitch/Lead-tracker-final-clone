/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CallStage, FreeWebsiteStatus, VoiceSegregationResult } from '../types/lead.js';
import { formatDayDate, resolveDateAndTimeString } from './dateResolver.js';

const STOP_NAME_WORDS = new Set([
  'i',
  'we',
  'they',
  'he',
  'she',
  'told',
  'have',
  'has',
  'had',
  'need',
  'needs',
  'to',
  'with',
  'and',
  'follow',
  'following',
  'up',
  'call',
  'called',
  'calling',
  'at',
  'from',
  'today',
  'tomorrow',
  'yesterday',
  'the',
  'a',
  'an',
  'meeting',
  'demo',
  'said',
  'spoke',
  'discussed',
  'him',
  'her',
  'them',
]);

const COMPANY_PREFIX_REGEX =
  /^(?:(?:i\s+told\s+)?(?:i|we)\s+had\s+a\s+call\s+with|(?:i\s+told\s+)?(?:i|we)\s+have\s+a\s+call\s+with|(?:i\s+told\s+)?had\s+a\s+call\s+with|(?:i|we)\s+called|i\s+spoke\s+to|i\s+spoke\s+with|i\s+met\s+with|call\s+with|call\s+was\s+with|calling|called|spoke\s+with|talked\s+with|meeting\s+with|for\s+company|the\s+company\s+called|company\s+called|the\s+company\s+is|company\s+is|the\s+company\s+name\s+is|company\s+name\s+is|the\s+company\s+name\s+i\s+told|company\s+name\s+i\s+told|the\s+company\s+name|company\s+name|the\s+company|company|for\s+the\s+company|for)\s+/i;

/**
 * Intelligent entity and CRM detail extractor.
 * Parses natural spoken voice notes with high accuracy and 0ms latency.
 * Handles patterns such as:
 * - "I had a call with Zirco Private Limited. The owner name is Sujay. I told I have to follow up with them tomorrow."
 * - "I told I had a call with Zirco Private Limited. The owner name is Sujay. I told I have to follow up with them."
 * - "The company name I told MM Agro Farms and I told the owner name is Manjulekha"
 * - "Company is MM Agro Farms, business owner Manjulekha"
 * - "Called Zirco Private Limited today, owner is Sujay, follow up tomorrow at 3 PM"
 */
export function extractLeadDetails(
  text: string,
  baseDate: Date = new Date()
): VoiceSegregationResult {
  const clean = (text || '').trim();
  const lower = clean.toLowerCase();
  const todayFormatted = formatDayDate(baseDate);

  // 1. Determine Call Number & Stage
  let callNumber: 1 | 2 | 3 | 4 = 1;
  if (
    lower.includes('fourth call') ||
    lower.includes('4th call') ||
    lower.includes('call number 4') ||
    lower.includes('call 4')
  ) {
    callNumber = 4;
  } else if (
    lower.includes('third call') ||
    lower.includes('3rd call') ||
    lower.includes('call number 3') ||
    lower.includes('call 3')
  ) {
    callNumber = 3;
  } else if (
    lower.includes('second call') ||
    lower.includes('2nd call') ||
    lower.includes('call number 2') ||
    lower.includes('call 2')
  ) {
    callNumber = 2;
  } else {
    callNumber = 1;
  }

  const callStage = `CALL_${callNumber}` as CallStage;
  const callLabel = `Call ${callNumber}`;

  // 2. Extract Company Name
  let companyName = '';

  // Explicit company match with comprehensive cues including "I told I had a call with"
  const explicitCompanyRegex =
    /(?:\b(?:(?:i\s+told\s+)?(?:i|we)\s+had\s+a\s+call\s+with|(?:i\s+told\s+)?had\s+a\s+call\s+with|(?:i|we)\s+called|call\s+with|call\s+was\s+with|calling|called|spoke\s+with|talked\s+with|meeting\s+with|company\s+name\s+is|company\s+is|company\s+name\s+i\s+told|the\s+company\s+name|the\s+company|company)\b\s*(?:called|named|is|was|i\s+told|as)?)\s*:?\s*([^,.\n]+?)(?=\s*(?:\b(?:and\s+)?(?:i\s+told\s+)?(?:the\s+)?(?:owner|business\s+owner|director|client|founder|proprietor|contact|phone|mobile|email|call|called|we|they|he|she|today|tomorrow|yesterday|follow\s*up|meeting|have\s+to|need\s+to|notes?)\b|[.,;]|$))/i;

  const explicitMatch = clean.match(explicitCompanyRegex);
  if (explicitMatch && explicitMatch[1]) {
    companyName = cleanEntityString(explicitMatch[1]);
  }

  // Secondary patterns if explicit prefix not matched
  if (!companyName) {
    const secondaryCompanyRegexes = [
      /\b(?:call\s+was\s+with|calling|called|spoke\s+with|meeting\s+with)\b\s+(?:the\s+)?(?:company\s+)?([^,.\n]+?)(?=\s*(?:\b(?:and\s+)?(?:i\s+told\s+)?(?:the\s+)?(?:owner|business\s+owner|director|client|phone|email|call|today|tomorrow|yesterday)\b|[.,;]|$))/i,
      /\b(?:from\s+company|at\s+company|with\s+company)\b\s+([^,.\n]+?)(?=\s*(?:\b(?:and\s+)?(?:the\s+)?(?:owner|director|client|phone|email|today|tomorrow)\b|[.,;]|$))/i,
    ];

    for (const reg of secondaryCompanyRegexes) {
      const m = clean.match(reg);
      if (m && m[1]) {
        companyName = cleanEntityString(m[1]);
        if (companyName) break;
      }
    }
  }

  // 3. Extract Director / Owner / Business Owner / Client
  let directorName = '';

  const explicitDirectorRegex =
    /(?:(?:the\s+)?\b(?:business\s+owner|owner|director|client|proprietor|founder|contact(?:\s+person)?|ceo)\b(?:\s+name)?(?:\s*(?:is|was|called|named|i\s+told|told|named\s+as))\s*:?\s*|\b(?:spoke\s+(?:with|to)|met\s+with|talked\s+to)\s+(?:the\s+)?(?:owner|director|client|mr\.|ms\.|mrs\.)?\s*)([A-Za-z]+(?:\s+[A-Za-z]+){0,2})/i;

  const directorMatch = clean.match(explicitDirectorRegex);
  if (directorMatch && directorMatch[1]) {
    directorName = cleanPersonName(directorMatch[1]);
  }

  if (!directorName) {
    const secondaryDirRegex =
      /\b(?:director|owner|client|founder|contact)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i;
    const m = clean.match(secondaryDirRegex);
    if (m && m[1]) {
      directorName = cleanPersonName(m[1]);
    }
  }

  // In case companyName still empty, parse before director
  if (!companyName && directorName) {
    const beforeDirector = clean.split(new RegExp(`\\b${escapeRegExp(directorName)}\\b`, 'i'))[0];
    const stripped = cleanEntityString(
      beforeDirector
        .replace(/(?:owner|director|client|company|name|is|was|i told)\b/gi, '')
        .replace(/[.,;]/g, '')
    );
    if (stripped.length > 1 && stripped.length < 50) {
      companyName = stripped;
    }
  }

  if (!companyName) {
    companyName = 'New Lead';
  }

  // 4. Extract Phone Number
  let companyNumber = '';
  const phoneMatch = clean.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  if (phoneMatch) {
    companyNumber = phoneMatch[0].trim();
  }

  // 5. Extract Email
  let email = '';
  const emailMatch = clean.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    email = emailMatch[0].trim();
  }

  // 6. Free Website Status
  let freeWebsiteStatus: FreeWebsiteStatus = 'Not Asked';
  if (
    lower.includes('send a free website') ||
    lower.includes('send free website') ||
    lower.includes('to send free website') ||
    lower.includes('have to send a free website')
  ) {
    freeWebsiteStatus = 'To Send Free Website';
  } else if (lower.includes('sent free website') || lower.includes('website sent')) {
    freeWebsiteStatus = 'Free Website Sent';
  } else if (
    lower.includes('see and get back') ||
    lower.includes('reviewing website') ||
    lower.includes('reviewing the website')
  ) {
    freeWebsiteStatus = 'Website Reviewing';
  } else if (
    lower.includes('not interested in website') ||
    lower.includes('no website needed') ||
    lower.includes('declined') ||
    lower.includes('dont need website')
  ) {
    freeWebsiteStatus = 'Declined / Not Needed';
  }

  // 7. Dates & Times: Call Date, Follow-up, Scheduled Meeting
  let callDate = todayFormatted;
  if (lower.includes('yesterday')) {
    const yest = new Date(baseDate.getTime());
    yest.setDate(yest.getDate() - 1);
    callDate = formatDayDate(yest);
  }

  let hasNextFollowUp = false;
  let nextFollowUpDate = '';
  let nextFollowUpTime = '';
  let nextFollowUpType = 'None';
  let scheduledMeeting = 'None';

  const isMeeting =
    lower.includes('meeting') ||
    lower.includes('demo') ||
    lower.includes('scheduled meeting') ||
    lower.includes('schedule a meeting');

  const followUpIndicators = [
    'follow up',
    'follow-up',
    'followup',
    'meeting',
    'demo',
    'call back',
    'tomorrow',
    'today',
    'next week',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ];

  const hasNegativeFollowUp =
    lower.includes('no follow up') ||
    lower.includes('no follow-up') ||
    lower.includes('no meeting') ||
    lower.includes('no schedule') ||
    lower.includes('not scheduled') ||
    lower.includes('without follow up');

  if (!hasNegativeFollowUp && followUpIndicators.some((ind) => lower.includes(ind))) {
    // Check if relative date is specified
    const resolved = resolveDateAndTimeString(clean, baseDate);
    if (resolved.dayDate) {
      hasNextFollowUp = true;
      nextFollowUpDate = resolved.dayDate;
      nextFollowUpTime = resolved.time;

      if (isMeeting) {
        nextFollowUpType = 'Meeting Scheduled';
        scheduledMeeting = nextFollowUpTime
          ? `${nextFollowUpDate} @ ${nextFollowUpTime}`
          : nextFollowUpDate;
      } else if (freeWebsiteStatus === 'Website Reviewing' || lower.includes('free website')) {
        nextFollowUpType = 'Free Website Review';
      } else {
        nextFollowUpType = 'Follow-up Call';
      }
    } else if (lower.includes('tomorrow')) {
      hasNextFollowUp = true;
      const tmrw = new Date(baseDate.getTime());
      tmrw.setDate(tmrw.getDate() + 1);
      nextFollowUpDate = formatDayDate(tmrw);
      nextFollowUpType = isMeeting ? 'Meeting Scheduled' : 'Follow-up Call';
      if (isMeeting) {
        scheduledMeeting = nextFollowUpDate;
      }
    }
  }

  // 8. Extract Call Note (Substance of the call)
  let callNote = '';
  const noteMatch = clean.match(
    /(?:discussed|they\s+said|they\s+told|told\s+that|note\s+is|conversation\s+was|notes?:?)\s*(.*)/i
  );
  if (noteMatch && noteMatch[1] && noteMatch[1].trim().length > 3) {
    callNote = noteMatch[1].trim();
  } else if (lower.includes('follow up') || lower.includes('follow-up')) {
    callNote = hasNextFollowUp
      ? `Follow-up scheduled for ${nextFollowUpDate}${nextFollowUpTime ? ` at ${nextFollowUpTime}` : ''}`
      : `Follow-up needed with ${directorName || companyName}`;
  } else {
    // If no explicit note section, clean out company/owner/director declarations from the raw text
    let noteCandidate = clean
      .replace(new RegExp(`\\b${escapeRegExp(companyName)}\\b`, 'gi'), '')
      .replace(new RegExp(`\\b${escapeRegExp(directorName)}\\b`, 'gi'), '')
      .replace(/(?:the\s+)?\b(?:company\s+name|company|business\s+name|business)\b(?:\s+(?:is|was|called|named|i\s+told|told))?/gi, '')
      .replace(/(?:the\s+)?\b(?:business\s+owner|owner|director|client|founder|contact)\b(?:\s+name)?(?:\s+(?:is|was|called|named|i\s+told|told))?/gi, '')
      .replace(/\b(?:and\s+)?(?:i\s+told|we\s+called|i\s+called|called|calling)\b/gi, '')
      .replace(/\b(?:call\s+[1-4]|first\s+call|second\s+call|third\s+call|fourth\s+call|1st\s+call|2nd\s+call|3rd\s+call|4th\s+call)\b/gi, '')
      .replace(/\b(?:today|tomorrow|calling\s+today|no\s+follow\s*up|no\s+meeting)\b/gi, '')
      .replace(/^[.,;:\s-]+|[.,;:\s-]+$/g, '')
      .trim();

    const meaningfulWords = noteCandidate.split(/\s+/).filter((w) => w.length > 2);
    if (meaningfulWords.length >= 3) {
      callNote = noteCandidate.charAt(0).toUpperCase() + noteCandidate.slice(1);
    } else {
      callNote = directorName
        ? `Call ${callNumber} discussion with ${directorName}`
        : `Call ${callNumber} with ${companyName}`;
    }
  }

  // Capitalize properly
  const formattedCompany = capitalizeWords(companyName);
  const formattedDirector = capitalizeWords(directorName);

  return {
    companyName: formattedCompany,
    directorName: formattedDirector,
    callNumber,
    callStage,
    callLabel,
    callNote,
    callDate,
    companyNumber,
    email,
    hasNextFollowUp,
    nextFollowUpDate,
    nextFollowUpTime,
    nextFollowUpType,
    scheduledMeeting,
    freeWebsiteStatus,
    callOutcome: isMeeting
      ? 'Meeting Scheduled'
      : hasNextFollowUp
      ? 'Follow-up Scheduled'
      : 'Connected & Discussed',
    summary: `${callLabel} with ${formattedCompany}: ${callNote.slice(0, 80)}`,
    transcription: clean,
  };
}

export function cleanPersonName(raw: string): string {
  if (!raw) return '';
  const stripped = raw
    .replace(/^(?:(?:the\s+)?\b(?:business\s+owner|owner|director|client|proprietor|founder|contact(?:\s+person)?|ceo)\b(?:\s+name)?(?:\s+(?:is|was|called|named|i\s+told|told|named\s+as))\s*:?\s*|(?:mr\.|ms\.|mrs\.)\s*)/i, '')
    .replace(/^(?:he\s+is|she\s+is|his\s+name\s+is|her\s+name\s+is|name\s+is)\s*/i, '');

  const words = stripped.trim().replace(/[.,;:]/g, '').split(/\s+/);
  const nameParts: string[] = [];
  for (const w of words) {
    if (STOP_NAME_WORDS.has(w.toLowerCase())) break;
    nameParts.push(w);
  }
  return nameParts.join(' ').trim();
}

export function cleanEntityString(raw: string): string {
  if (!raw) return '';
  // Split at sentence boundaries or owner/director/follow-up indicators to prevent whole sentence capture
  const firstSegment = raw.split(/[.,;\n]|\b(?:the\s+)?(?:owner|business\s+owner|director|client|founder|follow\s*up|meeting)\b/i)[0] || '';
  return firstSegment
    .replace(COMPANY_PREFIX_REGEX, '')
    .replace(/^(?:the\s+company|the\s+firm|company|client)\s+/i, '')
    .replace(/(?:\s+(?:and|i\s+told|the|is|was|spoke|talked|today|tomorrow|yesterday))+$/i, '')
    .replace(/[.,;:]/g, '')
    .trim();
}

export function capitalizeWords(str: string): string {
  if (!str) return '';
  return str
    .split(/\s+/)
    .map((word) => {
      // Keep words like Private, Limited, LLC, Inc., Farms, etc.
      if (word.toUpperCase() === 'PVT' || word.toUpperCase() === 'LTD' || word.toUpperCase() === 'LLC') {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
