# Pulse Main Grid — Daily / Week Toggle — Design

**Date:** 2026-06-09
**Status:** Approved design — pending spec review
**Component:** `AdminPulse` in `app.jsx` (the main Pulse page: network → district → store grid)

## Goal
Add a **Daily | Week** toggle to the main Pulse grid so each **district and store** tile can show either today's net sales/guests (default) or the **week-to-date (Sun→today)** totals.

## Locked decisions
- **"Week" = week-to-date (WTD), Sun→today** — the running total for the current week so far, matching the convention `getWeekDates(busDt)` already uses (Sunday start, no future days).
- **Scope:** both **district** rollups and **store** tiles.
- **Metrics that switch:** **net sales _and_ guests** (the two headline numbers on the tiles).
- **Default:** Daily.
- **Consistency:** WTD is the **sum of the same Pulse daily numbers** the grid shows in Daily mode (sum of `fetchDate` results across the week's days) — not labor-blob-derived — so Daily and Week reconcile exactly.
- **Lazy:** no extra fetching until the user first switches to Week (or refreshes while in Week mode).
- **Session-only UI state:** no new persisted settings; detail views (which already have their own day/week toggle) are untouched.

## Existing machinery reused (in `AdminPulse`, `app.jsx`)
- `fetchDate(date, batchSize, onProg)` → `{ [pc]: { status:'ok'|'error', data:{netSales,guests,voids,discounts}, rcs } }` — fetches **all active stores** for one date (batched, with progress). This is the per-store/per-date source.
- `loadAll()` → fetches `busDt`, fills `storeData` (the per-store data the grid renders in Daily mode), and caches the network aggregate in `dateCache`.
- `getWeekDates(busDt)` → `[ISO dates]` Sunday→today (never future).
- `aggResults(results)` / `sumRVC(...)` → aggregation helpers.
- `activePCs` → active store PCs (DM-scoped when a DM is viewing).
- Grid render reads `storeData[pc].data.netSales` / `.guests`; district rollups sum their member stores.

> Note: the existing `loadWTD()` computes **network-level** WTD aggregates for the KPI cards only — it does **not** retain per-store sums. The new work adds a **per-store/per-district** WTD map for the tiles.

## Architecture (all within `AdminPulse`)

### New state
- `viewMode: 'day' | 'week'` — default `'day'`.
- `weekStoreData: { [pc]: {netSales, guests, voids, discounts} }` — per-store WTD sums (null/empty until loaded).
- `weekLoading: boolean` — drives the existing progress affordance while WTD loads.
- `dayStoreCache: { [date]: { [pc]: {data...} } }` — memoizes per-date per-store `fetchDate` results so re-toggling and auto-refresh don't re-fetch already-loaded days.

### New function: `loadWeekGrid()`
1. `const dates = getWeekDates(busDt)`.
2. For each `date`:
   - Today's slice (`busDt`): reuse the already-loaded `storeData` (seed `dayStoreCache[busDt]` from it).
   - Else: use `dayStoreCache[date]` if present; otherwise `await fetchDate(date, 8)` and store in `dayStoreCache`.
3. Sum each active store's `data.netSales`/`.guests`/`.voids`/`.discounts` across the week's dates → `weekStoreData`.
4. Set `weekLoading` around the loop; reuse the existing progress bar pattern.

### Toggle UI
- A small segmented control **`Daily | Week`** placed in the existing Pulse controls row (near the date picker / refresh / auto-refresh controls), defaulting to `Daily`, with a sublabel "Week = WTD (Sun→today)".
- Switching to `Week`: set `viewMode='week'`; if `weekStoreData` is empty for the current week, call `loadWeekGrid()`.
- Switching to `Day`: set `viewMode='day'` (instant; no fetch).

### Render changes (district + store tiles)
- A single accessor decides the source: `const tileMetrics = (pc) => viewMode === 'week' ? (weekStoreData[pc] || ZERO) : (storeData[pc]?.data || ZERO)`.
- **Store tile:** render `tileMetrics(pc).netSales` and `.guests` instead of reading `storeData` directly.
- **District tile:** sum `tileMetrics(pc)` over the district's member stores (same rollup logic, swapped source).
- Tile layout, coloring, and click-through are unchanged. A small "WTD · {n}d" caption appears on tiles in Week mode (n = `getWeekDates(busDt).length`).

### Refresh / auto-refresh
- `loadAll()` (Daily) is unchanged.
- While `viewMode === 'week'`: after a refresh of today's slice, invalidate `dayStoreCache[busDt]` (today moves), re-seed it from the fresh `storeData`, and re-run the per-store sum so the WTD tiles update with today's latest.
- Changing `busDt` to a different week resets `weekStoreData` (week changed) so it recomputes on next Week view.

## Data flow
```
viewMode=day  → storeData (busDt)                         → tiles
viewMode=week → getWeekDates(busDt) → fetchDate(each)      → dayStoreCache
              → sum per pc                                 → weekStoreData → tiles
              (busDt slice reused from storeData; only prior days fetched)
```

## Performance
- Daily mode: zero change.
- First Week toggle: fetches the week's **prior** days for active stores (today already loaded). Worst case (Saturday, full network) ≈ 6 days × `activePCs`, batched by `fetchDate` (batch 8) with the existing progress bar. Cached after, so re-toggling and day-detail navigation are instant. DM users only pay for their district's stores (`activePCs` is already DM-scoped).

## Testing
- This is in-component React UI over a live Pulse API; the repo unit-tests pure modules, not `AdminPulse`. Verification is manual smoke on a preview/prod build:
  - Daily mode unchanged (tiles = today's net sales + guests).
  - Toggle Week → tiles show WTD net sales + guests; a store's Week value equals the sum of that store's daily values across the days seen when stepping through the week in Daily mode (spot-check one store).
  - District Week tile = sum of its stores' Week values.
  - Toggling back to Day is instant; auto-refresh in Week mode updates today's contribution.
  - DM view only loads/sums the DM's district.

## Guardrails
- Stores returning `status:'error'` for a day contribute 0 for that day (consistent with Daily-mode handling) and don't break the sum.
- No future dates fetched (`getWeekDates` already excludes them).
- Toggle and caches are session state — a page reload starts in Daily with caches cleared (acceptable; matches "default daily").

## File touch list
- Edit: `app.jsx` — `AdminPulse`: add `viewMode`/`weekStoreData`/`weekLoading`/`dayStoreCache` state, `loadWeekGrid()`, the toggle control, and the tile/district source switch; version bump.

## Confirm on review
1. Toggle label `Daily | Week` with "WTD (Sun→today)" sublabel — OK, or different wording?
2. Week-mode tile caption "WTD · {n}d" — keep, or omit?
3. Net sales + guests both switch (locked) — anything else on the tile should follow the toggle, or just those two?
