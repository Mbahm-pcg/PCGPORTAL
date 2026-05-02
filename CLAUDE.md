# PCG Company Portal — CLAUDE.md

## Project Overview
**PCG Unified Operations Portal (UOP)** — A single-page React application (no build step) serving as the internal operations dashboard for People Capital Group, a Dunkin' franchise operator with 45+ stores across 8 districts in the Philadelphia region.

**Live URL:** https://pcg-ops.netlify.app
**Hosting:** Netlify (Pro plan) — static SPA + serverless functions + Netlify Blobs storage
**Version:** Track in sidebar footer (currently v4.82). **Increment on every code change.**

---

## Architecture

### Tech Stack
- **Frontend:** React 18.2.0 via CDN (Babel standalone transpiler, no build step)
- **Backend:** Netlify Functions (Node.js serverless)
- **Storage:** Netlify Blobs (`pcg-portal` store) + localStorage for client state
- **Styling:** Inline `style={}` objects — no CSS framework (no Tailwind, no Bootstrap)
- **Fonts:** Google Fonts — Raleway (headings, 600-900), Source Sans 3 (body, 300-700)
- **PWA:** Service worker for push notifications, manifest.json for installability

### File Structure
```
index.html              — Entire SPA (16,500+ lines, all components inline)
sw.js                   — Service worker (push notifications)
manifest.json           — PWA manifest
netlify.toml            — Build config, scheduled functions, headers
package.json            — Dependencies (@netlify/blobs, web-push, resend, twilio)
netlify/functions/
  labor-cron.js          — Scheduled: labor cost aggregation (every 4h)
  labor-cron-background.js — Background wrapper for manual refresh (15min timeout)
  paycor.js              — Paycor API OAuth proxy
  pulse.js               — Pulse POS API proxy (CORS bypass)
  pulse-cron.js          — Scheduled: daily notifications wrapper (2 AM UTC)
  pulse-notify.js        — Daily sales notification builder (push + email)
  notify.js              — Email sender via Resend API
  push.js                — Web push subscription management + send
  sms.js                 — SMS via Twilio
  storage.js             — Netlify Blobs CRUD wrapper
  daily-feed.js          — Daily quotes + news headlines
```

### Key Principle: Single-File SPA
Everything lives in `index.html`. There is no build step, no bundler, no JSX compilation at build time. React and Babel are loaded from CDN. All components are plain functions using `React.useState`, `React.useEffect`, etc. This is intentional — do NOT refactor into a multi-file build system.

---

## Deployment

### Commands
```bash
npx netlify deploy --prod    # Production deploy (run from project root)
npx netlify deploy           # Preview deploy
npx netlify status           # Check auth + site link
```

### Scheduled Functions
| Function | Schedule | Timeout |
|----------|----------|---------|
| `labor-cron` | `0 */4 * * *` (every 4h) | 15 min (scheduled) |
| `pulse-cron` | `0 2 * * *` (2 AM UTC / 9 PM ET) | 15 min (scheduled) |

### Manual Trigger Limitations
Netlify functions triggered via HTTP POST have a **26-second timeout** (Pro plan). The labor cron processes 45 stores and exceeds this. Use `labor-cron-background` (Netlify background function, 15-min timeout) for manual refresh. The Refresh button on the Labor tab uses this pattern: fire-and-forget POST to background function, then poll the blob every 5s until `lastUpdated` changes.

---

## External APIs

### Paycor (Payroll & HR)
- **Base URL:** `https://apis.paycor.com/v1`
- **Auth:** OAuth 2.0 refresh token flow. Tokens cached in-memory in the function.
- **Key Endpoints:**
  - `/legalentities/{id}/employees?include=All` — Employee list
  - `/employees/{id}/payrates` — Pay rates
  - `/legalentities/{id}/punches?startDate=X&endDate=X` — Completed shifts only
  - `/employees/{id}/employeePunches?startDate=X&endDate=X` — Individual punch events (live clock-in detection: odd count = in)
  - `/legalentities/{id}/schedulingShifts?startDate=X&endDate=X` — Scheduled shifts (Paycor Scheduling system)
- **Critical Gotchas:**
  - Employee IDs differ between `/employees` and `/punches` endpoints — match by name, not ID
  - `schedulingShifts` and `employeePunches` share the same employee IDs
  - Filter employees on `statusData.status === 'Active'`
  - Token mutex in labor-cron prevents concurrent refresh race conditions

### Pulse POS (Dunkin' Point of Sale)
- **Base URL:** `https://pos-ra.dunkindonuts.com`
- **Routes:** `/p227` (Willits store only), `/p228` (all other stores)
- **Auth:** `x-api-key` + `Api-Key` headers
- **Key Endpoints:** `getOperationsDailyTotals`, `getGuestChecks`, `getTenderMediaDailyTotals`, `getMenuItemDailyTotals`, `getOrderTypeDailyTotals`, `getLatestBusDt`

### Other Services
| Service | Purpose | Auth | Function |
|---------|---------|------|----------|
| Resend | Email notifications | API key (`RESEND_API_KEY`) | notify.js, pulse-notify.js |
| Twilio | SMS alerts | SID + Auth Token | sms.js |
| Web Push | Browser push notifications | VAPID keys | push.js |
| ZenQuotes | Daily quotes | Public | daily-feed.js |

---

## Netlify Blobs (Data Storage)

All blobs use store name `pcg-portal` with `{ savedAt, data }` wrapper for `cloudLoad` compatibility.

| Key Pattern | Contents | Updated By |
|-------------|----------|------------|
| `pcg_labor_v1` | Network labor summary: all stores' today + WTD labor $, sales, labor %, scheduled counts | labor-cron (4h) |
| `pcg_labor_store_{pc}` | Per-store daily (30 entries) + weekly (13 entries) history | labor-cron (4h) |
| `pcg_push_subscriptions_v1` | Push notification subscription objects by user | push.js |
| `pcg_pulse_notify_last_run` | Last pulse notification timestamp | pulse-notify.js |
| Scorecard/report keys | User-uploaded data, daily reports, project photos | storage.js |

---

## Store Configuration

45 stores across 8 districts. Each store has:
- `pc` — Pulse Cloud store number (used as primary key)
- `paycor` — Paycor Legal Entity ID
- `name` — Store name
- `district` — District number (1-8)
- `mgr`, `mgrPhone`, `email` — Manager info
- `baseAsset` — Asset type (DT=drive-thru, IL=inline, FS=freestanding, GS=gas station)

**Special case:** Willits (pc: `345986`) uses Pulse route `p227`; all others use `p228`.

---

## User Roles & Permissions

| userType | Label | Admin | Scope |
|----------|-------|-------|-------|
| `executive` | VP | Yes | Full access to everything |
| `it` | IT/HR Admin | Yes | Full access + user management |
| `office_staff` | Office Staff | No | Base tabs + read-only admin views |
| `dm` | District Manager | No | Base tabs + admin views filtered to their district |
| `manager` | Store Manager | No | Base tabs only |
| `vendor` | Vendor | No | Projects tab only |
| `kiosk_pulse` | Kiosk TV | No | Pulse TV display only |
| `kiosk_upload` | Kiosk Upload | No | Upload-only kiosk |

### Tab Visibility
- **All users:** Dashboard, Links, Contacts, Notes, To-Do, Chat, Announcements
- **Admin tabs (exec/IT):** Locations, Analytics, Pulse, Labor, Cash, Projects, Users, Settings
- **Office staff:** Locations, Analytics, Pulse, Labor, Projects (read-only)
- **DMs:** Locations, Pulse, Labor, Cash, Projects (filtered to their district)

---

## Theme System

Two themes: **DARK** and **LIGHT**. Toggled via `ThemeToggle` component with animated ripple transition.

### Colors
- **Brand orange:** `#FF671F`
- **Labor thresholds:** Green (#4caf50) ≤22.9%, Yellow (#ff9800) 23-25.9%, Red (#f44336) ≥26%
- **Theme objects** returned by `getTheme(dark)` — contains `bg`, `card`, `text`, `muted`, `sidebar`, etc.

### Styling Helpers
```javascript
btn(th, overrides)  // Button styles
inp(th)             // Input styles  
card(th)            // Card styles
```

---

## Major Sections

### Dashboard (`Dashboard` component)
Main landing page. Shows links, todos, daily feed, store status grid, project status, announcements.

### Pulse (`AdminPulse` component)
POS sales dashboard. Two levels:
- **Store grid** — All stores with daily sales, colored by performance
- **Store detail** (`StoreDetail`) — Hourly sales chart, tender breakdown, menu items, order types
- **District detail** (`DistrictDetail`) — Aggregated district data with Sales by Day (this week vs last week), Sales by Hour chart, forecast attainment

### Labor (`AdminLabor` + `LaborDrillDown`)
Labor cost dashboard:
- **Dashboard** — KPI cards (Total Labor, Avg Labor %, Total Sales, Scheduled Now), store grid sorted by labor %
- **Drill-down** — Hourly labor vs sales chart, daily/weekly history tabs, employee panel with live status (Clocked In / Scheduled / Shift Today / Off)

### Projects (`AdminProjects`)
Construction/remodel project tracker with phases, photos, daily reports, and team chat per project.

### Cash Management (`CashManagement`)
Deposit tracking, POS cash reconciliation, bank deposit verification.

### Chat (`ChatSection`)
Team messaging with channels per store/district + DMs. Supports @mentions, notifications.

---

## Development Guidelines

### Version Bumping
**Always increment the version** in the sidebar footer on every code change. Search for `v4.XX` in index.html (near the end, in sidebar content).

### Code Style
- All React components are plain functions (not classes)
- Use `React.useState`, `React.useEffect` (no import destructuring)
- Inline styles everywhere — `style={{ ... }}`
- No TypeScript, no JSX files — everything is in one `index.html`
- Format numbers: `fmtDollars(n)` for currency, `fmtPct(n)` for percentages

### Adding New Tabs
1. Add to `BASE_TABS` or conditional admin tabs in `getTabs()` function
2. Add the component function
3. Add the tab routing in the main `PCGPortal` return (search for `{tab ===`)
4. Control visibility via `userType` checks in `getTabs()`

### Adding New Netlify Functions
1. Create `netlify/functions/myfunction.js` with `exports.handler`
2. For scheduled functions: add `[functions.myfunction]` + `schedule` in `netlify.toml`
3. For background functions: name file `myfunction-background.js` (gets 15-min timeout)
4. Deploy: `npx netlify deploy --prod`

### Data Flow Pattern
```
External API → Netlify Function (proxy/cron) → Netlify Blob → Frontend (cloudLoad)
                                                             → Frontend (direct fetch for live data)
```

### Environment Variables (Netlify)
| Variable | Purpose |
|----------|---------|
| `PAYCOR_CLIENT_ID` | Paycor OAuth |
| `PAYCOR_CLIENT_SECRET` | Paycor OAuth |
| `PAYCOR_SUBSCRIPTION_KEY` | Paycor API subscription |
| `PAYCOR_REFRESH_TOKEN` | Paycor OAuth refresh token |
| `PCG_SITE_ID` | Netlify site ID (for Blobs) |
| `PCG_AUTH_TOKEN` | Netlify auth token (for Blobs) |
| `RESEND_API_KEY` | Email service |
| `TWILIO_ACCOUNT_SID` | SMS service |
| `TWILIO_AUTH_TOKEN` | SMS service |
| `TWILIO_FROM_NUMBER` | SMS sender number |
| `VAPID_PUBLIC_KEY` | Web push (public) |
| `VAPID_PRIVATE_KEY` | Web push (private) |
| `VAPID_EMAIL` | Web push contact email |

---

## Common Gotchas

1. **Single-file SPA** — Everything is in `index.html`. Don't try to split into files.
2. **No build step** — React/Babel load from CDN. Just edit and deploy.
3. **Function timeout** — Manual POST to functions = 26s max. Use background functions for heavy work.
4. **Paycor employee ID mismatch** — Different endpoints return different GUIDs for the same person. Match by name when cross-referencing.
5. **Pulse POS routing** — Willits uses `p227`, all others use `p228`.
6. **Token race condition** — Paycor token refresh uses a mutex to prevent concurrent refreshes.
7. **Blob wrapper** — All blobs are stored as `{ savedAt, data }`. The `cloudLoad` helper unwraps this.
8. **Week start** — Labor uses Monday as week start. Pulse uses Sunday.
