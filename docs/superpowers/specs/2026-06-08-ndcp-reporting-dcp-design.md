# NDCP Reporting + DCP% Scorecard — Design

**Date:** 2026-06-08
**Status:** Approved — all parameters confirmed (ready for implementation plan)
**Author:** Mike + Claude (brainstorming)

## Goal
Turn the existing `ndcp_orders` Postgres table into operational reporting:
- Pick a **date range**; roll spend up **by week** (Sun–Sat).
- **Separate by district** (showing the **District Manager** name) and by **store** (showing the **real store name**, resolved from `pc`).
- A new **NDCP analysis** view: weekly spend trend, category breakdown, and **DCP% over time**.
- Surface **weekly DCP%** on the **DM Scorecard**, folded into the composite at a **20% weight**, scored against the company DCP budget.

## Locked decisions
- **DCP% = Σ `total_order` ÷ Σ net Pulse sales** for the period, per store, rolled to district. (`total_order` = full NDCP invoice — what's paid DCP.)
- **Weekly buckets keyed by `date_ordered`, weeks Sun–Sat** (aligns with Pulse sales weeks).
- **Account→store join is the identity function: `ndcp_orders.account == store.pc`.** Verified 2026-06-08: all **45 NDCP accounts === all 45 `STORES_SEED.pc`** (0 mismatches). No hand-built mapping table required.
- **DCP budget = 19.5%** (per the DM weekly report's `Weekly Goals`), referred to operationally as ~20%.
- **Default date range:** last **13 weeks**.
- **DCP% in the DM Scorecard composite at 20% weight** (see reweight below).
- Built as **one spec, 3 phases**, each independently deployable.

## Current state (what exists today)
- **Storage:** `ndcp_orders` (Neon Postgres), 26 columns, indexed on `order_number` and `email_date`. Defined in `netlify/functions/ndcp-lib/ndcp-ingest.js:42–73`. Key fields: `account`, `store_name` (billing legal entity), `order_number`, `email_type`, `email_date`, `date_ordered`, `total_order`, `item_subtotal`, `category_subtotals` (JSONB), `line_items` (JSONB).
- **Read API:** `netlify/functions/ndcp.js` — `POST`, CORS-gated to the two portal origins, unauthenticated. Actions: `list` (all orders) and `detail` (version history). No date filtering, no aggregation.
- **UI:** `AdminNdcp` (app.jsx ~24038–24351), gated to exec/IT/office. Text search + store dropdown; no date-range picker, no weekly/district grouping.
- **Store config:** `STORES_SEED` (app.jsx:2748–2795) — per store `pc`, `paycor`, `legal`, `name`, `district`, `dmName`, … `DISTRICTS_SEED` (app.jsx:2796–2805) maps district# → DM `{name,email}` (current DMs: D1 Taylor, D2 Jay, D3 Sonia, D4 Yolicet, D5 Shreyes/Sunny, D6 Mohamed, D7 Sharmin, D8 Mike). Store config is duplicated (minimal `pc/name/district`) into ~8 netlify functions.
- **DM Scorecard:** `DmScorecardTab` (app.jsx:19196), data from blob `pcg_dm_scorecard`, computed weekly by `analyst-cron.js → computeAndSaveDMScores` (~96–199). Metrics Labor / Sales / Response / Tickets; composite Labor 30 / Sales 30 / Response 20 / Tickets 20; rolling 13-week history.
- **Sales source for DCP%:** Pulse net sales per store per day/week in blob `pcg_labor_store_{pc}` and network `pcg_labor_v1` (written by `labor-cron.js`).

## Reference: the DM weekly report Excel
`23. DM Weekly reports 05.31-06.06_Draft.xlsx` is the hand-maintained source of truth. Relevant facts extracted:
- `Weekly Goals`: **DCP budget 19.5%** (with Bakery 6.5%, Labor 23%, Total 49%).
- `Weekly Scorecard` (current week 05/31–06/06): computes per-store **DCP% = DCP $ ÷ sales** (col L). Real values run ~17–21% (e.g. Wadsworth 20.85%, N Front St 19.63%, District 2 ~18%).
- Store IDs in the report ("PC #") equal the NDCP account numbers — confirming the identity join.
- **No explicit red/yellow/good DCP cutoffs exist in the file** — the colored cells on the `DCP ScoreCard` tab are per-district row banding; the only conditional formatting is on Total Cost % and Labor %. DCP is judged against the 19.5% budget. (The `DCP ScoreCard`/`DCP Cost` tabs also carry stale DM names from an older week — ignore them; use the portal's current `DISTRICTS_SEED`.)
- The portal's NDCP "Analysis" view and the DM Scorecard DCP% can reproduce this report's DCP section natively.

## Architecture decision — where DCP% is computed
NDCP spend is in Postgres; Pulse sales are in Netlify Blobs. **Chosen:** one **pure DCP helper** `dcpPct(spend, sales) → number | null` (null when sales missing/zero), called in both consumers that already hold the inputs — the scorecard cron (has weekly sales) and the analysis view (pulls sales from `pcg_labor_v1`). Rejected: a mega `ndcp-analytics.js` endpoint that reads labor blobs itself (couples NDCP to labor internals).

---

## Phase 1 — Enriched read API (no mapping table needed)
**`netlify/functions/ndcp-lib/store-map.js`** (new, shared, pure, unit-tested):
- Canonical lightweight store list (pc, name, district, dmName) — sourced from `STORES_SEED`/`DISTRICTS_SEED` (single shared copy so functions stop duplicating it ad hoc).
- `enrich(order)` → joins `order.account === pc`, adds `pc, name, district, dmName, weekKey`. Unknown account → `{ pc:null, name:order.store_name, district:null, unmapped:true }` (currently none, but future-proof).
- `weekOf(dateStr)` → Sunday-start ISO week key (e.g. `2026-06-07` is a Sunday).

**Extend `netlify/functions/ndcp.js`:**
- `list` gains optional `{ from, to }` on `date_ordered`; rows returned already `enrich`ed.
- New `summary` action `{ from, to }` → server-side SQL aggregation: totals; `byWeek` (weekKey → {orders, spend}); `byDistrict` (district → {dmName, orders, spend, stores:[…]}); `byStore` (pc → {name, district, orders, spend}). Includes any unmapped bucket.
- Keep CORS gating. (`ndcp` is on the portal-auth Phase C list to become token-gated; out of scope here.)

**Tests:** account→pc join; `weekOf` Sunday boundary; unknown-account fallback; `summary` shape on a fixture.

## Phase 2 — AdminNdcp UI revamp + analysis view
- **Date-range picker**, default **last 13 weeks**, driving `list`/`summary`.
- **Weekly rollup** (Sun–Sat): row per week with order count + spend, expandable to that week's orders.
- **District sections** (collapsible): header shows **DM name** (`DISTRICTS_SEED`); within, each **store by real name** (from `pc`); store + district subtotals. Any unmapped account in its own labeled section.
- **Analysis subview:** weekly spend trend (Chart.js line), category breakdown (from `category_subtotals`), and **DCP% over time** per store/district (sales from `pcg_labor_v1`/`pcg_labor_store_{pc}`; renders "—" when a week's sales are absent). Mirrors the Excel `DCP ScoreCard` layout (district → store → DCP$ / sales / DCP%).
- Reuse the existing order-detail modal.

## Phase 3 — DCP% on the DM Scorecard
- `analyst-cron.js → computeAndSaveDMScores`: per store, weekly NDCP `total_order` ÷ weekly net sales → district average → `scores[district].dcpPct` + `dcpScore`, saved into the existing `pcg_dm_scorecard` 13-week history.
- **DCP% rating bands (CONFIRMED 2026-06-08), anchored on the ~20% budget:**
  - **Good (green): ≤ 20.0%** → `dcpScore = 100`
  - **Yellow: 20.0%–22.0%** → `dcpScore = 50`
  - **Red: > 22.0%** → `dcpScore = 0`
- **Composite reweight:** Labor **25** / Sales **25** / **DCP 20** / Response **15** / Tickets **15** (= 100).
- `DmScorecardTab`: add a **DCP%** pill (lower-is-better, green/yellow/red vs budget) with the same week-over-week trend; composite/rank now reflect DCP%.
- Shared pure `dcpPct` helper so cron and analysis view agree.

## Data flow
```
NDCP email → ndcp_orders (Postgres) → ndcp.js (enrich account==pc + aggregate) → AdminNdcp UI
Pulse POS  → pcg_labor_* blobs ──────────────────────────────────────────────────┐
                                                                                  ▼
                          dcpPct() helper ── analyst-cron (scorecard) + analysis view
```

## Guardrails / no-surprise
- Unknown accounts (future) surfaced in their own section, never silently dropped.
- DCP% renders "—" (not 0%) when a week's sales are missing — no div-by-zero, excluded from district averages.
- Endpoint stays CORS-gated; token-gating deferred to portal-auth Phase C.
- Version bump in the sidebar footer; build `app.js` before deploy.

## Testing
- Unit: `store-map` (account==pc join, Sunday `weekOf` boundary, unknown-account fallback), `dcpPct` (normal, zero/missing sales → null).
- Aggregation: `summary` shape on a fixture order set.
- Manual: prod smoke of `summary` (`{from,to}`) after Phase 1; scorecard recompute spot-check after Phase 3.

## Confirmed parameters (2026-06-08)
1. **DCP% rating bands** — Good ≤20% / Yellow 20–22% / Red >22% (3-tier → score 100/50/0). ✅
2. **Composite weights** — Labor 25 / Sales 25 / DCP 20 / Response 15 / Tickets 15. ✅

## File touch list
- New: `netlify/functions/ndcp-lib/store-map.js` (+ test), shared `dcpPct` helper (+ test).
- Edit: `netlify/functions/ndcp.js` (date filter + `summary`), `netlify/functions/analyst-cron.js` (`dcpPct`/`dcpScore` + reweight), `app.jsx` (`AdminNdcp` revamp + analysis view, `DmScorecardTab` DCP% pill, version bump).
