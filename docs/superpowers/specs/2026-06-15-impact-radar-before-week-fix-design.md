# Impact Radar — "before-week sales not pulling" fix — Design

**Date:** 2026-06-15
**Status:** Root cause confirmed; approach approved (inline fetch); pending implementation plan
**Component:** `ImpactRadar` (app.jsx ~24548) + `src/impact.mjs`

## Symptom
Impact Radar shows `0/13 ⚠` weeks-before and `avgBefore = $0` for the impacted store; after-week sales compute fine. Confirmed by user 2026-06-15 with the default event date **2025-12-28**.

## Root cause (confirmed)
`ImpactRadar.compute()` builds each store's `weekly` series from ONE of two cached sources, chosen by total week count (app.jsx ~24579):
```js
const useCard = cardWeekly.length > laborWeekly.length;
const weekly  = useCard ? cardWeekly : laborWeekly;
```
- `laborWeekly` (`pcg_labor_store_{pc}`) is capped at ~13 recent weeks by labor-cron → with "today" = June 2026, all weeks are AFTER 2025-12-28.
- `cardWeekly` (uploaded scorecard `pcg_sales_v1`) does not extend back into 2025.

So `beforeAfter()` (which is itself correct) finds zero weeks with `weekOf <= eventDate` → `weeksBeforeUsed = 0`, `avgBefore = 0`.

Secondary bug: choosing the source by *total length* can discard a shorter-but-deeper scorecard that actually covers the before-window.

## Fix — two parts

### 1. Merge sources (pure, in `src/impact.mjs`)
Add `mergeWeekly(a, b)`: union of two `{weekOf,sales}[]` series, dedup by `weekOf` (prefer scorecard on conflict — it's the reported figure), sorted ascending. Replace the `useCard ? ... : ...` pick with `mergeWeekly(cardWeekly, laborWeekly)`. Necessary for correctness; alone it will NOT create 2025 weeks if neither source has them.

### 2. Inline Pulse backfill for the missing before-window
After merging, if the series lacks the requested before-window (the `weeksBefore` Sunday-weeks ending at `eventDate`):
- Compute the set of **missing weeks** (Sunday starts) between `eventDate - weeksBefore` and `eventDate` not already present.
- For each missing week, fetch its 7 daily `getOperationsDailyTotals` from Pulse **inline from the browser** (reuse the `fetchEndpoint`/`fetchOpsTotals` pattern at app.jsx ~6285/6519; route `p227` for Willits `345986`, else `p228`), sum `netSlsTtl` across revenue centers per day, then sum days → that week's net sales.
- Aggregate via a new pure helper `dailyToWeekly(dailyRows)` in `impact.mjs` (`{busDt, netSales}[]` → `{weekOf, sales}[]`, Sunday-start weeks, drop partial/zero weeks).
- `mergeWeekly` the fetched weeks into the series, then run `beforeAfter`.
- Applies to the impacted store **and the 3 controls** (user chose full inline fetch, not impacted-only).

**Volume/perf:** ~13 weeks × 7 days × 4 stores ≈ 360 daily calls. Fire in bounded-concurrency batches from the browser with a progress status ("Backfilling pre-event sales… 120/360"). Cache fetched weeks in-memory for the session so re-Compute doesn't refetch.

## Edge cases
- Pulse returns no data for a 2025 date (store not yet open, e.g. 18th St) → that week is simply absent; `weeksBeforeUsed` reflects what exists, ⚠ still shown if < weeksBefore. Don't fabricate zeros.
- Network/timeout on some days → fail soft per-day; week computed from whatever days returned only if all 7 present (else drop, to avoid understating a partial week).
- Respect existing source when it already covers a week (don't refetch).

## Verification
Must be verified against **live Pulse** in the deployed portal (no local Pulse access): pick a control store open since 2025, confirm `weeksBeforeUsed` rises toward 13 and `avgBefore` populates with plausible weekly net sales.

## Out of scope
- Server-side/background backfill + persistent cache (considered; user chose inline). Revisit if inline proves too slow/rate-limited.
- Changing `beforeAfter` math (it's correct).
