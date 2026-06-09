# Orion — Expand Operational Datasets (Projects, Tickets, Cash, Food Cost) — Design

**Date:** 2026-06-09
**Status:** Approved design — pending spec review
**Driver:** Orion (the AI analyst) currently only sees sales/labor/scheduling, so it punts on construction, maintenance, cash, and food-cost questions (see the "remodel/construction status" ask it couldn't answer).

## Goal
Give Orion read access to four more operational datasets so it can answer questions and cross-reference them with sales/labor: **construction/projects**, **maintenance tickets**, **cash management**, and **food cost** — each as a compact, role-scoped context, following the existing `analyst-data.js` builder pattern.

## Locked decisions
- **All four domains** in this work (not phased).
- **Include project financials** (budget vs actuals) so Orion can flag cost overruns.
- **Compact summaries, not raw dumps** — token discipline; preserve answer quality.
- **Role-scoped** via the analyst's existing `district` param: DM → their district only; exec/IT/office → full network.
- **No secrets/PII to the model** — amounts/statuses only; never deposit-slip images or credentials.
- **Graceful absence** — a missing/empty blob yields `{ available: false }`, so Orion says "no X data yet" instead of erroring (same as the current weather/sentiment builders).

## Data sources (Netlify Blobs, loaded via existing `cacheLoad`)
- **Projects:** `pcg_projects_v1`
- **Tickets:** `pcg_tickets_v1`
- **Cash:** `pcg_cash_deposits_v1` (primary; `pcg_cash_uploads_v1` / `pcg_cash_notes_v1` not sent to the model)
- **Food cost:** `pcg_food_cost_*_v1` category blobs (e.g. `pcg_food_cost_beverages_v1`)

> The exact record field names in each blob will be read during planning (the summarizers map raw fields → the summary shapes below). Stores carry `pc`/`district` for scoping; `STORES` (already imported in `analyst-data.js`) provides store→district lookup.

## Architecture — follow the existing pattern in `netlify/functions/analyst-lib/analyst-data.js`
Each domain = a **pure summarizer** (testable) + a **thin async builder** (loads blob, calls summarizer):

| Domain | Pure summarizer | Async builder | Blob |
|--------|-----------------|---------------|------|
| Projects | `summarizeProjects(raw, district)` | `buildProjectsContext({district})` | `pcg_projects_v1` |
| Tickets | `summarizeTickets(raw, district, now)` | `buildTicketsContext({district})` | `pcg_tickets_v1` |
| Cash | `summarizeCash(raw, district)` | `buildCashContext({district})` | `pcg_cash_deposits_v1` |
| Food cost | `summarizeFoodCost(rawByCategory)` | `buildFoodCostContext()` | `pcg_food_cost_*_v1` |

Pure summarizers are exported and unit-tested; async builders use `cacheLoad` and are exported from `analyst-data.js`'s `module.exports` (alongside `buildWeatherContext`, etc.).

### Summary shapes (compact)
- **Projects** → `{ available, projects: [{ store, district, type, phase, status, targetCompletion, daysBehind, budget, actual, variancePct, permitHold }], counts: { total, behind, atRisk, permitHolds } }`. `daysBehind`/`atRisk` derived from `targetCompletion` vs now; `variancePct = (actual-budget)/budget`.
- **Tickets** → `{ available, openByStore: [{ store, district, open, oldestDays }], aging: { gt7, gt14 }, critical: [{ store, title, days }], totalOpen }`.
- **Cash** → `{ available, missingDeposits: [{ store, district, date, expected }], unreconciledCount, unreconciledTotal, recent: [{ store, date, amount }] }`.
- **Food cost** → `{ available, categories: [{ category, itemCount, avgUnitCost, topMovers: [{ item, unitCost }] }] }`.

### Role scoping
- `district` (a number) → filter each summary to stores in that district; `null` → full network. Reuse `getStoresByDistrict` already in `analyst-data.js`. The analyst entrypoint already resolves `district` from the request/user.

### Orchestration (`analyst.js` + `analyst-data.js`)
- Extend `buildDataContext({ district, includeStoreDetail, storePC, userRole })` to also assemble the four new contexts and include them on the returned context object (e.g. `context.projects`, `.tickets`, `.cash`, `.foodCost`).
- The analyst entrypoints at `analyst.js:64/151/180/327` call `buildDataContext` — no call-site changes needed beyond what `buildDataContext` returns.

### Prompt (`analyst-lib/analyst-prompts.js`)
- Add a short "Operational datasets" section telling Orion it now has Projects, Tickets, Cash, and Food Cost, what each contains, and that figures are role-scoped. Render the four compact summaries into the data block the system prompt already builds.

## Data flow
```
request {district, user} → buildDataContext
   ├─ existing: labor/KPI/sales, weather, sentiment, email
   └─ NEW: pcg_projects_v1 → summarizeProjects(district)   ┐
           pcg_tickets_v1  → summarizeTickets(district,now) ├→ context.{projects,tickets,cash,foodCost}
           pcg_cash_deposits_v1 → summarizeCash(district)   │      → analyst-prompts → Claude
           pcg_food_cost_*_v1   → summarizeFoodCost()       ┘
```

## Testing
- **TDD the four pure summarizers** (new `netlify/functions/analyst-lib/ops-summaries.test.js`, `node:test` like `pnl-calc.test.js`): district filtering; projects `daysBehind`/`atRisk`/`variancePct`; tickets aging buckets + oldest; cash missing/unreconciled totals; food-cost category aggregation; empty-blob → `{ available:false }`.
- **Integration:** ask Orion the screenshot question ("status of all active remodel/construction projects, flag behind/at-risk") on a preview build and confirm it answers from real project data, role-scoped.

## Guardrails / YAGNI
- Read-only; no writes to any blob.
- Summaries cap list lengths (e.g. top/oldest N) to bound tokens; full enumeration is out of scope.
- Deposit images, ticket attachments, and any credential/PII fields are never included.
- No new cron; data freshness follows whatever already maintains these blobs.

## File touch list
- New: `netlify/functions/analyst-lib/ops-summaries.js` (the four pure summarizers + `ops-summaries.test.js`).
- Edit: `analyst-lib/analyst-data.js` (four `build*Context` async builders + exports + wire into `buildDataContext`); `analyst-lib/analyst-prompts.js` (describe + render the four summaries).

## Confirm on review
1. The four summary shapes above capture what you'd want Orion to reason over — anything missing (e.g. project GC/contractor name, ticket assignee)?
2. Food cost is the lightest/most optional — keep it in this pass, or drop to fast-follow?
3. List caps (top/oldest N) acceptable for token control, or do you want full enumeration for a domain?
