// src/tips-reconcile.mjs — pure decision logic for tips-reconcile-cron.mjs's
// daily late-punch reconciliation. Kept separate from the Netlify function so
// the per-employee-vs-per-day withhold behavior (the 2026-09-29 fix) can be
// unit tested directly against fixtures, without touching Paycor, Netlify
// Blobs, or Resend.
//
// Root cause this fixes (confirmed 2026-09-29 via several real missing-
// employee cases in one day — Jara Ibrahim/Grant, Farhan John + Mohammadi
// Barhanudin/store 8200, Brajbala Mehta + Shubhkumar Patel/Easton, four
// employees at Westchester, Isaac Vega Figueroa/Hunting Park — every one a
// real time-clock employee whose punches sat correctly in Paycor for up to
// two weeks without ever auto-correcting): the OLD logic withheld EVERY
// correction for a whole store/day the moment ANY previously-saved employee
// looked "dropped" relative to a fresh live fetch, even a completely
// unrelated genuine addition. One person's ambiguous schedule change was
// blocking everyone else's legitimate fix, store-wide, day after day. This
// version scopes the withhold to the individual employee who looks dropped —
// their old hours are preserved (never silently deleted) and flagged for
// manual review — while every other real addition/correction found in the
// same fetch still applies normally.

// guid/payrollId are "strong" identifiers (stable, unique to one person);
// name is a "weak" fallback used only when no strong key is available.
// Exported for tips-reconcile-cron.mjs's own use (e.g. if it ever needs to
// key crew members the same way outside this module).
export function candidateKeys(c) {
  const keys = [];
  if (c.guid) keys.push('g:' + c.guid);
  if (c.payrollId) keys.push('p:' + c.payrollId);
  if (c.name) keys.push('n:' + c.name);
  return keys;
}

function indexByAnyKey(crew) {
  const map = {};
  crew.forEach(c => { candidateKeys(c).forEach(k => { if (!map[k]) map[k] = c; }); });
  return map;
}

function findMatch(c, indexMap) {
  for (const k of candidateKeys(c)) { if (indexMap[k]) return indexMap[k]; }
  return null;
}

// Decides what one store/day's crew array should become after comparing
// `savedCrew` (already-saved) against `liveCrew` (a fresh Paycor fetch).
// `isKnownExcluded(savedCrewMember)` matches tips-reconcile-cron.mjs's own
// MANUALLY_EXCLUDED_EMPLOYEES check — a known, intentional permanent
// exclusion should never be reported as a "possible drop."
//
// Returns null when there is nothing at all to report (no additions, no
// hour corrections, no possible drops) — the caller should skip both saving
// and emailing, same as the original "continue" path.
//
// Otherwise returns { shouldSave, nextCrew, corrections }:
//   - shouldSave is true only when a real addition or hour-correction was
//     found (liveCrew genuinely differs from saved in a way worth
//     persisting). A day with nothing but a possible drop leaves the saved
//     data untouched — the dropped person's hours are already sitting there
//     correctly, so there is nothing to write, only something to flag.
//   - nextCrew is every liveCrew entry (so real additions/hour-corrections
//     are included) PLUS any saved entry that looked dropped, preserved
//     verbatim. Only meaningful when shouldSave is true; the caller must
//     gate the actual save on shouldSave, not on nextCrew's presence.
//   - corrections is a list of { employee, change, applied } — `applied:
//     true` for additions/hour-corrections actually reflected in nextCrew,
//     `applied: false` for a possible drop (preserved, not auto-removed,
//     flagged for manual review). The `change` string text is unchanged
//     from the pre-fix version so the existing email rendering still works;
//     only the withhold GRANULARITY changed, not the reporting text.
export function planStoreDayReconciliation(savedCrew, liveCrew, isKnownExcluded) {
  const savedIndex = indexByAnyKey(savedCrew || []);
  const matchedSavedEntries = new Set();
  const corrections = [];
  let mismatch = false;

  (liveCrew || []).forEach(lc => {
    const prev = findMatch(lc, savedIndex);
    if (!prev) {
      corrections.push({ employee: lc.name, change: `added — ${lc.hours.toFixed(2)}h (was missing entirely)`, applied: true });
      mismatch = true;
    } else {
      matchedSavedEntries.add(prev);
      // Same 0.5h tolerance as before this fix — Paycor quietly settles punch
      // rounding by a few minutes in the day or two after a punch, unrelated
      // to any real schedule change. A tight tolerance flags nearly every
      // employee on every day as "changed" purely from that noise.
      if (Math.abs(prev.hours - lc.hours) > 0.5) {
        corrections.push({ employee: lc.name, change: `${prev.hours.toFixed(2)}h → ${lc.hours.toFixed(2)}h`, applied: true });
        mismatch = true;
      }
    }
  });

  const preservedDrops = [];
  (savedCrew || []).forEach(sc => {
    if (matchedSavedEntries.has(sc) || isKnownExcluded(sc)) return;
    corrections.push({ employee: sc.name, change: `POSSIBLE DROP — missing from live fetch (was ${sc.hours.toFixed(2)}h saved); NOT auto-removed, needs manual review`, applied: false });
    preservedDrops.push(sc);
  });

  if (corrections.length === 0) return null;

  return {
    shouldSave: mismatch,
    nextCrew: [...(liveCrew || []), ...preservedDrops],
    corrections,
  };
}
