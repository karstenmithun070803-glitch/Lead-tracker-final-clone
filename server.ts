/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import path from 'path';
import { resolveDateAndTimeString, formatDayDate } from './src/utils/dateResolver.js';
import {
  todayInTimezone,
  toIsoDate,
  buildCalendarTable,
  isoToDayDate,
  normalizeTime,
  snapToKnown,
  repairEntities,
} from './src/utils/voiceExtraction.js';
import {
  extractLeadDetails,
  cleanEntityString,
  cleanPersonName,
} from './src/utils/intelligentExtractor.js';

dotenv.config();

export { extractLeadDetails };

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json({ limit: '15mb' }));

  // Created lazily so the server still boots (rule-based fallback only) without an API key.
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const ai = new GoogleGenAI({ apiKey: apiKey || 'missing-key' });
  if (!apiKey) console.warn('GEMINI_API_KEY is not set: voice extraction will use the weaker rule-based fallback.');

  // Health endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', serverTime: new Date().toISOString() });
  });

  // Voice & text segregation endpoint.
  // Accuracy strategy: the browser transcript is noisy (esp. proper nouns), so the
  // recorded audio is sent to Gemini alongside it and treated as ground truth. The model
  // never does date math: it picks from an explicit calendar and the server formats dates.
  app.post('/api/voice/segregate', async (req, res) => {
    const { text, audioBase64, mimeType, clientDate, timeZone, knownCompanies, knownPeople } = req.body;

    if (!text && !audioBase64) {
      return res.status(400).json({ error: 'Either spoken transcript or audio data is required.' });
    }

    const today = todayInTimezone(clientDate, timeZone);
    const todayFormatted = formatDayDate(today);
    const companies: string[] = Array.isArray(knownCompanies)
      ? knownCompanies.filter((s: any) => typeof s === 'string' && s.trim()).slice(0, 300)
      : [];
    const people: string[] = Array.isArray(knownPeople)
      ? knownPeople.filter((s: any) => typeof s === 'string' && s.trim()).slice(0, 300)
      : [];

    // Instant rule-based baseline (also the fallback when AI is unavailable)
    const fallbackResult: any = text ? extractLeadDetails(text, today) : null;

    try {
      const hasAudio = Boolean(audioBase64);
      const prompt = `You are the extraction engine of a sales CRM. A rep in India speaks a short, messy, unscripted call note; you turn it into clean fields. Speakers have Indian English accents and mention Indian business and person names. Speech is often out of order, with fillers and false starts ("I have a meeting with... and his... it's MM Agro Farms").

TODAY: ${todayFormatted} (${toIsoDate(today)}).
CALENDAR (use it for every date; never calculate dates yourself):
${buildCalendarTable(today)}

${
  hasAudio
    ? `INPUT: an audio recording is attached. LISTEN TO THE AUDIO; it is the only reliable source.${
        text
          ? ` A browser speech-to-text transcript is also given, but it is frequently WRONG and often drops or garbles exactly the names and initials that matter. Use it only as a weak hint, and overrule it whenever the audio disagrees: "${text}"`
          : ''
      }`
    : `INPUT: only a browser speech-to-text transcript, which is noisy (names misspelled, split into common words, or missing): "${text}"`
}

== THE TWO FIELDS THAT MATTER MOST ==
companyName = the business the rep called or is meeting. directorName = the human on the other side.

Who is the person (directorName)? Anyone described by any of: owner, business owner, proprietor, director, managing director, MD, founder, co-founder, CEO, partner, client, customer, contact, contact person, person, proprietor, "the gentleman/lady", "his/her name", "spoke to X", "met X", "meeting with X", "X picked up". All of these mean the same thing: put that name in directorName. Keep first name plus surname if both are said; drop titles (Mr, Mrs, Ms, Sir, Madam, Dr unless part of the name). If no person is named, directorName is "".

What is the company (companyName)? The business name, nothing else: no "I called", "the company", "his company is", no sentence fragments. Business names usually end in or contain words like Agro, Farms, Traders, Textiles, Industries, Enterprises, Exports, Solutions, Motors, Foods, Constructions, Builders, Hotel, Engineering, Pharma, Pvt Ltd. A name containing such a word is a COMPANY, never a person. A person's name inside a business name ("Ravi Traders") belongs to companyName only; do not also put Ravi in directorName unless the rep says Ravi is the person they spoke to.

Spoken initials and spellings (very common in Indian business names): the rep may say letters ("em em", "M M", "double M", "capital M capital M", "S R K", "V K S"). Speech-to-text turns letters into words ("yum yum", "um um", "am am", "him him", "ess are kay"). Write initials as joined capitals: "MM Agro Farms", "SRK Traders", "VKS Exports". Repeated odd syllables at the start of a business name ("yum yum", "um um", "em em") almost always mean spoken initials. If the rep spells a name out, follow the spelling exactly.
Names may also be run together or split wrongly ("agroforms" is "Agro Farms", "so jay" is "Sujay"); repair them into the most plausible real name. Prefer common Indian spellings of people's names (Arun, Sujay, Manjula, Karthik, Priya...) over look-alike Western names (Aaron, Sue Jay).
${
  companies.length
    ? `Companies already in the sheet; if the spoken company clearly refers to one of these, use that exact spelling: ${companies.join('; ')}`
    : ''
}
${people.length ? `People already in the sheet; same rule: ${people.join('; ')}` : ''}
Never invent a name that was not said. If the person's name is genuinely inaudible, use "" rather than guessing; if the company is unclear, give your best phonetic spelling.

== OTHER FIELDS ==
- transcription: ${hasAudio ? 'a faithful transcript of the audio, with initials written joined (MM) and obvious mishearings fixed' : 'the transcript with only obvious speech-to-text errors fixed'}.
- callNumber 1-4 from "first/second/third/fourth call"; default 1.
- callDateIso: when the call happened. Default today ${toIsoDate(today)}; "yesterday" uses the calendar.
- Follow-up or meeting: if anything is planned for later (follow up, call back, meeting, demo, visit, "tomorrow at 3"), hasNextFollowUp = true. nextFollowUpDateIso comes from the CALENDAR: "today"/"tomorrow"/"day after tomorrow" as listed; a bare weekday or "next <weekday>" means the first such weekday after today (never today itself, never an extra week skipped; said on a Friday, "Friday" and "next Friday" both mean 7 days later). A meeting stated with a time but no day ("the meeting is at 5 PM") is today. nextFollowUpTime is 24h "HH:mm", or "" if no time was said. A bare hour without am/pm: 1-6 means PM, 7-11 means AM, unless said. "no follow up" means hasNextFollowUp = false.
- isMeeting: true only when a meeting or demo is being scheduled (not a plain call back).
- freeWebsiteStatus: exactly one of "Not Asked", "To Send Free Website", "Free Website Sent", "Website Reviewing", "Declined / Not Needed".
- companyNumber (digits only, as spoken) and email: copy exactly, "" if absent. "john at gmail dot com" means john@gmail.com.
- callNote: one or two clean third-person sentences about what was discussed or planned, without repeating the name, number and date fields.

== EXAMPLES ==
Heard: "I have a meeting with Arun Prakash and his company is em em agro farms, the meeting is at five" -> companyName "MM Agro Farms", directorName "Arun Prakash", meeting today 17:00.
Heard: "second call, business owner Sujay, it's the Sri Murugan Textiles, call him back tomorrow morning at ten" -> companyName "Sri Murugan Textiles", directorName "Sujay", follow-up tomorrow 10:00.
Heard: "spoke to the client Ravi Kumar of yes are kay traders, no follow up" -> companyName "SRK Traders", directorName "Ravi Kumar", no follow-up.`;

      const parts: any[] = [];
      if (audioBase64) {
        parts.push({ inlineData: { data: audioBase64, mimeType: mimeType || 'audio/webm' } });
      }
      parts.push({ text: prompt });

      const config = {
        responseMimeType: 'application/json',
        temperature: 0,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transcription: { type: Type.STRING },
            companyName: { type: Type.STRING },
            directorName: { type: Type.STRING },
            callNumber: { type: Type.INTEGER },
            callDateIso: { type: Type.STRING },
            callNote: { type: Type.STRING },
            companyNumber: { type: Type.STRING },
            email: { type: Type.STRING },
            hasNextFollowUp: { type: Type.BOOLEAN },
            nextFollowUpDateIso: { type: Type.STRING },
            nextFollowUpTime: { type: Type.STRING },
            isMeeting: { type: Type.BOOLEAN },
            freeWebsiteStatus: { type: Type.STRING },
          },
          required: ['transcription', 'companyName', 'directorName', 'callNumber', 'callNote'],
        },
      };

      const models = Array.from(
        new Set(
          [process.env.GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'].filter(
            Boolean
          ) as string[]
        )
      );
      let parsedAi: any = null;
      let lastErr: any = null;
      // Models can return transient 503s under load: retry each briefly, then move on.
      outer: for (const model of models) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response: any = await Promise.race([
              ai.models.generateContent({ model, contents: { parts }, config }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('AI request timeout')), 20000)),
            ]);
            if (response?.text) {
              parsedAi = JSON.parse(response.text.trim());
              break outer;
            }
          } catch (e) {
            lastErr = e;
            const msg = String((e as any)?.message || '');
            console.warn(`Gemini model ${model} attempt ${attempt + 1} failed:`, msg.slice(0, 160));
            // 429 = quota for this model: retrying is pointless, move to the next model instead.
            const transient = /503|UNAVAILABLE|timeout/i.test(msg);
            if (!transient) break;
            await new Promise((r) => setTimeout(r, 700));
          }
        }
      }
      if (!parsedAi) throw lastErr || new Error('No AI response');

      const spoken: string = parsedAi.transcription || text || '';
      const rules = extractLeadDetails(spoken, today);

      const repaired = repairEntities(
        String(parsedAi.companyName || '').trim(),
        String(parsedAi.directorName || '').trim()
      );
      const companyName =
        snapToKnown(repaired.company, companies) ||
        fallbackResult?.companyName ||
        rules.companyName ||
        'New Lead';
      const directorName =
        snapToKnown(repaired.director, people) || (parsedAi.directorName ? '' : rules.directorName) || '';

      // Dates: trust the model's calendar pick only if it is sane, else fall back to the rules.
      const inRange = (iso: string) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
        if (!m) return false;
        const d = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
        const t0 = today.getTime();
        return d >= t0 && d <= t0 + 180 * 86400000;
      };
      let nextFollowUpDate = '';
      let nextFollowUpTime = normalizeTime(parsedAi.nextFollowUpTime);
      let hasNextFollowUp = Boolean(parsedAi.hasNextFollowUp);
      if (hasNextFollowUp) {
        if (inRange(parsedAi.nextFollowUpDateIso)) {
          nextFollowUpDate = isoToDayDate(parsedAi.nextFollowUpDateIso);
        } else {
          const resolved = resolveDateAndTimeString(spoken, today);
          nextFollowUpDate = resolved.dayDate;
          if (!nextFollowUpTime) nextFollowUpTime = resolved.time;
        }
      }
      if (!nextFollowUpDate) hasNextFollowUp = false;

      const isMeeting = Boolean(parsedAi.isMeeting) && hasNextFollowUp;
      const callNumber = ([1, 2, 3, 4].includes(parsedAi.callNumber) ? parsedAi.callNumber : 1) as 1 | 2 | 3 | 4;
      const callDate = isoToDayDate(parsedAi.callDateIso) || todayFormatted;
      const callNote = (parsedAi.callNote || '').trim() || rules.callNote;

      return res.json({
        companyName,
        directorName,
        callNumber,
        callStage: `CALL_${callNumber}`,
        callLabel: `Call ${callNumber}`,
        callNote,
        callDate,
        companyNumber: parsedAi.companyNumber || rules.companyNumber || '',
        email: parsedAi.email || rules.email || '',
        hasNextFollowUp,
        nextFollowUpDate,
        nextFollowUpTime: hasNextFollowUp ? nextFollowUpTime : '',
        nextFollowUpType: !hasNextFollowUp ? 'None' : isMeeting ? 'Meeting Scheduled' : 'Follow-up Call',
        scheduledMeeting: isMeeting
          ? nextFollowUpTime
            ? `${nextFollowUpDate} @ ${nextFollowUpTime}`
            : nextFollowUpDate
          : 'None',
        freeWebsiteStatus: parsedAi.freeWebsiteStatus || rules.freeWebsiteStatus || 'Not Asked',
        callOutcome: isMeeting ? 'Meeting Scheduled' : hasNextFollowUp ? 'Follow-up Scheduled' : 'Connected & Discussed',
        summary: `Call ${callNumber} with ${companyName}: ${callNote.slice(0, 80)}`,
        transcription: spoken,
        source: 'ai',
      });
    } catch (err: any) {
      console.warn('Gemini extraction unavailable, using rule-based fallback:', err?.message);
    }

    if (fallbackResult) {
      return res.json({ ...fallbackResult, source: 'rules' });
    }

    return res.status(200).json({
      companyName: 'New Lead',
      directorName: '',
      callNumber: 1,
      callStage: 'CALL_1',
      callLabel: 'Call 1',
      callNote: 'Voice note recorded',
      callDate: todayFormatted,
      companyNumber: '',
      email: '',
      hasNextFollowUp: false,
      nextFollowUpDate: '',
      nextFollowUpTime: '',
      nextFollowUpType: 'None',
      scheduledMeeting: 'None',
      freeWebsiteStatus: 'Not Asked',
      callOutcome: 'Connected & Discussed',
      summary: 'Voice note recorded',
      transcription: '',
      source: 'none',
    });
  });

  // Handle SPA routing & Vite middleware
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(process.cwd(), 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(process.cwd(), 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true' },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

startServer();
