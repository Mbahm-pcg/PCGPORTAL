# RESUME — System Health build

**Read this first after a context clear. Then proceed.**

## Where we are
- **Repo:** PCGPORTAL (main, live v20.48). Workflow: edit `app.jsx` → `npm run build` → bump `APP_VERSION` → commit BOTH `app.jsx` + `app.js` → `npx netlify deploy --prod` (manual). `src/*.mjs` pure modules + `src/*.test.mjs` (node:test), run via `npm test`.
- **Project:** "Fold Workpulse into Pulse." Gap analysis at `docs/workpulse-gap-analysis-2026-09-05.md`. Sprint scope = all four Tier-1 items. Workpulse fate = eventually replace.
- **Current increment:** System Health (first Tier-1). Spec DONE + committed: `docs/superpowers/specs/2026-09-06-system-health-design.md`. Design was approved by user in brainstorming.

## Status — IMPLEMENTATION COMPLETE (2026-09-07)
All 8 plan tasks built + individually reviewed on branch `feature/system-health` (SDD). Final whole-branch review (opus) = ready with fixes; fixes applied. Deploying as v20.49.
- **Security fixes caught in review (all fixed + re-reviewed):** (1) cron `sql()` unguarded could skip snapshot/alert-log writes; (2) fail-open re-alert-guard drift (guard armed even when DB down → 6h silent outage); (3) endpoint AUTH BYPASS (unauth caller could pass `userRole:'executive'`) → now requires verified portal token (`requireUser`), role from `resolveCaller(authed.sub)`, fail-closed 403.
- **Tuning fix:** labor/labor-store/pnl-live/pnl-store `expectedMaxAgeMin` = **420** (labor-cron has a ~6h overnight gap in `0 9-23,0-3` UTC; 90/180 would false-page nightly). Paycor token death still caught instantly by the `recordHealth` heartbeat. Per-store feeds scoped to their own blob prefix (`activePcsByKey`) so closed/excluded stores don't false-alarm.
- **Sidebar note:** surfaced as a TILE under existing `system-hub` (NOT a new hub), so `ADMIN_GROUPS` was intentionally NOT touched — the gotcha was sidestepped, not hit.
- **FOLLOW-UPS for Mike (not blocking):** (a) `analyst.mjs` (+peers) likely share the same auth-bypass pattern (`effRole = caller?.role || body userRole` after only a `==='revoked'` check) — needs its own security pass; (b) pre-existing unrelated test failure `ndcp-lib/store-map.test.js` (46 vs 45 stores) — Ahmed's, untouched; (c) schedule-alerts window zero-buffer; endpoint `action:'get'` dead path; recovery push dropped if DB down at recovery.
- **Post-deploy manual verification** (plan bottom): load System Health tile as exec/IT; confirm banner + counts + per-category cards + per-store chips; test Refresh-now (200; non-exec/IT → 403); confirm `system-health-cron` scheduled + `pcg_system_health_v1` updates within 30m.

Spec at a glance: new `src/system-health.mjs` (FEEDS registry + pure logic: `classifyFeed`, `classifyPerStore`, `rollup`, `diffForAlerts`) + tests; `netlify/functions/system-health-cron.mjs` (30-min monitor + push/email alerts, re-alert guard 6h); `netlify/functions/system-health.mjs` (on-demand recompute, exec/IT auth); `netlify/functions/health-lib/record-health.mjs` heartbeat helper; `netlify.toml` schedule `*/30 * * * *`; `app.jsx` new System Health tab — MUST add to `getTabs()` AND `ADMIN_GROUPS` sidebar id list (documented gotcha) + APP_VERSION bump; key crons (labor/pulse/tips) + `paycor.mjs` call `recordHealth()`.

## Side finding (DCP invoice data — answered, parked)
Workpulse Purchasing → Invoice ingests DCP data via an **automated National DCP vendor/EDI feed** (1,193 invoices; multiple vendors — National DCP dominant, South Jersey Bakery, Dunkin Loyalty Funding, DoorDash — each with distinct invoice-# formats, keyed to PC#/store, with Order-Qty-vs-Sent-Qty line detail = distributor feed, not manual). Invoice PDFs served as stored media blobs from `api.workpulse.com`. **Pulse already has NDCP plumbing**: `ndcp-sync-cron` (every 6h) + `ndcp-lib/` (store-map, summary, parse). Investigate that when the Purchasing sprint starts.

## Standing constraints
- Browser Workpulse crawl is read-only (no send/save/delete/submit/settings/purchase/consent). Mike does his own logins/credentials.
- Ahmed (pcg-preeom) commits to shared main; always `git fetch` + fast-forward before committing.
- The pasted Paycor refresh token in an earlier transcript should be rotated (security).

## Backlog (not blocking System Health)
Paycor token writeback fix; district/store strip follow LOCAL viewMode; ndcp store-map.test.js to 46 stores.
