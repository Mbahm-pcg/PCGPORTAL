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
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL` / `VAPID_SUBJECT` | Web push |

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
