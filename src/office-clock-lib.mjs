// Pure logic for the Office Hourly Time Clock feature — no network or DB I/O.
import {
  isBiweekBoundary, weekEndForTrigger, dateRangeEndingAt, BIWEEKLY_ANCHOR_END,
} from '../netlify/functions/tips-report-cron-background.mjs';

const BUTTON_MAP = {
  clock_in: { status: 'In', activity: 'Work' },
  meal_start: { status: 'Out', activity: 'Meal' },
  meal_end: { status: 'In', activity: 'Work' },
  clock_out: { status: 'Out', activity: 'Work' },
};

export function punchStatusAndActivity(buttonType) {
  const m = BUTTON_MAP[buttonType];
  if (!m) throw new Error(`unknown punch type: ${buttonType}`);
  return { ...m };
}

function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// The Saturday that closes the biweekly pay period containing dateStr. Walks
// forward/backward from BIWEEKLY_ANCHOR_END in 14-day steps rather than
// re-deriving the anchor math independently, so this can never drift out of
// sync with tips-report-cron-background.mjs's own period boundaries.
export function payPeriodEndFor(dateStr) {
  const anchor = parseDateOnly(BIWEEKLY_ANCHOR_END);
  const target = parseDateOnly(dateStr);
  const diffDays = Math.round((target - anchor) / 86400000);
  // Math.ceil, not floor: we need the smallest anchor-aligned period-end at or after the target.
  // floor() reverses this for dates between period boundaries (e.g., Aug 2 would wrongly map to Aug 1).
  const periodIndex = Math.ceil(diffDays / 14);
  const end = new Date(anchor);
  end.setUTCDate(end.getUTCDate() + periodIndex * 14);
  return toDateStr(end);
}

// True once "now" is past the Tuesday-night deadline that closes out editing/
// sending for the pay period ending on periodEndDate. Tuesday is 3 days after
// Saturday; "night" is the end of that Tuesday in UTC (00:00:00 UTC the
// following Wednesday) — a plain, unambiguous UTC boundary.
export function isPeriodLocked(periodEndDate, now) {
  const end = parseDateOnly(periodEndDate);
  const lockAt = new Date(end);
  lockAt.setUTCDate(lockAt.getUTCDate() + 4);
  return now.getTime() >= lockAt.getTime();
}

// Flags days where a punch sequence is incomplete: an open clock-in with no
// later clock-out that same day, or an open meal_start with no later meal_end
// that same day. `punches` is one employee's punches for a period (or a day),
// each { punchType, capturedAt (ISO string) }, in any order.
export function findIncompleteDays(punches) {
  const sorted = [...punches].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
  const byDay = new Map();
  for (const p of sorted) {
    const day = p.capturedAt.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p);
  }
  const issues = [];
  for (const [day, dayPunches] of byDay) {
    let clockedIn = false;
    let onMeal = false;
    for (const p of dayPunches) {
      if (p.punchType === 'clock_in') clockedIn = true;
      if (p.punchType === 'clock_out') clockedIn = false;
      if (p.punchType === 'meal_start') onMeal = true;
      if (p.punchType === 'meal_end') onMeal = false;
    }
    if (onMeal) { issues.push({ day, reason: 'open_meal' }); continue; }
    if (clockedIn) issues.push({ day, reason: 'open_clock_in' });
  }
  return issues;
}

export { isBiweekBoundary, weekEndForTrigger, dateRangeEndingAt, BIWEEKLY_ANCHOR_END };
