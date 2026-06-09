# Orion Ops Datasets (Projects, Tickets, Cash, Food Cost) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Orion (the AI analyst) read access to construction/projects, maintenance tickets, cash deposits, and food-cost data as compact, role-scoped context — plus add the budget/actual-cost fields to the Projects UI that the cost-overrun analysis needs.

**Architecture:** Four pure summarizers + one pure renderer in a new `ops-summaries.js` module (node:test TDD, like `pnl-calc.test.js`), thin async builders in `analyst-data.js` that load blobs via `cacheLoad` and call the summarizers, all appended to the string `buildDataContext()` already returns. One frontend task adds `budget`/`actualCost` number fields to the Edit Project form in `app.jsx`.

**Tech Stack:** Node (CommonJS) Netlify Functions, Netlify Blobs, `node:test`, React 18 (inline-style JSX bundled by esbuild).

**Branch:** `feature/orion-ops-datasets` (already checked out in `pcg-netlify 3`).

**Verified production data reality (sampled 2026-06-09 via the storage function):**
- `pcg_projects_v1` — 16 records (14 active). Flat fields incl. `nickname`, `pc`, `type` (Remodel/Relocation/New Location), `dueDate`, `constructionCompleteBy`, milestone dates (`dcpDeliveryDate`, `installationDate`, …), `completed`. Pipeline projects also have `gc`, `gcCompany`, `utilities` (`{electric:{provider,status},…}`), `phaseOverride`. **Budget fields already exist in the UI** as `totalBudget`/`spentToDate` (editable inputs app.jsx:11834/:11842, progress bar :11856, export :12983) but are stored as **raw strings** (possibly `"$250,000"`-style) and are unfilled on all current records — the summarizer reads these keys with money-string coercion. (Task 1 originally added duplicate `budget`/`actualCost` inputs; reverted in f4b7639.) `attorney`/`architect`/`engineer` are FK ids (`"att1"`) into a separate professionals blob — **do not render these ids** (decision: no vendor-blob join in this pass).
- `pcg_tickets_v1` — fields: `id,number,title,storePC,storeName,address,category,priority,dueDate,status,ticketOwner,createdBy,description,selectedIssues,attachments,comments,createdAt,updatedAt,startedBy,startedAt`. **`attachments` contain multi-MB base64 dataUrls — summarizer must never pass them through.**
- `pcg_cash_deposits_v1` — 504 records: `{id, depositDate, businessDates:[], pc, llcName, amount, uploadId, uploadedAt, uploadedBy}`. **No reconciled flag** — "missing deposits" is derived (business dates not covered by any deposit).
- `pcg_food_cost_beverages_v1` — **empty in production.** Real unit costs are static tables in `analyst-lib/cost-lookup.js` (`BEVERAGE_COSTS`, `FOOD_COSTS`, `ICE_CREAM_COSTS`, `INGREDIENT_COSTS`: flat `{ "Item Name": 2.28 }` maps). Decision: static tables are the baseline, blob is an overlay when populated.
- Projects' `district` is often `null` — derive district from `pc` via the `STORES` array (pass stores into summarizers as a param; **do not** import `analyst-data.js` from `ops-summaries.js` — that's a require cycle).
- `buildDataContext()` (analyst-data.js:146) **returns a string**, and on missing labor returns an error string early. Ops context must append in both paths.

**Run tests with** (note the space in the path — always quote):
```bash
cd "/Users/mike/Library/Mobile Documents/com~apple~CloudDocs/ClaudePro/PCG/pcg-netlify 3"
node --test "netlify/functions/analyst-lib/ops-summaries.test.js"
```

---

### Task 1: Budget / Actual Cost fields on the Edit Project form

The cost-overrun requirement has no data behind it today. Add two optional money fields so projects can carry `budget` and `actualCost`; `startEdit` already spreads the full project into the form (`setForm({ ...p })` at app.jsx:11694) and save spreads the form back, so the fields round-trip with no save-handler changes.

**Files:**
- Modify: `app.jsx` (form grid ~line 13096-13107; version string ~line 33765)

- [ ] **Step 1: Add the two inputs to the first form grid**

In `app.jsx`, find the `Dunkin' Completion Date` field (~line 13106) inside the `gridTemplateColumns: "1fr 1fr 1fr"` grid and add these two divs immediately after it (inside the same grid div):

```jsx
            <div><label style={{ fontSize: "0.6875rem", color: th.muted, fontWeight: 600 }}>Budget ($)</label><input type="number" min="0" step="1000" style={inp(th)} placeholder="e.g. 250000" value={form.budget ?? ""} onChange={e => setForm(f => ({ ...f, budget: e.target.value === "" ? null : Number(e.target.value) }))} /></div>
            <div><label style={{ fontSize: "0.6875rem", color: th.muted, fontWeight: 600 }}>Actual Cost to Date ($)</label><input type="number" min="0" step="1000" style={inp(th)} placeholder="e.g. 180000" value={form.actualCost ?? ""} onChange={e => setForm(f => ({ ...f, actualCost: e.target.value === "" ? null : Number(e.target.value) }))} /></div>
```

Coercing to `Number` in `onChange` keeps the blob clean (numbers, not strings) — the summarizer in Task 2 still defensively `Number()`s.

- [ ] **Step 2: Bump the version**

At ~line 33765 change `v14.54` → `v14.55`.

- [ ] **Step 3: Build and verify**

Run: `cd "/Users/mike/Library/Mobile Documents/com~apple~CloudDocs/ClaudePro/PCG/pcg-netlify 3" && npm run build`
Expected: esbuild completes with no errors and `app.js` is regenerated.

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(projects): budget + actual cost fields on project form (v14.55)"
```

---

### Task 2: `summarizeProjects` (TDD)

**Files:**
- Create: `netlify/functions/analyst-lib/ops-summaries.js`
- Create: `netlify/functions/analyst-lib/ops-summaries.test.js`

- [ ] **Step 1: Write the failing tests**

Create `netlify/functions/analyst-lib/ops-summaries.test.js`:

```js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { summarizeProjects } = require('./ops-summaries');

// Small store fixture (mirrors STORES shape)
const STORES_FIX = [
  { pc: '342144', name: 'Westchester', district: 6 },
  { pc: '339616', name: 'Wadsworth', district: 1 },
];
const NOW = new Date('2026-06-09T12:00:00Z');

describe('summarizeProjects', () => {
  test('empty/missing blob → available:false', () => {
    assert.deepStrictEqual(summarizeProjects(null, null, NOW, STORES_FIX), { available: false });
    assert.deepStrictEqual(summarizeProjects([], null, NOW, STORES_FIX), { available: false });
  });

  test('derives district from pc, daysBehind from target, variance from budget', () => {
    const raw = [{
      id: 1, nickname: 'West Chester', pc: '342144', district: null, type: 'Remodel',
      dueDate: '2026-07-01', constructionCompleteBy: '2026-06-01', completed: false,
      totalBudget: '$100,000', spentToDate: '120000', gc: 'Jane Doe', gcCompany: 'Premier',
      utilities: { electric: { provider: 'Peco', status: 'In Progress' } },
      dcpDeliveryDate: '2026-06-20', notes: 'on it',
    }];
    const r = summarizeProjects(raw, null, NOW, STORES_FIX);
    assert.strictEqual(r.available, true);
    const p = r.projects[0];
    assert.strictEqual(p.district, 6);              // from STORES, not the null on the record
    assert.strictEqual(p.targetCompletion, '2026-06-01'); // constructionCompleteBy wins over dueDate
    assert.strictEqual(p.daysBehind, 8);            // 6/1 → 6/9
    assert.strictEqual(p.atRisk, true);
    assert.strictEqual(p.budget, 100000);           // '$100,000' coerced
    assert.strictEqual(p.actualCost, 120000);       // '120000' coerced
    assert.strictEqual(p.variancePct, 20);          // (120k-100k)/100k
    assert.strictEqual(p.gc, 'Jane Doe');
    assert.deepStrictEqual(p.utilities, ['electric: In Progress (Peco)']);
    assert.strictEqual(p.nextMilestone, 'DCP delivery 2026-06-20');
    assert.strictEqual(r.counts.behind, 1);
  });

  test('district filter excludes other districts; completed excluded from list', () => {
    const raw = [
      { id: 1, nickname: 'A', pc: '342144', type: 'Remodel', dueDate: '2026-08-01', completed: false },
      { id: 2, nickname: 'B', pc: '339616', type: 'Remodel', dueDate: '2026-08-01', completed: false },
      { id: 3, nickname: 'C', pc: '342144', type: 'Remodel', dueDate: '2026-01-01', completed: true },
    ];
    const r = summarizeProjects(raw, 6, NOW, STORES_FIX);
    assert.strictEqual(r.projects.length, 1);
    assert.strictEqual(r.projects[0].name, 'A');
    assert.strictEqual(r.counts.completed, 1);      // counts still see scope-wide completed
  });

  test('no budget → variancePct null; FK vendor ids are not exposed', () => {
    const raw = [{ id: 1, nickname: 'A', pc: '342144', type: 'Remodel', dueDate: '2026-08-01', completed: false, attorney: 'att1' }];
    const p = summarizeProjects(raw, null, NOW, STORES_FIX).projects[0];
    assert.strictEqual(p.budget, null);
    assert.strictEqual(p.variancePct, null);
    assert.ok(!JSON.stringify(p).includes('att1'));
  });

  test('garbage money strings coerce to null, empty string to null', () => {
    const raw = [{ id: 1, nickname: 'A', pc: '342144', type: 'Remodel', dueDate: '2026-08-01', completed: false, totalBudget: 'TBD', spentToDate: '' }];
    const p = summarizeProjects(raw, null, NOW, STORES_FIX).projects[0];
    assert.strictEqual(p.budget, null);
    assert.strictEqual(p.actualCost, null);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test "netlify/functions/analyst-lib/ops-summaries.test.js"`
Expected: FAIL — `Cannot find module './ops-summaries'`

- [ ] **Step 3: Implement**

Create `netlify/functions/analyst-lib/ops-summaries.js`:

```js
// ops-summaries.js — Pure summarizers for Orion's operational datasets
// (projects, tickets, cash deposits, food cost). No I/O here — builders in
// analyst-data.js load blobs and call these. All list lengths are capped for token control.

const DAY_MS = 86400000;
const LIST_CAPS = { projects: 20, tickets: 15, deposits: 25, missingDeposits: 20, foodItems: 15, critical: 10 };

function storesByPc(stores) {
  const m = new Map();
  for (const s of stores || []) m.set(String(s.pc), s);
  return m;
}

function toMs(d) { return d instanceof Date ? d.getTime() : new Date(d).getTime(); }
function dateMs(yyyyMmDd) { return new Date(yyyyMmDd + 'T12:00:00').getTime(); }
function daysBetween(laterMs, earlierMs) { return Math.round((laterMs - earlierMs) / DAY_MS); }

/** Coerce a money value that may be a number or a user-typed string ("$250,000") to a number, else null. */
function toMoney(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Milestone date fields on project records, in pipeline order
const PROJECT_MILESTONES = [
  ['dcpDeliveryDate', 'DCP delivery'],
  ['ncrDeinstallDate', 'NCR de-install'],
  ['ncrReinstallDate', 'NCR re-install'],
  ['interiorDmbDate', 'Interior DMB install'],
  ['exteriorDmbDate', 'Exterior DMB install'],
  ['cameraReinstallDate', 'Camera reinstall'],
  ['installationDate', 'Installation'],
];

const AT_RISK_WINDOW_DAYS = 14; // active project with target within 14 days (or past) = at risk

function summarizeProjects(raw, district, now, stores) {
  if (!Array.isArray(raw) || raw.length === 0) return { available: false };
  const byPc = storesByPc(stores);
  const nowMs = toMs(now);

  const mapped = raw.map(p => {
    const store = byPc.get(String(p.pc));
    const dist = store ? store.district : (p.district || null);
    const target = p.constructionCompleteBy || p.dueDate || null;
    const active = !p.completed;
    const daysBehind = active && target ? Math.max(0, daysBetween(nowMs, dateMs(target))) : 0;
    const atRisk = active && target ? daysBetween(dateMs(target), nowMs) <= AT_RISK_WINDOW_DAYS : false;
    const budget = toMoney(p.totalBudget);       // existing UI key (app.jsx:11834), string-typed
    const actualCost = toMoney(p.spentToDate);   // existing UI key (app.jsx:11842), string-typed
    const variancePct = budget > 0 && actualCost != null
      ? Math.round(((actualCost - budget) / budget) * 1000) / 10 : null;
    let nextMilestone = null;
    for (const [key, label] of PROJECT_MILESTONES) {
      if (p[key] && dateMs(p[key]) >= nowMs) { nextMilestone = `${label} ${p[key]}`; break; }
    }
    const utilities = Object.entries(p.utilities || {})
      .map(([k, v]) => `${k}: ${v?.status || 'Unknown'}${v?.provider ? ` (${v.provider})` : ''}`);
    return {
      name: p.nickname || String(p.id), pc: p.pc || null, district: dist,
      type: p.type || null, status: p.completed ? 'Completed' : 'Active',
      targetCompletion: target, daysBehind, atRisk,
      budget, actualCost, variancePct,
      gc: p.gc || null, gcCompany: p.gcCompany || null,
      utilities, nextMilestone,
      notes: p.notes ? String(p.notes).slice(0, 200) : null,
    };
  });

  const scoped = district ? mapped.filter(p => p.district === district) : mapped;
  if (scoped.length === 0) return { available: true, counts: { total: 0, active: 0, behind: 0, atRisk: 0, completed: 0 }, projects: [] };

  const active = scoped.filter(p => p.status === 'Active');
  const counts = {
    total: scoped.length,
    active: active.length,
    behind: active.filter(p => p.daysBehind > 0).length,
    atRisk: active.filter(p => p.atRisk).length,
    completed: scoped.length - active.length,
  };
  const projects = active
    .sort((a, b) => (b.daysBehind - a.daysBehind) || String(a.targetCompletion || '9999').localeCompare(String(b.targetCompletion || '9999')))
    .slice(0, LIST_CAPS.projects);
  return { available: true, counts, projects };
}

module.exports = { summarizeProjects, LIST_CAPS };
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test "netlify/functions/analyst-lib/ops-summaries.test.js"`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add "netlify/functions/analyst-lib/ops-summaries.js" "netlify/functions/analyst-lib/ops-summaries.test.js"
git commit -m "feat(orion): summarizeProjects — role-scoped project summary with schedule + budget variance"
```

---

### Task 3: `summarizeTickets` (TDD)

**Files:**
- Modify: `netlify/functions/analyst-lib/ops-summaries.js`
- Modify: `netlify/functions/analyst-lib/ops-summaries.test.js`

- [ ] **Step 1: Write the failing tests** — append to `ops-summaries.test.js` (add `summarizeTickets` to the require):

```js
const { summarizeTickets } = require('./ops-summaries'); // merge into existing require at top

describe('summarizeTickets', () => {
  const mkTicket = (over = {}) => ({
    id: 1780950032935, number: 'T-0001', title: 'Ice machine down', storePC: '339616',
    storeName: 'Wadsworth', category: 'Equipment Repair / Maintenance', priority: 'Medium',
    dueDate: '2026-06-11', status: 'In Progress', ticketOwner: 'Clarence Jackson',
    createdAt: '2026-06-01T08:00:00Z',
    attachments: [{ name: 'image.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }],
    comments: [{ text: 'big blob of chatter' }],
    ...over,
  });

  test('empty → available:false', () => {
    assert.deepStrictEqual(summarizeTickets(null, null, NOW, STORES_FIX), { available: false });
  });

  test('open ticket summarized with ageDays, owner; attachments/comments stripped', () => {
    const r = summarizeTickets([mkTicket()], null, NOW, STORES_FIX);
    assert.strictEqual(r.totalOpen, 1);
    const t = r.tickets[0];
    assert.strictEqual(t.owner, 'Clarence Jackson');
    assert.strictEqual(t.ageDays, 8);
    assert.strictEqual(t.district, 1);
    const s = JSON.stringify(r);
    assert.ok(!s.includes('dataUrl') && !s.includes('base64') && !s.includes('chatter'));
  });

  test('closed statuses excluded; aging buckets and critical list', () => {
    const r = summarizeTickets([
      mkTicket({ id: 1, status: 'Completed' }),
      mkTicket({ id: 2, createdAt: '2026-05-20T08:00:00Z', priority: 'High' }), // 20 days old
      mkTicket({ id: 3, createdAt: '2026-06-08T08:00:00Z' }),                   // 1 day old
    ], null, NOW, STORES_FIX);
    assert.strictEqual(r.totalOpen, 2);
    assert.deepStrictEqual(r.aging, { gt7: 1, gt14: 1 });
    assert.strictEqual(r.critical.length, 1);
    assert.strictEqual(r.tickets[0].ageDays, 20); // oldest first
    assert.strictEqual(r.openByStore[0].open, 2);
  });

  test('district filter', () => {
    const r = summarizeTickets([mkTicket()], 6, NOW, STORES_FIX); // Wadsworth is district 1
    assert.strictEqual(r.totalOpen, 0);
  });
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `node --test "netlify/functions/analyst-lib/ops-summaries.test.js"`
Expected: FAIL — `summarizeTickets is not a function`

- [ ] **Step 3: Implement** — add to `ops-summaries.js` (before `module.exports`), and add `summarizeTickets` to exports:

```js
const CLOSED_TICKET_STATUSES = new Set(['completed', 'closed', 'resolved', 'done', 'cancelled']);
const CRITICAL_PRIORITIES = new Set(['high', 'urgent', 'critical']);

function summarizeTickets(raw, district, now, stores) {
  if (!Array.isArray(raw) || raw.length === 0) return { available: false };
  const byPc = storesByPc(stores);
  const nowMs = toMs(now);

  let scoped = raw
    .filter(t => !CLOSED_TICKET_STATUSES.has(String(t.status || '').toLowerCase()))
    .map(t => {
      const store = byPc.get(String(t.storePC));
      return {
        number: t.number || String(t.id),
        title: t.title || null,
        store: t.storeName || (store && store.name) || String(t.storePC),
        district: store ? store.district : null,
        category: t.category || null,
        priority: t.priority || 'Medium',
        status: t.status || 'Open',
        owner: t.ticketOwner || null,
        dueDate: t.dueDate || null,
        ageDays: t.createdAt ? Math.max(0, daysBetween(nowMs, toMs(t.createdAt))) : null,
      };
    });
  if (district) scoped = scoped.filter(t => t.district === district);

  const aging = {
    gt7: scoped.filter(t => (t.ageDays || 0) > 7).length,
    gt14: scoped.filter(t => (t.ageDays || 0) > 14).length,
  };
  const critical = scoped
    .filter(t => CRITICAL_PRIORITIES.has(String(t.priority).toLowerCase()))
    .slice(0, LIST_CAPS.critical);
  const byStore = {};
  for (const t of scoped) {
    byStore[t.store] = byStore[t.store] || { store: t.store, district: t.district, open: 0, oldestDays: 0 };
    byStore[t.store].open++;
    byStore[t.store].oldestDays = Math.max(byStore[t.store].oldestDays, t.ageDays || 0);
  }
  const tickets = [...scoped].sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0)).slice(0, LIST_CAPS.tickets);
  return {
    available: true,
    totalOpen: scoped.length,
    tickets,
    openByStore: Object.values(byStore).sort((a, b) => b.open - a.open),
    aging,
    critical,
  };
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `node --test "netlify/functions/analyst-lib/ops-summaries.test.js"`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add "netlify/functions/analyst-lib/ops-summaries.js" "netlify/functions/analyst-lib/ops-summaries.test.js"
git commit -m "feat(orion): summarizeTickets — open-ticket summary, aging buckets, attachments stripped"
```

---

### Task 4: `summarizeCash` (TDD)

> **Business-rule note (confirm with Mike at execution):** "missing deposit" = a participating store (≥1 deposit ever) has a business date in the last 14 days, **excluding the most recent 2 days** (upload-lag buffer), that no deposit's `businessDates` covers. Heuristic, not an accusation — the prompt says so in Task 8.

**Files:**
- Modify: `netlify/functions/analyst-lib/ops-summaries.js`
- Modify: `netlify/functions/analyst-lib/ops-summaries.test.js`

- [ ] **Step 1: Write the failing tests** — append (merge `summarizeCash` into the require):

```js
describe('summarizeCash', () => {
  const dep = (over = {}) => ({
    id: 'dep_1', depositDate: '2026-06-05', businessDates: ['2026-06-04'],
    pc: '339616', llcName: 'Rao 7 Inc', amount: 356.18, ...over,
  });

  test('empty → available:false', () => {
    assert.deepStrictEqual(summarizeCash(null, null, NOW, STORES_FIX), { available: false });
  });

  test('deposit detail with store name/district + totals', () => {
    const r = summarizeCash([dep()], null, NOW, STORES_FIX);
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.deposits[0].store, 'Wadsworth');
    assert.strictEqual(r.deposits[0].district, 1);
    assert.strictEqual(r.last7Total, 356.18);
    assert.strictEqual(r.last30Total, 356.18);
  });

  test('missing deposits: uncovered business dates in window, 2-day buffer excluded', () => {
    // Store covered 6/1-6/4 only. Window = 5/26..6/7 (14 days back, minus 6/8 & 6/9 buffer).
    const deposits = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']
      .map((d, i) => dep({ id: 'd' + i, businessDates: [d], depositDate: d }));
    const r = summarizeCash(deposits, null, NOW, STORES_FIX);
    const dates = r.missingDeposits.filter(m => m.store === 'Wadsworth').map(m => m.date);
    assert.ok(dates.includes('2026-05-31'));   // in window, uncovered
    assert.ok(dates.includes('2026-06-07'));   // in window, uncovered
    assert.ok(!dates.includes('2026-06-08'));  // buffer
    assert.ok(!dates.includes('2026-06-02'));  // covered
    // Westchester never deposited → not a participating store → no gaps reported
    assert.ok(!r.missingDeposits.some(m => m.store === 'Westchester'));
  });

  test('district filter', () => {
    const r = summarizeCash([dep()], 6, NOW, STORES_FIX);
    assert.deepStrictEqual(r.deposits, []);
  });
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `node --test "netlify/functions/analyst-lib/ops-summaries.test.js"`
Expected: FAIL — `summarizeCash is not a function`

- [ ] **Step 3: Implement** — add to `ops-summaries.js`, export `summarizeCash`:

```js
const CASH_WINDOW_DAYS = 14;  // gap-scan window
const CASH_BUFFER_DAYS = 2;   // most recent N days exempt (upload lag)

function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

function summarizeCash(raw, district, now, stores) {
  if (!Array.isArray(raw) || raw.length === 0) return { available: false };
  const byPc = storesByPc(stores);
  const nowMs = toMs(now);

  let deps = raw.map(d => {
    const store = byPc.get(String(d.pc));
    return {
      store: store ? store.name : String(d.pc),
      district: store ? store.district : null,
      pc: String(d.pc),
      depositDate: d.depositDate || null,
      amount: typeof d.amount === 'number' ? d.amount : Number(d.amount) || 0,
      llcName: d.llcName || null,
      businessDates: Array.isArray(d.businessDates) ? d.businessDates : [],
    };
  });
  if (district) deps = deps.filter(d => d.district === district);

  const ageDays = d => d.depositDate ? daysBetween(nowMs, dateMs(d.depositDate)) : Infinity;
  const round2 = n => Math.round(n * 100) / 100;
  const last7Total = round2(deps.filter(d => ageDays(d) <= 7).reduce((s, d) => s + d.amount, 0));
  const last30Total = round2(deps.filter(d => ageDays(d) <= 30).reduce((s, d) => s + d.amount, 0));

  // Missing deposits: per participating store (≥1 deposit in scope), business dates in
  // [now-CASH_WINDOW_DAYS, now-CASH_BUFFER_DAYS-1] not covered by any deposit's businessDates.
  const coveredByPc = new Map();
  for (const d of deps) {
    if (!coveredByPc.has(d.pc)) coveredByPc.set(d.pc, new Set());
    for (const bd of d.businessDates) coveredByPc.get(d.pc).add(bd);
  }
  const missingDeposits = [];
  for (const [pc, covered] of coveredByPc) {
    const store = byPc.get(pc);
    for (let back = CASH_WINDOW_DAYS; back > CASH_BUFFER_DAYS; back--) {
      const date = isoDay(nowMs - back * DAY_MS);
      if (!covered.has(date)) {
        missingDeposits.push({ store: store ? store.name : pc, district: store ? store.district : null, date });
      }
    }
  }
  missingDeposits.sort((a, b) => a.store.localeCompare(b.store) || a.date.localeCompare(b.date));

  const deposits = [...deps]
    .sort((a, b) => String(b.depositDate || '').localeCompare(String(a.depositDate || '')))
    .slice(0, LIST_CAPS.deposits)
    .map(({ pc, ...rest }) => rest);
  return {
    available: true,
    deposits,
    last7Total,
    last30Total,
    missingDeposits: missingDeposits.slice(0, LIST_CAPS.missingDeposits),
    missingCount: missingDeposits.length,
  };
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `node --test "netlify/functions/analyst-lib/ops-summaries.test.js"`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add "netlify/functions/analyst-lib/ops-summaries.js" "netlify/functions/analyst-lib/ops-summaries.test.js"
git commit -m "feat(orion): summarizeCash — deposit detail, totals, derived missing-deposit gaps"
```

---

### Task 5: `summarizeFoodCost` + `compactComputed` (TDD)

Static cost-lookup tables are the always-available baseline; the (currently empty) `pcg_food_cost_beverages_v1` blob is an overlay when populated. `compactComputed` defends against a future multi-MB blob: it keeps only top-level scalars and array lengths.

**Files:**
- Modify: `netlify/functions/analyst-lib/ops-summaries.js`
- Modify: `netlify/functions/analyst-lib/ops-summaries.test.js`

- [ ] **Step 1: Write the failing tests** — append (merge `summarizeFoodCost, compactComputed` into the require):

```js
describe('summarizeFoodCost', () => {
  const tables = {
    beverages: { 'Latte M': 1.50, 'Latte L': 2.00, 'Cold Brew': 1.00 },
    food: { Sandwich: 2.00 },
    empty: {},
  };

  test('no tables → available:false', () => {
    assert.deepStrictEqual(summarizeFoodCost({}, null), { available: false });
  });

  test('per-category counts, averages, items sorted by cost desc; empty category dropped', () => {
    const r = summarizeFoodCost(tables, null);
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.categories.length, 2);
    const bev = r.categories.find(c => c.category === 'beverages');
    assert.strictEqual(bev.itemCount, 3);
    assert.strictEqual(bev.avgUnitCost, 1.5);
    assert.strictEqual(bev.items[0].item, 'Latte L');
    assert.strictEqual(r.computed, undefined);
  });

  test('computed overlay included when present', () => {
    const r = summarizeFoodCost(tables, { beverages: { asOf: '2026-06-08', storeCount: 45 } });
    assert.deepStrictEqual(r.computed, { beverages: { asOf: '2026-06-08', storeCount: 45 } });
  });
});

describe('compactComputed', () => {
  test('keeps scalars, replaces arrays/objects with sizes', () => {
    assert.deepStrictEqual(
      compactComputed({ asOf: 'x', pct: 0.28, rows: [1, 2, 3], nested: { a: 1 }, big: 'y'.repeat(500) }),
      { asOf: 'x', pct: 0.28, rows: '[3 items]', nested: '[object]' }
    );
  });
  test('non-object passthrough → null', () => {
    assert.strictEqual(compactComputed(null), null);
    assert.strictEqual(compactComputed('str'), null);
  });
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `node --test "netlify/functions/analyst-lib/ops-summaries.test.js"`
Expected: FAIL — `summarizeFoodCost is not a function`

- [ ] **Step 3: Implement** — add to `ops-summaries.js`, export both:

```js
function summarizeFoodCost(tables, computed) {
  const categories = [];
  for (const [category, table] of Object.entries(tables || {})) {
    const entries = Object.entries(table || {}).filter(([, v]) => typeof v === 'number');
    if (entries.length === 0) continue;
    const avg = entries.reduce((s, [, v]) => s + v, 0) / entries.length;
    categories.push({
      category,
      itemCount: entries.length,
      avgUnitCost: Math.round(avg * 100) / 100,
      items: entries.sort((a, b) => b[1] - a[1]).slice(0, LIST_CAPS.foodItems)
        .map(([item, unitCost]) => ({ item, unitCost })),
    });
  }
  if (categories.length === 0) return { available: false };
  const out = { available: true, categories };
  if (computed && typeof computed === 'object' && Object.keys(computed).length > 0) out.computed = computed;
  return out;
}

/** Defensive trim of an unknown blob: top-level scalars only (strings ≤200 chars), arrays/objects → size markers */
function compactComputed(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null;
  const out = {};
  for (const [k, v] of Object.entries(blob)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 200) out[k] = v;
    else if (Array.isArray(v)) out[k] = `[${v.length} items]`;
    else if (v && typeof v === 'object') out[k] = '[object]';
  }
  return out;
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `node --test "netlify/functions/analyst-lib/ops-summaries.test.js"`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add "netlify/functions/analyst-lib/ops-summaries.js" "netlify/functions/analyst-lib/ops-summaries.test.js"
git commit -m "feat(orion): summarizeFoodCost — static cost tables baseline + compacted blob overlay"
```

---

### Task 6: `renderOpsContext` (TDD)

Converts the four summary objects into the compact text sections appended to the prompt data block (same style as `buildWeatherContext`'s `'\n\nWEATHER FORECAST:\n…'`).

**Files:**
- Modify: `netlify/functions/analyst-lib/ops-summaries.js`
- Modify: `netlify/functions/analyst-lib/ops-summaries.test.js`

- [ ] **Step 1: Write the failing tests** — append (merge `renderOpsContext` into the require):

```js
describe('renderOpsContext', () => {
  test('unavailable domains render "no data yet" lines', () => {
    const txt = renderOpsContext({
      projects: { available: false }, tickets: { available: false },
      cash: { available: false }, foodCost: { available: false },
    });
    assert.ok(txt.includes('CONSTRUCTION & PROJECTS:'));
    assert.ok(txt.includes('No project data yet'));
    assert.ok(txt.includes('No ticket data yet'));
    assert.ok(txt.includes('No cash deposit data yet'));
    assert.ok(txt.includes('No food cost data yet'));
  });

  test('available domains render counts and detail lines', () => {
    const txt = renderOpsContext({
      projects: {
        available: true,
        counts: { total: 2, active: 1, behind: 1, atRisk: 1, completed: 1 },
        projects: [{ name: 'West Chester', district: 6, type: 'Remodel', status: 'Active', targetCompletion: '2026-06-01', daysBehind: 8, atRisk: true, budget: 100000, actualCost: 120000, variancePct: 20, gc: 'Jane Doe', gcCompany: 'Premier', utilities: ['electric: In Progress (Peco)'], nextMilestone: 'DCP delivery 2026-06-20', notes: null }],
      },
      tickets: {
        available: true, totalOpen: 1, aging: { gt7: 1, gt14: 0 },
        tickets: [{ number: 'T-0001', title: 'Ice machine down', store: 'Wadsworth', district: 1, category: 'Equipment', priority: 'High', status: 'In Progress', owner: 'Clarence Jackson', dueDate: '2026-06-11', ageDays: 8 }],
        openByStore: [{ store: 'Wadsworth', district: 1, open: 1, oldestDays: 8 }],
        critical: [{ number: 'T-0001', store: 'Wadsworth', title: 'Ice machine down', owner: 'Clarence Jackson', ageDays: 8 }],
      },
      cash: {
        available: true, last7Total: 356.18, last30Total: 1024.5, missingCount: 1,
        deposits: [{ store: 'Wadsworth', district: 1, depositDate: '2026-06-05', amount: 356.18, llcName: 'Rao 7 Inc', businessDates: ['2026-06-04'] }],
        missingDeposits: [{ store: 'Wadsworth', district: 1, date: '2026-05-31' }],
      },
      foodCost: {
        available: true,
        categories: [{ category: 'beverages', itemCount: 3, avgUnitCost: 1.5, items: [{ item: 'Latte L', unitCost: 2 }] }],
      },
    });
    assert.ok(txt.includes('8d BEHIND'));
    assert.ok(txt.includes('GC: Jane Doe (Premier)'));
    assert.ok(txt.includes('variance +20%'));
    assert.ok(txt.includes('T-0001'));
    assert.ok(txt.includes('Clarence Jackson'));
    assert.ok(txt.includes('$356.18'));
    assert.ok(txt.includes('2026-05-31'));
    assert.ok(txt.includes('Latte L'));
    assert.ok(txt.includes('possible missing deposits'));
  });
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `node --test "netlify/functions/analyst-lib/ops-summaries.test.js"`
Expected: FAIL — `renderOpsContext is not a function`

- [ ] **Step 3: Implement** — add to `ops-summaries.js`, export `renderOpsContext`:

```js
function renderOpsContext({ projects, tickets, cash, foodCost } = {}) {
  const L = [];

  L.push('\n\nCONSTRUCTION & PROJECTS:');
  if (!projects || !projects.available) L.push('  No project data yet.');
  else {
    const c = projects.counts;
    L.push(`  ${c.active} active (${c.behind} behind schedule, ${c.atRisk} at risk), ${c.completed} completed.`);
    for (const p of projects.projects) {
      let line = `  ${p.name} (${p.type || 'Project'}, D${p.district ?? '?'}): target ${p.targetCompletion || 'n/a'}`;
      if (p.daysBehind > 0) line += `, ${p.daysBehind}d BEHIND`;
      else if (p.atRisk) line += ', AT RISK';
      if (p.budget != null) line += `, budget $${p.budget.toLocaleString()}`;
      if (p.actualCost != null) line += `, spent $${p.actualCost.toLocaleString()}`;
      if (p.variancePct != null) line += `, variance ${p.variancePct > 0 ? '+' : ''}${p.variancePct}%`;
      if (p.gc) line += `, GC: ${p.gc}${p.gcCompany ? ` (${p.gcCompany})` : ''}`;
      L.push(line);
      if (p.nextMilestone) L.push(`    next: ${p.nextMilestone}`);
      if (p.utilities && p.utilities.length) L.push(`    utilities: ${p.utilities.join('; ')}`);
      if (p.notes) L.push(`    notes: ${p.notes}`);
    }
  }

  L.push('\nMAINTENANCE TICKETS:');
  if (!tickets || !tickets.available) L.push('  No ticket data yet.');
  else if (tickets.totalOpen === 0) L.push('  No open tickets.');
  else {
    L.push(`  ${tickets.totalOpen} open (${tickets.aging.gt7} older than 7d, ${tickets.aging.gt14} older than 14d).`);
    for (const t of tickets.tickets) {
      L.push(`  ${t.number} | ${t.store} (D${t.district ?? '?'}) | ${t.title} | ${t.priority} | ${t.status} | owner: ${t.owner || 'unassigned'} | ${t.ageDays ?? '?'}d old${t.dueDate ? ` | due ${t.dueDate}` : ''}`);
    }
    if (tickets.critical.length) L.push(`  CRITICAL/HIGH: ${tickets.critical.map(t => `${t.number} ${t.store} (${t.owner || 'unassigned'})`).join('; ')}`);
  }

  L.push('\nCASH DEPOSITS:');
  if (!cash || !cash.available) L.push('  No cash deposit data yet.');
  else {
    L.push(`  Last 7 days: $${cash.last7Total.toLocaleString()} deposited. Last 30 days: $${cash.last30Total.toLocaleString()}.`);
    for (const d of cash.deposits.slice(0, 10)) {
      L.push(`  ${d.depositDate} | ${d.store} (D${d.district ?? '?'}) | $${d.amount.toLocaleString()} | ${d.llcName || ''} | covers ${d.businessDates.join(', ')}`);
    }
    if (cash.missingCount > 0) {
      L.push(`  ${cash.missingCount} possible missing deposits (business dates with no covering deposit — derived heuristic, verify before acting):`);
      for (const m of cash.missingDeposits) L.push(`    ${m.store} (D${m.district ?? '?'}): ${m.date}`);
    }
  }

  L.push('\nFOOD COST (THEORETICAL UNIT COSTS):');
  if (!foodCost || !foodCost.available) L.push('  No food cost data yet.');
  else {
    for (const c of foodCost.categories) {
      L.push(`  ${c.category}: ${c.itemCount} items, avg unit cost $${c.avgUnitCost}`);
      L.push(`    top: ${c.items.map(i => `${i.item} $${i.unitCost}`).join('; ')}`);
    }
    if (foodCost.computed) L.push(`  computed overlay: ${JSON.stringify(foodCost.computed)}`);
  }

  return L.join('\n');
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `node --test "netlify/functions/analyst-lib/ops-summaries.test.js"`
Expected: PASS (19 tests)

- [ ] **Step 5: Commit**

```bash
git add "netlify/functions/analyst-lib/ops-summaries.js" "netlify/functions/analyst-lib/ops-summaries.test.js"
git commit -m "feat(orion): renderOpsContext — compact text rendering of the four ops summaries"
```

---

### Task 7: Async builders + `buildDataContext` wiring in `analyst-data.js`

**Files:**
- Modify: `netlify/functions/analyst-lib/analyst-data.js` (requires at top; `buildDataContext` at :146; `module.exports` at :351)

- [ ] **Step 1: Add requires** — after the existing `analyst-cache` require at the top:

```js
const { summarizeProjects, summarizeTickets, summarizeCash, summarizeFoodCost, compactComputed, renderOpsContext } = require('./ops-summaries');
const { BEVERAGE_COSTS, FOOD_COSTS, ICE_CREAM_COSTS, INGREDIENT_COSTS } = require('./cost-lookup');
```

- [ ] **Step 2: Add the builders** — after `buildEmailContext` (before `module.exports`):

```js
// ── Operational datasets (projects, tickets, cash, food cost) ───────────────

async function buildProjectsContext({ district } = {}) {
  return summarizeProjects(await cacheLoad('pcg_projects_v1'), district || null, new Date(), STORES);
}

async function buildTicketsContext({ district } = {}) {
  return summarizeTickets(await cacheLoad('pcg_tickets_v1'), district || null, new Date(), STORES);
}

async function buildCashContext({ district } = {}) {
  return summarizeCash(await cacheLoad('pcg_cash_deposits_v1'), district || null, new Date(), STORES);
}

async function buildFoodCostContext() {
  const bev = await cacheLoad('pcg_food_cost_beverages_v1');
  const overlay = compactComputed(bev);
  return summarizeFoodCost(
    { beverages: BEVERAGE_COSTS, food: FOOD_COSTS, iceCream: ICE_CREAM_COSTS, ingredients: INGREDIENT_COSTS },
    overlay ? { beverages: overlay } : null
  );
}

/** Render all four ops summaries as a text block for the prompt data section. */
async function buildOpsContext({ district } = {}) {
  const [projects, tickets, cash, foodCost] = await Promise.all([
    buildProjectsContext({ district }),
    buildTicketsContext({ district }),
    buildCashContext({ district }),
    buildFoodCostContext(),
  ]);
  return renderOpsContext({ projects, tickets, cash, foodCost });
}
```

- [ ] **Step 3: Wire into `buildDataContext`** — change its first lines (analyst-data.js:146-148) from:

```js
async function buildDataContext({ district, includeStoreDetail } = {}) {
  const snapshot = await buildKPISnapshot({ district });
  if (snapshot.error) return snapshot.error;
```

to:

```js
async function buildDataContext({ district, includeStoreDetail } = {}) {
  const snapshot = await buildKPISnapshot({ district });
  const opsContext = await buildOpsContext({ district: district || null });
  if (snapshot.error) return snapshot.error + opsContext;
```

and change the final `return context;` of the same function to:

```js
  return context + opsContext;
```

(Ops data still reaches Orion even when the labor cron hasn't run — graceful degradation in both directions.)

- [ ] **Step 4: Extend `module.exports`** — add to the export object:

```js
  buildProjectsContext,
  buildTicketsContext,
  buildCashContext,
  buildFoodCostContext,
  buildOpsContext,
```

- [ ] **Step 5: Verify it loads and unit tests still pass**

Run: `node -e "const d = require('./netlify/functions/analyst-lib/analyst-data'); console.log(typeof d.buildOpsContext)"` (from the project root)
Expected: `function`

Run: `node --test "netlify/functions/analyst-lib/ops-summaries.test.js"`
Expected: PASS (19 tests)

- [ ] **Step 6: Commit**

```bash
git add "netlify/functions/analyst-lib/analyst-data.js"
git commit -m "feat(orion): wire projects/tickets/cash/food-cost contexts into buildDataContext"
```

---

### Task 8: Tell Orion about the new datasets in `analyst-prompts.js`

**Files:**
- Modify: `netlify/functions/analyst-lib/analyst-prompts.js:49-50` (`ASK_SYSTEM` numbered list)

- [ ] **Step 1: Append a rule to ASK_SYSTEM**

After item 9 (the `{{drill:StoreName:tab}}` rule, line 49), add:

```
10. You also have operational datasets in the data block: CONSTRUCTION & PROJECTS (status, target dates, days behind, GC/contractor, budget vs spend where entered), MAINTENANCE TICKETS (open tickets with owner, priority, age), CASH DEPOSITS (recent deposits and derived possible-missing-deposit gaps), and FOOD COST (theoretical per-item unit costs). All figures are already scoped to the user's role. Missing-deposit gaps are a derived heuristic — recommend verification, never accuse anyone of a missing deposit.
```

- [ ] **Step 2: Verify module loads**

Run: `node -e "const p = require('./netlify/functions/analyst-lib/analyst-prompts'); console.log(p.ASK_SYSTEM.includes('CONSTRUCTION & PROJECTS'))"`
Expected: `true`

- [ ] **Step 3: Commit**

```bash
git add "netlify/functions/analyst-lib/analyst-prompts.js"
git commit -m "feat(orion): prompt — describe the four operational datasets and their guardrails"
```

---

### Task 9: Full test run, preview deploy, integration check, PR

- [ ] **Step 1: Run the whole analyst-lib test suite**

Run: `node --test "netlify/functions/analyst-lib/"`
Expected: ALL PASS (ops-summaries + pnl-calc + cost-lookup)

- [ ] **Step 2: Preview deploy**

Run: `npx netlify deploy` (preview, NOT --prod)
Expected: deploy URL printed.

- [ ] **Step 3: Integration check — the original screenshot question**

POST to the preview's analyst function:

```bash
curl -s "<preview-url>/.netlify/functions/analyst" -H 'Content-Type: application/json' \
  -d '{"action":"ask","userId":1,"userRole":"executive","question":"What is the status of all active remodel and construction projects? Flag anything behind schedule or at risk."}' | head -c 2000
```

Expected: answer cites real project names (e.g. active remodels), days behind / at-risk flags — not "I don't have construction data."

Also verify role scoping: repeat with `"userRole":"dm","district":3` and confirm only District 3 items appear.

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin feature/orion-ops-datasets
gh pr create --title "Orion: projects, tickets, cash & food-cost datasets (v14.55)" --body "Implements docs/superpowers/specs/2026-06-09-orion-ops-datasets-design.md ..."
```

- [ ] **Step 5: After merge — prod deploy** (per deploy authorization: tracked tree must be clean first)

```bash
git checkout main && git pull && npm run build && npx netlify deploy --prod
```

---

## Self-Review

- **Spec coverage:** all four domains ✔; role scoping via district param ✔; graceful absence ✔ (`available:false` → "No X data yet"); no PII/secrets ✔ (attachments stripped + tested, deposit images never read, FK vendor ids dropped); list caps ✔ (`LIST_CAPS`); prompt section ✔ (Task 8); TDD via node:test ✔; integration test = the screenshot question ✔. **Deviation from spec (approved by Mike 2026-06-09):** budget fields added to UI first (Task 1) instead of assuming they exist; food cost from static tables + blob overlay instead of blob-only; cash gaps derived instead of a nonexistent `reconciled` flag; `summarizeFoodCost` takes `(tables, computed)` not `(rawByCategory)`. **Task 1 superseded during execution:** budget entry already existed as `totalBudget`/`spentToDate` (string-typed); duplicate inputs reverted (f4b7639) and the summarizer reads the existing keys via `toMoney()` coercion.
- **Placeholder scan:** none — every code step has complete code.
- **Type consistency:** summarizer signatures `(raw, district, now, stores)` consistent across Tasks 2-4; `renderOpsContext({projects,tickets,cash,foodCost})` matches Task 7's call; export names in Task 7 Step 1 require match Tasks 2-6 exports.
