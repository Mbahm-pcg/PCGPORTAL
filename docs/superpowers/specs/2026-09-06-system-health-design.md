# System Health — Design Spec

**Date:** 2026-09-06 · Repo: PCGPORTAL (main, live v20.48) · First increment of the "fold Workpulse into Pulse" project.

## Goal
Make silent failures in Pulse's data pipeline visible and alert on them — so a repeat of the Paycor
refresh-token dying unnoticed for days can't happen. Monitor every scheduled function (27 crons) and
every data feed's freshness, per-store where applicable, with both a dashboard and push/email alerts.

## Decisions (from brainstorming)
| # | Decision | Choice |
|---|---|---|
| 1 | Primary job | Dashboard **and** alerting, equally |
| 2 | Coverage | Every cron + per-store freshness for per-store feeds |
| 3 | Detection | **Hybrid** — registry-driven freshness for all (day one, no cron edits) + incremental heartbeat enrichment |
| 4 | Cron cadence | every 30 min |
| 5 | Alert recipients | critical feeds → push + email to IT + exec; non-critical → dashboard only |

## Architecture

### `src/system-health.mjs` (pure, unit-tested — no I/O)
The single source of truth. Contains:

**FEEDS registry** — one entry per monitored feed:
```js
{ key, label, blobKey, expectedMaxAgeMin, perStore: bool, critical: bool, category }
```
- `expectedMaxAgeMin` derived from the cron's schedule with a tolerance multiple. Examples:
  labor (hourly 9-23 ET) → 90; pulse-compare (30 min) → 45; pulse/hourly-snapshot (daily) → 1560 (26 h);
  reconciliation (Sun/Tue) → 4 d; reviews (weekly) → 8 d; pnl (monthly) → 32 d; tips (daily 7am) → 28 h.
- `perStore: true` for feeds keyed per store (`pcg_labor_store_{pc}`, `pcg_hourly_history_{pc}`,
  `pcg_tips_snapshot_{date}` per-store rows, `pcg_pnl_store_{pc}`).
- `critical: true` for money/ops feeds (Pulse sales, Paycor labor, tips, reconciliation, P&L); the rest
  are non-critical (weather, reviews, competitor, KB sync, deal alerts, trusted-devices reset…).
- `category` groups the dashboard: Sales · Labor · Cash · Compliance · Comms · AI · Platform.
- The registry is populated during implementation by mapping each of the 27 crons in `netlify.toml` to
  the blob it writes (enumerated in the plan). Any cron with no queryable output blob is monitored via
  the heartbeat layer instead (see below).

**Pure logic:**
```js
classifyFeed(savedAtMs, nowMs, spec) → 'OK' | 'STALE' | 'DOWN'
  // OK: age <= expectedMaxAgeMin; STALE: <= 2× expected; DOWN: > 2× expected OR blob missing
classifyPerStore(perStoreSavedAt, nowMs, spec, activePcs) → { status, storesOk, storesTotal, staleStores[] }
rollup(feedStatuses) → 'GREEN' | 'YELLOW' | 'RED'   // worst CRITICAL feed drives overall; non-critical caps at YELLOW
diffForAlerts(prevSnapshot, nextSnapshot) → [{ key, from, to, critical }]  // transitions only (incl. →OK recovery)
```

### `netlify/functions/system-health-cron.mjs` (scheduled, every 30 min)
1. For each FEEDS entry, load its blob (network or per-store) and read `savedAt`.
2. Classify via the pure module → build the current snapshot `{ overall, feeds[], asOf }`.
3. Load previous snapshot `pcg_system_health_v1`; `diffForAlerts(prev, next)`.
4. For each transition: critical → push (`push.js`) + email (`email-send.js`) to IT + exec; append to
   `pcg_system_health_alerts_v1`. Recovery (→OK) sends an "all clear."
5. Save the new snapshot to `pcg_system_health_v1`.
6. Re-alert guard: a still-DOWN critical feed re-alerts at most once every N hours (default 6), tracked
   via last-alerted timestamp in the alert log — no spam every 30 min.

### `netlify/functions/system-health.mjs` (on-demand)
Recomputes the snapshot live (same logic as the cron, minus alerting) so the dashboard's "Refresh now"
is real-time. Auth: exec/IT only (`...authHeader()`, server-enforced, matching existing hardened fns).

### Heartbeat layer (incremental, additive)
Shared helper `recordHealth(name, { ok, error, durationMs })` writing to `pcg_system_health_beats_v1`.
The highest-value crons call it (labor-cron, pulse-cron/pulse-notify, tips crons, and the Paycor proxy on
refresh failure). The cron/endpoint merges any beat into the matching feed to enrich it with the last
error message + run duration. The dashboard works fully on freshness alone without any beats present.

### Frontend — System Health tab (`app.jsx`)
- New tab, exec/IT only. Must be added to `getTabs()` AND the `ADMIN_GROUPS` sidebar id list (per the
  documented sidebar gotcha — adding to getTabs alone is not enough).
- Reads `pcg_system_health_v1` via `cloudLoad`; "Refresh now" hits the on-demand endpoint.
- Top-line Green/Yellow/Red banner + counts (N OK / M stale / K down).
- Per-category sections; each feed = a card: label, status pill, last-updated (relative), and for
  per-store feeds a "X/Y stores" chip that expands to the stale store list. Heartbeat error text shown
  when present.
- Follows existing inline-style / theme conventions; mobile-flow like other tabs.

## Data flow
```
existing crons → write output blobs (savedAt)
                         │
   system-health-cron (30m) ── reads savedAt per FEEDS ──► classify ──► pcg_system_health_v1
                         │                                          └──► diff vs prev ──► push+email (critical) ──► pcg_system_health_alerts_v1
   Paycor proxy / key crons ── recordHealth() ──► pcg_system_health_beats_v1 ──┘ (enrich)
                         │
   System Health tab ── cloudLoad(pcg_system_health_v1) / Refresh-now → system-health.mjs
```

## Error handling
- A feed whose blob read throws/does-not-exist → `DOWN` (missing is a failure signal, not an error to swallow).
- The cron must never crash on one bad feed — each feed read is isolated (try/catch → DOWN for that feed).
- Alerting failure (push/email) is logged but never blocks writing the snapshot.
- The dashboard renders whatever snapshot exists; if `pcg_system_health_v1` is absent it shows "initializing."

## Testing
`src/system-health.test.mjs` (existing `npm test` glob):
- `classifyFeed`: fresh < expected → OK; between 1× and 2× → STALE; > 2× or missing → DOWN; boundary exacts.
- `classifyPerStore`: all fresh → OK; some stale → correct storesOk/staleStores; all missing → DOWN.
- `rollup`: a critical DOWN → RED; only non-critical stale → YELLOW (never RED); all OK → GREEN.
- `diffForAlerts`: OK→STALE emits; STALE→STALE does not; DOWN→OK emits recovery; new feed handled.
- Registry sanity: every entry has required fields; expectedMaxAgeMin > 0; unique keys.

Manual verification: load the tab against live blobs; confirm known-fresh feeds show OK and a deliberately
stale check (e.g. monthly pnl mid-month) shows the expected age status; trigger the on-demand endpoint.

## Out of scope (first increment)
- Instrumenting all 27 crons with heartbeats (only the key ones; freshness covers the rest).
- Historical uptime charts / SLA %; latency graphs. (Snapshot + alert log only.)
- Auto-remediation (e.g. auto-refreshing the Paycor token) — surfaced, not fixed, here.

## Files
| File | Change |
|---|---|
| `src/system-health.mjs` | New — registry + pure logic |
| `src/system-health.test.mjs` | New — unit tests |
| `netlify/functions/system-health-cron.mjs` | New — scheduled monitor + alerts |
| `netlify/functions/system-health.mjs` | New — on-demand recompute |
| `netlify/functions/health-lib/record-health.mjs` | New — `recordHealth()` helper |
| `netlify.toml` | Add `[functions.system-health-cron]` schedule `*/30 * * * *` |
| `app.jsx` | New System Health tab + `getTabs()` + `ADMIN_GROUPS` + APP_VERSION bump |
| key crons (labor/pulse/tips) + `paycor.mjs` | Call `recordHealth()` (incremental) |
