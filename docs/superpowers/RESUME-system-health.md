# RESUME — System Health build

**Read this first after a context clear. Then proceed.**

## Where we are
- **Repo:** PCGPORTAL (main, live v20.48). Workflow: edit `app.jsx` → `npm run build` → bump `APP_VERSION` → commit BOTH `app.jsx` + `app.js` → `npx netlify deploy --prod` (manual). `src/*.mjs` pure modules + `src/*.test.mjs` (node:test), run via `npm test`.
- **Project:** "Fold Workpulse into Pulse." Gap analysis at `docs/workpulse-gap-analysis-2026-09-05.md`. Sprint scope = all four Tier-1 items. Workpulse fate = eventually replace.
- **Current increment:** System Health (first Tier-1). Spec DONE + committed: `docs/superpowers/specs/2026-09-06-system-health-design.md`. Design was approved by user in brainstorming.

## Next action (do this)
Plan DONE + committed: `docs/superpowers/plans/2026-09-06-system-health.md` (9 tasks, TDD, all code inline). Execute it via **superpowers:subagent-driven-development** (recommended — fresh subagent per task, review between) or **superpowers:executing-plans** (inline). Task order: 1-3 pure `src/system-health.mjs` (classifyFeed/rollup → classifyPerStore/diffForAlerts → FEEDS+buildSnapshot) → 4 recordHealth helper → 5 cron+netlify.toml → 6 on-demand endpoint → 7 app.jsx tab (v20.49, build) → 8 heartbeat instrumentation. Then manual verification checklist at plan bottom.

Spec at a glance: new `src/system-health.mjs` (FEEDS registry + pure logic: `classifyFeed`, `classifyPerStore`, `rollup`, `diffForAlerts`) + tests; `netlify/functions/system-health-cron.mjs` (30-min monitor + push/email alerts, re-alert guard 6h); `netlify/functions/system-health.mjs` (on-demand recompute, exec/IT auth); `netlify/functions/health-lib/record-health.mjs` heartbeat helper; `netlify.toml` schedule `*/30 * * * *`; `app.jsx` new System Health tab — MUST add to `getTabs()` AND `ADMIN_GROUPS` sidebar id list (documented gotcha) + APP_VERSION bump; key crons (labor/pulse/tips) + `paycor.mjs` call `recordHealth()`.

## Side finding (DCP invoice data — answered, parked)
Workpulse Purchasing → Invoice ingests DCP data via an **automated National DCP vendor/EDI feed** (1,193 invoices; multiple vendors — National DCP dominant, South Jersey Bakery, Dunkin Loyalty Funding, DoorDash — each with distinct invoice-# formats, keyed to PC#/store, with Order-Qty-vs-Sent-Qty line detail = distributor feed, not manual). Invoice PDFs served as stored media blobs from `api.workpulse.com`. **Pulse already has NDCP plumbing**: `ndcp-sync-cron` (every 6h) + `ndcp-lib/` (store-map, summary, parse). Investigate that when the Purchasing sprint starts.

## Standing constraints
- Browser Workpulse crawl is read-only (no send/save/delete/submit/settings/purchase/consent). Mike does his own logins/credentials.
- Ahmed (pcg-preeom) commits to shared main; always `git fetch` + fast-forward before committing.
- The pasted Paycor refresh token in an earlier transcript should be rotated (security).

## Backlog (not blocking System Health)
Paycor token writeback fix; district/store strip follow LOCAL viewMode; ndcp store-map.test.js to 46 stores.
