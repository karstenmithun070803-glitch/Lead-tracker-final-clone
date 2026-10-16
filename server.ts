/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import path from 'path';
import { resolveDateAndTimeString, formatDayDate } from './src/utils/dateResolver.js';
import {
  todayInTimezone,
  toIsoDate,
  buildCalendarTable,
  isoToDayDate,
  normalizeTime,
  snapToKnown,
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
      const prompt = `You extract CRM fields from a sales rep's spoken call note. The rep is in India; speakers often have an Indian English accent and mention Indian business and person names.

TODAY: ${todayFormatted} (${toIsoDate(today)}).
CALENDAR (use this for every date; never calculate dates yourself):
${buildCalendarTable(today)}

${audioBase64 ? 'An audio recording is attached. The AUDIO is the source of truth.' : ''}${
        text
          ? `\nBrowser speech-to-text transcript (noisy; proper nouns are often misspelled, wrongly split, or replaced by common words): "${text}"`
          : ''
      }

Step 1 - transcription: ${
        audioBase64
          ? 'transcribe the audio faithfully (fix obvious mishearings using the audio).'
          : 'return the transcript, correcting only obvious speech-to-text errors.'
      }

Step 2 - extract. The two fields that matter most are companyName and directorName. Be careful with them:
- companyName: the business being called. Exactly the name, nothing else (no "I called", "the company", "pvt ltd" unless spoken, no sentence). Spell it as a proper business name, e.g. "Sri Murugan Textiles", "MM Agro Farms".
- directorName: the person spoken to / owner / director / founder / client / contact. First name plus surname if both were said. No titles (Mr, Sir, Madam), no company words. Empty string if no person was named.
- A person's name inside a business name ("Ravi Traders") belongs to companyName only; do not copy it to directorName unless the speaker names Ravi as the person they spoke to.
- Names may be misrecognised as ordinary words ("sujay" -> "so jay", "Manjula" -> "mom jula"). Rejoin and repair them into the most plausible real name.
${
  companies.length
    ? `- Companies already in the sheet (if the spoken company clearly refers to one of these, use that exact spelling): ${companies.join('; ')}`
    : ''
}
${people.length ? `- People already in the sheet (same rule): ${people.join('; ')}` : ''}
- Never invent a name that was not said. If unsure, give your best phonetic spelling rather than an empty string for the company.

Other fields:
- callNumber 1-4 from phrases like "first/second/third/fourth call"; default 1.
- callDateIso: date the call happened (default today ${toIsoDate(today)}; "yesterday" -> use the calendar-adjacent date).
- Follow-up: if the rep says something should happen later (follow up, call back, meeting, demo, "tomorrow at 3"), set hasNextFollowUp true, nextFollowUpDateIso from the CALENDAR (weekday names resolve to the NEXT upcoming such day; "next <weekday>" is the one after), and nextFollowUpTime as 24h "HH:mm" or "" if no time was said. Bare hours without am/pm: 1-6 -> PM, 7-11 -> AM unless said otherwise. "no follow up" -> hasNextFollowUp false.
- isMeeting: true only if a meeting or demo is being scheduled.
- freeWebsiteStatus: exactly one of "Not Asked", "To Send Free Website", "Free Website Sent", "Website Reviewing", "Declined / Not Needed".
- companyNumber (phone digits) and email: copy exactly; "" if absent. Spoken emails like "john at gmail dot com" -> john@gmail.com.
- callNote: one or two clean sentences of what was discussed, in third person, excluding the name/number/date admin already captured.`;

      const parts: any[] = [];
      if (audioBase64) {
        parts.push({ inlineData: { data: audioBase64, mimeType: mimeType || 'audio/webm' } });
      }
      parts.push({ text: prompt });

      const config = {
        responseMimeType: 'application/json',
        temperature: 0.1,
        thinkingConfig: { thinkingBudget: 1024 },
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
        new Set([process.env.GEMINI_MODEL, 'gemini-2.5-flash'].filter(Boolean) as string[])
      );
      let parsedAi: any = null;
      let lastErr: any = null;
      for (const model of models) {
        try {
          const response: any = await Promise.race([
            ai.models.generateContent({ model, contents: { parts }, config }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('AI request timeout')), 25000)),
          ]);
          if (response?.text) {
            parsedAi = JSON.parse(response.text.trim());
            break;
          }
        } catch (e) {
          lastErr = e;
          console.warn(`Gemini model ${model} failed:`, (e as any)?.message);
        }
      }
      if (!parsedAi) throw lastErr || new Error('No AI response');

      const spoken: string = parsedAi.transcription || text || '';
      const rules = extractLeadDetails(spoken, today);

      const companyName =
        snapToKnown(cleanEntityString(parsedAi.companyName || ''), companies) ||
        fallbackResult?.companyName ||
        rules.companyName ||
        'New Lead';
      const directorName =
        snapToKnown(cleanPersonName(parsedAi.directorName || ''), people) ||
        (parsedAi.directorName ? '' : rules.directorName) ||
        '';

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
