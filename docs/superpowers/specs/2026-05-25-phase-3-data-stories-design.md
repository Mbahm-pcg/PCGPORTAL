# Phase 3: Data Stories + Scheduled Reports — Design Spec

## Goal

Add a Reports tab to the portal where Orion auto-generates and serves interactive dashboards, slide decks, and monthly P&L reports — all viewable in-app with PDF and PPTX export. Reports are also delivered via email and cross-posted to analyst chat channels.

## Architecture

**Hybrid rendering model:** Orion generates structured JSON artifacts (not raw HTML). Each artifact contains an ordered list of typed components (`kpi-grid`, `chart`, `table`, `narrative`, `ranked-list`, `comparison`). The frontend has a renderer for each component type, ensuring consistent visual quality across dark/light themes.

**Tech stack additions:**
- reveal.js 5.x (CDN) — in-browser slide presentations
- pptxgenjs 3.x (CDN) — client-side PPTX generation
- Chart.js (already loaded) — chart rendering in dashboards and decks

---

## 1. Report Artifact Model

Every report (dashboard, deck, P&L, brief) is stored as a single JSON artifact.

### Schema

```json
{
  "id": "rpt_abc123",
  "type": "dashboard | deck | pnl | brief",
  "title": "Weekly Exec Dashboard",
  "scope": "network | district:3 | store:339616",
  "createdAt": "2026-05-25T11:00:00Z",
  "createdBy": "orion | user:mike",
  "trigger": "scheduled | on-demand",
  "narrative": "Network posted $847K in sales...",
  "components": [
    { "type": "kpi-grid", "data": { "items": [...] } },
    { "type": "chart", "data": { "chartType": "bar", "labels": [...], "datasets": [...] } },
    { "type": "table", "data": { "columns": [...], "rows": [...] } }
  ]
}
```

### Storage

- Individual artifact: `analyst/reports/{id}` (blob, `{ savedAt, data }` wrapper)
- Feed index: `analyst/reports-index` (blob, array of `{ id, type, title, scope, createdAt, trigger, createdBy }`)
- Read tracking: `analyst/reports-read/{userId}` (blob, array of read report IDs)

### ID generation

`rpt_{timestamp}_{random4}` — e.g. `rpt_1716649200_a7f2`

---

## 2. Component Types

Six component types. The frontend renders each via a `ReportComponent({ component, theme })` switch function.

| Type | Renders | Data Shape |
|------|---------|------------|
| `kpi-grid` | Row of KPI cards with value, delta, color | `{ items: [{ label, value, delta, color }] }` |
| `chart` | Chart.js chart (bar, line, doughnut, stacked) | `{ chartType, labels, datasets, options }` — standard Chart.js config |
| `table` | Sortable data table | `{ columns: [{ key, label }], rows: [...], highlight: { key, condition } }` |
| `narrative` | Written analysis paragraph | `{ text, style: "summary" | "callout" | "insight" }` |
| `ranked-list` | Top/bottom performers | `{ title, items: [{ rank, name, value, delta }], direction: "top" | "bottom" }` |
| `comparison` | Side-by-side period or scope comparison | `{ periods: ["This Week", "Last Week"], metrics: [{ label, values: [v1, v2], delta }] }` |

### Rendering rules

- `kpi-grid`: 4 items per row (responsive: 2 on mobile). Each item's `color` field drives its accent color. Orion sets colors contextually (e.g., labor thresholds for labor KPIs, green/red for positive/negative deltas).
- `chart`: Rendered via Chart.js on a `<canvas>`. Dark theme: dark background, white grid lines, orange accent. Light theme: white background, gray grid lines.
- `table`: Striped rows, sticky header, max 20 visible rows with scroll. Highlight rule applies conditional coloring (e.g., labor % > 26 = red).
- `narrative`: `summary` = standard paragraph. `callout` = orange-bordered box. `insight` = italic with lightbulb icon.
- `ranked-list`: Numbered list with colored deltas. `top` = green accent, `bottom` = red accent.
- `comparison`: Grid layout, one column per period. Delta column with green/red coloring.

---

## 3. Reports Tab UI

### Tab setup

- New tab: **Reports** — added to `getTabs()` for all users
- Position: after Cash Management, before Projects (admin section of sidebar)
- Icon: chart/document icon

### Feed view

- **Filter bar** at top:
  - Type pills: All (default, orange) | Dashboards | Decks | P&L | Briefs — click to filter
  - Date dropdown: This Week | This Month (default) | Last 90 Days
- **Timeline feed** below, newest-first
- Each feed card shows:
  - Colored left border by type (orange=dashboard, purple=deck, blue=P&L, green=brief)
  - Type badge (colored pill)
  - Title (bold)
  - Metadata line: date · trigger label (Auto-generated / On-demand / Scheduled) · scope (Network / District X / Store Name)
  - One-line narrative preview (truncated)
- Click any card → opens full-page takeover
- **Unread badge** on Reports tab in sidebar — count of reports not in user's read list
- **Mark all read** button in filter bar

### Full-page takeover (dashboard detail)

- Dark semi-transparent overlay covers entire portal
- **Top bar**: close (×) button, title, date + scope, action buttons right-aligned:
  - Share — Web Share API or copy deep link
  - PDF — html2pdf export of rendered dashboard
  - Present — opens reveal.js slideshow (Section 4)
  - Download PPTX — generates PowerPoint (Section 4)
- **Body** (scrollable):
  - "Orion's Take" heading (orange, Raleway 700) + narrative component
  - Remaining components rendered in order via `ReportComponent`
- Opening a report marks it as read (updates `analyst/reports-read/{userId}` blob)

### Deep links

- URL format: `?tab=reports&report=rpt_abc123`
- PCGPortal reads URL params on load: if `report` param present, opens Reports tab and auto-opens the takeover for that artifact

### Role scoping

- Execs/IT/admin: see all reports
- DMs: see reports where `scope` is `network` or `district:{their district}`
- GMs/Managers: see reports where `scope` matches their store
- Office staff: see network reports (read-only)

---

## 4. Slide Deck Generation

Two output formats from the same artifact components.

### In-browser presentation (reveal.js)

- Click "Present" from dashboard detail → full-screen slideshow
- reveal.js 5.x loaded from CDN (`<script>` tag in index.html)
- Slide mapping from components:
  1. **Title slide**: report title, date, scope, "Generated by Orion" subtitle
  2. **Narrative slide**: "Orion's Take" — the summary text
  3. **One slide per component**: each `kpi-grid`, `chart`, `table`, `ranked-list`, `comparison` gets its own slide
  4. **Closing slide**: "Generated by Orion · PCG Unified Operations Portal" + timestamp
- Dark theme: black background, white text, orange accents (matches portal)
- Navigation: arrow keys, swipe on touch, ESC to exit
- Charts rendered live on each slide via Chart.js

### PPTX download (pptxgenjs)

- Click "Download PPTX" from dashboard detail
- pptxgenjs 3.x loaded from CDN
- Same slide mapping as reveal.js
- Charts: render Chart.js canvas → `toDataURL('image/png')` → insert as image in slide
- Tables: rendered as native PPTX tables with styled headers
- KPI grids: rendered as a row of styled text boxes
- Narratives: text slide with Orion branding
- Branding: dark background (#0b0b0c), orange accent (#FF671F), Raleway headings
- Filename: `PCG-{Title}-{Date}.pptx`

### Auto-generated decks

- Weekly exec report (analyst-cron, Sun/Tue) also creates a `type: "deck"` artifact with the same data
- Monthly P&L (pnl-cron, 1st of month) also creates a companion deck
- These appear in Reports feed with purple "Deck" badge

### On-demand decks

- User asks in analyst chat: "Create a presentation on District 3 labor trends"
- Orion generates a report artifact with `type: "deck"`, saves to blob, adds to index
- Responds in chat: "Your deck is ready" with a link to the Reports tab

---

## 5. Monthly P&L Report

### What it is

An automated operational P&L using sales (Pulse POS) and labor (Paycor) data. Not a full accounting P&L — covers the two biggest controllable line items. Full COGS/rent/utilities will come in Phase 4 when vendor connectors are built.

### Schedule

- **Function**: `pnl-cron.js` (new scheduled function)
- **Schedule**: 1st of each month, 7 AM ET (11:00 UTC)
- **Covers**: prior full calendar month

### Data sources

- **Sales**: aggregated from `pcg_labor_store_{pc}` blobs (daily history entries contain `sales` field)
- **Labor**: aggregated from same blobs (`laborDollars`, `laborHours`, `laborPct`)
- **Prior month**: same blobs, offset one month
- **Year-ago month**: same blobs, offset 12 months (if available, otherwise omitted)

### P&L artifact components (8 total)

1. `narrative` — Orion's executive summary ("April revenue was $3.4M, up 4.1% MoM...")
2. `kpi-grid` — Revenue, Labor Cost, Gross Margin (Sales - Labor), Labor %, MoM delta, YoY delta
3. `table` — Monthly P&L table: rows for Revenue, Labor, Gross Margin. Columns: This Month / Last Month / MoM Delta / Year Ago / YoY Delta
4. `chart` — Revenue vs Labor Cost trend (last 6 months, dual-axis bar+line)
5. `ranked-list` — Top 5 stores by labor % (best performers)
6. `ranked-list` — Bottom 5 stores by labor % (worst performers)
7. `comparison` — Week-over-week breakdown within the month: Week 1 / Week 2 / Week 3 / Week 4, showing Revenue, Labor $, Labor %, Gross Margin per week. Highlights best and worst week by labor %.
8. `comparison` — District-by-district breakdown: revenue, labor %, margin per district

### Scope variants

- **Network P&L**: generated for execs (scope: `network`)
- **District P&L**: generated per district for DMs (scope: `district:{N}`, 8 total)

### netlify.toml entry

```toml
[functions.pnl-cron]
  schedule = "0 11 1 * *"
```

---

## 6. In-App Delivery

### Reports tab as inbox

- Every artifact saved to `analyst/reports-index` automatically appears in the feed
- No separate inbox UI — the Reports tab IS the inbox
- Email delivery continues in parallel for DM briefs and exec reports

### Email enhancement

- Existing email templates (DM briefs, exec reports) get a "View in Portal" button
- Button links to `https://pcg-ops.netlify.app/?tab=reports&report={id}`
- Email continues to contain the full report content (not just a link)

### Unread tracking

- Blob: `analyst/reports-read/{userId}` — array of read report IDs
- Reports tab sidebar badge: count of reports in index minus count in read list (filtered by role scope)
- Opening a report adds its ID to the read list
- "Mark all read" button clears the badge

### Chat cross-posting

- When analyst-cron or pnl-cron generates a report, it also posts a message in the relevant analyst chat channel
- Message format: "New {type} ready: {title} — [View in Reports](?tab=reports&report={id})"
- Channel selection: exec reports → #analyst-exec, DM briefs → #analyst-ops, on-demand → the channel where the user asked
- On-demand dashboards requested via chat get a reply with the link

---

## 7. Report Generation Pipeline

### Auto-generated reports (cron)

Existing `analyst-cron.js` is extended to also produce report artifacts:

1. After generating DM briefs → save each as a `type: "brief"` artifact (scope: `district:{N}`)
2. After generating exec weekly report → save as `type: "dashboard"` artifact (scope: `network`) + companion `type: "deck"` artifact
3. New `pnl-cron.js` → generates `type: "pnl"` artifacts (network + per-district)

Each generation:
1. Builds data context (reuses `buildDataContext` / `buildKPISnapshot`)
2. Calls Claude to generate narrative + select component types
3. Assembles artifact JSON with real data in component `data` fields
4. Saves artifact blob
5. Appends to reports index
6. Posts chat cross-post message
7. (For briefs/exec reports) Sends email with "View in Portal" link added

### On-demand reports (analyst.js)

New action in `analyst.js`: `action: "create-report"`

```json
{
  "action": "create-report",
  "prompt": "Create a dashboard showing District 3 labor trends this month",
  "userId": "mike",
  "userRole": "executive",
  "scope": "district:3"
}
```

Flow:
1. Analyst builds scoped data context
2. Calls Claude with a `REPORT_SYSTEM` prompt that instructs it to return structured JSON with component array
3. Assembles artifact, saves to blob + index
4. Returns artifact ID to frontend
5. Frontend posts chat message with link and can auto-open the report

### Prompt engineering

New prompt template `REPORT_SYSTEM` in `analyst-prompts.js`:
- Instructs Orion to analyze the data and produce a JSON response with `narrative` and `components` array
- Each component must have a valid `type` and `data` matching the component schema
- Orion chooses which components best tell the story (not every report needs all 6 types)
- Max 8 components per report to keep things focused

---

## 8. New Files

| File | Purpose |
|------|---------|
| `netlify/functions/pnl-cron.js` | Scheduled monthly P&L generation |
| `netlify/functions/analyst-lib/analyst-reports-gen.js` | Report artifact generation logic (shared by cron + on-demand) |

### Modified files

| File | Changes |
|------|---------|
| `app.jsx` | New `ReportsTab` component, `ReportComponent` renderer, `ReportDetailModal` (takeover), `SlidePresenter` (reveal.js), `PPTXExporter`, unread badge logic |
| `index.html` | Add reveal.js + pptxgenjs CDN script tags |
| `netlify/functions/analyst.js` | New `create-report` action |
| `netlify/functions/analyst-cron.js` | Save artifacts after generating briefs/exec reports, chat cross-post |
| `netlify/functions/analyst-lib/analyst-prompts.js` | New `REPORT_SYSTEM` prompt template |
| `netlify/functions/analyst-lib/analyst-reports.js` | Add "View in Portal" link to email templates |
| `netlify.toml` | Add `pnl-cron` schedule |

---

## 9. CDN Dependencies

Added to `index.html` `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.min.css">
<script src="https://cdn.jsdelivr.net/npm/pptxgenjs@3/dist/pptxgen.bundle.js"></script>
```

Both are loaded but only initialized when the user clicks "Present" or "Download PPTX" — no performance impact on normal page loads.
