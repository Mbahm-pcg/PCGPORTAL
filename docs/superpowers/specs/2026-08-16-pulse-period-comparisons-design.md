# Pulse Sales — Period-over-Period Comparisons

**Date:** 2026-08-16
**Branch:** `feature/pulse-period-comparisons` (from `a4b6f54`, v19.98)
**Status:** Design — approved for planning

## Goal

Add prior-period comparisons to the Pulse sales KPI summary so a reader can tell at a
glance whether the business is up or down, at every level of drill-down.

- **Day view:** vs same day last week (LW), vs same day last year (LY)
- **Week view:** vs prior week (PW), vs same week last year (SW LY)
- **Levels:** network → district → individual store

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Metrics carrying comparisons | Net Sales + Guests only |
| 2 | Display format | Indented comparison sub-rows |
| 3 | Partial-week alignment | Day-matched (same elapsed weekdays) |
| 4 | Data approach | Client-side, reusing existing fetch plumbing |
| 5 | Intraday (today is partial) | Curve-scaled estimate, both periods, labeled |
| 6 | Stores missing prior data | Same-store basis, with comparable count footnote |

## Background — what already exists

`AdminPulse` (`app.jsx:11796`) already fetches last year's same week via `loadLYWeek()`
(`app.jsx:11998`) to drive the "Weekly Forecast (LY + 2%)" column. The LY convention is
**busDt − 364 days** (52 exact weeks), which preserves day-of-week alignment.

Three caches exist in `AdminPulse`:

| Cache | Shape | Use |
|---|---|---|
| `dateCache` | `date → network aggregate` | WTD totals |
| `dayStoreCache` | `date → {pc → data}` | Per-store week grid |
| `lyCache` | `date → network aggregate` | Weekly forecast |

`dayStoreCache` is the important one: because it is per-store, any date fetched once at
network level can be re-summed for any district or single store with no further API calls.

### Problems in the current code this design corrects

1. **The LY week is fetched three times.** `AdminPulse.loadLYWeek()` fetches it for all
   stores; `DistrictDetail` refetches it (`app.jsx:10826`); `StoreDetail` refetches it again
   via per-store `fetchEndpoint` calls (`app.jsx:9016`). Drilling network → district → store
   re-requests the same immutable data at every hop.
2. **LY data is evicted from localStorage first.** `writePulseDayCache` (`app.jsx:7911`)
   caps the cache at 30 days and evicts lexicographically-oldest keys. `2025-…` dates always
   sort before `2026-…` dates, so LY is permanently first out. The existing forecast bars
   silently re-fetch LY on every visit.
3. **The 364-day rule is duplicated** in at least three places, with `StoreDetail` even
   redeclaring a local `localDateStr` that shadows the module-level one (`app.jsx:8985`).

## Architecture

### New module: `src/pulse-comparison.mjs`

A pure, dependency-free module — no I/O, no React. Lives in `src/` alongside the existing
`src/pos-negative-shared.mjs` and `src/portal-auth.mjs`, and is covered by the existing
`node --test` glob (`src/*.test.mjs`) with no tooling changes.

```js
export const LY_OFFSET_DAYS = 364;

// Which dates make up the current period and each comparison period.
// viewMode: 'day' | 'week'
// Day  → current:[busDt],            lw:[busDt-7],       ly:[busDt-364]
// Week → current:[Sun..busDt],       lw: each -7,        ly: each -364
export function comparisonDates(busDt, viewMode)
  // → { current: string[], lw: string[], ly: string[] }

// Fraction of a typical day's sales complete by `throughHour` for a given
// day-of-week. `hourlyHistories` is the array of pcg_hourly_history_{pc} blobs
// for the stores currently in scope (network = all, district = that district's,
// store = one) — the curve is blended across exactly the stores being compared,
// so a district's curve reflects that district. Returns null when there is not
// enough history to be trustworthy.
export function dayCompletionFraction(hourlyHistories, dow, throughHour)
  // → number | null

// Sum a date set on a same-store basis. Any pc missing data in EITHER the
// current or prior set is excluded from BOTH sides. Called once per comparison
// period — i.e. twice per view (LW and LY), each against the same current set.
export function comparableTotals(dayStoreCache, currentDates, priorDates, pcs)
  // → { current: {netSales, guests}, prior: {netSales, guests},
  //     comparablePcs: string[], excludedPcs: string[] }

// Percent change. Returns null when prior is 0 or absent — never Infinity/NaN.
export function delta(current, prior) // → number | null
```

This module is the single source of truth for the 364-day rule and the same-store rule.

### Data flow

```
AdminPulse.loadComparisons()          ← runs AFTER loadAll() resolves
   └─ fetchDate(d) for missing lw/ly dates ──► dayStoreCache[date][pc]
                                                     │
              ┌──────────────────────────────────────┼──────────────────────────┐
              ▼                                      ▼                          ▼
        Network totals                        DistrictDetail               StoreDetail
     (comparableTotals over                (same call, district's       (same call, one pc)
        all activePCs)                          PCs)
        0 extra calls                        0 extra calls               0 extra calls
```

`loadComparisons()` runs after the main grid resolves, so first paint is unchanged and
comparison rows fill in progressively — the same pattern `loadWTD()` already uses.

`DistrictDetail` and `StoreDetail` receive `dayStoreCache` and the comparison date set as
props and drop their own duplicate LY fetching.

### Standalone StoreDetail

`StoreDetail` has a second call site at `app.jsx:8224` (`standalone`, `storeData={{}}`) used
by manager mobile, where no parent cache exists. That path keeps its own `fetchEndpoint`
fetching but calls the **same** `comparisonDates()` helper, so the definition of "last week"
and "last year" cannot drift between the two views. Only the fetch mechanism differs.

### Cache fix

LY dates move to a separate localStorage bucket that the 30-day pruner in
`writePulseDayCache` does not touch. LY data is immutable — a closed business day from last
year never changes — so it is safe to retain indefinitely. This also removes redundant
re-fetching from the existing forecast bars.

## Intraday handling (decision 5)

When `busDt` is today, today's figure is partial while the prior periods are complete days.
Comparing directly would read roughly −75% every morning.

**Approach:** derive the fraction of a typical day complete by the current hour, from the
cached `pcg_hourly_history_{pc}` blobs for the same day-of-week, then apply that fraction to
the prior periods' **net sales** daily totals.

```
Wednesday 11:00am, today so far: $12,400
Hourly cache: Wednesdays are 26% complete by 11am

LW Wed  $47,800 × 26% = $12,428   ▼ 0.2%
LY Wed  $44,400 × 26% = $11,544   ▲ 7.4%
```

**Why scale rather than measure directly:** the hourly history only retains 90 days
(`pulse-hourly-snapshot.mjs:88`), so LY hourly data does not exist. It also stores
*guest-check totals, which include tax* — these run a few percent above the Net Sales shown
in the KPI table (`analyst-lib/analyst-data.mjs:561`). Using hourly figures directly against
Net Sales would introduce a systematic false-positive delta every day. Scaling uses hourly
history only for the *shape* of the day and keeps Net Sales as the single metric throughout.

**This is an estimate and must be labeled as one** — sub-rows read `vs LW (est. to 11am)`.
It assumes last year's intraday curve resembles the recent same-weekday curve, which is
reasonable for a morning-weighted QSR but is modeled, not measured.

**Fallback:** when `dayCompletionFraction` returns null (insufficient history), the sub-rows
show `—` rather than an unlabeled guess.

Past dates are unaffected — they use full-day measured totals with no scaling.

**Week view uses the same rule.** WTD includes today, so the final day of the range is
partial there too. Within a week comparison, completed days compare full-day-to-full-day and
only the final (current) day is curve-scaled on the prior side. The `(est.)` label therefore
also applies to `vs PW` / `vs SW LY` whenever `busDt` is today, and disappears once the day
closes or a past week is selected.

**Order of operations:** same-store filtering happens first, then curve scaling is applied to
the prior-period totals of the surviving stores. Scaling a total that still contains
non-comparable stores would corrupt both adjustments.

## Same-store basis (decision 6)

Any store missing data in either the current or prior period is excluded from **both** sides
of the comparison. Hatboro (`pc 365953`, added 2026-07-30) is the live case: it relocated and
has no last-year history, so including it would add its entire volume to the "growth" side.

Network and district comparison rows carry a footnote: `† 45 of 46 stores comparable`. The
footnote appears only when at least one store is excluded.

Store-level comparison is unaffected — a single store either has prior data or shows `—`.

## Rendering

Comparison sub-rows are added beneath `Today` and `WTD` in the existing KPI table
(`app.jsx:12370`), spanning only the Net Sales and Guests columns. Avg Check, Discounts,
Void Rate, Weekly Forecast and Pace cells stay empty on comparison rows.

```
                Net Sales          Guests
 Today           $48,231          12,455
   vs LW         $46,890  ▲2.9%   12,201  ▲2.1%
   vs LY         $44,120  ▲9.3%   11,880  ▲4.8%
```

Delta colors follow the existing convention: `#69db7c` positive, `#ff6b6b` negative,
matching the Pace cell at `app.jsx:12405`.

Week view uses the labels `vs PW` and `vs SW LY` over the day-matched elapsed range.

## Edge cases

| Case | Behavior |
|---|---|
| Prior data still loading | `…` in the delta cell; row visible so the table does not jump |
| Prior period total = 0 | `—`; `delta()` returns null rather than dividing |
| Some stores errored in prior fetch | Excluded on the same-store rule; footnote count reflects it |
| Prior fetch fails entirely | Sub-rows omitted. `Today`/`WTD` rows are never affected |
| Insufficient hourly history | Intraday scaling disabled; sub-rows show `—` |
| Week containing Jan 1 | `comparisonDates` operates on absolute dates; year boundaries need no special handling |
| DST transitions | All dates anchored at `T12:00:00`, following existing convention |

A comparison failure must never degrade the primary Today/WTD figures.

## Testing

`src/pulse-comparison.test.mjs`, run by the existing `npm test`:

- `comparisonDates` — day mode and week mode; LY lands on the same weekday; week mode
  returns only elapsed days, not all 7; a week spanning a year boundary
- `dayCompletionFraction` — known hourly history yields the expected fraction; returns null
  on insufficient history; unknown day-of-week
- `comparableTotals` — a store missing prior data is excluded from **both** sides; excluded
  list is accurate; all-stores-missing yields empty rather than throwing
- `delta` — normal case; prior 0 → null; prior absent → null; negative movement
- Week view + today — only the final day of the prior range is scaled; completed days are
  compared at full value; selecting a past week applies no scaling at all

Manual verification: network → district → store drill-down shows consistent figures for the
same store, and the browser network tab confirms no additional Pulse calls fire on drill-down.

## Out of scope

- Comparisons on Avg Check, Discounts, Void Rate
- Month-over-month or year-to-date comparisons
- Server-side pre-caching (Approach B/C) — revisit only if client-side proves slow
- Changing the existing Weekly Forecast or Pace columns
- Backfilling hourly history beyond its 90-day retention

## Files touched

| File | Change |
|---|---|
| `src/pulse-comparison.mjs` | New — pure helpers |
| `src/pulse-comparison.test.mjs` | New — unit tests |
| `app.jsx` — `AdminPulse` | `loadComparisons()`, comparison sub-rows, pass caches down |
| `app.jsx` — `DistrictDetail` | Consume shared cache; drop duplicate LY fetch |
| `app.jsx` — `StoreDetail` | Consume shared cache; drop duplicate LY fetch; standalone fallback |
| `app.jsx` — `writePulseDayCache` | Separate LY bucket, exempt from 30-day pruning |
| `app.jsx` — `APP_VERSION` | Bump |

Per the repo workflow: edit `app.jsx` → `npm run build` → bump `APP_VERSION` → commit both
`app.jsx` and `app.js` → `npx netlify deploy --prod`.
