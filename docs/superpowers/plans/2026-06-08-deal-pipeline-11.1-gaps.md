# Task 2 — Deal Pipeline 11.1: Remaining Work (Gap Plan)

**Date:** 2026-06-08
**Base:** `main` (the `feature/deal-pipeline` branch is already fully merged into `main` — nothing to rebase). Do remaining work on a fresh branch `feature/deal-pipeline-11.1`.
**Spec:** `docs/superpowers/specs/2026-06-05-deal-pipeline-design.md`
**Architecture reminder:** edit `app.jsx` (+ `src/*`), `npm run build`, commit both `app.jsx` + `app.js`. Never hand-edit `app.js`.

## Status: ~80% done
DONE (10/13): 8-stage Kanban + table toggle (`app.jsx:24628–24991`); core + full lease + full purchase fields (`deals.js:54–76`); brand Dunkin/PJ/BWW GO/dual + PA/NJ; possession/rent-commencement split dates (`deal-dates.mjs:13–20`); SPE/entity; extended lease abstract (CAM cap/gross-up/audit, cotenancy, kickout, holdover, ROFR/ROFO, delivery); documents w/ version history (`deal-docs.js:45–106`); dashboard KPIs (`app.jsx:24814–24824`); **server-side RBAC view/edit on deals + deal-docs** (`deals.js:12–27`, `deal-docs.js:14–34`) — fully enforced, no gaps.

## Remaining work — prioritized

### P1 — core spec completeness
1. **Dead-deal reason codes (enum + dropdown).** Today free text (`deals.js:88`; UI `app.jsx:24856–24863` uses `prompt`). Add a fixed code list (lost-to-competitor, failed-DD, zoning-denied, franchisor-rejected, economics, financing, other) → dropdown in `doMarkDead`. ~1h.
2. **Critical dates → .ics export.** `deal-dates.mjs:76–95` already has `icsForDeal()` with per-tier `VALARM`, but there's **no endpoint and no button**. Add `netlify/functions/deal-calendar.js` (auth via `deal-lib` token; `{deal_id}` → `text/calendar`) + a "Download .ics" button in the AdminDeals detail panel. ~3h.
3. **Acknowledge-date UI.** `ackDate` action exists (`deals.js:114–116`) but no button. Add "Acknowledge" next to each critical date in the detail panel; reflect acknowledged state. ~2h.
4. **Recurring critical dates.** `deal_dates` lacks `recurring`/`cadence`. Add columns (migration) + `deals.js` add/update accept cadence (monthly/quarterly/annual) + UI toggle. Needed for % rent / CAM audit / COI renewals. ~3h.
5. **Configurable warning tiers UI.** `newDateTiers` state exists (`app.jsx:24682`) but no clear widget to set per-date alarm tiers (e.g. [180,120,90,60,30] vs [30,7,1]). Add an editor. ~2–3h.

### P2 — spec completeness
6. **Deal notes as activity log.** `deal_notes` exists (`deals.js:91–94`) but no actor/action/system-event metadata (e.g. "stage moved to Executing"). Add activity metadata + show who/when in UI. ~2–4h.
7. **Push notifications for alerts.** `deal-alerts-cron.js:43–55` is email-only; spec wants push+email. Integrate existing `push.js`. Add per-tier de-dup so a tier doesn't re-fire daily. ~2–3h.

### P3 — polish / foundation
8. **Codify deal tables in `db/schema.ts`** (Drizzle) — currently raw SQL only. ~2–3h.
9. **Allowed doc-type whitelist** in `deal-docs.js` upload. ~1h.
10. **Clearer error surfacing** for failed date/doc ops in AdminDeals. ~1h.
11. **Kanban mobile layout** polish. ~2–3h.
12. **Handoff → construction project** link/auto-create — **deferred per spec (v1.2)**; optionally show a post-handoff link.

## Acceptance (from the work order)
A deal moves through all 8 stages; alerts fire at configured thresholds **and can be acknowledged**; documents retain version history; **a non-edit role cannot write via the API** (verify with a direct request, not just hidden UI); critical dates export to `.ics`.

## Suggested execution
Branch `feature/deal-pipeline-11.1`; do P1 in small commits (each item: build + commit), then P2, then P3. Stop for review before deploy; preview-deploy → smoke (incl. the direct-API RBAC check) → prod. Reuse the existing `deal-lib` token/RBAC for `deal-calendar.js`.
