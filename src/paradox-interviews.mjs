// src/paradox-interviews.mjs — pure helpers for interview reminders sourced from the Paradox
// API instead of the store Gmail calendar invites (v22.45). No I/O.

// Candidate stages that carry a booked interview time.
export const SCHEDULED_STATUSES = ['Interview: Interview Scheduled', '2nd Interview: 2nd Interview Scheduled'];

// Paradox rows are stored in interview_invites next to the Gmail ones, told apart by uid.
export const PX_UID_PREFIX = 'px:';
export const pxUid = (oid) => `${PX_UID_PREFIX}${oid}`;

// Where interview reminders read interviews from (Admin → Interview Reminders):
// 'paradox' or 'email' (store Gmail invites). Anything else reads as 'email'.
export function interviewSource(cfg) {
  return cfg && cfg.source === 'paradox' ? 'paradox' : 'email';
}

// Offset (minutes, e.g. -300 for EST) of `zone` at instant `ms`.
function zoneOffsetMin(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - ms) / 60000);
}

// A Paradox timestamp → ISO (UTC). Explicit zone (Z / ±hh:mm) is trusted as is. A bare
// "YYYY-MM-DD HH:MM[:SS]" is read in `naiveZone` — 'UTC', or an IANA zone such as
// 'America/New_York' (store-local), handling DST. Unparseable → null.
export function parseParadoxTime(s, naiveZone = 'UTC') {
  if (s == null || s === '') return null;
  if (typeof s === 'number' || /^\d{9,13}$/.test(String(s))) {
    const n = Number(s); const ms = n < 1e12 ? n * 1000 : n;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const str = String(s).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(str)) { const t = Date.parse(str.replace(' ', 'T')); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (naiveZone === 'UTC') return new Date(wall).toISOString();
  // wall-clock in zone → UTC: subtract the zone's offset (re-checked once for DST edges).
  let ms = wall - zoneOffsetMin(wall, naiveZone) * 60000;
  ms = wall - zoneOffsetMin(ms, naiveZone) * 60000;
  return new Date(ms).toISOString();
}

// One GET /candidates?interviews=1 row (fetched for one store) → an interview_invites row,
// or null when there's no usable upcoming time / it already happened.
export function readInterviewRow(row, pc, { naiveZone = 'UTC', label = 'Interview' } = {}) {
  const c = (row && row.candidate) || {};
  const iv = (row && row.interview) || {};
  if (c.OID == null || !iv.scheduled_at) return null;
  const done = iv.interviewed != null && !/^(0|false|no|)$/i.test(String(iv.interviewed).trim());
  if (done) return null;
  const start = parseParadoxTime(iv.scheduled_at, naiveZone);
  if (!start) return null;
  return { uid: pxUid(c.OID), pc: String(pc), candidate: String(c.name || '').trim() || null, start, summary: label };
}
