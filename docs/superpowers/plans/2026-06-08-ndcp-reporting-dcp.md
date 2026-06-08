# NDCP Reporting + DCP% Scorecard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add date-range/weekly/district NDCP reporting with a new analysis view, and fold weekly DCP% (NDCP spend ÷ Pulse sales) into the DM Scorecard.

**Architecture:** Reuse the existing Neon `ndcp_orders` table. Join orders to stores by the identity `account == pc` (verified 45/45). A shared pure module (`ndcp-lib/store-map.js`) provides store enrichment + Sunday week keys; a shared `dcpPct` helper computes the ratio. The read API (`ndcp.js`) gains date filtering + a `summary` aggregation. The UI (`AdminNdcp`) gets a date picker, weekly rollup, district sections, and an analysis subview. The scorecard cron (`analyst-cron.js`) adds a DCP dimension and the scorecard UI adds a DCP% pill.

**Tech Stack:** Netlify Functions (CommonJS) + Neon Postgres (`db.js` tagged-template `sql()`), Node built-in `node:test`, React (app.jsx, esbuild bundle), Chart.js (CDN global `window.Chart`), Netlify Blobs (`pcg_labor_*`, `pcg_dm_scorecard`).

**Reference spec:** `docs/superpowers/specs/2026-06-08-ndcp-reporting-dcp-design.md`

---

## File structure

- **Create** `netlify/functions/ndcp-lib/store-map.js` — canonical store list (pc→{name,district,dmName}), `enrich(order)`, `weekOf(date)`, `dcpPct(spend,sales)`. Pure, no I/O.
- **Create** `netlify/functions/ndcp-lib/store-map.test.js` — unit tests for the above.
- **Modify** `netlify/functions/ndcp.js` — `list` gains `{from,to}`; new `summary` action; enrich rows.
- **Modify** `netlify/functions/analyst-cron.js` — add per-store weekly NDCP spend query, DCP dimension + reweighted composite in `computeAndSaveDMScores`.
- **Modify** `app.jsx` — `AdminNdcp` revamp (date picker, weekly rollup, district sections, analysis subview); `DmScorecardTab` DCP% pill + score-key; version bump.

> All NDCP business logic that's testable lives in `store-map.js` so it can be unit-tested without a DB or browser. `ndcp.js`, the cron, and the UI consume it.

---

## PHASE 1 — Shared helpers + enriched read API

### Task 1: `store-map.js` — store enrichment + week + DCP helpers

**Files:**
- Create: `netlify/functions/ndcp-lib/store-map.js`
- Test: `netlify/functions/ndcp-lib/store-map.test.js`

- [ ] **Step 1: Write failing tests**

Create `netlify/functions/ndcp-lib/store-map.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { enrich, weekOf, dcpPct, STORE_BY_PC } = require('./store-map');

test('STORE_BY_PC has all 45 stores keyed by pc string', () => {
  assert.equal(Object.keys(STORE_BY_PC).length, 45);
  // Wadsworth (pc 339616) and Willits (pc 345986) are known anchors
  assert.equal(STORE_BY_PC['339616'].district, 1);
  assert.ok(STORE_BY_PC['345986']); // Willits
});

test('enrich joins an order to its store via account == pc', () => {
  const e = enrich({ account: '339616', store_name: 'KJ Donuts Inc', total_order: 100, date_ordered: '06/03/2026' });
  assert.equal(e.pc, '339616');
  assert.equal(e.district, 1);
  assert.ok(e.name && e.name !== 'KJ Donuts Inc'); // real store name, not billing entity
  assert.ok(e.dmName);
  assert.equal(e.unmapped, false);
  assert.equal(e.weekKey, '2026-05-31'); // Sun of the week containing Wed 06/03/2026
});

test('enrich flags an unknown account as unmapped, keeping the billing name', () => {
  const e = enrich({ account: '999999', store_name: 'MYSTERY LLC', total_order: 50 });
  assert.equal(e.pc, null);
  assert.equal(e.unmapped, true);
  assert.equal(e.name, 'MYSTERY LLC');
  assert.equal(e.district, null);
});

test('weekOf returns the Sunday (YYYY-MM-DD) of the week, handling Sun and Sat edges', () => {
  assert.equal(weekOf('06/03/2026'), '2026-05-31'); // Wed
  assert.equal(weekOf('05/31/2026'), '2026-05-31'); // Sun -> itself
  assert.equal(weekOf('06/06/2026'), '2026-05-31'); // Sat -> prior Sun
  assert.equal(weekOf('2026-06-07'), '2026-06-07'); // next Sun (ISO input)
  assert.equal(weekOf(''), null);
  assert.equal(weekOf(null), null);
});

test('dcpPct returns spend/sales*100, or null when sales missing/zero', () => {
  assert.equal(dcpPct(2000, 10000), 20);
  assert.equal(dcpPct(0, 10000), 0);
  assert.equal(dcpPct(2000, 0), null);
  assert.equal(dcpPct(2000, null), null);
  assert.equal(dcpPct(null, 10000), null);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test netlify/functions/ndcp-lib/store-map.test.js`
Expected: FAIL — `Cannot find module './store-map'`.

- [ ] **Step 3: Implement `store-map.js`**

Create `netlify/functions/ndcp-lib/store-map.js`. Transcribe the 45 stores from `app.jsx` `STORES_SEED` (app.jsx:2748–2795) using fields `pc, name, district`, and the DM names from `DISTRICTS_SEED` (app.jsx:2796–2805). The codebase already duplicates the store list into functions (e.g. `schedule-alerts.js`), so this follows the established pattern. Shape:

```javascript
// store-map.js — pure NDCP↔store helpers. Account number == Pulse pc (verified
// 45/45 on 2026-06-08), so the order→store join is the identity function.
// No I/O — safe to unit-test and import anywhere.

// district → DM display name (from app.jsx DISTRICTS_SEED, current week's DMs)
const DM_BY_DISTRICT = {
  1: 'Taylor Cormier', 2: 'Jay Patel', 3: 'Sonia Khalique', 4: 'Yolicet Grin-Martinez',
  5: 'Shreyes Mehta', 6: 'Mohamed', 7: 'Sharmin Akter', 8: 'Mike',
};

// pc → { name, district } — transcribe ALL 45 from STORES_SEED (pc/name/district).
// Example rows (replace with the full 45):
const STORES = [
  { pc: '339616', name: 'Wadsworth', district: 1 },
  { pc: '345986', name: 'Willits',   district: 2 },
  // … all 45 …
];

const STORE_BY_PC = {};
for (const s of STORES) {
  STORE_BY_PC[String(s.pc)] = { ...s, pc: String(s.pc), dmName: DM_BY_DISTRICT[s.district] || `District ${s.district}` };
}

// Sunday-start week key 'YYYY-MM-DD'. Accepts 'MM/DD/YYYY' or ISO 'YYYY-MM-DD'.
function weekOf(dateStr) {
  if (!dateStr) return null;
  let d;
  const s = String(dateStr).trim();
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) d = new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
  else { const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (!iso) return null; d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])); }
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - d.getDay()); // back up to Sunday (getDay 0=Sun)
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function enrich(order) {
  const acct = String(order.account == null ? '' : order.account).trim();
  const store = STORE_BY_PC[acct];
  return {
    ...order,
    pc: store ? store.pc : null,
    name: store ? store.name : (order.store_name || null),
    district: store ? store.district : null,
    dmName: store ? store.dmName : null,
    weekKey: weekOf(order.date_ordered || order.email_date),
    unmapped: !store,
  };
}

// DCP% = spend / sales * 100, or null when sales missing/zero.
function dcpPct(spend, sales) {
  const sp = Number(spend), sl = Number(sales);
  if (!isFinite(sp) || !isFinite(sl) || sl <= 0) return null;
  return Math.round((sp / sl) * 1000) / 10; // one decimal
}

module.exports = { STORE_BY_PC, DM_BY_DISTRICT, enrich, weekOf, dcpPct };
```

> Get the full 45-store list by reading `app.jsx:2748–2795` and copying each store's `pc`, `name`, `district`. Verify count is 45.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test netlify/functions/ndcp-lib/store-map.test.js`
Expected: PASS (5 tests). If the `enrich` "real store name" assertion fails, ensure pc 339616's `name` is the location name (e.g. "Wadsworth"), not the billing entity.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/ndcp-lib/store-map.js netlify/functions/ndcp-lib/store-map.test.js
git commit -m "feat(ndcp): shared store-map (account==pc enrich, Sunday weekOf, dcpPct)"
```

---

### Task 2: `ndcp.js` — date filter on `list` + new `summary` action

**Files:**
- Modify: `netlify/functions/ndcp.js` (add `require`, extend `list`, add `summary`)
- Test: `netlify/functions/ndcp-lib/summary.test.js` (pure aggregator extracted for testability)

We extract the aggregation math into a pure function so it's testable without a DB.

- [ ] **Step 1: Write failing test for the pure aggregator**

Create `netlify/functions/ndcp-lib/summary.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { summarize } = require('./summary');

test('summarize rolls enriched orders into totals, byWeek, byDistrict, byStore', () => {
  const orders = [
    { account: '339616', total_order: 1000, date_ordered: '06/03/2026' }, // D1, week 05-31
    { account: '339616', total_order:  500, date_ordered: '06/10/2026' }, // D1, week 06-07
    { account: '345986', total_order:  200, date_ordered: '06/04/2026' }, // D2, week 05-31
    { account: '999999', total_order:   50, date_ordered: '06/04/2026' }, // unmapped
  ];
  const s = summarize(orders);
  assert.equal(s.totals.orders, 4);
  assert.equal(s.totals.spend, 1750);
  assert.equal(s.byWeek['2026-05-31'].spend, 1200);
  assert.equal(s.byWeek['2026-06-07'].spend, 500);
  assert.equal(s.byDistrict['1'].spend, 1500);
  assert.equal(s.byDistrict['1'].dmName, 'Taylor Cormier');
  assert.equal(s.byStore['339616'].spend, 1500);
  assert.equal(s.byStore['339616'].name, 'Wadsworth');
  assert.equal(s.unmapped.spend, 50); // never silently dropped
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test netlify/functions/ndcp-lib/summary.test.js`
Expected: FAIL — `Cannot find module './summary'`.

- [ ] **Step 3: Implement `summary.js`**

Create `netlify/functions/ndcp-lib/summary.js`:

```javascript
const { enrich } = require('./store-map');

// Pure aggregation over raw order rows ({account,total_order,date_ordered,...}).
function summarize(orders) {
  const out = {
    totals: { orders: 0, spend: 0 },
    byWeek: {}, byDistrict: {}, byStore: {},
    unmapped: { orders: 0, spend: 0 },
  };
  for (const raw of orders || []) {
    const o = enrich(raw);
    const amt = Number(o.total_order) || 0;
    out.totals.orders += 1; out.totals.spend += amt;
    if (o.weekKey) {
      const w = (out.byWeek[o.weekKey] ||= { orders: 0, spend: 0 });
      w.orders += 1; w.spend += amt;
    }
    if (o.unmapped) { out.unmapped.orders += 1; out.unmapped.spend += amt; continue; }
    const d = (out.byDistrict[String(o.district)] ||= { dmName: o.dmName, orders: 0, spend: 0, stores: new Set() });
    d.orders += 1; d.spend += amt; d.stores.add(o.pc);
    const st = (out.byStore[o.pc] ||= { name: o.name, district: o.district, orders: 0, spend: 0 });
    st.orders += 1; st.spend += amt;
  }
  // round + serialize sets
  for (const d of Object.values(out.byDistrict)) { d.spend = Math.round(d.spend); d.stores = [...d.stores]; }
  for (const w of Object.values(out.byWeek)) w.spend = Math.round(w.spend);
  for (const s of Object.values(out.byStore)) s.spend = Math.round(s.spend);
  out.totals.spend = Math.round(out.totals.spend);
  out.unmapped.spend = Math.round(out.unmapped.spend);
  return out;
}

module.exports = { summarize };
```

- [ ] **Step 4: Run test, verify pass**

Run: `node --test netlify/functions/ndcp-lib/summary.test.js`
Expected: PASS.

- [ ] **Step 5: Wire `summary` + date filter into `ndcp.js`**

In `netlify/functions/ndcp.js`, add after line 9 (`const { sql } = require('./db');`):

```javascript
const { enrich } = require('./ndcp-lib/store-map');
const { summarize } = require('./ndcp-lib/summary');
```

Replace the `list` block (current lines 30–56) so it accepts an optional `date_ordered` range and enriches rows. `date_ordered` is stored as an `MM/DD/YYYY` string, so range-filter on `email_date` (a real TIMESTAMPTZ) for the SQL window, then return enriched rows:

```javascript
    if (action === 'list') {
      const from = body.from ? new Date(body.from) : null; // ISO 'YYYY-MM-DD'
      const to   = body.to   ? new Date(body.to)   : null;
      const rows = await db`
        WITH latest AS (
          SELECT DISTINCT ON (order_number) *
          FROM ndcp_orders
          WHERE order_number IS NOT NULL
            AND (${from ? from.toISOString() : null}::timestamptz IS NULL OR email_date >= ${from ? from.toISOString() : null}::timestamptz)
            AND (${to ? to.toISOString() : null}::timestamptz IS NULL OR email_date <  (${to ? to.toISOString() : null}::timestamptz + interval '1 day'))
          ORDER BY order_number, email_date DESC NULLS LAST
        ),
        counts AS (
          SELECT order_number,
                 count(*)::int AS versions,
                 count(*) FILTER (WHERE email_type = 'revision')::int AS revisions,
                 (array_agg(total_order ORDER BY email_date ASC NULLS LAST))[1] AS orig_total
          FROM ndcp_orders WHERE order_number IS NOT NULL GROUP BY order_number
        )
        SELECT l.order_number, l.store_name, l.account, l.email_type, l.email_date,
               l.date_ordered, l.date_shipped, l.warehouse, l.terms,
               l.total_order, l.item_subtotal, l.tax, l.item_count, l.subject,
               c.versions, c.revisions, c.orig_total
        FROM latest l JOIN counts c USING (order_number)
        ORDER BY l.email_date DESC NULLS LAST`;
      return reply(200, { orders: rows.map(enrich) });
    }
```

Add a `summary` action immediately after the `list` block:

```javascript
    if (action === 'summary') {
      const from = body.from ? new Date(body.from) : null;
      const to   = body.to   ? new Date(body.to)   : null;
      const rows = await db`
        SELECT DISTINCT ON (order_number) account, total_order, date_ordered, email_date
        FROM ndcp_orders
        WHERE order_number IS NOT NULL
          AND (${from ? from.toISOString() : null}::timestamptz IS NULL OR email_date >= ${from ? from.toISOString() : null}::timestamptz)
          AND (${to ? to.toISOString() : null}::timestamptz IS NULL OR email_date < (${to ? to.toISOString() : null}::timestamptz + interval '1 day'))
        ORDER BY order_number, email_date DESC NULLS LAST`;
      return reply(200, summarize(rows));
    }
```

- [ ] **Step 6: Re-run all ndcp-lib tests**

Run: `node --test netlify/functions/ndcp-lib/store-map.test.js netlify/functions/ndcp-lib/summary.test.js`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/ndcp.js netlify/functions/ndcp-lib/summary.js netlify/functions/ndcp-lib/summary.test.js
git commit -m "feat(ndcp): date-range list + summary aggregation (week/district/store)"
```

- [ ] **Step 8: Deploy + manual smoke**

```bash
npx netlify deploy --prod
curl -s -X POST "https://uop.peoplecapitalgroup.com/.netlify/functions/ndcp" -H "Content-Type: application/json" -d '{"action":"summary"}' | head -c 800
```
Expected: JSON with `totals`, `byWeek`, `byDistrict` (each district shows a real `dmName`), `byStore` (real `name`), `unmapped` (orders:0 currently). Spot-check `byDistrict` dmNames are current (Taylor/Jay/…), not stale.

---

## PHASE 2 — AdminNdcp UI: date picker, weekly rollup, district sections, analysis

> `AdminNdcp` is at app.jsx ~24038. It currently fetches `{action:'list'}` on mount (no dates), renders search + store dropdown + a flat table + detail modal. We add a date range, view tabs (Orders / Weekly / Districts / Analysis), and pull `summary`. Sales for DCP% come from `cloudLoad('pcg_labor_v1')` (network: `{stores:{pc:{name,district,wtd:{sales}}}}`) and per-store `cloudLoad('pcg_labor_store_{pc}')` (`.daily[].{date,sales}`). Follow the existing AdminNdcp styling (cards via `card(th)`, dollar formatting via `fmtDollars`).

### Task 3: Date range + view-mode state and `summary` fetch

**Files:** Modify `app.jsx` `AdminNdcp` (state block ~24039–24056; fetch effect ~24047).

- [ ] **Step 1:** Add state at the top of `AdminNdcp` (after existing `useState`s):

```jsx
const todayISO = new Date().toISOString().slice(0,10);
const ago = (days) => new Date(Date.now() - days*86400000).toISOString().slice(0,10);
const [from, setFrom] = useState(ago(13*7));   // default last 13 weeks
const [to, setTo]     = useState(todayISO);
const [view, setView] = useState('weekly');     // 'orders' | 'weekly' | 'districts' | 'analysis'
const [summary, setSummary] = useState(null);
```

- [ ] **Step 2:** Replace the mount fetch so both `list` and `summary` refetch when `from`/`to` change:

```jsx
useEffect(() => {
  const f = (action, extra={}) => fetch('/.netlify/functions/ndcp', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action, from, to, ...extra })
  }).then(r => r.json());
  setLoading(true);
  Promise.all([ f('list'), f('summary') ])
    .then(([l, s]) => { setOrders(l.orders || []); setSummary(s); })
    .catch(() => {})
    .finally(() => setLoading(false));
}, [from, to]);
```

- [ ] **Step 3:** Add a date-range + view toolbar in the render (above the stats cards). Two `<input type="date">` bound to `from`/`to`, and four view buttons toggling `view`. Use `inp(th)` and `btn(th)` helpers for styling. Verify build after.

```bash
npm run build
```
Expected: esbuild completes (pre-existing warnings only), `app.js` ~2.2mb.

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(ndcp-ui): date range + view tabs + summary fetch"
```

### Task 4: Weekly rollup + District sections (from `summary`)

**Files:** Modify `app.jsx` `AdminNdcp` render.

- [ ] **Step 1:** Add a **Weekly** view (when `view==='weekly'`): map `Object.entries(summary.byWeek).sort()` descending by week key into rows showing `weekKey` (label "Week of {weekKey}"), `orders`, and `fmtDollars(spend)`. Each row expandable to that week's orders (filter `orders` where `o.weekKey === weekKey`).

- [ ] **Step 2:** Add a **Districts** view (when `view==='districts'`): for each `Object.entries(summary.byDistrict).sort()` render a collapsible card: header `D{district} · {dmName}` + `fmtDollars(spend)` + `{orders} orders`; body lists that district's stores from `Object.values(summary.byStore).filter(s=>String(s.district)===district)` showing real `name`, `orders`, `fmtDollars(spend)`. Render `summary.unmapped` in its own amber-bordered card when `unmapped.orders > 0`.

- [ ] **Step 3:** Keep the existing flat table under the **Orders** view (`view==='orders'`); its rows now carry enriched `name`/`district` — show real `name` instead of `store_name`.

- [ ] **Step 4: Build + visually verify**

```bash
npm run build && npx netlify deploy --prod
```
Then open the NDCP tab: Weekly shows ~13 week rows; Districts shows 8 districts with current DM names and per-store real names; subtotals reconcile to the Orders total.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(ndcp-ui): weekly rollup + district sections with DM + real store names"
```

### Task 5: Analysis subview (trend, category breakdown, DCP% over time)

**Files:** Modify `app.jsx` `AdminNdcp` (add an Analysis view + a sales load).

- [ ] **Step 1:** Load sales once for DCP%: `const [labor,setLabor]=useState(null); useEffect(()=>{ cloudLoad('pcg_labor_v1').then(setLabor).catch(()=>{}); },[]);`

- [ ] **Step 2:** Add the **Analysis** view (`view==='analysis'`):
  - **Weekly spend trend:** a Chart.js line over `summary.byWeek` (x=week keys ascending, y=spend). Use `window.Chart` (CDN global) in a `useRef` canvas + effect, following any existing Chart usage in app.jsx (search `new window.Chart` or `new Chart(`). Destroy the prior chart instance on re-render.
  - **Category breakdown:** aggregate `category_subtotals` across the loaded `orders` (each row's `category_subtotals` is `[{code,label,amount}]`); sum by `label`; render a sorted bar list (label + `fmtDollars`).
  - **DCP% over time (network):** for each week in `summary.byWeek`, compute `dcpPct = spend / weekNetSales * 100` where `weekNetSales` is the sum of `labor.stores[pc].wtd.sales` is NOT week-specific — instead derive per-week sales from each store's `pcg_labor_store_{pc}.daily[]` summed over that Sun–Sat window. For v1 simplicity, show **district/store DCP% for the latest complete week** using `labor.stores[pc].wtd.sales` vs that store's latest-week NDCP spend; render "—" when sales are missing. (Full per-historical-week DCP% trend is a follow-up; do not block on it.)

> Implementation note: reuse the same `dcpPct` math as the server (`spend/sales*100`, null when sales≤0). Keep a small inline `dcpPct` in app.jsx mirroring `store-map.js` (frontend can't `require` the function module; bundler only pulls `src/*.mjs`). Keep the formula identical.

- [ ] **Step 3: Build + deploy + verify**

```bash
npm run build && npx netlify deploy --prod
```
Analysis view: trend line renders, category breakdown lists food/paper/etc., DCP% shows ~17–21% for stores with sales and "—" where sales missing.

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(ndcp-ui): analysis view — spend trend, category breakdown, DCP%"
```

---

## PHASE 3 — DCP% on the DM Scorecard

### Task 6: Add DCP dimension to `computeAndSaveDMScores`

**Files:** Modify `netlify/functions/analyst-cron.js` (`computeAndSaveDMScores`, lines ~96–199).

- [ ] **Step 1:** Add the require near the top of `analyst-cron.js` (with the other requires):

```javascript
const { sql } = require('./db');
const { dcpPct } = require('./ndcp-lib/store-map');
```

- [ ] **Step 2:** Inside `computeAndSaveDMScores`, after `const scores = {};` (line ~115), load per-store NDCP spend for the current week. The current scorecard week is `mondayOf(today)`; build the matching 7-day window and sum `total_order` per `account` (== pc):

```javascript
    // Per-store NDCP spend for the current scorecard week (account == pc).
    const wkStart = new Date(mondayOf(today) + 'T00:00:00');
    const wkEndIso = new Date(wkStart.getTime() + 7*86400000).toISOString();
    const ndcpByPc = {};
    try {
      const db = sql();
      const rows = await db`
        SELECT DISTINCT ON (order_number) account, total_order
        FROM ndcp_orders
        WHERE order_number IS NOT NULL
          AND email_date >= ${wkStart.toISOString()}::timestamptz
          AND email_date <  ${wkEndIso}::timestamptz
        ORDER BY order_number, email_date DESC NULLS LAST`;
      for (const r of rows) {
        const pc = String(r.account || '').trim();
        ndcpByPc[pc] = (ndcpByPc[pc] || 0) + (Number(r.total_order) || 0);
      }
    } catch (e) { console.warn('[analyst-cron] NDCP weekly spend load failed:', e.message); }
```

- [ ] **Step 3:** Inside the `for (const [district, stores] of ...)` loop, after the ticket score block (after line ~153), add the DCP dimension. DCP% = district weekly NDCP spend ÷ district weekly net sales; banded score Good ≤20→100 / Yellow 20–22→50 / Red >22→0:

```javascript
      // 5. DCP cost score (lower is better; Good ≤20%, Yellow 20–22%, Red >22%)
      let distNdcp = 0, distSales = 0;
      for (const s of stores) {
        distNdcp  += ndcpByPc[String(s.pc)] || 0;
        distSales += Number(s.wtd?.sales) || 0;
      }
      const avgDcpPct = dcpPct(distNdcp, distSales); // null if no sales
      const dcpScore = avgDcpPct == null ? null
        : avgDcpPct <= 20 ? 100 : avgDcpPct <= 22 ? 50 : 0;
```

- [ ] **Step 4:** Update the weighted composite (lines ~156–161) to the confirmed weights, dropping any null dimension:

```javascript
      const dims = [
        { score: laborScore,    w: 0.25 },
        { score: salesScore,    w: 0.25 },
        { score: dcpScore,      w: 0.20 },
        { score: responseScore, w: 0.15 },
        { score: ticketScore,   w: 0.15 },
      ].filter(d => d.score != null);
```

- [ ] **Step 5:** Add `dcpPct`/`dcpScore` to the persisted `scores[district]` object (in the object literal at ~165–177):

```javascript
        avgDcpPct:  avgDcpPct != null ? avgDcpPct : null,
        dcpScore:   dcpScore  != null ? dcpScore  : null,
```

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/analyst-cron.js
git commit -m "feat(scorecard): DCP% dimension + reweighted composite (DCP 20%)"
```

### Task 7: DCP% pill + score-key in `DmScorecardTab`

**Files:** Modify `app.jsx` `DmScorecardTab` (pill array ~19302–19306; header subtitle ~19257; score-key ~19325).

- [ ] **Step 1:** Add a DCP pill to the metric-pills array (after the `Tickets` entry, line ~19306). Lower-is-better; color from `dcpScore`:

```jsx
{ label:'DCP', value: score.avgDcpPct != null ? `${score.avgDcpPct}%` : '—', score: score.dcpScore, prev: previous?.scores?.[district]?.avgDcpPct, higherIsBetter: false },
```

- [ ] **Step 2:** Update the header subtitle (line ~19257) to mention DCP:

```jsx
Weekly composite ranking · labor · sales growth · DCP cost · alert response · ticket health
```

- [ ] **Step 3:** Build + deploy + verify the pill shows and rankings reflect DCP:

```bash
npm run build && npx netlify deploy --prod
```
Then trigger a scorecard recompute (POST the analyst-cron manual trigger as used elsewhere) or wait for the Sunday run; confirm each district shows a DCP% pill (green ≤20 / amber 20–22 / red >22) and the composite shifted per the new weights.

- [ ] **Step 4:** Bump the version footer in `app.jsx` (search `v14.40`, increment to `v14.41`). Build.

```bash
npm run build
```

- [ ] **Step 5: Commit + deploy**

```bash
git add app.jsx app.js
git commit -m "feat(scorecard-ui): DCP% pill + version v14.41"
npx netlify deploy --prod
```

---

## Self-review (completed by author)

- **Spec coverage:** date range ✓ (Task 3); weekly rollup ✓ (Task 4); district + DM name ✓ (Task 4); real store name via pc ✓ (Tasks 1/4); new analysis ✓ (Task 5); DCP% in scorecard composite ✓ (Tasks 6/7); identity mapping ✓ (Task 1); guardrails (unmapped surfaced, "—" on missing sales) ✓ (Tasks 1/2/5/6).
- **Placeholder scan:** the only deferred item is the full *per-historical-week* DCP% trend in the Analysis view (Task 5 Step 2), explicitly scoped to "latest complete week" for v1 with a noted follow-up — not a silent gap. The 45-store transcription in Task 1 cites exact source lines.
- **Type consistency:** `dcpPct(spend,sales)`, `enrich(order)→{pc,name,district,dmName,weekKey,unmapped}`, `weekOf(date)`, `summarize(orders)→{totals,byWeek,byDistrict,byStore,unmapped}`, and `scores[district].{avgDcpPct,dcpScore}` are used identically across tasks.

## Phase boundaries (each is independently shippable)
- **Phase 1** ships a working enriched API (deploy + smoke at Task 2 Step 8).
- **Phase 2** ships the reporting UI (deploys at Tasks 4–5).
- **Phase 3** ships DCP% on the scorecard (deploy at Task 7).
