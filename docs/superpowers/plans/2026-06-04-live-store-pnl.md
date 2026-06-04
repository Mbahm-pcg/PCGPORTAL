# Live Store P&L Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a near-live, per-store estimated P&L (`Contribution = Revenue − Labor − COGS`) with a contribution-margin–ranked dashboard, weekly/monthly rollups, and trend lines — role-scoped by `userType`.

**Architecture:** A pure compute core (`analyst-lib/pnl-calc.js`) is the single source of truth for the P&L formula. COGS is hybrid: BOM (Pulse menu-mix × per-item cost from an extracted `analyst-lib/cost-lookup.js`) when menu-mix explains ≥70% of revenue, else a category-% fallback from a config blob. `labor-cron.js` computes P&L in its existing per-store loop (reusing its in-file Pulse client) and writes a live snapshot (`pcg_pnl_live_v1`) + per-store daily history (`pcg_pnl_store_{pc}`). The monthly `pnl-cron.js` reads stored COGS so its Orion narrative finally includes COGS. A new `AdminPnL` React component renders the dashboard.

**Tech Stack:** Node.js CommonJS Netlify Functions; Netlify Blobs; React 18 (CDN) authored in JSX, bundled with esbuild; Chart.js (CDN); inline styles only; tests via Node built-in `node:test` + `node:assert` (no new deps).

---

## File Structure

**New files:**
- `netlify/functions/analyst-lib/cost-lookup.js` — cost catalogs + `lookupUnitCost(itemName)` cascade, extracted from `food-cost.js`. Single source of per-item unit cost.
- `netlify/functions/analyst-lib/cost-lookup.test.js` — unit tests for the lookup cascade.
- `netlify/functions/analyst-lib/pnl-calc.js` — pure P&L compute core (`computeStorePnL`, `computeCogs`). No I/O.
- `netlify/functions/analyst-lib/pnl-calc.test.js` — unit tests for the compute core.

**Modified files:**
- `netlify/functions/food-cost.js` — `require` the extracted `cost-lookup.js`; replace inline catalogs + cascade with the shared module (behavior-preserving).
- `netlify/functions/labor-cron.js` — fetch menu mix per store; compute P&L via `pnl-calc`; write `pcg_pnl_live_v1` + `pcg_pnl_store_{pc}`; load `pcg_pnl_config_v1`.
- `netlify/functions/pnl-cron.js` — read stored daily COGS into the monthly narrative; fix `laborHours` → `hoursWorked` bug.
- `netlify.toml` — move `labor-cron` to hourly within business hours.
- `package.json` — add a `test` script.
- `app.jsx` — add `AdminPnL` component, P&L tab in `getTabs`, routing, version bump.

**Blob keys (all use the `{ savedAt, data }` wrapper):**
- `pcg_pnl_live_v1` — network + per-store current snapshot (drives the grid).
- `pcg_pnl_store_{pc}` — appended daily history points (drives trends + rollups).
- `pcg_pnl_config_v1` — COGS-% fallback config (`{ defaultCogsPct, byStore, byDistrict }`).

---

## Interface Contract (locked — used across all tasks)

```js
// analyst-lib/cost-lookup.js
lookupUnitCost(itemName: string) => number | undefined   // $/unit, undefined if unknown

// analyst-lib/pnl-calc.js
computeCogs(menuMix, costOf, revenue, cogsPct)
  // menuMix: Array<{ name: string, slsCnt: number, slsTtl: number }>
  // costOf:  (name) => number | undefined
  // => { cogs: number, method: 'BOM' | 'est', coverage: number /* 0..1 */ }

computeStorePnL(inputs, costOf)
  // inputs: { revenue, labor, menuMix, cogsPct }
  // => { revenue, labor, cogs, contribution, marginPct, laborPct, cogsPct, method, coverage }
  //    marginPct / laborPct / cogsPct / coverage are percentages to 1 dp (e.g. 22.9)

// Snapshot written by labor-cron to pcg_pnl_live_v1 (inside the {savedAt,data} wrapper):
{
  busDt: 'YYYY-MM-DD',
  network: { revenue, labor, cogs, contribution, marginPct, laborPct, cogsPct },
  stores: [ { pc, name, district, ...computeStorePnL output } ],   // ranked client-side
  excluded: [ { pc, name, reason } ]                               // missing-labor stores
}

// Per-store daily history point appended to pcg_pnl_store_{pc}.data.daily[]:
{ date, revenue, labor, cogs, contribution, marginPct, laborPct, cogsPct, method }
```

---

### Task 1: Extract cost catalog into a shared module

**Why:** `food-cost.js` holds the per-item cost catalogs and lookup cascade *inside its handler* (not exported). The P&L path needs the same cost lookup. Extract it once so both consume one source of truth (DRY).

**Files:**
- Create: `netlify/functions/analyst-lib/cost-lookup.js`
- Modify: `netlify/functions/food-cost.js`

- [ ] **Step 1: Identify the exact blocks to move in `food-cost.js`**

Open `netlify/functions/food-cost.js` and locate (line numbers approximate — match by symbol name):
- Cost catalogs: `BEVERAGE_COSTS`, `FOOD_COSTS`, `ICE_CREAM_COSTS`, `PREMIUM_COSTS` (≈ lines 25–277)
- `POS_ALIASES` (≈ lines 282–415)
- `INGREDIENT_COSTS` (≈ lines 323–337)
- Normalization helpers `_norm`, `_sortWords` and the derived `NORM_LOOKUP`, `WORD_SORT_LOOKUP` tables
- The lookup cascade currently at ≈ lines 699–702:
  ```js
  const exactCost = BEVERAGE_COSTS[itemName] ?? FOOD_COSTS[itemName] ?? ICE_CREAM_COSTS[itemName] ?? PREMIUM_COSTS[itemName]
    ?? POS_ALIASES[itemName]
    ?? NORM_LOOKUP[_norm(itemName)]
    ?? WORD_SORT_LOOKUP[_sortWords(itemName)];
  ```

- [ ] **Step 2: Create `cost-lookup.js` with the moved data + a `lookupUnitCost` wrapper**

Create `netlify/functions/analyst-lib/cost-lookup.js`. Paste the catalog/alias/ingredient objects and the `_norm`/`_sortWords` helpers + derived lookup tables **verbatim** from `food-cost.js`, then add the wrapper function and exports:

```js
// PCG Portal — Cost Lookup (shared)
// Single source of truth for per-menu-item unit cost ($/unit).
// Extracted from food-cost.js so both the Food Cost view and the P&L
// compute path resolve item costs identically.

// ── Cost catalogs (moved verbatim from food-cost.js) ──
const BEVERAGE_COSTS = { /* ...moved verbatim... */ };
const FOOD_COSTS      = { /* ...moved verbatim... */ };
const ICE_CREAM_COSTS = { /* ...moved verbatim... */ };
const PREMIUM_COSTS   = { /* ...moved verbatim... */ };
const POS_ALIASES     = { /* ...moved verbatim... */ };
const INGREDIENT_COSTS= { /* ...moved verbatim... */ };

// ── Normalization helpers (moved verbatim) ──
function _norm(s)      { /* ...moved verbatim... */ }
function _sortWords(s) { /* ...moved verbatim... */ }

// Derived lookup tables (moved verbatim — build from the catalogs above)
const NORM_LOOKUP      = { /* ...moved verbatim... */ };
const WORD_SORT_LOOKUP = { /* ...moved verbatim... */ };

/**
 * Resolve a Pulse menu-item name to a unit cost ($/unit).
 * Cascade: exact catalog → POS alias → normalized → word-sorted.
 * @param {string} itemName
 * @returns {number|undefined} unit cost, or undefined if unknown
 */
function lookupUnitCost(itemName) {
  if (!itemName) return undefined;
  return BEVERAGE_COSTS[itemName] ?? FOOD_COSTS[itemName] ?? ICE_CREAM_COSTS[itemName] ?? PREMIUM_COSTS[itemName]
    ?? POS_ALIASES[itemName]
    ?? NORM_LOOKUP[_norm(itemName)]
    ?? WORD_SORT_LOOKUP[_sortWords(itemName)];
}

module.exports = {
  lookupUnitCost,
  BEVERAGE_COSTS, FOOD_COSTS, ICE_CREAM_COSTS, PREMIUM_COSTS,
  POS_ALIASES, INGREDIENT_COSTS, NORM_LOOKUP, WORD_SORT_LOOKUP,
  _norm, _sortWords,
};
```

- [ ] **Step 3: Rewire `food-cost.js` to consume the shared module**

In `food-cost.js`, delete the moved definitions and add at the top (with the other `require`s):

```js
const {
  BEVERAGE_COSTS, FOOD_COSTS, ICE_CREAM_COSTS, PREMIUM_COSTS,
  POS_ALIASES, INGREDIENT_COSTS, NORM_LOOKUP, WORD_SORT_LOOKUP,
  _norm, _sortWords, lookupUnitCost,
} = require('./analyst-lib/cost-lookup');
```

Replace the inline cascade (≈ lines 699–702) with:
```js
const exactCost = lookupUnitCost(itemName);
```
Leave the surrounding lines (`unitCost`, `totalUnits`, `cost`) unchanged — `INGREDIENT_COSTS` is now imported, so the `cls.sub` fallback still resolves.

- [ ] **Step 4: Verify the refactor is behavior-preserving (syntax + spot check)**

Run: `node -e "require('./netlify/functions/food-cost.js'); require('./netlify/functions/analyst-lib/cost-lookup.js'); console.log('OK')"`
Expected: prints `OK` with no `ReferenceError`/`SyntaxError` (confirms all moved symbols still resolve in both files).

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/analyst-lib/cost-lookup.js netlify/functions/food-cost.js
git commit -m "refactor: extract cost catalog into analyst-lib/cost-lookup.js"
```

---

### Task 2: Add the `test` script

**Why:** The repo has no test runner. Node 25 ships `node:test`; wire it up so later TDD steps have a command to run.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add a `test` script**

In `package.json`, inside `"scripts"`, add (keep existing scripts):
```json
"test": "node --test netlify/functions/analyst-lib/"
```

- [ ] **Step 2: Verify the runner works (no tests yet = exit 0)**

Run: `npm test`
Expected: runs with `tests 0` / `pass 0` and exits 0 (no `*.test.js` files yet, which is fine).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add node:test test script"
```

---

### Task 3: Build the cost-lookup test (lock the extracted contract)

**Files:**
- Test: `netlify/functions/analyst-lib/cost-lookup.test.js`

- [ ] **Step 1: Write the failing test**

Create `netlify/functions/analyst-lib/cost-lookup.test.js`:
```js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { lookupUnitCost } = require('./cost-lookup');

describe('lookupUnitCost', () => {
  test('resolves a known exact catalog item to a positive number', () => {
    const cost = lookupUnitCost('Bacon Egg & Cheese');
    assert.strictEqual(typeof cost, 'number');
    assert.ok(cost > 0, 'expected a positive unit cost');
  });

  test('returns undefined for an unknown item', () => {
    assert.strictEqual(lookupUnitCost('Totally Not A Real Menu Item 9999'), undefined);
  });

  test('returns undefined for empty / nullish input', () => {
    assert.strictEqual(lookupUnitCost(''), undefined);
    assert.strictEqual(lookupUnitCost(undefined), undefined);
  });
});
```
> If `'Bacon Egg & Cheese'` is not present verbatim in `FOOD_COSTS`, substitute any key you confirmed exists in `cost-lookup.js` during Task 1.

- [ ] **Step 2: Run the test**

Run: `node --test netlify/functions/analyst-lib/cost-lookup.test.js`
Expected: PASS (3 tests). If the known-item test fails, the catalog wasn't moved correctly in Task 1 — fix the extraction.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/analyst-lib/cost-lookup.test.js
git commit -m "test: cover cost-lookup cascade"
```

---

### Task 4: Pure P&L compute core — `pnl-calc.js`

**Files:**
- Create: `netlify/functions/analyst-lib/pnl-calc.js`
- Test: `netlify/functions/analyst-lib/pnl-calc.test.js`

- [ ] **Step 1: Write the failing tests**

Create `netlify/functions/analyst-lib/pnl-calc.test.js`:
```js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { computeStorePnL, computeCogs, DEFAULT_COGS_PCT, BOM_COVERAGE_THRESHOLD } = require('./pnl-calc');

// Deterministic cost lookup for tests: latte $1, sandwich $2, everything else unknown.
const costOf = (name) => ({ Latte: 1, Sandwich: 2 }[name]);

describe('computeCogs', () => {
  test('zero / missing revenue → cogs 0, est', () => {
    assert.deepStrictEqual(computeCogs([], costOf, 0, 0.29), { cogs: 0, method: 'est', coverage: 0 });
  });

  test('no menu mix → category-% fallback (est)', () => {
    const r = computeCogs([], costOf, 1000, 0.29);
    assert.strictEqual(r.method, 'est');
    assert.strictEqual(r.cogs, 290); // 1000 * 0.29
  });

  test('high coverage → BOM (covered cost + estimated tail)', () => {
    // 800 of 1000 revenue is covered by known-cost items
    const mix = [
      { name: 'Latte',    slsCnt: 100, slsTtl: 500 }, // cost 100
      { name: 'Sandwich', slsCnt: 100, slsTtl: 300 }, // cost 200
      { name: 'Mystery',  slsCnt: 50,  slsTtl: 200 }, // unknown
    ];
    const r = computeCogs(mix, costOf, 1000, 0.29);
    assert.strictEqual(r.method, 'BOM');
    // covered cost 300 + tail (1000-800)*0.29 = 58 → 358
    assert.strictEqual(r.cogs, 358);
    assert.ok(r.coverage >= BOM_COVERAGE_THRESHOLD);
  });

  test('low coverage → est fallback on full revenue', () => {
    const mix = [{ name: 'Latte', slsCnt: 10, slsTtl: 50 }]; // only 50 of 1000 covered
    const r = computeCogs(mix, costOf, 1000, 0.29);
    assert.strictEqual(r.method, 'est');
    assert.strictEqual(r.cogs, 290);
  });

  test('invalid cogsPct falls back to DEFAULT_COGS_PCT', () => {
    const r = computeCogs([], costOf, 1000, 0);
    assert.strictEqual(r.cogs, Math.round(1000 * DEFAULT_COGS_PCT * 100) / 100);
  });
});

describe('computeStorePnL', () => {
  test('contribution = revenue − labor − cogs, with percentages', () => {
    const mix = [
      { name: 'Latte',    slsCnt: 100, slsTtl: 500 },
      { name: 'Sandwich', slsCnt: 100, slsTtl: 300 },
      { name: 'Mystery',  slsCnt: 50,  slsTtl: 200 },
    ];
    const p = computeStorePnL({ revenue: 1000, labor: 250, menuMix: mix, cogsPct: 0.29 }, costOf);
    assert.strictEqual(p.cogs, 358);
    assert.strictEqual(p.contribution, 392); // 1000 - 250 - 358
    assert.strictEqual(p.marginPct, 39.2);
    assert.strictEqual(p.laborPct, 25);
    assert.strictEqual(p.cogsPct, 35.8);
    assert.strictEqual(p.method, 'BOM');
  });

  test('zero-revenue guard → all percentages 0, no divide-by-zero', () => {
    const p = computeStorePnL({ revenue: 0, labor: 0, menuMix: [], cogsPct: 0.29 }, costOf);
    assert.strictEqual(p.marginPct, 0);
    assert.strictEqual(p.laborPct, 0);
    assert.strictEqual(p.cogsPct, 0);
    assert.strictEqual(p.contribution, 0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test netlify/functions/analyst-lib/pnl-calc.test.js`
Expected: FAIL with "Cannot find module './pnl-calc'".

- [ ] **Step 3: Write the implementation**

Create `netlify/functions/analyst-lib/pnl-calc.js`:
```js
// PCG Portal — P&L Compute Core (pure, no I/O)
// Single source of truth for: Contribution = Revenue − Labor − COGS.
// COGS is hybrid: BOM (menu-mix × unit cost) when menu-mix explains enough
// revenue, else a category-% fallback. Callers inject sales/labor/menu-mix
// + a costOf(name) lookup so this module stays fully unit-testable.

const DEFAULT_COGS_PCT = 0.29;        // network fallback (~29% of sales)
const BOM_COVERAGE_THRESHOLD = 0.70;  // menu-mix must explain ≥70% of revenue to trust BOM

const round2 = (n) => Math.round((n || 0) * 100) / 100;
const pct1   = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0); // % to 1 dp

/**
 * Estimate COGS for a store/period using the hybrid method.
 * @param {Array<{name:string, slsCnt:number, slsTtl:number}>} menuMix
 * @param {(name:string)=>(number|undefined)} costOf
 * @param {number} revenue
 * @param {number} cogsPct  fractional fallback (e.g. 0.29)
 * @returns {{cogs:number, method:'BOM'|'est', coverage:number}}
 */
function computeCogs(menuMix, costOf, revenue, cogsPct) {
  const pct = (typeof cogsPct === 'number' && cogsPct > 0) ? cogsPct : DEFAULT_COGS_PCT;
  if (!revenue || revenue <= 0) return { cogs: 0, method: 'est', coverage: 0 };
  if (!Array.isArray(menuMix) || menuMix.length === 0) {
    return { cogs: round2(revenue * pct), method: 'est', coverage: 0 };
  }
  let bomCogs = 0, coveredRev = 0;
  for (const it of menuMix) {
    const unit = costOf(it.name);
    if (typeof unit === 'number' && unit > 0) {
      bomCogs    += (it.slsCnt || 0) * unit;
      coveredRev += (it.slsTtl || 0);
    }
  }
  const coverage = coveredRev / revenue;
  if (coverage >= BOM_COVERAGE_THRESHOLD) {
    const tail = Math.max(0, revenue - coveredRev) * pct; // estimate uncovered tail at category %
    return { cogs: round2(bomCogs + tail), method: 'BOM', coverage };
  }
  return { cogs: round2(revenue * pct), method: 'est', coverage };
}

/**
 * Full store P&L line.
 * @param {{revenue:number, labor:number, menuMix:Array, cogsPct:number}} inputs
 * @param {(name:string)=>(number|undefined)} costOf
 */
function computeStorePnL(inputs, costOf) {
  const revenue = Number(inputs.revenue) || 0;
  const labor   = Number(inputs.labor) || 0;
  const { cogs, method, coverage } = computeCogs(inputs.menuMix, costOf, revenue, inputs.cogsPct);
  const contribution = round2(revenue - labor - cogs);
  return {
    revenue: round2(revenue),
    labor:   round2(labor),
    cogs,
    contribution,
    marginPct: pct1(contribution, revenue),
    laborPct:  pct1(labor, revenue),
    cogsPct:   pct1(cogs, revenue),
    method,
    coverage:  Math.round(coverage * 1000) / 10, // 0..100, 1 dp
  };
}

module.exports = { computeStorePnL, computeCogs, DEFAULT_COGS_PCT, BOM_COVERAGE_THRESHOLD };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test netlify/functions/analyst-lib/pnl-calc.test.js`
Expected: PASS (all `computeCogs` + `computeStorePnL` tests green).

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/analyst-lib/pnl-calc.js netlify/functions/analyst-lib/pnl-calc.test.js
git commit -m "feat: pure P&L compute core (pnl-calc) with hybrid COGS"
```

> **DECISION POINT (surface to user before/at execution):** `BOM_COVERAGE_THRESHOLD = 0.70` and "estimate the uncovered tail at category %" are the two tunable business rules. Alternatives: (a) require higher coverage (e.g. 0.85) to mark a store `BOM`; (b) treat uncovered items as $0 COGS instead of estimating a tail (understates COGS); (c) only mark `BOM` when coverage ≥ threshold AND ≥N items priced. The plan ships 0.70 + estimated-tail as a sensible default; confirm with Mike or adjust the two constants.

---

### Task 5: COGS-% config blob helper

**Why:** The category-% fallback needs a per-store/district override store. Add a small loader with a hard-coded network default so the system works even before any config blob exists.

**Files:**
- Modify: `netlify/functions/labor-cron.js` (add a helper near the other blob helpers)

- [ ] **Step 1: Add the config resolver to `labor-cron.js`**

Near the top of `labor-cron.js` (after the `getStore`/blob setup, before `processAllStores`), add:
```js
const { DEFAULT_COGS_PCT } = require('./analyst-lib/pnl-calc');

/**
 * Load the COGS-% fallback config once per run.
 * Blob shape: { defaultCogsPct, byStore: { [pc]: pct }, byDistrict: { [district]: pct } }
 * @param {object} blobStore  the @netlify/blobs store
 */
async function loadPnlConfig(blobStore) {
  try {
    const wrapped = await blobStore.get('pcg_pnl_config_v1', { type: 'json' });
    const cfg = wrapped?.data || {};
    return {
      defaultCogsPct: typeof cfg.defaultCogsPct === 'number' ? cfg.defaultCogsPct : DEFAULT_COGS_PCT,
      byStore:    cfg.byStore || {},
      byDistrict: cfg.byDistrict || {},
    };
  } catch {
    return { defaultCogsPct: DEFAULT_COGS_PCT, byStore: {}, byDistrict: {} };
  }
}

/** Resolve the COGS-% fallback for a store: per-store → per-district → network default. */
function cogsPctFor(cfg, store) {
  return cfg.byStore[String(store.pc)]
    ?? cfg.byDistrict[String(store.district)]
    ?? cfg.defaultCogsPct;
}
```

- [ ] **Step 2: Syntax check**

Run: `node -e "require('./netlify/functions/labor-cron.js'); console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/labor-cron.js
git commit -m "feat: pcg_pnl_config_v1 COGS-% resolver in labor-cron"
```

---

### Task 6: Fetch menu mix + compute P&L in `labor-cron`'s store loop

**Why:** This is where live P&L is produced. The store loop already has Pulse net sales and Paycor labor; add the menu-mix fetch and `computeStorePnL`, attaching a `pnl` object to each store result.

**Files:**
- Modify: `netlify/functions/labor-cron.js`

- [ ] **Step 1: Add a menu-mix fetcher (reusing the in-file Pulse client)**

In `labor-cron.js`, near the other Pulse helpers (after `postPOS`, ≈ line 153), add:
```js
const { lookupUnitCost } = require('./analyst-lib/cost-lookup');
const { computeStorePnL } = require('./analyst-lib/pnl-calc');

/**
 * Fetch per-item menu mix for a store/day from Pulse.
 * @returns {Promise<Array<{name:string, slsCnt:number, slsTtl:number}>>}
 */
async function getStoreMenuMix(pc, busDt) {
  const cfg = APIS[apiRoute(String(pc))];
  const [dims, daily] = await Promise.all([
    postPOS(cfg, 'getMenuItemDimensions', { locRef: String(pc) }),
    postPOS(cfg, 'getMenuItemDailyTotals', {
      locRef: String(pc), busDt,
      searchCriteria: 'where greaterThan(revenueCenters.menuItems.slsCnt, 0)',
      include: 'revenueCenters.menuItems.miNum,revenueCenters.menuItems.slsTtl,revenueCenters.menuItems.slsCnt',
    }),
  ]);
  const nameByNum = Object.fromEntries((dims?.menuItems || []).map(m => [m.num, m.name]));
  const agg = {}; // miNum -> { slsCnt, slsTtl }
  for (const rc of (daily?.revenueCenters || [])) {
    for (const mi of (rc.menuItems || [])) {
      if (!agg[mi.miNum]) agg[mi.miNum] = { slsCnt: 0, slsTtl: 0 };
      agg[mi.miNum].slsCnt += mi.slsCnt || 0;
      agg[mi.miNum].slsTtl += mi.slsTtl || 0;
    }
  }
  return Object.entries(agg).map(([miNum, v]) => ({
    name: nameByNum[miNum] || '', slsCnt: v.slsCnt, slsTtl: v.slsTtl,
  }));
}
```
> `getMenuItemDimensions` returns `{ menuItems: [{ num, name }] }`; `getMenuItemDailyTotals` returns `{ revenueCenters: [{ menuItems: [{ miNum, slsTtl, slsCnt }] }] }` (confirmed from `food-cost.js`).

- [ ] **Step 2: Thread the config through `processAllStores` / `processStore`**

`processAllStores(busDt, batchSize, opts)` already passes `opts` to `processStore`. Add the resolved config to `opts` at the call site (in `exports.handler`, where `processAllStores` is invoked), and read it in `processStore`.

In `exports.handler`, before calling `processAllStores`:
```js
const pnlConfig = await loadPnlConfig(blobStore);
const storeResults = await processAllStores(busDt, 5, { skipSchedules: isManual, pnlConfig });
```
> Use the existing `blobStore` handle from the handler. If the handler creates the store later, move `loadPnlConfig` after that line.

- [ ] **Step 3: Compute P&L inside `processStore` and attach it to the return**

Inside `processStore(store, busDt, opts)`, after `sales` and `totalLaborDollarsToday` are known (just before the `return {` at ≈ line 721), add:
```js
let pnl = null;
try {
  const menuMix = await getStoreMenuMix(store.pc, busDt);
  const cogsPct = cogsPctFor(opts.pnlConfig || { defaultCogsPct: undefined, byStore: {}, byDistrict: {} }, store);
  pnl = computeStorePnL(
    { revenue: sales.netSales, labor: totalLaborDollarsToday, menuMix, cogsPct },
    lookupUnitCost,
  );
} catch (e) {
  // Menu-mix unavailable → leave pnl null; labor-only path still works.
  pnl = null;
}
```
Then add `pnl` to the returned object (alongside `today`, `wtd`, …):
```js
return {
  pc, name, district, paycorId: legalEntityId,
  today: { /* ...unchanged... */ },
  wtd:   { /* ...unchanged... */ },
  pnl,                       // <-- new
  employeeDetails,
  scheduleShifts,
};
```

- [ ] **Step 4: Syntax check**

Run: `node -e "require('./netlify/functions/labor-cron.js'); console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/labor-cron.js
git commit -m "feat: compute per-store P&L in labor-cron loop"
```

---

### Task 7: Write the live snapshot + per-store P&L history blobs

**Why:** Persist what Task 6 computed so the dashboard and rollups can read it. Mirror the existing `pcg_labor_v1` / `pcg_labor_store_{pc}` write pattern.

**Files:**
- Modify: `netlify/functions/labor-cron.js`

- [ ] **Step 1: Build the network snapshot + write `pcg_pnl_live_v1`**

In `exports.handler`, after the labor blob writes (≈ line 1011, after the per-store labor loop), add:
```js
// ── P&L live snapshot + per-store history ──
const pnlStores = [];
const pnlExcluded = [];
for (const r of storeResults) {
  if (!r) continue;
  if (!r.pnl || !r.pnl.revenue) {
    pnlExcluded.push({ pc: r.pc, name: r.name, reason: r.pnl ? 'no revenue' : 'no labor/menu data' });
    continue;
  }
  pnlStores.push({ pc: r.pc, name: r.name, district: r.district, ...r.pnl });
}

const agg = pnlStores.reduce((a, s) => {
  a.revenue += s.revenue; a.labor += s.labor; a.cogs += s.cogs; a.contribution += s.contribution; return a;
}, { revenue: 0, labor: 0, cogs: 0, contribution: 0 });
const r2 = (n) => Math.round(n * 100) / 100;
const p1 = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);
const network = {
  revenue: r2(agg.revenue), labor: r2(agg.labor), cogs: r2(agg.cogs), contribution: r2(agg.contribution),
  marginPct: p1(agg.contribution, agg.revenue), laborPct: p1(agg.labor, agg.revenue), cogsPct: p1(agg.cogs, agg.revenue),
};

await blobStore.setJSON('pcg_pnl_live_v1', {
  savedAt: new Date().toISOString(),
  data: { busDt, network, stores: pnlStores, excluded: pnlExcluded },
});
```

- [ ] **Step 2: Append today's point to each `pcg_pnl_store_{pc}` history**

Immediately after Step 1's block, add:
```js
for (const s of pnlStores) {
  const key = `pcg_pnl_store_${s.pc}`;
  let history = { daily: [] };
  try {
    const existing = await blobStore.get(key, { type: 'json' });
    if (existing?.data?.daily) history = existing.data;
  } catch {}
  const point = {
    date: busDt, revenue: s.revenue, labor: s.labor, cogs: s.cogs,
    contribution: s.contribution, marginPct: s.marginPct, laborPct: s.laborPct,
    cogsPct: s.cogsPct, method: s.method,
  };
  history.daily = [...history.daily.filter(d => d.date !== busDt), point]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-400); // cap ~13 months
  await blobStore.setJSON(key, { savedAt: new Date().toISOString(), data: history });
}
```

- [ ] **Step 3: Syntax check**

Run: `node -e "require('./netlify/functions/labor-cron.js'); console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/labor-cron.js
git commit -m "feat: write pcg_pnl_live_v1 + pcg_pnl_store_{pc} history"
```

---

### Task 8: Move `pnl-cron` COGS through stored history + fix the labor-hours bug

**Why:** The monthly Orion narrative is Revenue−Labor only and references a non-existent `laborHours` field. Pull stored daily COGS from `pcg_pnl_store_{pc}` so the narrative includes COGS; fix the field name.

**Files:**
- Modify: `netlify/functions/pnl-cron.js`

- [ ] **Step 1: Fix the labor-hours field bug**

In `pnl-cron.js` (≈ line 31), change:
```js
sHours += day.laborHours || 0;
```
to:
```js
sHours += day.hoursWorked || 0;
```
> The labor blob's daily points use `hoursWorked`, not `laborHours` (confirmed from `labor-cron.js`).

- [ ] **Step 2: Accumulate COGS from stored per-store P&L history**

At the top of `pnl-cron.js`, add:
```js
const { getStore } = require('@netlify/blobs');
const { DEFAULT_COGS_PCT } = require('./analyst-lib/pnl-calc');
```
In `buildMonthlyData(stores)`, add `let totalCogs = 0;` with the other accumulators. Inside the per-store loop, after the existing daily `sSales`/`sLabor` accumulation, load the store's P&L history and sum in-range COGS (fall back to category % when a day has no stored COGS):
```js
let sCogs = 0;
try {
  const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
  const wrapped = await store.get(`pcg_pnl_store_${s.pc}`, { type: 'json' });
  const pnlDaily = wrapped?.data?.daily || [];
  const byDate = Object.fromEntries(pnlDaily.map(d => [d.date, d]));
  for (const day of storeData.daily) {
    const d = new Date(day.date);
    if (d >= targetMonth && d <= monthEnd) {
      const p = byDate[day.date];
      sCogs += (p && typeof p.cogs === 'number') ? p.cogs : (day.sales || 0) * DEFAULT_COGS_PCT;
    }
  }
} catch {
  sCogs = sSales * DEFAULT_COGS_PCT; // whole-store fallback
}
totalCogs += sCogs;
```
Push `cogs: sCogs` into each `storeResults` entry, and extend the returned object:
```js
return {
  totalSales, totalLabor, totalHours, totalCogs,
  laborPct: totalSales > 0 ? (totalLabor / totalSales * 100) : 0,
  cogsPct:  totalSales > 0 ? (totalCogs / totalSales * 100) : 0,
  margin:   totalSales - totalLabor,                    // legacy (revenue − labor)
  contribution: totalSales - totalLabor - totalCogs,    // new
  storeResults, weekSummaries,
};
```

- [ ] **Step 3: Surface COGS/contribution in the prompt snapshot**

Where the data snapshot string is built (≈ lines 59–79), add COGS and contribution lines alongside the existing margin/labor lines, e.g.:
```js
COGS: ${fmtMoney(networkData.totalCogs)} (${networkData.cogsPct.toFixed(1)}%)
Contribution: ${fmtMoney(networkData.contribution)}
```
> Match the existing money-formatting helper used in that file for the other figures (search the file for how `totalLabor`/`margin` are interpolated and mirror it).

- [ ] **Step 4: Syntax check**

Run: `node -e "require('./netlify/functions/pnl-cron.js'); console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/pnl-cron.js
git commit -m "feat: monthly P&L narrative now includes COGS; fix laborHours bug"
```

---

### Task 9: Move `labor-cron` to hourly within business hours

**Why:** Live P&L needs frequent refresh. Spec: hourly ~5am–11pm ET. ET = UTC−4 (EDT, June). 5am ET = 09:00 UTC; 11pm ET = 03:00 UTC next day.

**Files:**
- Modify: `netlify.toml`

- [ ] **Step 1: Update the schedule**

In `netlify.toml`, find the `labor-cron` schedule (`"0 11,16,21 * * *"`) and change it to hourly across the business-hours window (09:00–03:00 UTC ≈ 5am–11pm ET):
```toml
[functions."labor-cron"]
schedule = "0 9-23,0-3 * * *"
```
> Keep the existing key/section formatting used by the other scheduled functions in this file — only the `schedule` value changes.

- [ ] **Step 2: Verify the TOML still parses**

Run: `node -e "require('fs').readFileSync('netlify.toml','utf8'); console.log('read OK')"` then confirm visually that the `labor-cron` block matches the surrounding scheduled-function blocks.
Expected: prints `read OK`; the cron string is `0 9-23,0-3 * * *`.

- [ ] **Step 3: Commit**

```bash
git add netlify.toml
git commit -m "chore: labor-cron hourly during business hours for live P&L"
```

> **Caveat to flag:** ~8× more Paycor calls/day. The token mutex + 15-min background function already mitigate; the business-hours bound caps overnight waste. Watch Paycor rate limits after first deploy.

---

### Task 10: `AdminPnL` — KPI header, ranked store grid, role scoping

**Why:** The dashboard. This task delivers the network KPI header + contribution-ranked store grid with method badges and `userType` scoping.

**Files:**
- Modify: `app.jsx`

- [ ] **Step 1: Add the `AdminPnL` component**

Add a new component near `AdminLabor` (≈ line 23099) in `app.jsx`:
```jsx
function AdminPnL({ stores, districts, th, user, drillInStore, onClearDrillIn }) {
  const [pnl, setPnl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedStore, setSelectedStore] = useState(null);

  const isDM = user?.userType === 'dm';
  const isManager = user?.userType === 'manager';

  useEffect(() => {
    cloudLoad('pcg_pnl_live_v1')
      .then(d => { if (d?.stores) { setPnl(d); setError(null); } else setError('No P&L data yet. The labor cron may not have run.'); })
      .catch(() => setError('Failed to load P&L data'))
      .finally(() => setLoading(false));
  }, []);

  // Role scoping: DM → their district, manager → their store(s), exec/it → all.
  const managerStorePCs = React.useMemo(() => {
    if (!isManager) return new Set();
    return new Set(stores.filter(s => isManagersStore(s, user)).map(s => String(s.pc)));
  }, [isManager, stores, user]);

  const visibleStores = React.useMemo(() => {
    const all = pnl?.stores || [];
    if (isDM && user.district) return all.filter(s => String(s.district) === String(user.district));
    if (isManager) return all.filter(s => managerStorePCs.has(String(s.pc)));
    return all;
  }, [pnl, isDM, isManager, user, managerStorePCs]);

  // Rank by contribution dollars (descending). Highest contributors first.
  const ranked = React.useMemo(
    () => [...visibleStores].sort((a, b) => b.contribution - a.contribution),
    [visibleStores],
  );

  // Re-aggregate the network header from the visible (scoped) set.
  const header = React.useMemo(() => {
    const a = ranked.reduce((acc, s) => {
      acc.revenue += s.revenue; acc.labor += s.labor; acc.cogs += s.cogs; acc.contribution += s.contribution; return acc;
    }, { revenue: 0, labor: 0, cogs: 0, contribution: 0 });
    const p = (n) => (a.revenue > 0 ? (n / a.revenue) * 100 : 0);
    return { ...a, marginPct: p(a.contribution), laborPct: p(a.labor), cogsPct: p(a.cogs) };
  }, [ranked]);

  if (loading) return <div style={{ padding: '2rem', color: th.muted }}>Loading P&L…</div>;
  if (error)   return <div style={{ padding: '2rem', color: th.muted }}>{error}</div>;

  const kpis = [
    { label: 'Revenue',      value: fmtDollars(header.revenue),      color: '#3b82f6' },
    { label: 'Labor',        value: fmtDollars(header.labor),        color: '#f59e0b', sub: fmtPct(header.laborPct) },
    { label: 'COGS',         value: fmtDollars(header.cogs),         color: '#a855f7', sub: fmtPct(header.cogsPct) },
    { label: 'Contribution', value: fmtDollars(header.contribution), color: '#22c55e' },
    { label: 'Margin %',     value: fmtPct(header.marginPct),        color: header.marginPct >= 30 ? '#22c55e' : '#ef4444' },
  ];

  return (
    <div style={{ padding: '1rem' }}>
      <h2 style={{ fontFamily: "'Raleway'", fontWeight: 800, color: th.text, marginBottom: '1rem' }}>P&amp;L</h2>

      {/* KPI header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {kpis.map(k => (
          <div key={k.label} style={{ ...card(th), padding: '1rem 1.125rem', borderTop: `3px solid ${k.color}` }}>
            <div style={{ fontFamily: "'Raleway'", fontWeight: 800, fontSize: '1.45rem', color: th.text }}>{k.value}</div>
            {k.sub && <div style={{ fontSize: '0.7rem', color: th.muted, marginTop: '0.15rem' }}>{k.sub}</div>}
            <div style={{ fontSize: '0.68rem', fontWeight: 600, color: th.muted, marginTop: '0.3rem', textTransform: 'uppercase', letterSpacing: 0.5 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Ranked store grid */}
      <div style={{ ...card(th), overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ background: th.sidebar, color: th.muted, textAlign: 'left' }}>
              {['#', 'Store', 'Revenue', 'Labor %', 'COGS %', 'Contribution', 'Margin %', 'Method'].map(h => (
                <th key={h} style={{ padding: '0.6rem 0.75rem', fontWeight: 700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ranked.map((s, i) => (
              <tr key={s.pc}
                  onClick={() => setSelectedStore(s)}
                  style={{ cursor: 'pointer', borderTop: `1px solid ${th.cardBorder}`, color: th.text }}>
                <td style={{ padding: '0.55rem 0.75rem', color: th.muted }}>{i + 1}</td>
                <td style={{ padding: '0.55rem 0.75rem', fontWeight: 600 }}>{s.name}</td>
                <td style={{ padding: '0.55rem 0.75rem' }}>{fmtDollars(s.revenue)}</td>
                <td style={{ padding: '0.55rem 0.75rem' }}>{fmtPct(s.laborPct)}</td>
                <td style={{ padding: '0.55rem 0.75rem' }}>{fmtPct(s.cogsPct)}</td>
                <td style={{ padding: '0.55rem 0.75rem', fontWeight: 700 }}>{fmtDollars(s.contribution)}</td>
                <td style={{ padding: '0.55rem 0.75rem', color: s.marginPct >= 30 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{fmtPct(s.marginPct)}</td>
                <td style={{ padding: '0.55rem 0.75rem' }}>
                  <span style={{
                    fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.45rem', borderRadius: '0.4rem',
                    background: s.method === 'BOM' ? '#22c55e22' : '#f59e0b22',
                    color: s.method === 'BOM' ? '#16a34a' : '#d97706',
                  }}>{s.method === 'BOM' ? 'BOM' : 'est %'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pnl?.excluded?.length > 0 && (
        <div style={{ fontSize: '0.72rem', color: th.muted, marginTop: '0.6rem' }}>
          Excluded (missing data): {pnl.excluded.map(e => e.name).join(', ')}
        </div>
      )}

      {selectedStore && (
        <PnLStoreDetail store={selectedStore} th={th} onClose={() => setSelectedStore(null)} />
      )}
    </div>
  );
}
```
> `PnLStoreDetail` is implemented in Task 11. To keep this task independently runnable, temporarily stub it as `function PnLStoreDetail() { return null; }` directly above `AdminPnL`, and replace it in Task 11.

- [ ] **Step 2: Build to verify the JSX compiles**

Run: `npm run build`
Expected: esbuild completes with no errors, `app.js` regenerated.

- [ ] **Step 3: Commit**

```bash
git add app.jsx app.js
git commit -m "feat: AdminPnL KPI header + contribution-ranked grid"
```

---

### Task 11: `PnLStoreDetail` — waterfall, rollups, trend sparkline

**Why:** Store drill-down with the contribution waterfall, weekly/monthly rollup tables, and a margin trend line (Chart.js).

**Files:**
- Modify: `app.jsx`

- [ ] **Step 1: Add the `PnLStoreDetail` component**

Replace the Task 10 stub (or add near `AdminPnL`):
```jsx
function PnLStoreDetail({ store, th, onClose }) {
  const [history, setHistory] = useState(null);
  const canvasRef = React.useRef(null);
  const chartRef = React.useRef(null);

  useEffect(() => {
    cloudLoad(`pcg_pnl_store_${store.pc}`).then(d => setHistory(d?.daily || [])).catch(() => setHistory([]));
  }, [store.pc]);

  // Trend line: contribution margin % over time.
  useEffect(() => {
    if (!canvasRef.current || typeof Chart === 'undefined' || !history?.length) return;
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: history.map(h => h.date),
        datasets: [{ label: 'Margin %', data: history.map(h => h.marginPct), borderColor: '#FF671F', borderWidth: 2, tension: 0.3, fill: false, pointRadius: 0 }],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: th.muted, maxTicksLimit: 8 } }, y: { ticks: { color: th.muted } } },
      },
    });
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, [history, th]);

  // Weekly (Mon-start) + monthly rollups from daily history.
  const rollups = React.useMemo(() => {
    const sum = (arr) => arr.reduce((a, d) => {
      a.revenue += d.revenue; a.labor += d.labor; a.cogs += d.cogs; a.contribution += d.contribution; return a;
    }, { revenue: 0, labor: 0, cogs: 0, contribution: 0 });
    const bucket = (keyFn) => {
      const m = {};
      for (const d of (history || [])) { const k = keyFn(d.date); (m[k] = m[k] || []).push(d); }
      return Object.entries(m).map(([k, ds]) => { const s = sum(ds); return { key: k, ...s, marginPct: s.revenue > 0 ? (s.contribution / s.revenue) * 100 : 0 }; }).sort((a, b) => b.key.localeCompare(a.key)).slice(0, 8);
    };
    const mondayOf = (iso) => { const d = new Date(iso); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return d.toISOString().slice(0, 10); };
    return { weekly: bucket(mondayOf), monthly: bucket(iso => iso.slice(0, 7)) };
  }, [history]);

  const waterfall = [
    { label: 'Revenue', value: store.revenue, color: '#3b82f6' },
    { label: '− Labor', value: -store.labor, color: '#f59e0b' },
    { label: '− COGS', value: -store.cogs, color: '#a855f7' },
    { label: '= Contribution', value: store.contribution, color: '#22c55e' },
  ];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'flex-end', zIndex: 1000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ ...card(th), width: 'min(540px, 92vw)', height: '100%', overflowY: 'auto', borderRadius: 0, padding: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontFamily: "'Raleway'", fontWeight: 800, color: th.text }}>{store.name}</h3>
          <button onClick={onClose} style={{ ...btn(th), padding: '0.3rem 0.7rem' }}>Close</button>
        </div>

        {/* Waterfall */}
        <div style={{ marginBottom: '1.25rem' }}>
          {waterfall.map(w => (
            <div key={w.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: `1px solid ${th.cardBorder}`, color: th.text }}>
              <span>{w.label}</span>
              <span style={{ fontWeight: 700, color: w.color }}>{fmtDollars(w.value)}</span>
            </div>
          ))}
        </div>

        {/* Trend */}
        <div style={{ ...card(th), padding: '0.75rem', marginBottom: '1.25rem' }}>
          <div style={{ fontSize: '0.7rem', color: th.muted, marginBottom: '0.5rem', textTransform: 'uppercase' }}>Margin % Trend</div>
          <canvas ref={canvasRef} style={{ maxHeight: '180px' }} />
        </div>

        {/* Rollups */}
        {[['Weekly', rollups.weekly], ['Monthly', rollups.monthly]].map(([title, rows]) => (
          <div key={title} style={{ marginBottom: '1.25rem' }}>
            <div style={{ fontSize: '0.7rem', color: th.muted, marginBottom: '0.4rem', textTransform: 'uppercase' }}>{title}</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', color: th.text }}>
              <thead><tr style={{ color: th.muted, textAlign: 'left' }}>{['Period', 'Revenue', 'Contribution', 'Margin %'].map(h => <th key={h} style={{ padding: '0.3rem' }}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.key} style={{ borderTop: `1px solid ${th.cardBorder}` }}>
                    <td style={{ padding: '0.3rem' }}>{r.key}</td>
                    <td style={{ padding: '0.3rem' }}>{fmtDollars(r.revenue)}</td>
                    <td style={{ padding: '0.3rem' }}>{fmtDollars(r.contribution)}</td>
                    <td style={{ padding: '0.3rem', color: r.marginPct >= 30 ? '#22c55e' : '#ef4444' }}>{fmtPct(r.marginPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build to verify the JSX compiles**

Run: `npm run build`
Expected: esbuild completes; `app.js` regenerated.

- [ ] **Step 3: Commit**

```bash
git add app.jsx app.js
git commit -m "feat: PnLStoreDetail waterfall, rollups, margin trend"
```

---

### Task 12: Wire the P&L tab into navigation + routing + version bump

**Why:** Make the component reachable and role-gated, and bump the version per project convention.

**Files:**
- Modify: `app.jsx`

- [ ] **Step 1: Add the tab to `getTabs`**

In `getTabs` (≈ lines 15980–16059), add a P&L tab to the `executive`/`it` array, the `dm` array, and the `manager` array (place it next to the `labor` tab). Use the existing icon convention:
```jsx
{ id: "pnl", label: "P&L", icon: (c) => ICONS.dollar(c) },
```
For `dm` use `label: "District P&L"` and for `manager` use `label: "My P&L"` to match the existing "My Labor"/"My Locations" naming style.

- [ ] **Step 2: Add routing in the main render**

After the `labor` routing line (≈ line 31073) in the `PCGPortal` return, add:
```jsx
{tab === "pnl" && (isFullAdmin(user) || isOfficeStaff || isDM || isManager) && <AdminPnL stores={stores} districts={districts} th={th} user={user} drillInStore={drillInStore} onClearDrillIn={() => setDrillInStore(null)} />}
```
> Use the same gate variables already in scope for the `labor` line (`isFullAdmin(user)`, `isOfficeStaff`, `isDM`, `isManager`). Stores outside the user's scope are already filtered inside `AdminPnL`.

- [ ] **Step 3: Bump the version**

In the sidebar footer (≈ line 30660), change `v14.13` to `v14.14`.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: esbuild completes; `app.js` regenerated.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "feat: add P&L tab routing + role gating; bump v14.14"
```

---

### Task 13: Manual end-to-end verification

**Why:** Unit tests cover the pure core; the live path and UI need a real check.

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all `cost-lookup` + `pnl-calc` tests pass.

- [ ] **Step 2: Trigger a labor/P&L refresh and inspect blobs**

Deploy a preview (`npx netlify deploy`) or trigger `labor-cron` manually, then load `pcg_pnl_live_v1` (via the storage function or the app). Verify: `network` totals are non-zero; each store has `revenue/labor/cogs/contribution/method`; stores with no menu data appear under `excluded`.

- [ ] **Step 3: Hand-check one store**

Pick a store with `method: 'BOM'`. Confirm `contribution ≈ revenue − labor − cogs` and `marginPct ≈ contribution/revenue`. Spot-check that `cogs` is plausible (~25–35% of revenue).

- [ ] **Step 4: Confirm role scoping in the UI**

Log in as (or impersonate) a DM → P&L shows only their district. A manager → only their store. An executive → full network. A role with no P&L tab → tab hidden.

- [ ] **Step 5: Confirm the monthly narrative includes COGS**

Trigger `pnl-cron` (or review its next scheduled output). Confirm the Orion narrative now reports COGS and Contribution, not just Revenue−Labor.

- [ ] **Step 6: Production deploy**

```bash
npm run build
npx netlify deploy --prod
```

---

## Self-Review

**Spec coverage:**
- COGS hybrid (BOM × menu-mix, else category %, with method badge) → Tasks 1, 4, 6, 10. ✓
- Hourly business-hours refresh; P&L in same pass → Tasks 6, 7, 9. ✓
- New top-level P&L tab, ranked by contribution margin → Tasks 10, 12. ✓
- `pnl-calc.js` shared core, wired into monthly `pnl-cron` → Tasks 4, 8. ✓
- Blobs `pcg_pnl_live_v1`, `pcg_pnl_store_{pc}`, `pcg_pnl_config_v1` → Tasks 5, 7. ✓
- Weekly/monthly rollups + trend lines → Task 11. ✓
- Role scoping by `userType` (exec/it full, dm district, manager store, others hidden) → Tasks 10, 12. ✓
- Error handling: missing menu-mix → est badge; missing labor → excluded → Tasks 6, 7, 10. ✓
- Testing: BOM path, fallback, zero-revenue guard, method badge, margin math → Task 4. ✓
- District view for DMs → DM scoping in Task 10 (district-filtered grid + re-aggregated header). ✓

**Open decision (carry into execution):** `BOM_COVERAGE_THRESHOLD` (0.70) and the uncovered-tail estimation — flagged in Task 4. Confirm with Mike or tune the two constants in `pnl-calc.js`.

**Known follow-ups (out of v1 scope per spec):** forecasted P&L, push-to-Paycor scheduling, royalty/ad-fund modeling.
