// office-clock-period-math.mjs — pure, zero-dependency biweekly pay-period
// date math, shared between the server (src/office-clock-lib.mjs, which
// supplies the real BIWEEKLY_ANCHOR_END re-exported from tips-report-cron-
// background.mjs) and the browser bundle (app.jsx, which cannot import that
// Node/Netlify-Blobs-heavy chain and instead passes its own duplicated
// literal copy of that same anchor date — see app.jsx's
// OFFICE_CLOCK_BIWEEKLY_ANCHOR_END). The ANCHOR VALUE is the only thing ever
// duplicated across those two call sites; this file is the single, tested
// home for the actual period/lock FORMULA — never copy this logic elsewhere.
//
// No imports of any kind (no DB, no Blobs, no other Netlify-function files)
// so this is always safe to pull into either a server function or a browser
// bundle.

export function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// The Saturday that closes the biweekly pay period containing dateStr, given
// an anchor end date (a known period-closing Saturday). Walks forward/
// backward from the anchor in 14-day steps rather than any other date math,
// so callers can never drift out of sync with each other as long as they
// pass the same anchor.
export function payPeriodEndFor(dateStr, anchorEnd) {
  const anchor = parseDateOnly(anchorEnd);
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

// Given any anchor end date, the most recently CLOSED period as of `now`:
// the current anchor-aligned period if it's already locked, otherwise the
// one before it (always guaranteed locked, since periods lock 4 days after
// they close and are 14 days long).
export function defaultClosedPeriodEnd(anchorEnd, now) {
  const current = payPeriodEndFor(toDateStr(now), anchorEnd);
  if (isPeriodLocked(current, now)) return current;
  const prev = parseDateOnly(current);
  prev.setUTCDate(prev.getUTCDate() - 14);
  return toDateStr(prev);
}
