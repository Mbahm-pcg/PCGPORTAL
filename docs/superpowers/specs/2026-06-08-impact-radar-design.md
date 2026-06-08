# Impact / Cannibalization Radar — Design

**Date:** 2026-06-08
**Status:** Approved design — pending spec review
**Driver:** Task 3 of `docs/PCG_PORTAL_EXECUTION_PROMPT.md`
**Reference (methodology template):** `PCG/18th-street-impact-claim.md` (Mike's manual 18th-St impact claim — the exhibit this automates)

## Goal
Given an **opening event** (date + location + competitor-vs-sister), automatically reproduce the 18th-St analysis: quantify the impacted store's weekly-sales decline vs **distance-matched control stores**, show it on-screen (trend + map + comparison table), and export a **branded PDF exhibit** suitable for an Inspire/Dunkin' impact claim.

## Locked decisions
- **Store selection:** auto-rank by distance from the event; auto-suggest nearest = **impacted**, plus near/mid/far **controls**; user can override every pick.
- **Metric:** **net weekly sales only (v1)** — from `pcg_labor_store_{pc}.weekly[]`. (Guest count = noted fast-follow; needs a Pulse `getGuestChecks` pull.)
- **Windows:** **13 weeks before / through-now after**, anchored on the opening date, both counts **configurable**.
- **Output:** on-screen Radar view **+** one-click branded PDF.
- **Geocoder:** **US Census Geocoder** (free, US-wide, no key — Philly AIS is Philly-only and can't cover NJ/suburban stores). Manual lat/lng is the fallback.

## Architecture (mostly client-side + one geocode helper)
### `src/impact.mjs` (new, pure, unit-tested) — the math, isolated
- `haversineMiles({lat,lng}, {lat,lng})` → miles.
- `beforeAfter(weekly, eventDate, weeksBefore, weeksAfter)` → `{ avgBefore, avgAfter, deltaPct, annualizedLoss, weeksBeforeUsed, weeksAfterUsed, series:[{weekOf, sales, side:'before'|'after'}] }`.
  - `weekly` = a store's `weekly[]` (`{weekOf, sales}`); bucket by `weekOf` vs the event week; `avgBefore`/`avgAfter` = means; `deltaPct = (avgAfter-avgBefore)/avgBefore*100`; `annualizedLoss = (avgBefore-avgAfter)*52`. `weeksAfter` null = "through now."
- `pickControls(rankedStores, impactedPc, n=3)` → choose representative near/mid/far controls from stores outside the impacted slot.

### `netlify/functions/geocode.js` (new) — address → `{lat,lng}`
- POST `{address}` → US Census one-line geocoder (`geocoding.geo.census.gov/.../onelineaddress`), returns `{lat,lng,matched}`. CORS-gated to portal origins.
- Two uses: (a) **one-time** geocode all 45 `STORES_SEED` addresses → cache to blob **`pcg_store_coords_v1`** (`{[pc]:{lat,lng}}`); (b) geocode an event address.
- (Note: stays unauthenticated/CORS-gated now; joins portal-auth Phase C gating later.)

### `ImpactRadar` component in `app.jsx` (new tab, gated exec/IT/office like NDCP)
1. **Inputs:** event address (→geocode) or manual lat/lng; opening date; competitor|sister; editable weeksBefore (default 13) / weeksAfter (default through-now).
2. **Auto-select:** load `pcg_store_coords_v1` (geocode-and-cache on first use if absent); rank stores by `haversineMiles` from the event; suggest impacted = nearest, controls via `pickControls`; user overrides via dropdowns.
3. **Compute:** `cloudLoad('pcg_labor_store_{pc}')` for each selected store → `beforeAfter(...)`.
4. **Visuals:**
   - Chart.js **trend line** — impacted + controls, with an opening-date marker.
   - Leaflet **map** — event pin, trade-area radius (default 1.0 mi, editable), store markers colored by %Δ severity.
   - **Control-comparison table** — store · distance(mi) · before $/wk · after $/wk · %Δ (matches the claim).
   - Headline KPIs — impacted %Δ, annualized $ loss, "X× worse than nearest control."
5. **📄 Generate PDF exhibit** (jsPDF) — branded, mirroring the 18th-St package sections: header/site IDs, documented sales impact table, control comparison, weekly-sales-trend table.

## Data flow
```
STORES_SEED addresses → geocode.js (once) → pcg_store_coords_v1
event address → geocode.js → {lat,lng}
selected stores' pcg_labor_store_{pc}.weekly[] → impact.mjs(beforeAfter) → ImpactRadar view + jsPDF exhibit
```

## Testing
- `haversineMiles` — assert known pairs (e.g. two coords ~0.4 mi apart) within tolerance.
- `beforeAfter` — (1) a controlled fixture with hand-computed avgBefore/after/deltaPct/annualizedLoss; (2) the **real 18th-St weekly series** (from the claim doc) with event week `2025-12-28` → assert `deltaPct ≈ -28.9%` and `annualizedLoss ≈ $429k` within tolerance (proves the engine reproduces the manual analysis before any UI).
- `pickControls` — given ranked stores, returns the impacted-excluded near/mid/far spread.

## Guardrails
- Stores with insufficient weekly history (< weeksBefore) → flagged, excluded from auto-control picks.
- Event geocode failure → fall back to manual lat/lng entry (don't block).
- Net-sales-only v1; guest count is a labeled fast-follow.
- Coords cache built once and reused; a "re-geocode stores" admin action refreshes it.
- Distances are estimates (geocoded centroids) — PDF notes the data source (Pulse net sales) like the claim does.

## File touch list
- New: `src/impact.mjs` (+ `src/impact.test.mjs`); `netlify/functions/geocode.js`.
- Edit: `app.jsx` — `ImpactRadar` component + new tab registration + gating + version bump; `index.html` already loads Leaflet/Chart.js/jsPDF (verify).

## Confirm on review
1. Control auto-pick = near/mid/far trio (override-able) — OK, or a different default count/spread?
2. Default trade-area radius 1.0 mi — OK?
3. PDF mirrors the 18th-St claim sections — OK, or a leaner one-pager?
