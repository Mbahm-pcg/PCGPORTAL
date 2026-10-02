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
import { payPeriodEndFor as pmPayPeriodEndFor, parseDateOnly, toDateStr } from './office-clock-period-math.mjs';

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

// The ET (America/New_York) calendar date of a UTC instant, as a
// "YYYY-MM-DD" string — the same idiom already used correctly elsewhere in
// this feature (office-clock-compare.mjs's etDayOf, office-clock-punch.mjs's
// `today` action and etDateStr). Used here (I4), NOT a raw UTC slice, so a
// punch made after ~8pm ET buckets into the day the employee actually
// experienced it as, not the next UTC calendar day.
function etDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Flags days where a punch sequence is incomplete: an open clock-in with no
// later clock-out that same day, or an open meal_start with no later meal_end
// that same day. `punches` is one employee's punches for a period (or a day),
// each { punchType, capturedAt (ISO string) }, in any order.
export function findIncompleteDays(punches) {
  const sorted = [...punches].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
  const byDay = new Map();
  for (const p of sorted) {
    const day = etDateStr(new Date(p.capturedAt));
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

// Exact per-day totals from raw punches — the server-side twin of app.jsx's
// officeClockDailyHours (same day-bucketing idiom, same "only a clean
// one-in/one-out/one-meal-pair shape totals; anything else is left
// incomplete rather than guessed at" rule). Kept as a literal duplicate
// rather than a shared import because app.jsx can't import this Node/
// Netlify-Blobs-heavy file (see this file's own header comment) — if this
// math ever changes, update both copies together.
export function dailyHoursFromPunches(punches) {
  const sorted = [...(punches || [])].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
  const byDay = new Map();
  for (const p of sorted) {
    const day = etDateStr(new Date(p.capturedAt));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p);
  }
  const rows = [];
  for (const [day, dayPunches] of byDay) {
    const byType = (t) => dayPunches.filter(p => p.punchType === t);
    const clockIns = byType('clock_in');
    const clockOuts = byType('clock_out');
    const mealStarts = byType('meal_start');
    const mealEnds = byType('meal_end');
    const clockIn = clockIns[0] || null;
    const clockOut = clockOuts[0] || null;
    const mealStart = mealStarts[0] || null;
    const mealEnd = mealEnds[0] || null;

    let totalMinutes = null;
    const regularShape = clockIns.length === 1 && clockOuts.length === 1
      && mealStarts.length === mealEnds.length && mealStarts.length <= 1;
    if (regularShape) {
      const inMs = new Date(clockIn.capturedAt).getTime();
      const outMs = new Date(clockOut.capturedAt).getTime();
      let grossMs = outMs - inMs;
      let sane = Number.isFinite(grossMs) && grossMs > 0;
      if (sane && mealStart && mealEnd) {
        const mealInMs = new Date(mealStart.capturedAt).getTime();
        const mealOutMs = new Date(mealEnd.capturedAt).getTime();
        const mealMs = mealOutMs - mealInMs;
        if (!Number.isFinite(mealMs) || mealMs < 0 || mealInMs < inMs || mealOutMs > outMs) {
          sane = false;
        } else {
          grossMs -= mealMs;
        }
      }
      if (sane) totalMinutes = Math.round(grossMs / 60000);
    }
    rows.push({ day, totalMinutes });
  }
  return rows.sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
}

// Splits one employee's punches for a closed biweekly period into the two
// Sunday–Saturday workweeks it contains, each with its own Reg (<=40 hrs)
// and OT (>40 hrs) hours — the standard weekly FLSA overtime rule, applied
// independently per week (never combined across the two weeks of a period).
// This split exists only because the paygrid-staging write path
// (stagePayrollHours) has no concept of punches or time policies the way
// CreatePunches would have — it just accepts a flat number of hours under a
// "Reg"/"OT" earning code, so something has to do this math before staging.
// The hours themselves still come entirely from the exact real clock-in/
// clock-out data via dailyHoursFromPunches above — this function only
// decides how a week's exact total gets divided between the two codes.
//
// A day with punches in a malformed shape (dailyHoursFromPunches returns
// totalMinutes: null for it — e.g. a missing clock-out) makes its whole
// week `incomplete: true` rather than silently counting it as 0 hours,
// which would understate real pay. The caller must refuse to stage an
// incomplete week, not guess.
export function weeklyRegOtFromPunches(punches, periodEndDateStr) {
  const daily = dailyHoursFromPunches(punches);
  const periodEnd = parseDateOnly(periodEndDateStr);
  const weekStartFor = (daysBeforePeriodEnd) => {
    const d = new Date(periodEnd);
    d.setUTCDate(d.getUTCDate() - daysBeforePeriodEnd);
    return d;
  };
  const weeks = [
    { weekStart: toDateStr(weekStartFor(13)), weekEnd: toDateStr(weekStartFor(7)) }, // week 1
    { weekStart: toDateStr(weekStartFor(6)), weekEnd: toDateStr(weekStartFor(0)) },  // week 2
  ];
  return weeks.map(({ weekStart, weekEnd }) => {
    let totalMinutes = 0;
    let incomplete = false;
    for (const row of daily) {
      if (row.day < weekStart || row.day > weekEnd) continue;
      if (row.totalMinutes === null) { incomplete = true; continue; }
      totalMinutes += row.totalMinutes;
    }
    const totalHours = Math.round((totalMinutes / 60) * 100) / 100;
    const regHours = Math.min(totalHours, 40);
    const otHours = Math.round((Math.max(totalHours - 40, 0)) * 100) / 100;
    return { weekStart, weekEnd, regHours, otHours, incomplete };
  });
}

export { isBiweekBoundary, weekEndForTrigger, dateRangeEndingAt, BIWEEKLY_ANCHOR_END };
