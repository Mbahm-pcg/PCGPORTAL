# Phase 3: Data Stories + Scheduled Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Reports tab with Orion-generated dashboards, slide decks, monthly P&L, and in-app report delivery with PDF/PPTX export.

**Architecture:** Hybrid rendering model — Orion generates structured JSON artifacts with typed components (kpi-grid, chart, table, narrative, ranked-list, comparison). Frontend has a renderer per component type. Same artifact serves feed view, full-page takeover, reveal.js slides, and PPTX download. Reports stored as blobs with a feed index.

**Tech Stack:** React 18 (CDN, no build step beyond Babel), Chart.js 4.x (CDN, new), reveal.js 5.x (CDN, new), pptxgenjs 3.x (CDN, new), Netlify Functions, Netlify Blobs.

**Spec:** `docs/superpowers/specs/2026-05-25-phase-3-data-stories-design.md`

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `netlify/functions/analyst-lib/analyst-reports-gen.js` | Report artifact generation: build components from data, save artifact + index, read tracking |
| `netlify/functions/pnl-cron.js` | Scheduled monthly P&L generation (1st of month) |

### Modified Files
| File | Changes |
|------|---------|
| `index.html` | Add Chart.js, reveal.js, pptxgenjs CDN tags |
| `app.jsx` | ReportsTab, ReportComponent, ReportDetailModal, SlidePresenter, PPTXExporter, unread badge, deep links, getTabs update |
| `netlify/functions/analyst.js` | New `create-report` action for on-demand dashboards |
| `netlify/functions/analyst-cron.js` | Save report artifacts after generating briefs/exec reports, chat cross-post |
| `netlify/functions/analyst-lib/analyst-prompts.js` | New `REPORT_SYSTEM` prompt + `PNL_SYSTEM` prompt |
| `netlify/functions/analyst-lib/analyst-reports.js` | Add "View in Portal" link to wrapEmail |
| `netlify.toml` | Add `pnl-cron` schedule |

---

## Task 1: Report Artifact Storage Layer

**Files:**
- Create: `netlify/functions/analyst-lib/analyst-reports-gen.js`

This task builds the backend module that all other tasks depend on for saving and loading report artifacts.

- [ ] **Step 1: Create analyst-reports-gen.js with core functions**

```javascript
// netlify/functions/analyst-lib/analyst-reports-gen.js
const { cacheLoad, cacheSave } = require('./analyst-cache');

function generateReportId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  return `rpt_${ts}_${rand}`;
}

async function saveReport(artifact) {
  if (!artifact.id) artifact.id = generateReportId();
  if (!artifact.createdAt) artifact.createdAt = new Date().toISOString();
  await cacheSave(`analyst/reports/${artifact.id}`, artifact);
  const index = (await cacheLoad('analyst/reports-index')) || [];
  index.unshift({
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    scope: artifact.scope,
    createdAt: artifact.createdAt,
    trigger: artifact.trigger,
    createdBy: artifact.createdBy,
  });
  if (index.length > 200) index.length = 200;
  await cacheSave('analyst/reports-index', index);
  return artifact.id;
}

async function loadReport(id) {
  return cacheLoad(`analyst/reports/${id}`);
}

async function getReportsIndex() {
  return (await cacheLoad('analyst/reports-index')) || [];
}

async function markReportRead(userId, reportId) {
  const key = `analyst/reports-read/${userId}`;
  const read = (await cacheLoad(key)) || [];
  if (!read.includes(reportId)) {
    read.push(reportId);
    if (read.length > 500) read.splice(0, read.length - 500);
    await cacheSave(key, read);
  }
}

async function getReadReportIds(userId) {
  return (await cacheLoad(`analyst/reports-read/${userId}`)) || [];
}

module.exports = { generateReportId, saveReport, loadReport, getReportsIndex, markReportRead, getReadReportIds };
```

- [ ] **Step 2: Verify the module loads without errors**

Run from project root:
```bash
node -e "const m = require('./netlify/functions/analyst-lib/analyst-reports-gen.js'); console.log(Object.keys(m));"
```
Expected: `[ 'generateReportId', 'saveReport', 'loadReport', 'getReportsIndex', 'markReportRead', 'getReadReportIds' ]`

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/analyst-lib/analyst-reports-gen.js
git commit -m "feat: report artifact storage layer (analyst-reports-gen.js)"
```

---

## Task 2: REPORT_SYSTEM Prompt Templates

**Files:**
- Modify: `netlify/functions/analyst-lib/analyst-prompts.js`

Add prompt templates that instruct Orion to return structured JSON with component arrays for dashboards and P&L reports.

- [ ] **Step 1: Add REPORT_SYSTEM and PNL_SYSTEM templates**

After the existing `ASK_USER_TEMPLATE` definition (around line 60), add:

```javascript
const REPORT_SYSTEM = `${PERSONA}

You are generating a structured report artifact. Analyze the data provided and return a JSON object with:
1. "narrative" — a 2-4 sentence executive summary of the key findings
2. "components" — an ordered array of visualization components (max 8)

Each component must have "type" and "data" fields. Valid types:
- "kpi-grid": { "items": [{ "label": "Total Sales", "value": "$847K", "delta": "+3.2%", "color": "#4caf50" }] } — max 4 items
- "chart": { "chartType": "bar"|"line"|"doughnut"|"stacked", "title": "chart title", "labels": [...], "datasets": [{ "label": "...", "data": [...], "backgroundColor": "..." }] }
- "table": { "title": "table title", "columns": [{ "key": "name", "label": "Store" }], "rows": [{ "name": "Willow Grove", ... }] }
- "narrative": { "text": "analysis paragraph", "style": "summary"|"callout"|"insight" }
- "ranked-list": { "title": "Top 5 by Sales", "items": [{ "rank": 1, "name": "Store", "value": "$12.4K", "delta": "+5%" }], "direction": "top"|"bottom" }
- "comparison": { "title": "WoW Comparison", "periods": ["This Week", "Last Week"], "metrics": [{ "label": "Revenue", "values": ["$847K", "$821K"], "delta": "+3.2%" }] }

Choose components that best tell the story. Not every report needs all types. Lead with the most important insight.
Format all dollar values with $ and commas. Format percentages with one decimal. Use green (#4caf50) for positive, red (#f44336) for negative, yellow (#ff9800) for warning, white (#ffffff) for neutral.
Return ONLY valid JSON, no markdown fences.`;

const PNL_SYSTEM = `${PERSONA}

You are generating a Monthly P&L (Operational Profit & Loss) report. This covers Revenue (from POS sales) and Labor Cost (from payroll) — the two biggest controllable line items. Gross Margin = Revenue - Labor.

Analyze the monthly data and return a JSON object with:
1. "narrative" — 3-5 sentence executive summary: total revenue, labor cost, labor %, gross margin, month-over-month trend, any notable outliers
2. "components" — exactly these components in order:

Component 1 (kpi-grid): Revenue, Labor Cost, Gross Margin, Labor %, MoM Revenue Delta, YoY Revenue Delta (if available)
Component 2 (table): Monthly P&L table with rows [Revenue, Labor Cost, Gross Margin, Labor %] and columns [This Month, Last Month, MoM Delta, Year Ago (if available), YoY Delta (if available)]
Component 3 (chart): Revenue vs Labor Cost bar chart for last 6 months (dual dataset)
Component 4 (ranked-list, direction=top): Top 5 stores by lowest labor % (best performers)
Component 5 (ranked-list, direction=bottom): Bottom 5 stores by highest labor % (worst performers)
Component 6 (comparison): Week-over-week breakdown — Week 1/2/3/4 of the month showing Revenue, Labor $, Labor %, Gross Margin per week. Note best and worst weeks.
Component 7 (comparison): District-by-district breakdown — Revenue, Labor %, Gross Margin per district

Format all dollar values with $ and commas. Use green/red/yellow colors for thresholds.
Return ONLY valid JSON, no markdown fences.`;
```

- [ ] **Step 2: Add buildReportPrompt and buildPnlPrompt functions**

After the existing `buildAskPrompt` function, add:

```javascript
function buildReportPrompt(userPrompt, dataSnapshot) {
  return `${userPrompt}\n\nCurrent data:\n${dataSnapshot}`;
}

function buildPnlPrompt(monthLabel, dataSnapshot) {
  return `Generate the Monthly P&L report for ${monthLabel}.\n\nData:\n${dataSnapshot}`;
}
```

- [ ] **Step 3: Update module.exports**

Find the existing `module.exports` line and add the new exports:

```javascript
module.exports = {
  PERSONA, BRIEF_TEMPLATE, BUSINESS_CASE_TEMPLATE, ASK_SYSTEM, ASK_USER_TEMPLATE,
  REPORT_SYSTEM, PNL_SYSTEM,
  buildBriefPrompt, buildCasePrompt, buildAskPrompt, buildReportPrompt, buildPnlPrompt,
};
```

- [ ] **Step 4: Verify the module loads**

```bash
node -e "const m = require('./netlify/functions/analyst-lib/analyst-prompts.js'); console.log('REPORT_SYSTEM length:', m.REPORT_SYSTEM.length, 'PNL_SYSTEM length:', m.PNL_SYSTEM.length);"
```
Expected: Both lengths > 500

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/analyst-lib/analyst-prompts.js
git commit -m "feat: REPORT_SYSTEM + PNL_SYSTEM prompt templates for structured report generation"
```

---

## Task 3: CDN Dependencies

**Files:**
- Modify: `index.html` (lines 18-19, after existing jsPDF/html2pdf scripts)

Add Chart.js, reveal.js, and pptxgenjs.

- [ ] **Step 1: Add CDN script/link tags**

After line 19 (`html2pdf.bundle.min.js`), add:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.min.css">
<script src="https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js"></script>
```

- [ ] **Step 2: Verify in browser**

Open the portal in a browser. Open DevTools console and verify:
```javascript
typeof Chart       // "function"
typeof Reveal      // "object" or "function"
typeof PptxGenJS   // "function"
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add Chart.js, reveal.js, pptxgenjs CDN dependencies"
```

---

## Task 4: ReportComponent Renderer

**Files:**
- Modify: `app.jsx` — add before the `ReportsTab` component (which comes in Task 5)

This is the core rendering switch that turns component JSON into React elements.

- [ ] **Step 1: Add ReportComponent function**

Add this function in app.jsx before the KnowledgeBase component (around line 19747). This function will be used by the Reports tab, detail modal, and slide presenter.

```javascript
function ReportComponent({ component, theme: th, width }) {
  if (!component || !component.type || !component.data) return null;
  const { type, data } = component;

  if (type === 'kpi-grid') {
    const items = data.items || [];
    return React.createElement('div', {
      style: { display: 'grid', gridTemplateColumns: `repeat(${Math.min(items.length, 4)}, 1fr)`, gap: '12px', marginBottom: '16px' }
    }, items.map((item, i) =>
      React.createElement('div', {
        key: i,
        style: { background: th.card2 || th.card, borderRadius: '10px', padding: '14px 16px', textAlign: 'center', border: `1px solid ${th.border || th.muted + '22'}` }
      },
        React.createElement('div', { style: { color: th.muted, fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' } }, item.label),
        React.createElement('div', { style: { color: item.color || th.text, fontSize: '1.5rem', fontWeight: 800, fontFamily: 'Raleway, sans-serif' } }, item.value),
        item.delta && React.createElement('div', { style: { color: item.color || th.muted, fontSize: '0.78rem', fontWeight: 600, marginTop: '2px' } }, item.delta)
      )
    ));
  }

  if (type === 'chart') {
    const canvasRef = React.useRef(null);
    const chartRef = React.useRef(null);
    React.useEffect(() => {
      if (!canvasRef.current || typeof Chart === 'undefined') return;
      if (chartRef.current) chartRef.current.destroy();
      const isDark = th.bg === '#0b0b0c' || th.bg === '#000' || (th.bg && th.bg.startsWith('#0'));
      chartRef.current = new Chart(canvasRef.current, {
        type: data.chartType || 'bar',
        data: { labels: data.labels || [], datasets: (data.datasets || []).map(ds => ({ ...ds })) },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: data.title ? { display: true, text: data.title, color: isDark ? '#fff' : '#111', font: { family: 'Raleway', size: 14, weight: 700 } } : { display: false },
            legend: { labels: { color: isDark ? '#ccc' : '#333', font: { family: 'Source Sans 3' } } },
          },
          scales: data.chartType === 'doughnut' ? {} : {
            x: { ticks: { color: isDark ? '#999' : '#666' }, grid: { color: isDark ? '#ffffff12' : '#00000012' } },
            y: { ticks: { color: isDark ? '#999' : '#666' }, grid: { color: isDark ? '#ffffff12' : '#00000012' } },
          },
          ...(data.options || {}),
        },
      });
      return () => { if (chartRef.current) chartRef.current.destroy(); };
    }, [data, th]);
    return React.createElement('div', { style: { background: th.card2 || th.card, borderRadius: '10px', padding: '16px', marginBottom: '16px', border: `1px solid ${th.border || th.muted + '22'}` } },
      React.createElement('div', { style: { position: 'relative', height: '280px' } },
        React.createElement('canvas', { ref: canvasRef })
      )
    );
  }

  if (type === 'table') {
    const cols = data.columns || [];
    const rows = data.rows || [];
    return React.createElement('div', { style: { background: th.card2 || th.card, borderRadius: '10px', padding: '16px', marginBottom: '16px', overflowX: 'auto', border: `1px solid ${th.border || th.muted + '22'}` } },
      data.title && React.createElement('div', { style: { fontWeight: 700, fontSize: '0.9rem', marginBottom: '10px', color: th.text, fontFamily: 'Raleway' } }, data.title),
      React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' } },
        React.createElement('thead', null,
          React.createElement('tr', null, cols.map((c, i) =>
            React.createElement('th', { key: i, style: { textAlign: i === 0 ? 'left' : 'right', padding: '8px 10px', borderBottom: `2px solid ${th.muted}44`, color: th.muted, fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase' } }, c.label)
          ))
        ),
        React.createElement('tbody', null, rows.slice(0, 20).map((row, ri) =>
          React.createElement('tr', { key: ri, style: { background: ri % 2 === 0 ? 'transparent' : (th.card3 || th.muted + '08') } },
            cols.map((c, ci) => {
              let cellColor = th.text;
              if (data.highlight && row[data.highlight.key]) {
                const val = parseFloat(row[data.highlight.key]);
                if (data.highlight.condition === 'labor' && !isNaN(val)) {
                  cellColor = val >= 26 ? '#f44336' : val >= 23 ? '#ff9800' : '#4caf50';
                }
              }
              return React.createElement('td', { key: ci, style: { textAlign: ci === 0 ? 'left' : 'right', padding: '8px 10px', borderBottom: `1px solid ${th.muted}15`, color: c.key === (data.highlight?.key) ? cellColor : th.text } }, row[c.key] ?? '');
            })
          )
        ))
      )
    );
  }

  if (type === 'narrative') {
    const styles = {
      summary: { color: th.text, fontSize: '0.92rem', lineHeight: '1.65', marginBottom: '16px' },
      callout: { color: th.text, fontSize: '0.92rem', lineHeight: '1.65', marginBottom: '16px', padding: '14px 18px', borderLeft: '3px solid #FF671F', background: th.card2 || th.card, borderRadius: '0 8px 8px 0' },
      insight: { color: th.muted, fontSize: '0.88rem', lineHeight: '1.6', marginBottom: '16px', fontStyle: 'italic' },
    };
    return React.createElement('div', { style: styles[data.style] || styles.summary }, data.text);
  }

  if (type === 'ranked-list') {
    const isTop = data.direction === 'top';
    const accent = isTop ? '#4caf50' : '#f44336';
    return React.createElement('div', { style: { background: th.card2 || th.card, borderRadius: '10px', padding: '16px', marginBottom: '16px', border: `1px solid ${th.border || th.muted + '22'}` } },
      data.title && React.createElement('div', { style: { fontWeight: 700, fontSize: '0.9rem', marginBottom: '10px', color: th.text, fontFamily: 'Raleway' } }, data.title),
      (data.items || []).map((item, i) =>
        React.createElement('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: i < (data.items.length - 1) ? `1px solid ${th.muted}15` : 'none' } },
          React.createElement('span', { style: { width: '24px', height: '24px', borderRadius: '50%', background: accent + '22', color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 800, flexShrink: 0 } }, item.rank),
          React.createElement('span', { style: { flex: 1, color: th.text, fontSize: '0.85rem', fontWeight: 600 } }, item.name),
          React.createElement('span', { style: { color: th.text, fontSize: '0.88rem', fontWeight: 700, fontFamily: 'Raleway' } }, item.value),
          item.delta && React.createElement('span', { style: { color: accent, fontSize: '0.78rem', fontWeight: 600, minWidth: '50px', textAlign: 'right' } }, item.delta)
        )
      )
    );
  }

  if (type === 'comparison') {
    const periods = data.periods || [];
    const metrics = data.metrics || [];
    return React.createElement('div', { style: { background: th.card2 || th.card, borderRadius: '10px', padding: '16px', marginBottom: '16px', overflowX: 'auto', border: `1px solid ${th.border || th.muted + '22'}` } },
      data.title && React.createElement('div', { style: { fontWeight: 700, fontSize: '0.9rem', marginBottom: '10px', color: th.text, fontFamily: 'Raleway' } }, data.title),
      React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' } },
        React.createElement('thead', null,
          React.createElement('tr', null,
            React.createElement('th', { style: { textAlign: 'left', padding: '8px 10px', borderBottom: `2px solid ${th.muted}44`, color: th.muted, fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase' } }, ''),
            periods.map((p, i) => React.createElement('th', { key: i, style: { textAlign: 'right', padding: '8px 10px', borderBottom: `2px solid ${th.muted}44`, color: th.muted, fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase' } }, p)),
            React.createElement('th', { style: { textAlign: 'right', padding: '8px 10px', borderBottom: `2px solid ${th.muted}44`, color: th.muted, fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase' } }, 'Delta')
          )
        ),
        React.createElement('tbody', null, metrics.map((m, ri) => {
          const deltaColor = m.delta && m.delta.startsWith('-') ? '#f44336' : m.delta && m.delta.startsWith('+') ? '#4caf50' : th.text;
          return React.createElement('tr', { key: ri, style: { background: ri % 2 === 0 ? 'transparent' : (th.card3 || th.muted + '08') } },
            React.createElement('td', { style: { textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${th.muted}15`, color: th.text, fontWeight: 600 } }, m.label),
            (m.values || []).map((v, vi) => React.createElement('td', { key: vi, style: { textAlign: 'right', padding: '8px 10px', borderBottom: `1px solid ${th.muted}15`, color: th.text } }, v)),
            React.createElement('td', { style: { textAlign: 'right', padding: '8px 10px', borderBottom: `1px solid ${th.muted}15`, color: deltaColor, fontWeight: 700 } }, m.delta || '')
          );
        }))
      )
    );
  }

  return null;
}
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
```
Expected: `app.js` generated successfully. The "deoptimised styling" note is normal.

- [ ] **Step 3: Commit**

```bash
git add app.jsx app.js
git commit -m "feat: ReportComponent renderer — 6 component types (kpi-grid, chart, table, narrative, ranked-list, comparison)"
```

---

## Task 5: Reports Tab + Feed UI

**Files:**
- Modify: `app.jsx` — add ReportsTab component, update getTabs(), add tab routing, add unread badge

- [ ] **Step 1: Add a reports icon to the ICONS object**

Find the ICONS object in app.jsx (search for `const ICONS = {`). Add a reports icon. Place it near the existing `analytics` icon entry:

```javascript
reports: (c) => React.createElement("svg",{width:20,height:20,viewBox:"0 0 24 24",fill:"none",stroke:c,strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"},
  React.createElement("path",{d:"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"}),
  React.createElement("polyline",{points:"14 2 14 8 20 8"}),
  React.createElement("line",{x1:"16",y1:"13",x2:"8",y2:"13"}),
  React.createElement("line",{x1:"16",y1:"17",x2:"8",y2:"17"}),
  React.createElement("polyline",{points:"10 9 9 9 8 9"})
),
```

- [ ] **Step 2: Add "reports" tab to getTabs()**

In the `getTabs` function (line ~13133), add the reports tab for each role that should see it.

For executives/IT (after the `recon` entry):
```javascript
{ id: "reports", label: "Reports", icon: (c) => ICONS.reports(c) },
```

For DMs (in the DM branch, after their existing tabs):
```javascript
{ id: "reports", label: "Reports", icon: (c) => ICONS.reports(c) },
```

For office_staff (in the office branch):
```javascript
{ id: "reports", label: "Reports", icon: (c) => ICONS.reports(c) },
```

For managers (in the manager branch):
```javascript
{ id: "reports", label: "Reports", icon: (c) => ICONS.reports(c) },
```

- [ ] **Step 3: Add reportsUnreadCount state and loading**

In the PCGPortal component, near the existing state declarations (search for `chatUnreadCount`), add:

```javascript
const [reportsIndex, setReportsIndex] = React.useState([]);
const [reportsReadIds, setReportsReadIds] = React.useState([]);
const [reportsUnreadCount, setReportsUnreadCount] = React.useState(0);
```

Add a useEffect to load reports index and read state (near the existing chat useEffects):

```javascript
React.useEffect(() => {
  if (!user) return;
  async function loadReportsState() {
    const [index, readIds] = await Promise.all([
      cloudLoad('analyst/reports-index'),
      cloudLoad(`analyst/reports-read/${user.id}`),
    ]);
    const allReports = Array.isArray(index) ? index : [];
    const read = Array.isArray(readIds) ? readIds : [];
    const ut = user.userType;
    const dist = user.district ? String(user.district) : null;
    const storePC = user.storePC || null;
    const visible = allReports.filter(r => {
      if (ut === 'executive' || ut === 'it') return true;
      if (ut === 'dm' && dist) return r.scope === 'network' || r.scope === `district:${dist}`;
      if (ut === 'manager' && storePC) return r.scope === `store:${storePC}`;
      if (ut === 'office_staff') return r.scope === 'network';
      return r.scope === 'network';
    });
    setReportsIndex(visible);
    setReportsReadIds(read);
    setReportsUnreadCount(visible.filter(r => !read.includes(r.id)).length);
  }
  loadReportsState();
  const interval = setInterval(loadReportsState, 60000);
  return () => clearInterval(interval);
}, [user]);
```

- [ ] **Step 4: Add reports badge to sidebar**

In the sidebar badge section (line ~21789), after the announcements badge block, add:

```javascript
if (t.id === "reports" && reportsUnreadCount > 0) badge = reportsUnreadCount;
```

Pass `reportsUnreadCount` down to wherever the sidebar badge section lives. If it's inside `SidebarContent`, add it to the props.

- [ ] **Step 5: Add ReportsTab component**

Add this component in app.jsx before the `ReportComponent` function you added in Task 4:

```javascript
const REPORT_TYPE_COLORS = {
  dashboard: '#FF671F',
  deck: '#7c3aed',
  pnl: '#2563eb',
  brief: '#4caf50',
};

const REPORT_TYPE_LABELS = {
  dashboard: 'Dashboard',
  deck: 'Deck',
  pnl: 'P&L',
  brief: 'Brief',
};

function ReportsTab({ th, user, showAlert, reportsIndex, reportsReadIds, setReportsReadIds, setReportsUnreadCount }) {
  const [filter, setFilter] = React.useState('all');
  const [dateRange, setDateRange] = React.useState('month');
  const [selectedReport, setSelectedReport] = React.useState(null);
  const [reportDetail, setReportDetail] = React.useState(null);
  const [loading, setLoading] = React.useState(false);

  const now = Date.now();
  const dateFiltered = reportsIndex.filter(r => {
    const age = now - new Date(r.createdAt).getTime();
    if (dateRange === 'week') return age <= 7 * 86400000;
    if (dateRange === 'month') return age <= 31 * 86400000;
    if (dateRange === '90') return age <= 90 * 86400000;
    return true;
  });
  const filtered = filter === 'all' ? dateFiltered : dateFiltered.filter(r => r.type === filter);

  async function openReport(rpt) {
    setLoading(true);
    const detail = await cloudLoad(`analyst/reports/${rpt.id}`);
    setReportDetail(detail);
    setSelectedReport(rpt);
    setLoading(false);
    if (!reportsReadIds.includes(rpt.id)) {
      const newRead = [...reportsReadIds, rpt.id];
      setReportsReadIds(newRead);
      setReportsUnreadCount(prev => Math.max(0, prev - 1));
      fetch('/.netlify/functions/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', key: `analyst/reports-read/${user.id}`, data: newRead }),
      }).catch(() => {});
    }
  }

  function markAllRead() {
    const allIds = reportsIndex.map(r => r.id);
    setReportsReadIds(allIds);
    setReportsUnreadCount(0);
    fetch('/.netlify/functions/storage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', key: `analyst/reports-read/${user.id}`, data: allIds }),
    }).catch(() => {});
    showAlert('All reports marked as read', 'success');
  }

  const pills = [
    { key: 'all', label: 'All' },
    { key: 'dashboard', label: 'Dashboards' },
    { key: 'deck', label: 'Decks' },
    { key: 'pnl', label: 'P&L' },
    { key: 'brief', label: 'Briefs' },
  ];

  return React.createElement('div', { style: { maxWidth: '900px', margin: '0 auto' } },
    // Filter bar
    React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '20px' } },
      pills.map(p => React.createElement('button', {
        key: p.key,
        onClick: () => setFilter(p.key),
        style: {
          padding: '6px 14px', borderRadius: '16px', border: 'none', cursor: 'pointer',
          fontSize: '0.78rem', fontWeight: 700, fontFamily: 'Source Sans 3',
          background: filter === p.key ? (p.key === 'all' ? '#FF671F' : REPORT_TYPE_COLORS[p.key] || '#FF671F') : th.card2 || th.card,
          color: filter === p.key ? '#fff' : th.muted,
        }
      }, p.label)),
      React.createElement('div', { style: { flex: 1 } }),
      React.createElement('select', {
        value: dateRange, onChange: e => setDateRange(e.target.value),
        style: { padding: '6px 12px', borderRadius: '12px', border: `1px solid ${th.muted}44`, background: th.card2 || th.card, color: th.text, fontSize: '0.78rem', fontFamily: 'Source Sans 3', cursor: 'pointer' }
      },
        React.createElement('option', { value: 'week' }, 'This Week'),
        React.createElement('option', { value: 'month' }, 'This Month'),
        React.createElement('option', { value: '90' }, 'Last 90 Days'),
      ),
      reportsIndex.some(r => !reportsReadIds.includes(r.id)) && React.createElement('button', {
        onClick: markAllRead,
        style: { padding: '6px 12px', borderRadius: '12px', border: `1px solid ${th.muted}33`, background: 'transparent', color: th.muted, fontSize: '0.72rem', cursor: 'pointer', fontFamily: 'Source Sans 3' }
      }, 'Mark all read'),
    ),

    // Feed
    loading && React.createElement('div', { style: { textAlign: 'center', color: th.muted, padding: '40px' } }, 'Loading...'),
    !loading && filtered.length === 0 && React.createElement('div', { style: { textAlign: 'center', color: th.muted, padding: '40px', fontSize: '0.9rem' } }, 'No reports yet. Reports will appear here as Orion generates them.'),
    !loading && filtered.map(rpt => {
      const typeColor = REPORT_TYPE_COLORS[rpt.type] || '#FF671F';
      const isUnread = !reportsReadIds.includes(rpt.id);
      const date = new Date(rpt.createdAt);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const triggerLabel = rpt.trigger === 'scheduled' ? 'Auto-generated' : rpt.trigger === 'on-demand' ? 'On-demand' : 'Scheduled';
      const scopeLabel = rpt.scope === 'network' ? 'Network' : rpt.scope?.startsWith('district:') ? `District ${rpt.scope.split(':')[1]}` : rpt.scope?.startsWith('store:') ? `Store ${rpt.scope.split(':')[1]}` : '';

      return React.createElement('div', {
        key: rpt.id,
        onClick: () => openReport(rpt),
        style: {
          borderLeft: `3px solid ${typeColor}`, padding: '14px 16px', marginBottom: '10px', cursor: 'pointer',
          background: isUnread ? (th.card2 || th.card) : 'transparent', borderRadius: '0 8px 8px 0',
          transition: 'background 0.15s',
        },
        onMouseEnter: e => { e.currentTarget.style.background = th.card2 || th.card; },
        onMouseLeave: e => { e.currentTarget.style.background = isUnread ? (th.card2 || th.card) : 'transparent'; },
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
          React.createElement('span', { style: { background: typeColor, color: '#fff', padding: '2px 8px', borderRadius: '10px', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase' } }, REPORT_TYPE_LABELS[rpt.type] || rpt.type),
          React.createElement('span', { style: { fontWeight: 700, fontSize: '0.92rem', color: th.text } }, rpt.title),
          isUnread && React.createElement('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: '#FF671F', flexShrink: 0 } }),
        ),
        React.createElement('div', { style: { color: th.muted, fontSize: '0.75rem' } }, `${dateStr} · ${triggerLabel} · ${scopeLabel}`),
      );
    }),

    // Detail modal
    selectedReport && reportDetail && React.createElement(ReportDetailModal, {
      report: reportDetail, meta: selectedReport, th, user,
      onClose: () => { setSelectedReport(null); setReportDetail(null); },
    }),
  );
}
```

- [ ] **Step 6: Add tab routing for Reports**

Find the tab routing section (line ~22274, where `{tab === "cash" && ...}`) and add:

```javascript
{tab === "reports" && <ReportsTab th={th} user={user} showAlert={showAlert} reportsIndex={reportsIndex} reportsReadIds={reportsReadIds} setReportsReadIds={setReportsReadIds} setReportsUnreadCount={setReportsUnreadCount} />}
```

- [ ] **Step 7: Add tab description**

Find the tab description section (line ~22033, where `{tab === "cash" && "Deposit tracking..."}`) and add:

```javascript
{tab === "reports" && "Dashboards, slide decks, and scheduled reports from Orion."}
```

- [ ] **Step 8: Build and verify**

```bash
npm run build
```

Open the portal, verify the Reports tab appears in the sidebar with the correct icon. It should show "No reports yet" since no artifacts exist.

- [ ] **Step 9: Commit**

```bash
git add app.jsx app.js
git commit -m "feat: Reports tab with filter bar, feed UI, unread badges"
```

---

## Task 6: Report Detail Takeover Modal

**Files:**
- Modify: `app.jsx` — add ReportDetailModal component

- [ ] **Step 1: Add ReportDetailModal component**

Add this right after the `ReportsTab` component:

```javascript
function ReportDetailModal({ report, meta, th, user, onClose }) {
  const contentRef = React.useRef(null);

  function handlePDF() {
    if (!contentRef.current || typeof html2pdf === 'undefined') return;
    html2pdf().set({
      margin: 0.4,
      filename: `PCG-${(meta.title || 'Report').replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, backgroundColor: '#0b0b0c' },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'landscape' },
    }).from(contentRef.current).save();
  }

  function handleShare() {
    const url = `${window.location.origin}?tab=reports&report=${meta.id}`;
    if (navigator.share) {
      navigator.share({ title: meta.title, text: `Orion Report: ${meta.title}`, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).then(() => alert('Link copied to clipboard')).catch(() => {});
    }
  }

  const date = new Date(meta.createdAt);
  const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const scopeLabel = meta.scope === 'network' ? 'Network' : meta.scope?.startsWith('district:') ? `District ${meta.scope.split(':')[1]}` : meta.scope?.startsWith('store:') ? `Store ${meta.scope.split(':')[1]}` : '';
  const typeColor = REPORT_TYPE_COLORS[meta.type] || '#FF671F';

  return React.createElement('div', {
    onClick: e => { if (e.target === e.currentTarget) onClose(); },
    style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 10000, display: 'flex', flexDirection: 'column', backdropFilter: 'blur(6px)' }
  },
    // Top bar
    React.createElement('div', {
      style: { display: 'flex', alignItems: 'center', padding: '14px 24px', background: 'linear-gradient(135deg, #0b0b0c 0%, #1a1a2e 100%)', borderBottom: `2px solid ${typeColor}`, flexShrink: 0 }
    },
      React.createElement('button', { onClick: onClose, style: { background: 'none', border: 'none', color: '#fff', fontSize: '1.4rem', cursor: 'pointer', marginRight: '16px', padding: '4px 8px' } }, '×'),
      React.createElement('div', { style: { flex: 1 } },
        React.createElement('div', { style: { color: '#fff', fontWeight: 800, fontSize: '1.1rem', fontFamily: 'Raleway' } }, meta.title),
        React.createElement('div', { style: { color: '#999', fontSize: '0.78rem', marginTop: '2px' } }, `${dateStr} · ${scopeLabel}`),
      ),
      React.createElement('div', { style: { display: 'flex', gap: '8px' } },
        React.createElement('button', { onClick: handleShare, style: { padding: '6px 14px', borderRadius: '8px', border: '1px solid #ffffff33', background: 'transparent', color: '#ccc', fontSize: '0.78rem', cursor: 'pointer', fontFamily: 'Source Sans 3', fontWeight: 600 } }, 'Share'),
        React.createElement('button', { onClick: handlePDF, style: { padding: '6px 14px', borderRadius: '8px', border: '1px solid #ffffff33', background: 'transparent', color: '#ccc', fontSize: '0.78rem', cursor: 'pointer', fontFamily: 'Source Sans 3', fontWeight: 600 } }, 'PDF'),
        React.createElement('button', {
          onClick: () => { if (report && report.components) presentSlides(report, meta, th); },
          style: { padding: '6px 14px', borderRadius: '8px', border: '1px solid #FF671F55', background: '#FF671F22', color: '#FF671F', fontSize: '0.78rem', cursor: 'pointer', fontFamily: 'Source Sans 3', fontWeight: 700 }
        }, 'Present'),
        React.createElement('button', {
          onClick: () => { if (report && report.components) exportPPTX(report, meta); },
          style: { padding: '6px 14px', borderRadius: '8px', border: '1px solid #ffffff33', background: 'transparent', color: '#ccc', fontSize: '0.78rem', cursor: 'pointer', fontFamily: 'Source Sans 3', fontWeight: 600 }
        }, 'PPTX'),
      ),
    ),
    // Body
    React.createElement('div', { ref: contentRef, style: { flex: 1, overflow: 'auto', padding: '28px 32px', maxWidth: '960px', margin: '0 auto', width: '100%' } },
      report.narrative && React.createElement('div', { style: { marginBottom: '20px' } },
        React.createElement('div', { style: { color: '#FF671F', fontWeight: 800, fontSize: '1rem', fontFamily: 'Raleway', marginBottom: '8px' } }, "Orion's Take"),
        React.createElement('div', { style: { color: '#ddd', fontSize: '0.92rem', lineHeight: '1.65' } }, report.narrative),
      ),
      (report.components || []).map((comp, i) =>
        React.createElement(ReportComponent, { key: i, component: comp, theme: th })
      ),
    ),
  );
}
```

- [ ] **Step 2: Add placeholder functions for Present and PPTX**

Add these stubs (they will be implemented in Tasks 8 and 9):

```javascript
function presentSlides(report, meta, th) {
  alert('Slide presenter — coming in Task 8');
}

function exportPPTX(report, meta) {
  alert('PPTX export — coming in Task 9');
}
```

- [ ] **Step 3: Add deep link support**

In the PCGPortal component, find where URL parameters are read on load (search for `useEffect` near initialization). Add:

```javascript
React.useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const reportParam = params.get('report');
  const tabParam = params.get('tab');
  if (tabParam === 'reports' && reportParam) {
    setTab('reports');
  }
}, []);
```

In the `ReportsTab` component, add an effect that auto-opens a report from the URL:

```javascript
React.useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const reportParam = params.get('report');
  if (reportParam && reportsIndex.length > 0) {
    const rpt = reportsIndex.find(r => r.id === reportParam);
    if (rpt) openReport(rpt);
  }
}, [reportsIndex]);
```

- [ ] **Step 4: Build and verify**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "feat: ReportDetailModal — full-page takeover with PDF/Share, deep link support"
```

---

## Task 7: On-Demand Report Generation (Backend)

**Files:**
- Modify: `netlify/functions/analyst.js`

Add the `create-report` action so users can request dashboards via chat.

- [ ] **Step 1: Add imports**

At the top of `analyst.js`, add the new imports:

```javascript
const { REPORT_SYSTEM, buildReportPrompt } = require('./analyst-lib/analyst-prompts');
const { saveReport } = require('./analyst-lib/analyst-reports-gen');
```

- [ ] **Step 2: Add create-report action**

In the action routing switch (after the last existing action, around line 310), add:

```javascript
if (action === 'create-report') {
  const { prompt: userPrompt, scope, channelId } = body;
  const district = scope?.startsWith('district:') ? parseInt(scope.split(':')[1]) : null;
  const storePC = scope?.startsWith('store:') ? scope.split(':')[1] : null;
  const dataContext = await buildDataContext({ district, storePC, userRole });
  const kpiSnapshot = await buildKPISnapshot({ district });

  const dataSnapshot = `${dataContext}\n\nKPI Summary:\n${JSON.stringify(kpiSnapshot, null, 2)}`;
  const userMessage = buildReportPrompt(userPrompt, dataSnapshot);

  const { askAnalyst } = require('./analyst-lib/analyst-claude');
  const answer = await askAnalyst(REPORT_SYSTEM, userMessage, []);

  let artifact;
  try {
    const parsed = typeof answer === 'string' ? JSON.parse(answer.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()) : answer;
    artifact = {
      type: parsed.type || 'dashboard',
      title: parsed.title || userPrompt.slice(0, 60),
      scope: scope || 'network',
      createdBy: `user:${userId}`,
      trigger: 'on-demand',
      narrative: parsed.narrative || '',
      components: Array.isArray(parsed.components) ? parsed.components.slice(0, 8) : [],
    };
  } catch (parseErr) {
    return { statusCode: 200, headers: H, body: JSON.stringify({ error: 'Failed to parse report structure', raw: answer }) };
  }

  const reportId = await saveReport(artifact);

  if (channelId) {
    const { cacheSave, cacheLoad } = require('./analyst-lib/analyst-cache');
    const messages = (await cacheLoad(`pcg_chat_messages_v1`)) || [];
    messages.push({
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      channelId,
      senderId: 'orion',
      senderName: 'Orion',
      text: `New ${artifact.type} ready: **${artifact.title}** — [View in Reports](?tab=reports&report=${reportId})`,
      timestamp: new Date().toISOString(),
    });
    await cacheSave('pcg_chat_messages_v1', messages);
  }

  return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, reportId, title: artifact.title }) };
}
```

- [ ] **Step 3: Verify the function loads**

```bash
node -e "require('./netlify/functions/analyst.js'); console.log('OK');"
```

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/analyst.js
git commit -m "feat: create-report action — on-demand dashboard generation via analyst.js"
```

---

## Task 8: Auto-Generated Report Artifacts from Cron

**Files:**
- Modify: `netlify/functions/analyst-cron.js`
- Modify: `netlify/functions/analyst-lib/analyst-reports.js`

Extend the existing cron to save report artifacts alongside the email delivery.

- [ ] **Step 1: Add report artifact generation to analyst-cron.js**

At the top of `analyst-cron.js`, add:

```javascript
const { saveReport } = require('./analyst-lib/analyst-reports-gen');
const { REPORT_SYSTEM, buildReportPrompt } = require('./analyst-lib/analyst-prompts');
const { askAnalyst } = require('./analyst-lib/analyst-claude');
```

After the brief generation section (after briefs are saved to blobs, around line 140), add report artifact creation:

```javascript
// Save exec brief as report artifact
if (briefCache.network) {
  try {
    const execData = await buildKPISnapshot();
    const dataSnapshot = `${await buildDataContext()}\n\nKPI Summary:\n${JSON.stringify(execData, null, 2)}`;
    const reportJson = await askAnalyst(REPORT_SYSTEM, buildReportPrompt('Generate a weekly executive dashboard with sales, labor, and anomaly overview.', dataSnapshot), []);
    const parsed = JSON.parse(reportJson.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    await saveReport({
      type: 'dashboard',
      title: `Weekly Exec Dashboard — ${new Date().toISOString().slice(0, 10)}`,
      scope: 'network',
      createdBy: 'orion',
      trigger: 'scheduled',
      narrative: parsed.narrative || '',
      components: Array.isArray(parsed.components) ? parsed.components.slice(0, 8) : [],
    });
  } catch (e) { console.warn('Failed to save exec dashboard artifact:', e.message); }
}

// Save DM briefs as report artifacts
for (let d = 1; d <= 8; d++) {
  if (briefCache[`district_${d}`]) {
    try {
      await saveReport({
        type: 'brief',
        title: `DM Brief — District ${d} — ${new Date().toISOString().slice(0, 10)}`,
        scope: `district:${d}`,
        createdBy: 'orion',
        trigger: 'scheduled',
        narrative: briefCache[`district_${d}`],
        components: [],
      });
    } catch (e) { console.warn(`Failed to save D${d} brief artifact:`, e.message); }
  }
}
```

- [ ] **Step 2: Add "View in Portal" link to email templates**

In `analyst-reports.js`, modify the `wrapEmail` function to accept an optional `reportId` parameter. Update the footer section:

Find the closing `<p>` tag in `wrapEmail` that says "Generated by Orion..." and add before it:

```javascript
${reportId ? `<div style="text-align:center;margin:16px 0"><a href="https://pcg-ops.netlify.app/?tab=reports&report=${reportId}" style="display:inline-block;padding:10px 24px;background:#FF671F;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:14px">View in Portal</a></div>` : ''}
```

Update the `wrapEmail` signature:
```javascript
function wrapEmail(title, subtitle, bodyHtml, footerNote, reportId) {
```

Update the `module.exports` — no change needed, `wrapEmail` is already exported.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/analyst-cron.js netlify/functions/analyst-lib/analyst-reports.js
git commit -m "feat: auto-save report artifacts from analyst-cron, add View in Portal to emails"
```

---

## Task 9: Monthly P&L Cron

**Files:**
- Create: `netlify/functions/pnl-cron.js`
- Modify: `netlify.toml`

- [ ] **Step 1: Create pnl-cron.js**

```javascript
// netlify/functions/pnl-cron.js
const { buildKPISnapshot, getAllStores, getStoreLabor, getStoresByDistrict } = require('./analyst-lib/analyst-data');
const { cacheLoad } = require('./analyst-lib/analyst-cache');
const { PNL_SYSTEM, buildPnlPrompt } = require('./analyst-lib/analyst-prompts');
const { askAnalyst } = require('./analyst-lib/analyst-claude');
const { saveReport } = require('./analyst-lib/analyst-reports-gen');
const { sendEmail, wrapEmail, loadReportSettings } = require('./analyst-lib/analyst-reports');

exports.handler = async (event) => {
  const isManual = event.httpMethod === 'POST';
  const now = new Date();
  const targetMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthLabel = targetMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

  async function buildMonthlyData(stores) {
    let totalSales = 0, totalLabor = 0, totalHours = 0;
    const storeResults = [];
    const weeklyBuckets = [{}, {}, {}, {}, {}];

    for (const s of stores) {
      try {
        const storeData = await getStoreLabor(s.pc);
        if (!storeData?.daily) continue;
        let sSales = 0, sLabor = 0, sHours = 0;
        for (const day of storeData.daily) {
          const d = new Date(day.date);
          if (d >= targetMonth && d <= monthEnd) {
            sSales += day.sales || 0;
            sLabor += day.laborDollars || 0;
            sHours += day.laborHours || 0;
            const weekIdx = Math.min(4, Math.floor((d.getDate() - 1) / 7));
            if (!weeklyBuckets[weekIdx][s.pc]) weeklyBuckets[weekIdx][s.pc] = { sales: 0, labor: 0 };
            weeklyBuckets[weekIdx][s.pc].sales += day.sales || 0;
            weeklyBuckets[weekIdx][s.pc].labor += day.laborDollars || 0;
          }
        }
        totalSales += sSales;
        totalLabor += sLabor;
        totalHours += sHours;
        storeResults.push({ name: s.name, pc: s.pc, district: s.district, sales: sSales, labor: sLabor, laborPct: sSales > 0 ? (sLabor / sSales * 100) : 0 });
      } catch {}
    }

    const weekSummaries = weeklyBuckets.map((bucket, i) => {
      const wSales = Object.values(bucket).reduce((a, b) => a + b.sales, 0);
      const wLabor = Object.values(bucket).reduce((a, b) => a + b.labor, 0);
      return { week: `Week ${i + 1}`, sales: wSales, labor: wLabor, laborPct: wSales > 0 ? (wLabor / wSales * 100) : 0, margin: wSales - wLabor };
    }).filter(w => w.sales > 0);

    return { totalSales, totalLabor, totalHours, laborPct: totalSales > 0 ? (totalLabor / totalSales * 100) : 0, margin: totalSales - totalLabor, storeResults, weekSummaries };
  }

  const fmtD = n => '$' + (n >= 1000000 ? (n / 1000000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toFixed(0));

  try {
    const allStores = getAllStores();
    const networkData = await buildMonthlyData(allStores);
    const dataSnapshot = `Monthly P&L for ${monthLabel}:
Total Revenue: ${fmtD(networkData.totalSales)}
Total Labor Cost: ${fmtD(networkData.totalLabor)}
Gross Margin: ${fmtD(networkData.margin)}
Labor %: ${networkData.laborPct.toFixed(1)}%
Total Hours: ${networkData.totalHours.toFixed(0)}

Weekly breakdown:
${networkData.weekSummaries.map(w => `${w.week}: Sales ${fmtD(w.sales)}, Labor ${fmtD(w.labor)}, Labor% ${w.laborPct.toFixed(1)}%, Margin ${fmtD(w.margin)}`).join('\n')}

Store rankings by labor %:
Top 5 (lowest): ${networkData.storeResults.sort((a, b) => a.laborPct - b.laborPct).slice(0, 5).map(s => `${s.name} ${s.laborPct.toFixed(1)}%`).join(', ')}
Bottom 5 (highest): ${networkData.storeResults.sort((a, b) => b.laborPct - a.laborPct).slice(0, 5).map(s => `${s.name} ${s.laborPct.toFixed(1)}%`).join(', ')}

District breakdown:
${[1,2,3,4,5,6,7,8].map(d => {
  const distStores = networkData.storeResults.filter(s => s.district === d);
  const dSales = distStores.reduce((a, b) => a + b.sales, 0);
  const dLabor = distStores.reduce((a, b) => a + b.labor, 0);
  return `District ${d}: Sales ${fmtD(dSales)}, Labor ${fmtD(dLabor)}, Labor% ${dSales > 0 ? (dLabor/dSales*100).toFixed(1) : 0}%`;
}).join('\n')}`;

    const reportJson = await askAnalyst(PNL_SYSTEM, buildPnlPrompt(monthLabel, dataSnapshot), []);
    const parsed = JSON.parse(reportJson.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());

    const reportId = await saveReport({
      type: 'pnl',
      title: `Monthly P&L — ${monthLabel}`,
      scope: 'network',
      createdBy: 'orion',
      trigger: 'scheduled',
      narrative: parsed.narrative || '',
      components: Array.isArray(parsed.components) ? parsed.components.slice(0, 8) : [],
    });

    // Generate per-district P&L artifacts
    for (let d = 1; d <= 8; d++) {
      try {
        const distStores = getStoresByDistrict(d);
        const distData = await buildMonthlyData(distStores);
        if (distData.totalSales === 0) continue;
        const distSnapshot = `District ${d} P&L for ${monthLabel}:\nRevenue: ${fmtD(distData.totalSales)}\nLabor: ${fmtD(distData.totalLabor)}\nMargin: ${fmtD(distData.margin)}\nLabor%: ${distData.laborPct.toFixed(1)}%\n\nWeekly: ${distData.weekSummaries.map(w => `${w.week}: ${fmtD(w.sales)} / ${w.laborPct.toFixed(1)}%`).join(', ')}`;
        const distJson = await askAnalyst(PNL_SYSTEM, buildPnlPrompt(`${monthLabel} — District ${d}`, distSnapshot), []);
        const distParsed = JSON.parse(distJson.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        await saveReport({
          type: 'pnl',
          title: `Monthly P&L — District ${d} — ${monthLabel}`,
          scope: `district:${d}`,
          createdBy: 'orion',
          trigger: 'scheduled',
          narrative: distParsed.narrative || '',
          components: Array.isArray(distParsed.components) ? distParsed.components.slice(0, 8) : [],
        });
      } catch (e) { console.warn(`Failed district ${d} P&L:`, e.message); }
    }

    // Email exec P&L
    try {
      const settings = await loadReportSettings();
      const to = settings.execReportCC || ['Mike@PeopleCapitalGroup.com'];
      const pnlHtml = `<h2>Monthly P&L — ${monthLabel}</h2><p>${parsed.narrative || ''}</p><p>Revenue: ${fmtD(networkData.totalSales)} | Labor: ${fmtD(networkData.totalLabor)} | Margin: ${fmtD(networkData.margin)} | Labor%: ${networkData.laborPct.toFixed(1)}%</p>`;
      const html = wrapEmail(`Monthly P&L — ${monthLabel}`, `ORION ANALYST • PEOPLE CAPITAL GROUP`, pnlHtml, null, reportId);
      await sendEmail({ to, subject: `Orion Monthly P&L — ${monthLabel}`, html });
    } catch (e) { console.warn('Failed P&L email:', e.message); }

    return { statusCode: 200, body: JSON.stringify({ ok: true, reportId, month: monthLabel }) };
  } catch (err) {
    console.error('P&L cron error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
```

- [ ] **Step 2: Add schedule to netlify.toml**

After the existing `[functions.reconciliation-cron]` block, add:

```toml
# Monthly P&L — 1st of each month at 7 AM ET (11:00 UTC)
[functions.pnl-cron]
  schedule = "0 11 1 * *"
```

- [ ] **Step 3: Verify the function loads**

```bash
node -e "require('./netlify/functions/pnl-cron.js'); console.log('OK');"
```

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/pnl-cron.js netlify.toml
git commit -m "feat: monthly P&L cron — network + per-district operational P&L reports"
```

---

## Task 10: Slide Deck Presenter (reveal.js)

**Files:**
- Modify: `app.jsx` — replace the `presentSlides` stub with the real implementation

- [ ] **Step 1: Implement presentSlides function**

Replace the `presentSlides` stub from Task 6 with:

```javascript
function presentSlides(report, meta, th) {
  if (typeof Reveal === 'undefined') { alert('Reveal.js not loaded'); return; }

  const overlay = document.createElement('div');
  overlay.id = 'orion-slides-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:#000';

  const exitBtn = document.createElement('button');
  exitBtn.textContent = 'ESC to exit';
  exitBtn.style.cssText = 'position:fixed;top:12px;right:16px;z-index:20001;background:rgba(255,255,255,0.15);color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:0.75rem;cursor:pointer;font-family:Source Sans 3';
  exitBtn.onclick = () => { overlay.remove(); exitBtn.remove(); };

  const revealDiv = document.createElement('div');
  revealDiv.className = 'reveal';
  revealDiv.style.cssText = 'width:100%;height:100%';

  const slidesDiv = document.createElement('div');
  slidesDiv.className = 'slides';

  // Title slide
  const titleSlide = document.createElement('section');
  titleSlide.innerHTML = `<h2 style="color:#FF671F;font-family:Raleway;font-weight:900">${meta.title}</h2><p style="color:#999;font-size:0.9em">${new Date(meta.createdAt).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })}</p><p style="color:#666;font-size:0.75em;margin-top:40px">Generated by Orion · PCG Unified Operations Portal</p>`;
  slidesDiv.appendChild(titleSlide);

  // Narrative slide
  if (report.narrative) {
    const narSlide = document.createElement('section');
    narSlide.innerHTML = `<h3 style="color:#FF671F;font-family:Raleway">Orion's Take</h3><p style="color:#ddd;font-size:0.85em;line-height:1.7;max-width:700px;margin:0 auto">${report.narrative}</p>`;
    slidesDiv.appendChild(narSlide);
  }

  // Component slides
  (report.components || []).forEach((comp, idx) => {
    const slide = document.createElement('section');
    const container = document.createElement('div');
    container.id = `slide-comp-${idx}`;
    container.style.cssText = 'width:100%;max-width:800px;margin:0 auto';
    slide.appendChild(container);
    slidesDiv.appendChild(slide);

    setTimeout(() => {
      const root = ReactDOM.createRoot(container);
      const darkTheme = { bg: '#000', card: '#111', card2: '#1a1a2e', card3: '#222', text: '#fff', muted: '#999', border: '#333' };
      root.render(React.createElement(ReportComponent, { component: comp, theme: darkTheme }));
    }, 500);
  });

  // Closing slide
  const endSlide = document.createElement('section');
  endSlide.innerHTML = `<p style="color:#FF671F;font-size:1.2em;font-family:Raleway;font-weight:800">Thank You</p><p style="color:#666;font-size:0.75em;margin-top:30px">Generated by Orion · PCG Unified Operations Portal<br>${new Date().toLocaleString()}</p>`;
  slidesDiv.appendChild(endSlide);

  revealDiv.appendChild(slidesDiv);
  overlay.appendChild(revealDiv);
  document.body.appendChild(overlay);
  document.body.appendChild(exitBtn);

  const deck = new Reveal(revealDiv, {
    hash: false,
    controls: true,
    progress: true,
    transition: 'slide',
    backgroundTransition: 'fade',
    width: 1280,
    height: 720,
  });
  deck.initialize();

  function handleKey(e) {
    if (e.key === 'Escape') {
      overlay.remove();
      exitBtn.remove();
      document.removeEventListener('keydown', handleKey);
    }
  }
  document.addEventListener('keydown', handleKey);
}
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add app.jsx app.js
git commit -m "feat: reveal.js slide presenter — full-screen presentation from report artifacts"
```

---

## Task 11: PPTX Export

**Files:**
- Modify: `app.jsx` — replace the `exportPPTX` stub with the real implementation

- [ ] **Step 1: Implement exportPPTX function**

Replace the `exportPPTX` stub from Task 6 with:

```javascript
function exportPPTX(report, meta) {
  if (typeof PptxGenJS === 'undefined') { alert('PptxGenJS not loaded'); return; }

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.defineSlideMaster({
    title: 'PCG_MASTER',
    background: { color: '0B0B0C' },
  });

  const O = 'FF671F';
  const W = 'FFFFFF';
  const G = '999999';

  // Title slide
  const s1 = pptx.addSlide({ masterName: 'PCG_MASTER' });
  s1.addText(meta.title, { x: 1, y: 2.2, w: 11, fontSize: 28, color: O, fontFace: 'Arial', bold: true, align: 'center' });
  s1.addText(new Date(meta.createdAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), { x: 1, y: 3.2, w: 11, fontSize: 14, color: G, fontFace: 'Arial', align: 'center' });
  s1.addText('Generated by Orion · PCG Unified Operations Portal', { x: 1, y: 6, w: 11, fontSize: 10, color: '666666', fontFace: 'Arial', align: 'center' });

  // Narrative slide
  if (report.narrative) {
    const s2 = pptx.addSlide({ masterName: 'PCG_MASTER' });
    s2.addText("Orion's Take", { x: 0.8, y: 0.5, w: 11, fontSize: 22, color: O, fontFace: 'Arial', bold: true });
    s2.addText(report.narrative, { x: 0.8, y: 1.5, w: 11, fontSize: 14, color: 'DDDDDD', fontFace: 'Arial', lineSpacingMultiple: 1.5 });
  }

  // Component slides
  (report.components || []).forEach(comp => {
    const slide = pptx.addSlide({ masterName: 'PCG_MASTER' });

    if (comp.type === 'kpi-grid' && comp.data?.items) {
      const items = comp.data.items;
      const colW = 11 / Math.min(items.length, 4);
      items.forEach((item, i) => {
        const x = 0.8 + i * colW;
        slide.addText(item.label, { x, y: 2, w: colW - 0.3, fontSize: 10, color: G, fontFace: 'Arial', align: 'center', bold: true });
        slide.addText(item.value, { x, y: 2.6, w: colW - 0.3, fontSize: 26, color: (item.color || '#fff').replace('#', ''), fontFace: 'Arial', align: 'center', bold: true });
        if (item.delta) slide.addText(item.delta, { x, y: 3.5, w: colW - 0.3, fontSize: 12, color: (item.color || '#999').replace('#', ''), fontFace: 'Arial', align: 'center' });
      });
    }

    if (comp.type === 'chart' && comp.data) {
      const chartCanvas = document.querySelector(`canvas[data-report-chart]`);
      if (chartCanvas) {
        const imgData = chartCanvas.toDataURL('image/png');
        slide.addImage({ data: imgData, x: 1, y: 0.8, w: 10.5, h: 5.5 });
      } else {
        slide.addText(comp.data.title || 'Chart', { x: 0.8, y: 0.5, w: 11, fontSize: 18, color: O, fontFace: 'Arial', bold: true });
        if (comp.data.labels && comp.data.datasets) {
          const rows = comp.data.labels.map((label, i) => {
            const vals = comp.data.datasets.map(ds => ({ text: String(ds.data?.[i] ?? ''), options: { fontSize: 11, color: W } }));
            return [{ text: label, options: { fontSize: 11, color: W } }, ...vals];
          });
          const header = [{ text: '', options: { bold: true, fontSize: 11, color: O } }, ...comp.data.datasets.map(ds => ({ text: ds.label || '', options: { bold: true, fontSize: 11, color: O } }))];
          slide.addTable([header, ...rows], { x: 0.8, y: 1.5, w: 11, fontSize: 11, color: W, border: { type: 'solid', pt: 0.5, color: '333333' }, rowH: 0.4 });
        }
      }
    }

    if (comp.type === 'table' && comp.data) {
      slide.addText(comp.data.title || '', { x: 0.8, y: 0.4, w: 11, fontSize: 16, color: O, fontFace: 'Arial', bold: true });
      const cols = comp.data.columns || [];
      const rows = (comp.data.rows || []).slice(0, 15);
      const header = cols.map(c => ({ text: c.label, options: { bold: true, fontSize: 10, color: O, fill: { color: '1A1A2E' } } }));
      const body = rows.map(row => cols.map(c => ({ text: String(row[c.key] ?? ''), options: { fontSize: 10, color: W } })));
      slide.addTable([header, ...body], { x: 0.5, y: 1.2, w: 12, fontSize: 10, color: W, border: { type: 'solid', pt: 0.5, color: '333333' }, rowH: 0.35, autoPage: true });
    }

    if (comp.type === 'narrative' && comp.data) {
      slide.addText(comp.data.text, { x: 0.8, y: 1.5, w: 11, fontSize: 14, color: 'DDDDDD', fontFace: 'Arial', lineSpacingMultiple: 1.5 });
    }

    if (comp.type === 'ranked-list' && comp.data) {
      const isTop = comp.data.direction === 'top';
      const accent = isTop ? '4CAF50' : 'F44336';
      slide.addText(comp.data.title || '', { x: 0.8, y: 0.4, w: 11, fontSize: 16, color: O, fontFace: 'Arial', bold: true });
      (comp.data.items || []).forEach((item, i) => {
        const y = 1.3 + i * 0.55;
        slide.addText(`${item.rank}.`, { x: 0.8, y, w: 0.5, fontSize: 14, color: accent, fontFace: 'Arial', bold: true });
        slide.addText(item.name, { x: 1.4, y, w: 5, fontSize: 13, color: W, fontFace: 'Arial' });
        slide.addText(item.value, { x: 7, y, w: 2, fontSize: 13, color: W, fontFace: 'Arial', bold: true, align: 'right' });
        if (item.delta) slide.addText(item.delta, { x: 9.5, y, w: 2, fontSize: 12, color: accent, fontFace: 'Arial', align: 'right' });
      });
    }

    if (comp.type === 'comparison' && comp.data) {
      slide.addText(comp.data.title || '', { x: 0.8, y: 0.4, w: 11, fontSize: 16, color: O, fontFace: 'Arial', bold: true });
      const periods = comp.data.periods || [];
      const metrics = comp.data.metrics || [];
      const header = [{ text: '', options: { bold: true, fontSize: 10, color: G } }, ...periods.map(p => ({ text: p, options: { bold: true, fontSize: 10, color: O, fill: { color: '1A1A2E' } } })), { text: 'Delta', options: { bold: true, fontSize: 10, color: O, fill: { color: '1A1A2E' } } }];
      const body = metrics.map(m => [{ text: m.label, options: { fontSize: 10, color: W, bold: true } }, ...(m.values || []).map(v => ({ text: v, options: { fontSize: 10, color: W } })), { text: m.delta || '', options: { fontSize: 10, color: m.delta?.startsWith('-') ? 'F44336' : m.delta?.startsWith('+') ? '4CAF50' : W, bold: true } }]);
      slide.addTable([header, ...body], { x: 0.5, y: 1.2, w: 12, fontSize: 10, color: W, border: { type: 'solid', pt: 0.5, color: '333333' }, rowH: 0.4 });
    }
  });

  // Closing slide
  const end = pptx.addSlide({ masterName: 'PCG_MASTER' });
  end.addText('Thank You', { x: 1, y: 2.5, w: 11, fontSize: 28, color: O, fontFace: 'Arial', bold: true, align: 'center' });
  end.addText(`Generated by Orion · PCG Unified Operations Portal\n${new Date().toLocaleString()}`, { x: 1, y: 4, w: 11, fontSize: 11, color: '666666', fontFace: 'Arial', align: 'center' });

  const filename = `PCG-${(meta.title || 'Report').replace(/[^a-zA-Z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}`;
  pptx.writeFile({ fileName: filename });
}
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add app.jsx app.js
git commit -m "feat: PPTX export — download PowerPoint from report artifacts"
```

---

## Task 12: Chat Integration + Version Bump

**Files:**
- Modify: `app.jsx` — add "create report" trigger from analyst chat, bump version

- [ ] **Step 1: Add report creation from chat**

In the `sendToOrion` function in the ChatSection component, add detection for report-creation requests. Before the existing fetch to `/.netlify/functions/analyst`, add:

```javascript
const reportKeywords = ['create a dashboard', 'create a report', 'generate a dashboard', 'generate a report', 'create a presentation', 'build a dashboard', 'make a dashboard'];
const isReportRequest = reportKeywords.some(kw => text.toLowerCase().includes(kw));

if (isReportRequest) {
  try {
    const res = await fetch('/.netlify/functions/analyst', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create-report',
        prompt: text,
        userId: user.id,
        userRole: user.userType,
        scope: user.userType === 'dm' ? `district:${user.district}` : user.userType === 'manager' ? `store:${storePC}` : 'network',
        channelId,
      }),
    });
    const result = await res.json();
    if (result.ok) {
      const botMsg = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        channelId,
        senderId: 'orion',
        senderName: 'Orion',
        text: `Your report is ready: **${result.title}** — [View in Reports](?tab=reports&report=${result.reportId})`,
        timestamp: new Date().toISOString(),
        threadId: threadId || undefined,
      };
      setChatMessages(prev => [...prev, botMsg]);
      await cloudSave('pcg_chat_messages_v1', [...chatMessages, botMsg]);
      return;
    }
  } catch (e) { console.warn('Report creation failed, falling back to regular ask:', e); }
}
```

- [ ] **Step 2: Bump version to v9.1**

Find `v9.0` in the sidebar footer (line ~21915) and change to:

```
v9.1
```

- [ ] **Step 3: Build and verify**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "v9.1 — Phase 3 complete: Reports tab, dashboards, decks, P&L, PPTX export"
```

- [ ] **Step 5: Push and deploy**

```bash
git push origin main
npx netlify deploy --prod
```

- [ ] **Step 6: Smoke test**

1. Open portal → verify Reports tab appears in sidebar
2. Reports tab shows "No reports yet" (expected — no artifacts generated)
3. In analyst chat, type "Create a dashboard showing network labor overview" → verify Orion generates a report
4. Reports tab should show the new dashboard in the feed
5. Click the dashboard → full-page takeover opens with KPI cards, charts, tables
6. Click "Present" → reveal.js slideshow opens, ESC to exit
7. Click "PPTX" → PowerPoint file downloads
8. Click "PDF" → PDF downloads
9. Click "Share" → link copied
10. Check sidebar badge shows unread count

---

## Self-Review Checklist

**Spec coverage:**
- [x] Report artifact model (Task 1)
- [x] Component types — all 6 (Task 4)
- [x] Reports tab with filter bar + feed (Task 5)
- [x] Full-page takeover detail view (Task 6)
- [x] Role scoping (Task 5 — filter in useEffect)
- [x] Deep links (Task 6)
- [x] Unread badges (Task 5)
- [x] On-demand report generation (Task 7)
- [x] Auto-generated artifacts from cron (Task 8)
- [x] Monthly P&L with WoW comparison (Task 9)
- [x] reveal.js slide presenter (Task 10)
- [x] PPTX export (Task 11)
- [x] Email "View in Portal" link (Task 8)
- [x] Chat cross-posting (Task 7 + Task 12)
- [x] REPORT_SYSTEM + PNL_SYSTEM prompts (Task 2)
- [x] CDN dependencies (Task 3)

**Placeholder scan:** No TBDs, TODOs, or vague instructions found.

**Type consistency:** `saveReport`, `loadReport`, `getReportsIndex`, `markReportRead`, `getReadReportIds` — consistent across Tasks 1, 5, 6, 7, 8, 9. `REPORT_SYSTEM`, `PNL_SYSTEM`, `buildReportPrompt`, `buildPnlPrompt` — consistent across Tasks 2, 7, 8, 9. `ReportComponent` — consistent across Tasks 4, 6, 10. `REPORT_TYPE_COLORS`, `REPORT_TYPE_LABELS` — defined once in Task 5, used in Tasks 5 and 6.
