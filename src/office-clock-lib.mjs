// Pure logic for the Office Hourly Time Clock feature — no network or DB I/O.
import {
  isBiweekBoundary, weekEndForTrigger, dateRangeEndingAt, BIWEEKLY_ANCHOR_END,
} from '../netlify/functions/tips-report-cron-background.mjs';
// The actual period/lock FORMULA lives in office-clock-period-math.mjs (pure,
// zero-dependency) so it can be shared with app.jsx's browser bundle, which
// can't import this file directly (the import above pulls in Node/Netlify-
// Blobs-only dependencies). This file still owns the single real
// BIWEEKLY_ANCHOR_END value and passes it in below — app.jsx instead passes
// its own duplicated literal copy of that same anchor date. See that file's
// OFFICE_CLOCK_BIWEEKLY_ANCHOR_END for the one place that duplication lives.
import { payPeriodEndFor as pmPayPeriodEndFor, isPeriodLocked as pmIsPeriodLocked } from './office-clock-period-math.mjs';

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

// The Saturday that closes the biweekly pay period containing dateStr. Walks
// forward/backward from BIWEEKLY_ANCHOR_END in 14-day steps rather than
// re-deriving the anchor math independently, so this can never drift out of
// sync with tips-report-cron-background.mjs's own period boundaries. Same
// single-argument public signature as before this was split out — only the
// formula itself moved to office-clock-period-math.mjs.
export function payPeriodEndFor(dateStr) {
  return pmPayPeriodEndFor(dateStr, BIWEEKLY_ANCHOR_END);
}

// True once "now" is past the Tuesday-night deadline that closes out editing/
// sending for the pay period ending on periodEndDate. Tuesday is 3 days after
// Saturday; "night" is the end of that Tuesday in UTC (00:00:00 UTC the
// following Wednesday) — a plain, unambiguous UTC boundary.
export function isPeriodLocked(periodEndDate, now) {
  return pmIsPeriodLocked(periodEndDate, now);
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
