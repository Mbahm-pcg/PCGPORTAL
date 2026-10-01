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

// NOT a real locking decision — that's now isPeriodFinalized (a DB-backed
// check in office-clock-review.mjs: a period is read-only once a send has
// actually been triggered AND every one of its punches is 'confirmed' in
// Paycor; see that file's header comment for the full rule). This is kept
// purely as an internal heuristic for defaultClosedPeriodEnd below, to pick a
// sane default period to show when the review screen first loads — "has this
// period had enough time to plausibly be closed out" — not to gate edits or
// sends. Intentionally not exported: nothing outside this file should use it
// as a lock check.
function isPastTuesdayNightHeuristic(periodEndDate, now) {
  const end = parseDateOnly(periodEndDate);
  const lockAt = new Date(end);
  lockAt.setUTCDate(lockAt.getUTCDate() + 4);
  return now.getTime() >= lockAt.getTime();
}

// Given any anchor end date, a reasonable default period to show on first
// load, as of `now`: the current anchor-aligned period once it's plausibly
// closed out (past the Tuesday-night heuristic above), otherwise the one
// before it. This is a UI convenience default only — it does not determine
// whether a period can still be edited or sent; see isPeriodFinalized in
// office-clock-review.mjs for that.
export function defaultClosedPeriodEnd(anchorEnd, now) {
  const current = payPeriodEndFor(toDateStr(now), anchorEnd);
  if (isPastTuesdayNightHeuristic(current, now)) return current;
  const prev = parseDateOnly(current);
  prev.setUTCDate(prev.getUTCDate() - 14);
  return toDateStr(prev);
}
