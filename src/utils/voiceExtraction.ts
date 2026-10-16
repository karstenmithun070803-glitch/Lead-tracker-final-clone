/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { formatDayDate, formatStandardTime } from './dateResolver.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Today's calendar date in the caller's timezone, as a local-constructed Date (noon-free, midnight local). */
export function todayInTimezone(clientDateIso?: string, timeZone?: string): Date {
  const instant = clientDateIso ? new Date(clientDateIso) : new Date();
  const safeInstant = isNaN(instant.getTime()) ? new Date() : instant;
  let ymd: string;
  try {
    ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(safeInstant);
  } catch {
    ymd = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      safeInstant
    );
  }
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

export function toIsoDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Explicit calendar handed to the model so it never has to do date arithmetic itself. */
export function buildCalendarTable(today: Date, days = 15): string {
  const lines: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const label = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : i === 2 ? ' (day after tomorrow)' : '';
    lines.push(`${toIsoDate(d)} = ${DAYS[d.getDay()]}${label}`);
  }
  return lines.join('\n');
}

/** "2026-10-17" -> "Saturday, Oct 17, 2026". Returns '' when not a valid ISO date. */
export function isoToDayDate(iso?: string): string {
  if (!iso) return '';
  const m = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return isNaN(d.getTime()) ? '' : formatDayDate(d);
}

/** "15:00" -> "3:00 PM". Also accepts "3 PM" / "3:00 PM". Returns '' when empty. */
export function normalizeTime(raw?: string): string {
  if (!raw) return '';
  const t = raw.trim();
  const h24 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    let h = parseInt(h24[1], 10);
    const min = h24[2];
    if (h > 23) return '';
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 === 0 ? 12 : h % 12;
    return `${h}:${min} ${ampm}`;
  }
  return formatStandardTime(t);
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|the|and|&)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Phonetic-ish key: collapses vowels and common sound-alikes so "Sujay"/"Suji"/"Sujai" meet. */
function soundKey(s: string): string {
  return normalizeForMatch(s)
    .replace(/ph/g, 'f')
    .replace(/[wv]/g, 'v')
    .replace(/[ckq]/g, 'k')
    .replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1')
    .replace(/[aeiouy]/g, '');
}

/**
 * Snap a transcribed name onto a name already in the user's sheet when they are
 * near-identical (speech-to-text often garbles spelling of a known company/person).
 * Returns the original string when nothing is close enough.
 */
export function snapToKnown(candidate: string, known: string[]): string {
  const cand = (candidate || '').trim();
  if (!cand || !known.length) return cand;
  const nc = normalizeForMatch(cand);
  const sc = soundKey(cand);
  if (nc.length < 3) return cand;

  let best = cand;
  let bestScore = 0;
  for (const k of known) {
    const kn = normalizeForMatch(k);
    if (!kn) continue;
    const dist = levenshtein(nc, kn);
    const textScore = 1 - dist / Math.max(nc.length, kn.length);
    const sk = soundKey(k);
    const soundScore = sc && sk ? 1 - levenshtein(sc, sk) / Math.max(sc.length, sk.length) : 0;
    const score = Math.max(textScore, soundScore >= 0.9 && textScore >= 0.6 ? soundScore : 0);
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return bestScore >= 0.8 ? best : cand;
}
