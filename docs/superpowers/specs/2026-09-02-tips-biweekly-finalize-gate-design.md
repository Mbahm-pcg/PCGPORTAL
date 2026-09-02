# Tips Biweekly Finalize Gate — Design Spec

## Goal

Make it structurally hard for an employee's tips to be silently missed
when their Paycor punches are entered or corrected after the nightly
tips snapshot has already run — without building an automatic send to
Paycor (that stays fully manual, and is separately blocked on Paycor's
Trackforce/Integration Payroll Time Partner entitlement issue).

The trigger for this work: over the course of one day (2026-09-02),
seven real employees' tips across five stores had to be found and
patched by hand — each one confirmed as real Paycor punches that never
made it into that day's saved snapshot. Manually re-verifying an entire
14-day pay period, store by store, from screenshots is not sustainable
and is itself an audit risk (a missed employee reads as underpayment).

## Background — three distinct root causes found this session

1. **Late entry.** A manager or the accounting team enters/corrects an
   employee's Paycor time after the day's snapshot already ran (the
   large majority of today's cases: Prakash Patel, Jollyben Patel,
   Mohammadi Barhanudin's schedule-entry cases, Merfat Salama, Usama
   Hassan, Brajbala Mehta).
2. **Overnight-shift timing gap.** A shift crossing midnight (e.g.
   Mohammadi Barhanudin's 9:58pm–6:01am shift) may not have a punch-out
   recorded yet at the nightly pull's ~3am ET run time, so it's
   genuinely absent from Paycor at fetch time, not merely un-fetched.
3. **Empty crew.** A store's Pulse tip pool has money but Paycor punches
   show nobody working that day (e.g. Grant's, three separate days,
   confirmed genuinely crew-less even on live re-check).

Paycor's API exposes no way to distinguish "just inserted" from "always
there" on a punch record — every punch record checked this session
(both `/punches` and the per-employee `/employeePunches` timecard) shows
identical status fields regardless of known insert timing. The only way
to detect any of these three causes is to re-fetch and diff against what
was last saved.

## Current state — what already exists

This session found three pieces of existing, already-shipped
infrastructure that were not previously connected to this problem:

- **`tips-report-cron-background.mjs`** (nightly, 3am ET): builds each
  day's snapshot from Pulse (`tipPool`) + Paycor (`crew`, via
  `fetchStoreCrew`), retries transient fetch failures same-run, and
  saves to `pcg_tips_snapshot_{busDt}`. Already computes
  `isBiweekBoundary(busDt)` — true on the Tuesday 3 days after a
  biweekly period's Saturday close — and already fires the "biweekly
  (payroll)" rollup report on that exact day, explicitly because
  "payroll locks Tuesday night."
- **`tips-report-morning-sweep-background.mjs`** (7am ET): retries only
  stores left `crewStatus: 'error'` from the prior night — a real fetch
  failure, not a stale-but-successful fetch.
- **`tips-reconcile-cron.mjs`** (9am ET, `runReconcile(daysBack=3)`):
  re-fetches live Paycor crew for the last 3 already-`ok` days per
  store, diffs person-by-person against the saved snapshot (matched by
  guid → payrollId → name, with a 0.5h tolerance for Paycor's own punch
  rounding), auto-applies additions/hour-changes, and emails a summary.
  Has a real safety behavior: if any saved crew member looks dropped
  entirely, it withholds **every** correction for that store/day
  (not just the ambiguous one) and flags it "NOT APPLIED — needs manual
  review," rather than risk silently deleting someone's real pay.
- **`tips-reconcile-refresh-background.mjs`**: an on-demand version of
  the same function with a default 14-day lookback and an optional
  single-store scope — built for exactly this kind of manual trace-back,
  but nothing calls it automatically today.

## Gap analysis — why today's mess still happened

- `tips-reconcile-cron.mjs` only looks back **3 days**. Every correction
  made today traced back to the start of a 14-day pay period —
  discovered on the period's last day, 17 days after the earliest one
  (8/16). Three days of lookback cannot reach that.
- Its withhold-on-any-drop safety means a store/day with one legitimate
  addition alongside one ambiguous "looks dropped" name gets **fully
  withheld**, with the only visibility being a daily email — nobody was
  reliably reviewing that inbox for a "NOT APPLIED" case.
- Nothing marks a store's period as ever actually settled. The biweekly
  payroll rollup already fires on the right day (the Tuesday
  `isBiweekBoundary` trigger) but just reads whatever the last-saved
  snapshots say — it has no concept of "don't trust this data yet,
  something's still unresolved."
- Genuine fetch failures (`crewStatus: 'error'`) are explicitly skipped
  by the reconcile diff (`if (!saved || saved.crewStatus !== 'ok') continue;`)
  — by design, since a bad live re-fetch shouldn't overwrite good saved
  data — but that also means a day still stuck in `'error'` by the
  biweekly boundary is never retried by this path at all.

## Design

### 1. Full-period reconcile on the biweekly boundary

On the same Tuesday `isBiweekBoundary(busDt)` already fires the
biweekly rollup, **before** building that rollup, run a full-period
version of the existing reconcile — reusing `runReconcile` from
`tips-reconcile-cron.mjs` unchanged, called with `daysBack` covering the
full 14-day period that just closed (computed from the same
`weekEndForTrigger`/`dateRangeEndingAt` helpers the rollup itself
already uses), instead of the daily job's hardcoded 3.

### 2. Retry-until-clean, bounded

`runReconcile` deliberately skips any day whose saved snapshot is
already `crewStatus: 'error'` (`if (!saved || saved.crewStatus !== 'ok') continue;`)
— it only diffs days that already succeeded, by design, so a bad live
re-fetch can never overwrite good saved data. That means reusing it
as-is would never heal a day still stuck in outright error; only
stale-but-successful days. The full-period settle needs both halves:

- For every day in the period still `crewStatus: 'error'`, first run
  the same retry `fetchStoreCrew` already used by
  `tips-report-morning-sweep-background.mjs`, so an error day gets a
  chance to become `'ok'` before anything tries to diff it.
- Then run the full-period `runReconcile` diff pass over the (now
  hopefully larger set of) `'ok'` days.

Wrap both halves in the same bounded multi-pass pattern the morning
sweep already uses (a fixed pass count, time-boxed to fit the 15-minute
background budget) so a transient live-fetch hiccup gets a few more
chances before being reported as genuinely stuck — not one shot and
done.

### 3. A real "finalized" record, not just an email

After the full-period pass (and its retries) completes, compute and
save a per-store finalized status for that period: a store is
`finalized: true` only if every day in the period is `crewStatus: 'ok'`,
is not the zero-eligible-crew-with-tips case, and was not withheld by
the reconcile's drop-safety check. Anything else leaves that store
`finalized: false` with the specific unresolved day(s) and reason
recorded.

New blob: `pcg_tips_period_status_{periodStart}` (same `periodStart`
the biweekly rollup already computes), shape:

```json
{
  "302642": { "finalized": true, "unresolvedDays": [], "lastCheckedAt": "2026-09-15T23:10:00Z" },
  "310382": { "finalized": false, "unresolvedDays": [{"busDt": "2026-08-24", "reason": "zero-eligible-crew-with-tips"}], "lastCheckedAt": "2026-09-15T23:10:00Z" }
}
```

### 4. Notification

Extend the existing correction email (reuse its sending path) with a
clear "period finalize status" section on biweekly-boundary runs:
every store still `finalized: false` and why, sent the same Tuesday
night — proactive, rather than waiting for someone to notice a mismatch
in a screenshot days later.

### 5. Genuinely stuck cases

A store that's still not finalized after the bounded retries (e.g. a
real Grant's-style empty-crew day) stays flagged, visibly, in that
email — same as Grant's today, except surfaced automatically instead of
requiring you to spot and ask about it.

## Non-goals

- **No automatic send to Paycor.** Stays fully manual regardless of
  finalize status — separately blocked on the Paycor
  Trackforce/Integration Payroll Time Partner entitlement issue, and
  the manual send remains the last human checkpoint either way.
- No change to the manual-exclusion mechanism, the manager-exclusion
  regex, or the per-day tip-split math — all stay exactly as-is.
- Not shortening or replacing the existing 3-day daily reconcile — this
  adds a period-wide pass on top of it, on top of the existing
  infrastructure, not instead of it.
- No new Netlify function. This site's total env-var size already sits
  near AWS Lambda's 4KB-per-function cap (documented directly in
  `tips-report-cron-background.mjs`'s own header comment) — every
  function gets the full env injected, so adding a new function is
  avoided. This design only adds code to the existing
  `tips-report-cron-background.mjs` (to call the full-period reconcile
  before building the biweekly rollup) and `tips-reconcile-cron.mjs`
  (to export the retry-wrapped, finalize-computing version of
  `runReconcile` for reuse).

## Testing plan

- Unit-test the finalize-status computation against constructed
  snapshot fixtures covering all four states: clean, `crewStatus:
  'error'`, zero-eligible-crew-with-tips, and reconcile-withheld.
- Unit-test the bounded retry loop against a fake `fetchStoreCrew` that
  fails N times then succeeds, confirming it stops retrying a
  genuinely-stuck store after its pass budget instead of looping
  forever.
- This session's own 8/16–8/29 period is already fully hand-corrected,
  so it won't demonstrate a fresh catch — validate instead against the
  next real biweekly boundary (the Tuesday closing the next pay
  period) by comparing its automatic finalize output against a manual
  spot-check of a few stores.

## Rollout

Deploy directly (no feature-flag convention in this codebase). Monitor
the next real biweekly-boundary run's finalize email and logs to
confirm behavior before relying on it as the sole check.
