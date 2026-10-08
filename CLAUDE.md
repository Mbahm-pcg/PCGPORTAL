# PCG Company Portal — CLAUDE.md

## Project Overview
**PCG Unified Operations Portal (UOP)** — A React single-page application serving as the internal operations dashboard for People Capital Group, a Dunkin' franchise operator with 45+ stores across 8 districts in the Philadelphia region.

**Live URL:** https://pcg-ops.netlify.app
**Hosting:** Netlify (Pro plan) — bundled static SPA + serverless functions + Netlify Blobs + Neon Postgres
**Version:** Single source of truth is the `APP_VERSION` constant in `app.jsx` (currently **v15.32**), rendered in both the sidebar footer and the Admin · System "Portal version / live build" field. **Increment on every code change.**

---

## Architecture

### Tech Stack
- **Frontend:** React 18.2.0 (loaded from CDN), authored in JSX, bundled with **esbuild**
- **Backend:** Netlify Functions (Node.js serverless)
- **Storage:** Netlify Blobs (`pcg-portal` store) + **Neon Postgres** (relational) + localStorage (client state)
- **ORM:** Drizzle ORM + drizzle-kit (schema in `db/schema.ts`)
- **Styling:** Inline `style={}` objects — no CSS framework (no Tailwind, no Bootstrap)
- **Fonts:** Google Fonts — Raleway (headings, 600-900), Source Sans 3 (body, 300-700)
- **PWA:** Service worker for push notifications, manifest.json for installability

### Build Step (IMPORTANT — this changed)
The app **is bundled**. You edit JSX source, then build to `app.js`, which `index.html` loads.

```bash
npm run build      # esbuild app.jsx --bundle --outfile=app.js --jsx=transform --platform=browser
npm run watch      # same, with --watch for live rebuilds during development
```

- **Source of truth:** `app.jsx` (~1.8MB, the bulk of the app) + `src/icons.jsx` + `src/theme.js`
- **Build output:** `app.js` — **committed and served**. Always rebuild before committing/deploying so `app.js` matches the JSX source.
- React/ReactDOM and other libs (pdf.js, xlsx, jspdf, html2pdf, Chart.js, reveal.js, pptxgenjs, Google GSI) are loaded via CDN `<script>` tags in `index.html` and referenced as globals (`React`, `window.Chart`, etc.) — they are **not** bundled.
- `index.html` is a thin shell: `<div id="root"></div>` + `<script src="app.js"></script>`.
- `build:babel` (legacy Babel build) and `build:src` (future `src/main.jsx` entry) scripts exist but the **active build is esbuild on `app.jsx`**.

### File Structure
```
app.jsx                 — Main app source (~1.8MB, most components inline)
src/icons.jsx           — Icon, OrionIcon, ICONS, CAT_ICONS_SVG (SVG icon system)
src/theme.js            — BRAND_CONFIG, DARK/LIGHT themes, getTheme(), btn/inp/card helpers
app.js                  — esbuild bundle output (committed, served)
index.html              — Thin HTML shell (CDN libs + #root + app.js)
sw.js                   — Service worker (push notifications)
manifest.json           — PWA manifest
netlify.toml            — Build config, scheduled functions, headers
package.json            — Dependencies + build scripts
drizzle.config.ts       — Drizzle config (postgresql, schema → netlify/database/migrations)
db/
  schema.ts             — Postgres schema (users, tickets, chat, notifications, audit_log, …)
  index.ts              — DB client export
netlify/functions/      — Serverless functions (see below)
docs/                   — Roadmaps, specs, update logs
```

---

## Netlify Functions

```
netlify/functions/
  # ── Pulse POS (sales) ──
  pulse.js                    — Pulse POS API proxy (CORS bypass)
  pulse-cron.js               — Scheduled daily sales notification wrapper
  pulse-hourly-snapshot.js    — Hourly sales + weather snapshot
  pulse-notify.js             — Daily sales notification builder (push + email)
  # ── Labor (Paycor) ──
  paycor.js                   — Paycor API OAuth proxy
  labor-cron.js               — Scheduled labor cost aggregation
  labor-cron-background.js    — Background wrapper for manual refresh (15-min timeout)
  labor-cron-warmup.js        — Saturday pre-warm
  schedule-alerts.js          — Labor schedule risk alerts (≥26% projected → DM/mgr push+email)
  no-clockin-cron.mjs         — No clock-in alerts: 30 min → manager, 60 min → absent to manager + DM (SMS + push + email)
  no-clockin.mjs              — Manual exec/IT endpoint for it: dry run + `?sendTest=1` (scheduled fns can't be hit over HTTP — empty 403)
  no-clockin-lib/run.mjs      — Shared engine used by both
  # ── Minor Timecard Compliance (PA minor labor law) ──
  minor-timecard-detect-cron-background.mjs — Sunday: scans every store's under-18 crew for the
                                closed week, flags hours strictly OVER 5 (exactly 5.0h is the limit,
                                not a violation of it) with no qualifying 30-min break, emails the
                                manager — or the DM immediately if the store has no manager account/
                                email on file at all, rather than silently notifying nobody until
                                Monday (`-background` = 15-min budget; it WILL exceed 60s)
  minor-timecard-followup-cron.mjs — Daily: re-checks each open issue against live Paycor (same
                                strictly-over-5-hours rule), auto-resolves, escalates from the Monday
                                after the week closes to DM + the manually-curated "Minor Timecard"
                                notify list (Admin · Notifications tab, `pcg_minor_timecard_notify_v1`
                                — NOT every office_staff account; add/remove exactly who should get
                                it). A manager or DM's own email is hard-excluded from this curated
                                list in code (not just convention) — confirmed real 2026-10-06: the
                                list has no store/district scoping at all, so a manager/DM account
                                sitting in it (the original 43-manager bulk-add, or later 4 real DMs
                                added on purpose) got paged for every store/district network-wide
                                instead of just their own. Explicit requirement: a DM only ever sees
                                their own district's stores, a manager only ever their own store — no
                                code path may widen that. See `resolveNotificationRecipients`
                                (src/minor-timecard-lifecycle.mjs) for the exact manager/DM-fallback/
                                escalation/exclusion recipient logic.
                                `applyResolutionCheck` (src/minor-timecard-lifecycle.mjs) now refreshes
                                `consecutiveHours`/`longestGapMinutes` on an issue from the SAME live
                                re-check every day it stays open, not just on resolve (fixed
                                2026-10-05: a manager correcting a timecard in Paycor AFTER detection —
                                e.g. adding a missed meal punch — left the issue's displayed hours/
                                break frozen at whatever was true at first detection, forever, even
                                though the email's clock-in/out text was already re-derived fresh each
                                time; confirmed live with Jessup Charlotte/Tollgate, 9/27 and 10/3).
  minor-timecard-resolve.mjs  — Manual "Mark Resolved" endpoint (exec/IT/DM, DM district-scoped)
  # ── Office Hourly Time Clock (office/corporate staff, Paycor legal entity 193872) ──
  office-clock-punch.mjs      — office_staff's own punch (clock in/meal/clock out) + today's list;
                                409s if the caller isn't linked (paycor_employee_id + paycor_department_id
                                both set) — the real enablement gate in the feature, re-checked live.
                                Tab/tile VISIBILITY is also per-person now (2026-10-02, not just role):
                                `user.officeClockLinked` (set at login in portal-auth.mjs's `issue()`
                                from those same two columns) decides whether an office_staff account
                                sees the tab/mobile-landing/tile at all — someone not yet linked sees
                                nothing to click, rather than a tile that would just 409. Stale until
                                next login/token refresh if linked/unlinked mid-session, same as every
                                other session field here.
  office-clock-review.mjs     — exec/IT: pay-period review/edit + fires the background Paycor send.
                                Locking (revised 2026-10-02): the CURRENT period only is freely
                                editable — any other period locks automatically the instant it's no
                                longer current ("9/26 or 9/12 is the actual past"), regardless of
                                whether it was ever sent to/confirmed by Paycor. `isPeriodFinalized`
                                (fully sent + every punch `confirmed`) still exists but is now just one
                                of two reasons a period can be locked, kept for the background sender's
                                own I1 check and for UI messaging. exec/IT can deliberately reopen an
                                old period (`unlockPeriod`) and re-close it (`lockPeriod`) — both
                                audit-logged (`office_clock_period_overrides` table + `audit_log`).
                                Unlocking NEVER bypasses the separate, unconditional per-punch check: a
                                punch Paycor has already confirmed can still only be corrected in
                                Paycor's own timecard editor — there is no delete/undo API for it, so
                                this app refuses to silently diverge from what Paycor actually has.
                                Linking an office_staff account to Paycor is a live name/employee-
                                number search against Paycor's own roster (`employeeSearch` action) —
                                IT picks a match, the real employee/department GUIDs are saved via
                                `users.mjs`'s `update` action, never hand-typed (an earlier paste-the-
                                display-value form caused a real CreatePunches 400 — Paycor's GUID
                                isn't what its own UI shows)
  office-clock-send-background.mjs — stages each linked employee's exact worked hours into Paycor's
                                PAYGRID (`stagePayrollHours`, v2, employeeId-keyed) — NOT CreatePunches
                                (switched 2026-10-02: CreatePunches for this legal entity returned
                                inconsistent "tparnerhubapi"-tagged errors, including a confirmed-valid
                                EmployeeId rejected outright and a request that returned an ambiguous
                                2xx then "duplicate request" on retry with nothing ever created, and
                                has no delete/undo API at all). Paygrid staging is synchronous (no
                                tracking-ID/polling) and, per Paycor's own confirmation, only stages
                                data for human review — a human still reviews/submits in Paycor's own
                                UI, and a re-stage (stable processId + replaceData:true) safely
                                corrects a mistake any time before that real submit — strictly safer
                                than CreatePunches ever was. Hours still come entirely from the real
                                clock-in/clock-out data; this file's own added responsibility is
                                splitting each of the period's two Sunday-Saturday workweeks into
                                Reg (<=40 hrs) / OT (>40 hrs) independently at the standard weekly
                                FLSA threshold (`weeklyRegOtFromPunches`, src/office-clock-lib.mjs) —
                                CreatePunches would have left that to Paycor's own Time Policy engine
  office-clock-compare.mjs    — exec/IT: read-only validation — app punch counts vs. Paycor's own
                                employeePunches for the same linked employees/date range
  # ── Orion Analyst (AI) ──
  analyst.js                  — Analyst entry
  analyst-cron.js             — Scheduled analyst runs (DM briefs, anomaly scans, exec reports)
  analyst-cron-background.js  — Background analyst wrapper
  analyst-report-background.js— Long-running report generation
  analyst-lib/                — Analyst modules: anomaly, audit, cache, cases, claude,
                                data, kb, prompts, reports, reports-gen
  # ── Knowledge Base ──
  kb-search.js / kb-manage.js / kb-embed.js / kb-sync.js / kb-sync-background.js
  # ── Reports / P&L / Reconciliation ──
  pnl-cron.js / pnl-cron-background.js
  reconciliation.js / reconciliation-cron.js
  reports-backup.js
  employee-hours-report-background.mjs — exec/IT/office_staff, on-demand (Tools hub): one store, any
                                date range, per-employee hours in weekly columns + total. Combines raw
                                Paycor punches (who worked) with employeePunches (the "timecard" copy,
                                authoritative whenever available) — see this file's header for the
                                exact merge rule. Fetches the punches side ONE WEEK AT A TIME, not the
                                whole range in one call — confirmed 2026-10-08 that a busy store's full
                                multi-week punch history can take longer than Paycor's own 20s timeout
                                to assemble in a single response.
  weekly-hours-schedule-report-cron.mjs — scheduled Mon 7am ET: emails Ahmed a network-wide (all 45
                                stores) workbook for the previous Sun-Sat week — Timecard sheet (raw
                                Paycor punches only, NOT the employeePunches-reconciled version the
                                on-demand tool above uses, to keep a 45-store weekly job fast) + Schedule
                                sheet (posted Paycor shifts). Recipient is hardcoded, not a notify list.
                                Dates shown as MM/DD/YYYY; internal logic/Paycor calls stay ISO.
  weekly-hours-schedule-report-manual-background.mjs — exec/IT manual trigger for the above, for a
                                specific past week (`{ weekStart?, weekEnd? }`, ISO, defaults to the
                                same previous-week calc) — scheduled fns can't be hit over HTTP, same
                                reason no-clockin.mjs exists alongside no-clockin-cron.mjs.
  paycor-webhook-background.mjs — receives Paycor's Time.Punch.Data webhook events and runs a
                                targeted tips reconcile (runReconcileForDates, tips-reconcile-cron.mjs)
                                for just the affected store the moment a DM/manager manually edits a
                                punch in Paycor — real-time fix for the gap where a manual mid-period
                                correction older than the daily reconcile's 3-day window would
                                otherwise only self-correct once that period's finalize-gate settle
                                pass runs at period close (2026-10-02). UNVERIFIED payload shape
                                (built from Paycor's publicly documented event fields, not a
                                confirmed real delivery yet) — defensive by design: logs the full raw
                                payload every time, debounces per store (60s), and only ever reconciles
                                a bounded 3-day window for the one affected store even if parsing is
                                incomplete. Signature verification via `PAYCOR_WEBHOOK_SECRET` is
                                skipped (with a loud warning) until that env var is set — safe to
                                deploy ahead of actually registering the webhook with Paycor, but set
                                it immediately once registered. Registration itself is manual, via
                                paycor.mjs's `registerWebhook`/`listWebhooks` actions (exec/it only) —
                                not yet exercised against production.
  # ── Construction / Projects (Philadelphia open data) ──
  philly-data.js              — 6 city APIs: property, licenses, violations, 311, crime, appeals
  philly-zoning.js            — Zoning + AIS address normalization (OPA lookup)
  # ── Food Cost ──
  food-cost.js                — Food cost catalog + recipe/BOM matching
  # ── Notifications / Comms ──
  notify.js                   — Email via Resend
  email-send.js               — Email via Google SMTP (nodemailer)
  email-sync-cron.js          — Hourly Gmail inbox poll (Google service account)
  push.js                     — Web push subscription mgmt + send (VAPID)
  sms.js                      — SMS via Twilio
  # ── Storage / DB / Auth / Misc ──
  storage.js                  — Netlify Blobs CRUD wrapper
  db.js                       — Neon Postgres client (NEON_DATABASE_URL)
  db-migrate.js               — Manual schema migration trigger
  trusted-devices.js          — 2FA trusted-device registry (Netlify Blobs)
  mcp.js                      — MCP endpoint: exposes Pulse/Labor/Analyst as MCP tools
  weather-forecast-cron.js    — Daily weather forecast
  reviews-cron.js / reviews-cron-background.js — Google Reviews + sentiment
  daily-feed.js               — Daily quotes + news headlines
```

### MCP Endpoint
`mcp.js` exposes Pulse, Labor, and Orion Analyst data as MCP tools over HTTP at
`https://pcg-ops.netlify.app/.netlify/functions/mcp` (auth: `Bearer $PCG_MCP_SECRET`).
Compatible with Claude Desktop / Claude Code / any MCP client.

---

## Deployment

### Commands
```bash
npm run build                # Rebuild app.js from app.jsx (DO THIS before deploying)
npx netlify deploy --prod    # Production deploy (from project root)
npx netlify deploy           # Preview deploy
npx netlify status           # Check auth + site link
```

### Scheduled Functions
| Function | Schedule (UTC) | Notes |
|----------|----------------|-------|
| `labor-cron` | `0 11,16,21 * * *` | 7am/12pm/5pm ET labor aggregation |
| `labor-cron-warmup` | `45 3 * * 0` | Sat 11:45pm ET warmup |
| `pulse-cron` | `0 2 * * *` | 9pm ET daily sales notify |
| `pulse-hourly-snapshot` | `30 2 * * *` | sales + weather snapshot |
| `analyst-cron` | `0 11,14 * * *` | DM briefs + anomaly/exec reports |
| `schedule-alerts` | `0 10 * * 1,4` | Mon/Thu 6am ET labor risk alerts |
| `weekly-hours-schedule-report-cron` | `0 11 * * 1` | Mon 7am ET; emails Ahmed a network-wide (all 45 stores) workbook — Timecard sheet (raw Paycor punches, not the employeePunches-reconciled version the Tools-hub Hours Report uses) + Schedule sheet (posted shifts), both for the previous Sun–Sat week |
| `no-clockin-cron` | `*/15 * * * *` | log-only until `NO_CLOCKIN_LIVE=true`; scheduled shifts with no punch |
| `minor-timecard-detect-cron-background` | `0 10 * * 0` | Sun 6am ET; log-only until `MINOR_TIMECARD_LIVE` is set; PA under-18 break violations for the closed week |
| `minor-timecard-followup-cron` | `30 11 * * *` | 7:30am ET daily re-check/escalation; **90 min after detect on purpose** — both write `pcg_minor_timecard_issues_v1` |
| `reports-backup` | `59 4 * * *` | nightly rolling 7-day backup |
| `kb-sync-background` | `0 10 * * 1` | Mon weekly Drive KB sync |
| `reconciliation-cron` | `1 4 * * 0,2` | Sun snapshot / Tue compare |
| `weather-forecast-cron` | `0 12 * * *` | 8am ET forecast |
| `reviews-cron` | `0 5 * * 0` | Sun Google Reviews + sentiment |
| `pnl-cron` | `0 11 1 * *` | 1st-of-month P&L |
| `kb-embed` | manual (60s timeout) | embed after KB article approval |
| `db-migrate` | manual (30s timeout) | create/update Postgres schema |

> Note: `email-sync-cron` is in the codebase; its hourly schedule is currently commented out in `netlify.toml`.

### Manual Trigger Limitations
HTTP POST to functions has a **26-second timeout** (Pro plan). Heavy jobs (labor over 45 stores, analyst reports, P&L) use **background functions** (`*-background.js`, 15-min timeout): fire-and-forget POST, then poll the result blob every ~5s until it changes.

---

## External APIs

### Paycor (Payroll & HR)
- **Base URL:** `https://apis.paycor.com/v1`
- **Auth:** OAuth 2.0 refresh token flow. Tokens cached in-memory in the function.
- **Key Endpoints:** `/legalentities/{id}/employees?include=All`, `/employees/{id}/payrates`, `/legalentities/{id}/punches`, `/employees/{id}/employeePunches`, `/legalentities/{id}/schedulingShifts`
- **Critical Gotchas:**
  - Employee IDs differ between `/employees` and `/punches` — match by **name**, not ID
  - `schedulingShifts` and `employeePunches` share the same employee IDs
  - Filter employees on `statusData.status === 'Active'`
  - Token mutex in labor-cron prevents concurrent refresh races

### Pulse POS (Dunkin')
- **Base URL:** `https://pos-ra.dunkindonuts.com`
- **Routes:** `/p227` (Willits only), `/p228` (all others)
- **Auth:** `x-api-key` + `Api-Key` headers
- **Key Endpoints:** `getOperationsDailyTotals`, `getGuestChecks`, `getTenderMediaDailyTotals`, `getMenuItemDailyTotals`, `getOrderTypeDailyTotals`, `getLatestBusDt`

### Philadelphia Open Data (Construction/Projects)
- `philly-data.js` — property, licenses, violations, 311, crime, appeals (6 APIs)
- `philly-zoning.js` — zoning + AIS address normalization (e.g. `9375` → `9367-75` via OPA lookup)

### Other Services
| Service | Purpose | Auth | Function |
|---------|---------|------|----------|
| Anthropic (Claude) | Orion analyst AI | `@anthropic-ai/sdk` | analyst-lib/analyst-claude.js |
| Resend | Email | `RESEND_API_KEY` | notify.js |
| Google SMTP | Email (nodemailer) | `GOOGLE_SMTP_*` | email-send.js |
| Gmail API | Inbox sync | `GOOGLE_SERVICE_ACCOUNT_KEY` | email-sync-cron.js |
| Google Places | Reviews/location | `GOOGLE_PLACES_API_KEY` | reviews-cron.js |
| Twilio | SMS | SID + token | sms.js |
| Web Push | Browser push | VAPID keys | push.js |

---

## Data Storage

### Neon Postgres (relational — `db/schema.ts`)
Tables: `users`, `tickets`, `ticket_comments`, `business_cases`, `chat_messages`, `chat_channels`, `notifications`, `audit_log`.
- Client: `netlify/functions/db.js` → `neon(process.env.NEON_DATABASE_URL)`
- Migrations: `db-migrate.js` (manual trigger) / drizzle-kit → `netlify/database/migrations`
- Office Hourly Time Clock adds 4 self-created tables (same `CREATE TABLE IF NOT EXISTS` pattern as
  `tickets.mjs`/`incident-reports.mjs` — not in `db/schema.ts`, created lazily by the functions that
  use them): `office_clock_punches` (every punch — live, manual edit, or admin-inserted; `paycor_status`
  tracks unsent/confirmed/failed — set per-user from a paygrid stage result, not per-punch from Paycor,
  since staging is one call per employee covering their whole period, not one call per punch),
  `office_clock_activity_types` (cached Work/Meal Paycor ActivityTypeId GUIDs per legal entity — a
  leftover from the original CreatePunches write path, unused by the current paygrid-staging path but
  kept in case CreatePunches is ever revisited), `office_clock_pay_period_sends` (audit trail of each
  "Send to Paycor" attempt), `office_clock_period_overrides` (manual lock/unlock per period, added
  2026-10-02 — see below). Only the CURRENT biweekly pay period (same anchor as Paycor's own pay-group
  frequency) is freely editable by default; every other period locks automatically the instant it's no
  longer current, regardless of send/confirm status — "the actual past shouldn't be editable." It is
  ALSO locked ("finalized") once a send has actually been triggered, at least one punch exists for the
  period (an empty period is never "finalized" just because nothing was outstanding), AND every punch
  for that period is `confirmed` (`isPeriodFinalized`, a DB-backed check in `office-clock-review.mjs`,
  shared with `office-clock-send-background.mjs`) — "confirmed" here means Paycor accepted that
  employee's staged paygrid entry, NOT that a human has reviewed/submitted it in Paycor's own UI (that
  real payroll-submit step still happens there, outside this app, by design — paygrid staging is
  deliberately non-destructive and correctable via the same stable processId + `replaceData:true` any
  time before it does). A send with any `unsent`/`pending`/`failed` punches left over keeps the period
  open so IT can fix and resend. exec/IT can deliberately unlock a past (not-current) period to add a
  forgotten punch or fix one Paycor hasn't confirmed yet (`unlockPeriod`/`lockPeriod` actions, audit-
  logged to both `office_clock_period_overrides` and `audit_log`) — this NEVER bypasses the separate,
  unconditional rule that a punch Paycor has already confirmed can only be corrected in Paycor's own
  timecard editor. `payPeriodEndFor` in `src/office-clock-lib.mjs` is still the single source of truth
  for period boundaries, shared by the punch, review, and send-background functions.

### Netlify Blobs (`pcg-portal` store)
All blobs use `{ savedAt, data }` wrapper for `cloudLoad` compatibility.

| Key Pattern | Contents | Updated By |
|-------------|----------|------------|
| `pcg_labor_v1` | Network labor summary | labor-cron |
| `pcg_labor_store_{pc}` | Per-store daily/weekly labor history | labor-cron |
| `pcg_schedule_{pc}` | 7-day Paycor schedule per store | labor/schedule |
| `pcg_schedule_alerts_v1` | Schedule risk alert log | schedule-alerts |
| `pcg_push_subscriptions_v1` | Push subscriptions by user | push.js |
| `pcg_trusted_devices_v1` | 2FA trusted devices | trusted-devices.js |
| `pcg_pulse_notify_last_run` | Last pulse notify timestamp | pulse-notify.js |
| Scorecard/report/project keys | User uploads, daily reports, photos | storage.js |

---

## Store Configuration
45 stores across 8 districts. Each store has: `pc` (Pulse Cloud store #, primary key), `paycor` (Legal Entity ID), `name`, `district` (1-8), `mgr`/`mgrPhone`/`email`, `baseAsset` (DT/IL/FS/GS).
**Special case:** Willits (`pc: 345986`) uses Pulse route `p227`; all others use `p228`.
> Store lists are duplicated across functions (e.g. `labor-cron.js`, `schedule-alerts.js`) — keep them in sync.

---

## User Roles & Permissions

| userType | Label | Admin | Scope |
|----------|-------|-------|-------|
| `executive` | VP | Yes | Full access |
| `it` | IT/HR Admin | Yes | Full access + user management |
| `office_staff` | Office Staff | No | Base tabs + read-only admin views |
| `dm` | District Manager | No | Base tabs + admin views filtered to their district; DM Scorecard |
| `manager` | Store Manager | No | Base tabs + My Store mobile mode |
| `construction` | Construction | No | Projects / Construction (incl. mobile construction view) |
| `maintenance` | Maintenance | No | Tickets + Calendar + expense tracking/approvals |
| `vendor` | Vendor | No | Projects tab only |
| `kiosk_pulse` | Kiosk TV | No | Pulse TV display only |
| `kiosk_upload` | Kiosk Upload | No | Upload-only kiosk |

---

## Theme System
Two themes: **DARK** and **LIGHT** (defined in `src/theme.js`). Toggled via `ThemeToggle` with animated ripple.
- **Brand orange:** `#FF671F` (`O`); dark variant `#cc4f12` (`Od`)
- **Labor thresholds:** Green ≤22.9%, Yellow 23-25.9%, Red ≥26%
- `getTheme(dark)` returns the theme object (`bg`, `card`, `text`, `muted`, `sidebar`, …)
- Helpers (in `src/theme.js`): `btn(th, overrides)`, `inp(th)`, `card(th)`, `accentCard(th)`

---

## Major Sections

- **Dashboard** — links, todos, daily feed, store status grid, project status, announcements
- **Pulse** (`AdminPulse`) — POS sales: store grid, store detail (hourly chart, tender, menu, order types), district detail
- **Labor** (`AdminLabor` + `LaborDrillDown`) — KPI cards, store grid by labor %, hourly labor vs sales, daily/weekly history, live employee status; **Labor Optimizer** (smart staffing recommendations)
- **Map** — Real-Time Operations Map (full-page, store detail panel, legend)
- **Projects / Construction** (`AdminProjects`) — 7-phase construction pipeline, vendor mgmt (attorneys/architects/engineers/GC w/ $), Philly zoning/permit/property APIs, contractor roster, doc viewer (chunked upload for 11MB+ files), phase notes, inspections, At-A-Glance export
- **Maintenance** — tickets, calendar, expense tracking/approvals, photo log
- **Food Cost** — catalog + recipe/BOM matching, per-item unit cost, category drill-down
- **Cash Management** — deposit tracking, POS cash reconciliation, bank deposit verification
- **Chat** — channels per store/district + DMs, @mentions, notifications
- **Orion Analyst** — AI ops copilot: DM briefs, anomaly detection 2.0, action queue, auto P&L, weather correlation, review sentiment, KB-grounded answers

---

## Development Guidelines

### Workflow (build before commit!)
1. Edit `app.jsx` (or `src/icons.jsx` / `src/theme.js`)
2. `npm run build` (or run `npm run watch` while developing)
3. Bump the `APP_VERSION` constant in `app.jsx` (search `const APP_VERSION =`)
4. Commit **both** the JSX source and the regenerated `app.js`
5. `npx netlify deploy --prod`

### Version Bumping
**Always increment `APP_VERSION`** (in `app.jsx`) on every code change. It feeds both the sidebar footer and the Admin · System "Portal version / live build" field, so they stay in sync.

### Code Style
- React components are plain functions; use `useState`/`useEffect` (destructured from `React` at top of `app.jsx`)
- Inline styles everywhere — `style={{ ... }}`
- No TypeScript in the frontend (DB schema/config is TS)
- Format numbers: `fmtDollars(n)` for currency, `fmtPct(n)` for percentages
- Icons and theme come from `src/` — import from `./src/icons.jsx` and `./src/theme.js`

### Adding New Tabs
1. Add to the tab list / `getTabs()` in `app.jsx`
2. Add the component function
3. Add routing in the main `PCGPortal` return (search `{tab ===`)
4. Gate visibility via `userType` checks

### Adding New Netlify Functions
1. Create `netlify/functions/myfunction.js` with `exports.handler`
2. Scheduled: add `[functions.myfunction]` + `schedule` in `netlify.toml`
3. Background (15-min timeout): name it `myfunction-background.js`
4. Deploy: `npx netlify deploy --prod`

### Data Flow Pattern
```
External API → Netlify Function (proxy/cron) → Netlify Blob / Neon → Frontend (cloudLoad / direct fetch)
```

### Environment Variables (Netlify)
| Variable | Purpose |
|----------|---------|
| `PAYCOR_CLIENT_ID` / `PAYCOR_CLIENT_SECRET` / `PAYCOR_SUBSCRIPTION_KEY` / `PAYCOR_REFRESH_TOKEN` | Paycor OAuth |
| `NEON_DATABASE_URL` | Neon Postgres connection |
| `PCG_SITE_ID` / `PCG_AUTH_TOKEN` | Netlify Blobs access |
| `PCG_MCP_SECRET` | Bearer auth for `mcp.js` endpoint |
| `RESEND_API_KEY` | Email (Resend) |
| `GOOGLE_SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` | Email (nodemailer) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Gmail inbox sync |
| `GOOGLE_PLACES_API_KEY` | Reviews / location |
| `GOOGLE_SHARED_MAILBOX` | Shared mailbox for email workspace |
| `NOTIFY_FROM` / `PULSE_NOTIFY_EMAIL` / `SMTP_FROM_DOMAIN` | Email sender config |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | SMS |
| `NO_CLOCKIN_LIVE` / `NO_CLOCKIN_SHADOW_USER` / `TEXTBELT_API_KEY` | no-clockin-cron mode: unset = log-only, `shadow` = alerts go ONLY to the username in `NO_CLOCKIN_SHADOW_USER` (labelled with who they'd reach), `true` = real managers/DMs; Textbelt SMS key (what sms.mjs / pulse-notify / no-clockin actually use) |
| `MINOR_TIMECARD_LIVE` / `MINOR_TIMECARD_SHADOW_EMAIL` | Minor-timecard cron mode (same 3-state shape as `NO_CLOCKIN_LIVE`): unset = log-only (detects + logs, sends nothing, writes nothing — safe to deploy unconfigured), `shadow` = every email redirected to `MINOR_TIMECARD_SHADOW_EMAIL` labelled with who it would have reached (issue state still written), `true` = real manager/DM/office-staff/exec. **Before switching `shadow` → `true`, clear the `pcg_minor_timecard_issues_v1` blob** — shadow runs write real `escalatedAt` and real `exec_backstop` notification records, which would otherwise suppress the real backstop and make a manager's first-ever email an already-escalated "Day 12" notice. Full runbook in `minor-timecard-followup-cron.mjs`'s header |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL` / `VAPID_SUBJECT` | Web push |
| `PAYCOR_WEBHOOK_SECRET` | Event Secret for verifying `paycor-webhook-background.mjs` deliveries — unset = signature verification skipped (loud warning), only safe before the webhook is actually registered with Paycor via `registerWebhook`. Set it to the secret that registration call returns. |
| `OFFICE_LEGAL_ENTITY_ID` | Office Hourly Time Clock: the office/corporate Paycor legal entity ID (`193872`, "People Capital Group LLC") — read server-side only, in `office-clock-send-background.mjs`; never client-supplied. |

---

## Common Gotchas

1. **Build before deploy** — `app.js` is the bundle of `app.jsx` + `src/*`. Edit JSX, run `npm run build`, commit both. Editing `app.js` directly will be overwritten.
2. **CDN globals** — React and libs (Chart.js, pdf.js, xlsx, jspdf, pptxgenjs, reveal.js, GSI) load from CDN in `index.html`, not bundled. Reference them as globals.
3. **Function timeout** — Manual POST = 26s max. Use background functions for heavy work.
4. **Paycor employee ID mismatch** — Different endpoints return different GUIDs for the same person. Match by name.
5. **Pulse POS routing** — Willits uses `p227`, all others `p228`.
6. **Token race condition** — Paycor token refresh uses a mutex.
7. **Blob wrapper** — All blobs stored as `{ savedAt, data }`; `cloudLoad` unwraps.
8. **Week start** — Labor uses Monday; Pulse uses Sunday.
9. **Duplicated store config** — Store arrays live in multiple functions; update all when stores change.
