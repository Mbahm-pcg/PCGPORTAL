# Phase 7.1 — Live Store P&L — Design Spec

**Date:** 2026-06-04
**Status:** Approved (design); pending implementation plan
**Roadmap ref:** `docs/ROADMAP_PHASES_6-10.md` → Phase 7.1

## Goal

Combine Pulse POS sales + Paycor labor + Food Cost(T) BOM into a real-time
estimated per-store P&L:

```
Contribution = Revenue − Labor − COGS
```

Updated near-live, with weekly/monthly rollups, trend lines, and stores ranked
by **contribution margin** (not just sales). Role-scoped per existing
`userType` permissions.

## Context — what already exists

- `netlify/functions/pnl-cron.js` (142 lines): **monthly** batch (1st of month,
  prior month). Computes **Revenue − Labor = Margin only — no COGS.** Ranks by
  labor %. Output is an emailed Orion **narrative report**, not a live dashboard.
- Data layer: `analyst-lib/analyst-data.js` `getStoreLabor(pc)` returns `.daily`
  points `{ date, sales, laborDollars, laborHours }` per store.
- `food-cost.js` (55KB): Food Cost(T) catalog + BOM / per-item cost (Phase 7.2,
  complete).
- Pulse `getMenuItemDailyTotals` provides per-store, per-day item-sold counts.

**Gap that 7.1 fills:** (1) a COGS dimension, (2) near-live refresh vs monthly,
(3) a dashboard ranked by contribution margin vs an emailed narrative.

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| COGS estimation | **Hybrid:** BOM × menu-mix where available, else category % of sales; per-store method badge (`BOM` / `est %`) |
| Refresh cadence | Bump `labor-cron` to **hourly during business hours (~5am–11pm ET)**; P&L recomputes in the same pass |
| UI placement | New **top-level "P&L" tab** |
| v1 scope | Full roadmap at once: live P&L + weekly/monthly rollups + trend lines + contribution-margin ranking |
| Role scoping | Inherit existing `userType` model |

## Architecture

### 1. Compute core — `netlify/functions/analyst-lib/pnl-calc.js` (new)

Pure, testable module. Single source of truth for the P&L formula.

```
computeStorePnL(store, range) → {
  revenue,            // Pulse sales (getStoreLabor daily)
  labor,              // Paycor laborDollars (existing)
  cogs,               // hybrid (see below)
  contribution,       // revenue − labor − cogs
  marginPct,          // contribution / revenue
  laborPct, cogsPct,  // labor/revenue, cogs/revenue
  method              // 'BOM' | 'est'
}
```

COGS hybrid logic:

```
if (menuMix available && trustworthy)
    cogs = Σ (menuItemQty × BOM_cost)      ; method = 'BOM'
else
    cogs = revenue × cogsPct                ; method = 'est'
```

Reused by **both** the live path and the existing monthly `pnl-cron.js`. Wiring
`pnl-cron.js` through `pnl-calc.js` means COGS also flows into the monthly Orion
narrative — fixing its current Revenue−Labor-only gap.

### 2. COGS inputs

- Per-item cost map sourced from `food-cost.js` (7.2 BOM).
- Menu mix from Pulse `getMenuItemDailyTotals` per store/day (daily-grained — so
  intra-day COGS is an estimate, revenue/labor remain hourly-fresh).
- `cogsPct` fallback config: network default ~29%, overridable per
  store/district, stored in a small config blob (`pcg_pnl_config_v1`).

### 3. Data writer — extend `labor-cron.js`

`labor-cron` already loops all 45 stores aggregating labor. In the same loop,
call `computeStorePnL` and write:

- `pcg_pnl_live_v1` — network + per-store **current snapshot** (drives the grid).
- `pcg_pnl_store_{pc}` — appended **daily history** points (drives trends + rollups).

Schedule change: `labor-cron` moves from `0 11,16,21 * * *` to hourly within
business hours (exact cron TBD in plan, e.g. `0 10-23,0-4 * * *` ET-adjusted).
Caveat: 8× more Paycor calls than today — token mutex + background function
(15-min) already mitigate; business-hours bound caps overnight waste.

### 4. Rollups & trends

Derived from `pcg_pnl_store_{pc}` daily history:

- Weekly buckets (Mon-start, matching the labor convention).
- Monthly buckets.
- Trend line = contribution margin over time (Chart.js, CDN-loaded).

### 5. Frontend — `AdminPnL` component + P&L tab (`app.jsx`)

- **Network KPI header:** Revenue · Labor · COGS · **Contribution** · Margin %.
- **Store grid ranked by contribution margin** (not sales): each row shows
  margin %, labor% + cogs% chips, and a `BOM` / `est %` method badge.
- **Store detail:** Revenue − Labor − COGS → Contribution **waterfall**;
  weekly/monthly rollup tables; margin **trend sparkline**.
- **District view** for DMs.
- Inline `style={}` objects + `getTheme(dark)` per project conventions; no CSS
  framework. Numbers via `fmtDollars` / `fmtPct`.

### 6. Role scoping (existing `userType`)

| userType | P&L scope |
|----------|-----------|
| `executive`, `it` | Full network |
| `dm` | Their district only |
| `manager` | Their store only |
| others | Tab hidden |

### 7. Error handling (matches existing per-store try/catch)

- Missing food-cost/menu-mix → `est %` fallback + badge (never shown as exact).
- Missing labor for a store → store flagged, excluded from ranking.
- Degraded/partial data is always visually distinguished from BOM-exact data.

## Data flow

```
Pulse (sales, menu mix) ─┐
Paycor (labor)          ─┼─► labor-cron (hourly) ─► pnl-calc ─► pcg_pnl_live_v1
food-cost BOM           ─┘                                   └─► pcg_pnl_store_{pc}
pcg_pnl_config_v1 (cogsPct) ──────────────────────────────────────┘ (fallback)
                                                                   │
                          AdminPnL (P&L tab) ◄── cloudLoad ────────┘
```

## Testing

- `pnl-calc.js` unit tests: BOM path, fallback path, zero-revenue guard,
  method-badge selection, margin math.
- Manual: verify a known store's live snapshot vs hand calc; confirm role
  scoping (DM sees only district, manager only store); confirm monthly
  `pnl-cron` narrative now includes COGS.

## Out of scope (v1)

- Forecasted/projected P&L (Phase 7.4; depends on 6.2 forecasting).
- Push-to-Paycor scheduling.
- Royalty/ad-fund fee modeling (Phase 7.4).
