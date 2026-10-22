// src/interview-reminders.mjs — which interview reminder is due, and its wording.
// Pure, no I/O (used by netlify/functions/interview-reminders-lib/run.mjs).

const HOUR = 3600000;

// interview: { start (ISO), status, sentDayAt, sentHourAt }
// nowMs: Date.now(); etHour: current hour (0-23) in America/New_York.
export function dueReminder(iv, nowMs, etHour) {
  if (!iv || !iv.start || iv.status === 'cancelled') return null;
  const start = new Date(iv.start).getTime();
  if (!Number.isFinite(start) || start <= nowMs) return null;
  const until = start - nowMs;
  // Cron runs every 15 min, so "about an hour before" = within 65 minutes.
  if (!iv.sentHourAt && until <= 65 * 60000) return 'hour';
  // Day-before reminder: within 24h, not when the interview is under 2h away
  // (the hour reminder covers that), and only 8am–9pm ET so nobody gets a 2am text.
  if (!iv.sentDayAt && !iv.sentHourAt && until <= 24 * HOUR && until > 2 * HOUR && etHour >= 8 && etHour < 21) return 'day';
  return null;
}

const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export function reminderText(kind, iv, nowMs, { storeName, includeLink = true } = {}) {
  const who = iv.candidate || 'a candidate';
  const virtual = /virtual/i.test(iv.summary || '') ? 'virtual ' : '';
  const at = fmtTime(iv.start);
  const where = storeName ? ` (${storeName})` : '';
  const link = includeLink && iv.link ? ` Join: ${iv.link}` : '';
  if (kind === 'hour') {
    const mins = Math.max(1, Math.round((new Date(iv.start).getTime() - nowMs) / 60000));
    return `Interview in ${mins} min (${at}): ${virtual}interview with ${who}${where}.${link}`;
  }
  const when = etDay(new Date(iv.start).getTime()) === etDay(nowMs) ? 'today' : 'tomorrow';
  return `Reminder: ${when} at ${at} you have a ${virtual}interview with ${who}${where}.${link}`;
}
