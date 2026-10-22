// src/interview-ics.mjs — read Paradox ("Ally from Dunkin'") interview invites.
// Pure, no I/O. The invites are standard calendar (.ics) data, so the exact start
// time, candidate, meeting link and a stable UID come from the invite itself —
// a reschedule keeps the UID with a higher SEQUENCE; a cancellation is
// METHOD:CANCEL / STATUS:CANCELLED.

const WINDOWS_TZ = {
  'eastern standard time': 'America/New_York', 'us eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago', 'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
};
const DEFAULT_TZ = 'America/New_York';

function resolveTz(tz) {
  if (!tz) return DEFAULT_TZ;
  const t = String(tz).replace(/^"|"$/g, '').trim();
  const mapped = WINDOWS_TZ[t.toLowerCase()];
  if (mapped) return mapped;
  try { new Intl.DateTimeFormat('en-US', { timeZone: t }); return t; } catch { return DEFAULT_TZ; }
}

// "20261024T110000" in a named time zone -> Date (UTC). Uses the zone's real offset
// on that date, so EST/EDT are both right.
export function zonedToUtc(local, tz) {
  const m = String(local).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/);
  if (!m) return null;
  const [y, mo, d, h = '00', mi = '00', s = '00'] = m.slice(1);
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const zone = resolveTz(tz);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offsetAt = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  let utc = guess - offsetAt(guess);
  utc = guess - offsetAt(utc); // second pass settles DST-boundary cases
  return new Date(utc);
}

function parseDate(value, params) {
  const v = String(value || '').trim();
  if (/Z$/i.test(v)) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i);
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
  }
  return zonedToUtc(v, params.TZID);
}

const unescapeText = (v) => String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

export function parseIcs(text) {
  // Unfold: a line starting with a space or tab continues the previous line.
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n').reduce((acc, line) => {
    if (/^[ \t]/.test(line) && acc.length) acc[acc.length - 1] += line.slice(1);
    else acc.push(line);
    return acc;
  }, []);
  let method = null;
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [nameRaw, ...paramParts] = head.split(';');
    const name = nameRaw.toUpperCase();
    const params = Object.fromEntries(paramParts.map(p => { const i = p.indexOf('='); return i < 0 ? [p.toUpperCase(), ''] : [p.slice(0, i).toUpperCase(), p.slice(i + 1)]; }));
    if (name === 'BEGIN' && value.toUpperCase() === 'VEVENT') { cur = {}; continue; }
    if (name === 'END' && value.toUpperCase() === 'VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) { if (name === 'METHOD') method = value.trim().toUpperCase(); continue; }
    if (name === 'UID') cur.uid = value.trim();
    else if (name === 'SEQUENCE') cur.sequence = parseInt(value, 10) || 0;
    else if (name === 'STATUS') cur.status = value.trim().toUpperCase();
    else if (name === 'DTSTART') { const d = parseDate(value, params); cur.start = d ? d.toISOString() : null; }
    else if (name === 'DTEND') { const d = parseDate(value, params); cur.end = d ? d.toISOString() : null; }
    else if (name === 'SUMMARY') cur.summary = unescapeText(value).trim();
    else if (name === 'LOCATION') cur.location = unescapeText(value).trim();
    else if (name === 'DESCRIPTION') cur.description = unescapeText(value);
    else if (name === 'ORGANIZER') cur.organizer = value.replace(/^mailto:/i, '').trim();
  }
  return events.map(e => ({ sequence: 0, status: null, ...e, method }));
}

// "Your virtual interview with Jordanna G Mormando" -> "Jordanna G Mormando"
export function candidateFromSummary(summary) {
  const m = String(summary || '').match(/interview with\s+(.+?)(?:\s+[-–|(].*)?$/i);
  return m ? m[1].trim() : null;
}

// First http(s) link in the event (LOCATION first, then DESCRIPTION).
export function meetingLink(event) {
  const m = `${event?.location || ''} ${event?.description || ''}`.match(/https?:\/\/[^\s<>"')]+/i);
  return m ? m[0] : null;
}
