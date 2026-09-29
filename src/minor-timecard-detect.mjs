// src/minor-timecard-detect.mjs — pure PA minor-labor-law violation detection.
// No network, no blobs — every function here takes plain data in and returns
// plain data out, so the legally-sensitive math (§ analyzeDayForViolation) can
// be tested exhaustively without touching Paycor.
//
// PA's Child Labor Act requires employees under 18 to get an uninterrupted
// 30-minute break after 5 consecutive hours worked. A shorter gap does NOT
// satisfy the requirement and does NOT reset the consecutive-hours clock —
// time on either side of a sub-30-minute gap still counts as one continuous
// stretch for compliance purposes.
const VIOLATION_HOURS = 5.0;
const QUALIFYING_BREAK_MINUTES = 30;

export function ageFromBirthDate(birthDate, asOfDate = new Date()) {
  if (!birthDate) return null;
  const dob = new Date(birthDate);
  if (isNaN(dob)) return null;
  let age = asOfDate.getFullYear() - dob.getFullYear();
  const beforeBirthdayThisYear = (asOfDate.getMonth() < dob.getMonth())
    || (asOfDate.getMonth() === dob.getMonth() && asOfDate.getDate() < dob.getDate());
  if (beforeBirthdayThisYear) age--;
  return age;
}

export function isMinor(age) {
  return age != null && age < 18;
}

function toISODate(d) { return d.toISOString().slice(0, 10); }

// Called any day; returns the most recently COMPLETED Sun-Sat week (the week
// ending on the Saturday before `now`, even if `now` isn't a Sunday — the
// detection cron always calls this on Sunday, but keeping it correct for any
// day makes it safe to re-run manually without recomputing the boundary by hand).
export function weekRangeEndingYesterday(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Walk back to the most recent Saturday strictly before `start`.
  const dow = start.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceLastSaturday = dow === 6 ? 7 : dow + 1;
  const weekEndDate = new Date(start.getTime() - daysSinceLastSaturday * 86400000);
  const weekStartDate = new Date(weekEndDate.getTime() - 6 * 86400000);
  const days = [];
  for (let i = 0; i < 7; i++) days.push(toISODate(new Date(weekStartDate.getTime() + i * 86400000)));
  return { weekStart: toISODate(weekStartDate), weekEnd: toISODate(weekEndDate), days };
}

const punchTime = (p) => p.punchDateTime || p.punchIn || p.timeIn || null;

// Buckets by America/New_York calendar date, since punch timestamps from
// Paycor are ET wall-clock values with no timezone suffix (confirmed via
// direct API responses, e.g. "2026-09-16T05:37:00").
export function groupPunchesByDate(punches) {
  const grouped = {};
  for (const p of (punches || [])) {
    const t = punchTime(p);
    if (!t) continue;
    const dateStr = String(t).slice(0, 10);
    if (!grouped[dateStr]) grouped[dateStr] = [];
    grouped[dateStr].push(p);
  }
  return grouped;
}

// Analyzes ONE employee's punches for ONE already-completed day. Punches must
// pair up (clock-in, clock-out, clock-in, clock-out, ...) for a completed day
// — an odd count means a punch is missing/unpaired and the day cannot be
// safely analyzed, so this returns 'indeterminate' rather than guessing
// either way. (Confirmed necessary 2026-09-29: real punch data for overnight/
// irregular shifts is sometimes genuinely ambiguous, and guessing produced a
// wrong answer that had to be manually caught and corrected that same day.)
export function analyzeDayForViolation(dayPunches) {
  const sorted = [...(dayPunches || [])]
    .map(p => ({ raw: p, t: new Date(punchTime(p)) }))
    .filter(p => !isNaN(p.t))
    .sort((a, b) => a.t - b.t);

  if (sorted.length === 0) {
    return { status: 'ok', consecutiveHours: 0, longestGapMinutes: null, violates: false };
  }
  if (sorted.length % 2 !== 0) {
    return { status: 'indeterminate', consecutiveHours: null, longestGapMinutes: null, violates: false };
  }

  const pairs = [];
  for (let i = 0; i < sorted.length; i += 2) pairs.push({ in: sorted[i].t, out: sorted[i + 1].t });

  let longestGapMinutes = null;
  let stretchStart = pairs[0].in;
  let maxStretchHours = 0;
  const closeStretch = (end) => {
    const hours = (end - stretchStart) / 3600000;
    if (hours > maxStretchHours) maxStretchHours = hours;
  };

  for (let i = 1; i < pairs.length; i++) {
    const gapMinutes = (pairs[i].in - pairs[i - 1].out) / 60000;
    if (longestGapMinutes === null || gapMinutes > longestGapMinutes) longestGapMinutes = gapMinutes;
    if (gapMinutes >= QUALIFYING_BREAK_MINUTES) {
      closeStretch(pairs[i - 1].out);
      stretchStart = pairs[i].in;
    }
    // A sub-qualifying gap does NOT close the stretch — the clock keeps running
    // across it, per PA law's actual intent (see file header).
  }
  closeStretch(pairs[pairs.length - 1].out);

  return {
    status: 'ok',
    consecutiveHours: maxStretchHours,
    longestGapMinutes,
    violates: maxStretchHours >= VIOLATION_HOURS,
  };
}
