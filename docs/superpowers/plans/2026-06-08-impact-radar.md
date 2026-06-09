# Impact / Cannibalization Radar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given an opening event (date + location), automatically reproduce the 18th-St impact analysis — quantify the impacted store's weekly-sales decline vs distance-matched control stores, show it on-screen (trend + map + table), and export a branded PDF exhibit.

**Architecture:** A pure, unit-tested math module (`src/impact.mjs`) does all distance/before-after math; a tiny Netlify function (`geocode.js`) turns addresses into lat/lng via the free US Census geocoder and caches the 45 store coords to a blob; a new `ImpactRadar` tab in `app.jsx` wires live `cloudLoad` labor data through the engine into a Chart.js trend line, a Leaflet radius map, KPI cards, a control-comparison table, and a jsPDF exhibit.

**Tech Stack:** ESM module + `node:test` (engine); Netlify Function + US Census Geocoder; React 18 (inline-styled, CDN globals) + Chart.js 4 + Leaflet 1.9.4 + jsPDF 2.5.1 (all already loaded in `index.html`).

---

## Spec reference

Design spec: `docs/superpowers/specs/2026-06-08-impact-radar-design.md`
Methodology template (real data to test against): `PCG/18th-street-impact-claim.md` (NOTE: lives in the iCloud `PCG/` folder, one level **above** the repo root — full path `/Users/mike/Library/Mobile Documents/com~apple~CloudDocs/ClaudePro/PCG/18th-street-impact-claim.md`).

## Key decisions locked during planning (CONFIRM on review)

1. **Bucketing convention — event week counts as the LAST "before" week** (`weekOf <= eventDate` → before; `weekOf > eventDate` → after). This is evidence-backed: it reproduces the manual claim's `avgBefore = $28,593` to the dollar (13 weeks `2025-10-05`…`2025-12-28`). The competitor's food license issued `2025-12-29` — the day after that Monday — so the week-of `12/28` is the last full pre-competition week. **Confirm with Mike**, because it sets the headline number on a quasi-legal exhibit.
2. **Engine validated two ways** (see Task 2): (a) a formula-exactness test reproduces the claim headline `−28.9% / $429,154` exactly from the claim's stated averages; (b) a real-series regression test runs the full 32-week published table through the bucketing rule and locks the computed result. The real-series **after** average (~$21,117) is intentionally *higher* than the claim's $20,340 because the published table extends through a spring partial-recovery the May-19 claim snapshot predates — the engine is correct; the input data vintage differs. This is surfaced as a finding, not hidden.
3. **Data-availability limitation (v1):** the live per-store blob `pcg_labor_store_{pc}.weekly[]` is **capped at 13 weeks** by `labor-cron.js` (`MAX_WEEKLY = 13`). So live analysis of a past event can show at most ~13 weeks total. The engine handles however many weeks it is given and reports `weeksBeforeUsed`/`weeksAfterUsed`; the UI must show those actuals and warn when a store has insufficient history. Extending retention or adding an on-demand Pulse backfill is a labeled fast-follow.

## File structure

| File | Responsibility | New/Edit |
|------|----------------|----------|
| `src/impact.mjs` | Pure math: `haversineMiles`, `beforeAfter`, `pickControls`. No DOM, no fetch. | New |
| `src/impact.test.mjs` | `node:test` unit tests, incl. the 18th-St acceptance tests. | New |
| `netlify/functions/geocode.js` | POST `{address}` → US Census geocoder → `{lat,lng,matched}`. CORS-gated. | New |
| `app.jsx` | `ImpactRadar` component, tab registration, role gating, version bump. | Edit |

## Codebase facts this plan relies on (verified)

- **Store config:** `const STORES_SEED` at `app.jsx:2748–2794`, 45 entries. Each has `pc` (string, primary key), `address`, `city`, `state`, `zip`, `name`, `district`. Example: `{ id:15, pc:"304863", name:"18th St", address:"2654 S. 18th St", city:"Philadelphia", state:"PA", zip:"19145", district:3, ... }`.
- **Persistence:** `async function cloudLoad(key)` / `async function cloudSave(key, data)` at `app.jsx:5843–5896`. `cloudLoad` returns the unwrapped `data` (or `null`); `cloudSave` returns boolean. Key format for labor: `pcg_labor_store_${pc}`.
- **Weekly shape:** each entry of `pcg_labor_store_{pc}.weekly[]` = `{ weekOf:"2026-06-01", laborDollars:1245.50, sales:18930.45, laborPct:6.58, avgDailyEmployees:8 }`. **Net sales = `sales`.** `weekOf` is a Monday ISO date string. Array sorted desc, max 13.
- **Tabs:** `getTabs(user)` at `app.jsx:16527`. Tab objects: `{ id, label, icon }`. Add to the `executive`/`it` list and the `office_staff` list.
- **Gating:** main render at `app.jsx:~33762` uses `{tab === "ndcp" && (isFullAdmin(user) || isOfficeStaff) && <AdminNdcp .../>}`. `isFullAdmin(user)` = exec or it. Reuse the exact same gate.
- **Formatters:** `fmtDollars(n)` / `fmtPct(n)` at `app.jsx:23660`.
- **Version:** `v14.48` at `app.jsx:33346` (sidebar footer). Bump to `v14.49`.
- **CDN globals (confirmed in `index.html`):** `window.jspdf.jsPDF`, `window.Chart`, `window.L` (Leaflet) + Leaflet CSS.
- **Module style:** `src/*.mjs` are ESM (`export { ... }`). app.jsx imports at top (lines 2–7), e.g. `import { ... } from './src/deal-dates.mjs';`.
- **Tests:** `npm test` runs `node --test '...' 'src/*.test.mjs' '...'`. Single file: `node --test src/impact.test.mjs`. Pattern: `import { test, describe } from 'node:test'; import assert from 'node:assert';`.
- **Build:** `npm run build` (esbuild `app.jsx` → `app.js`). Commit BOTH. Never hand-edit `app.js`.

---

## Task 1: `haversineMiles` — distance math (TDD)

**Files:**
- Create: `src/impact.mjs`
- Test: `src/impact.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `src/impact.test.mjs`:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { haversineMiles } from './impact.mjs';

describe('haversineMiles', () => {
  test('identical points → 0', () => {
    assert.strictEqual(haversineMiles({ lat: 39.92, lng: -75.18 }, { lat: 39.92, lng: -75.18 }), 0);
  });

  test('1° of latitude ≈ 69.1 miles', () => {
    const d = haversineMiles({ lat: 40.0, lng: -75.0 }, { lat: 41.0, lng: -75.0 });
    assert.ok(Math.abs(d - 69.09) < 0.5, `expected ~69.09, got ${d}`);
  });

  test('1° of longitude at 40°N ≈ 53.0 miles', () => {
    const d = haversineMiles({ lat: 40.0, lng: -75.0 }, { lat: 40.0, lng: -76.0 });
    assert.ok(Math.abs(d - 53.0) < 0.6, `expected ~53.0, got ${d}`);
  });

  test('two points ~0.40 mi apart (0.0058° lat)', () => {
    const d = haversineMiles({ lat: 39.9200, lng: -75.1800 }, { lat: 39.9258, lng: -75.1800 });
    assert.ok(Math.abs(d - 0.40) < 0.02, `expected ~0.40, got ${d}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/mike/Library/Mobile Documents/com~apple~CloudDocs/ClaudePro/PCG/pcg-netlify 3" && node --test src/impact.test.mjs`
Expected: FAIL — `Cannot find module './impact.mjs'` (or `haversineMiles is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `src/impact.mjs`:

```javascript
// src/impact.mjs — Impact Radar math engine. Pure: no DOM, no fetch, no globals.

const EARTH_RADIUS_MI = 3958.7613; // mean Earth radius in miles

/**
 * Great-circle distance between two {lat,lng} points, in miles.
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number} miles
 */
export function haversineMiles(a, b) {
  if (!a || !b) return NaN;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/impact.test.mjs`
Expected: PASS — 4 `haversineMiles` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/impact.mjs src/impact.test.mjs
git commit -m "feat(impact): haversineMiles distance helper + tests"
```

---

## Task 2: `beforeAfter` — before/after sales engine + 18th-St acceptance (TDD)

This is the heart of the feature. Two validation tracks: (A) **formula exactness** against the claim's stated averages; (B) **real-series regression** against the full published 32-week table.

**Files:**
- Modify: `src/impact.mjs`
- Test: `src/impact.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `src/impact.test.mjs`:

```javascript
import { beforeAfter } from './impact.mjs';

// ── The real 18th-St weekly net-sales series, verbatim from PCG/18th-street-impact-claim.md §6 ──
// Event week = 2025-12-28 (competitor food license issued 2025-12-29).
const EIGHTEENTH_ST = [
  { weekOf: '2025-10-05', sales: 29308 }, { weekOf: '2025-10-12', sales: 29022 },
  { weekOf: '2025-10-19', sales: 30168 }, { weekOf: '2025-10-26', sales: 30075 },
  { weekOf: '2025-11-02', sales: 30000 }, { weekOf: '2025-11-09', sales: 29187 },
  { weekOf: '2025-11-16', sales: 29184 }, { weekOf: '2025-11-23', sales: 29818 },
  { weekOf: '2025-11-30', sales: 28135 }, { weekOf: '2025-12-07', sales: 28137 },
  { weekOf: '2025-12-14', sales: 27951 }, { weekOf: '2025-12-21', sales: 27220 },
  { weekOf: '2025-12-28', sales: 23507 }, // ← event week (last "before")
  { weekOf: '2026-01-04', sales: 23502 }, { weekOf: '2026-01-11', sales: 22479 },
  { weekOf: '2026-01-18', sales: 21647 }, { weekOf: '2026-01-25', sales: 17944 },
  { weekOf: '2026-02-01', sales: 20948 }, { weekOf: '2026-02-08', sales: 20951 },
  { weekOf: '2026-02-15', sales: 20115 }, { weekOf: '2026-02-22', sales: 18622 },
  { weekOf: '2026-03-01', sales: 20757 }, { weekOf: '2026-03-08', sales: 21585 },
  { weekOf: '2026-03-15', sales: 20837 }, { weekOf: '2026-03-22', sales: 20518 },
  { weekOf: '2026-03-29', sales: 20799 }, { weekOf: '2026-04-05', sales: 21043 },
  { weekOf: '2026-04-12', sales: 21575 }, { weekOf: '2026-04-19', sales: 20257 },
  { weekOf: '2026-04-26', sales: 22571 }, { weekOf: '2026-05-03', sales: 22297 },
  { weekOf: '2026-05-10', sales: 22781 },
];

describe('beforeAfter — formula exactness vs the claim headline', () => {
  // Two synthetic weeks whose averages ARE the claim's stated figures.
  // Proves the formula reproduces −28.9% / $429,154 exactly.
  test('avgBefore=28593, avgAfter=20340 → −28.9% / ~$429k', () => {
    const series = [
      { weekOf: '2025-12-21', sales: 28593 }, // before
      { weekOf: '2026-01-04', sales: 20340 }, // after
    ];
    const r = beforeAfter(series, '2025-12-28', 13, null);
    assert.strictEqual(Math.round(r.avgBefore), 28593);
    assert.strictEqual(Math.round(r.avgAfter), 20340);
    assert.ok(Math.abs(r.deltaPct - -28.86) < 0.05, `deltaPct ${r.deltaPct}`);
    assert.ok(Math.abs(r.annualizedLoss - 429156) < 100, `annualizedLoss ${r.annualizedLoss}`);
  });
});

describe('beforeAfter — real 18th-St series (event week → before)', () => {
  const r = beforeAfter(EIGHTEENTH_ST, '2025-12-28', 13, null); // 13 before, "through now" after

  test('reproduces the claim avgBefore to the dollar ($28,593)', () => {
    assert.strictEqual(Math.round(r.avgBefore), 28593);
    assert.strictEqual(r.weeksBeforeUsed, 13);
  });

  test('after-side regression lock (live table extends through spring recovery)', () => {
    assert.strictEqual(r.weeksAfterUsed, 19);
    assert.strictEqual(Math.round(r.avgAfter), 21117);
    assert.ok(Math.abs(r.deltaPct - -26.15) < 0.1, `deltaPct ${r.deltaPct}`);
    assert.ok(Math.abs(r.annualizedLoss - 388750) < 200, `annualizedLoss ${r.annualizedLoss}`);
  });

  test('is directionally consistent with the manual claim (within ~10%)', () => {
    assert.ok(r.deltaPct < -23 && r.deltaPct > -32, `deltaPct ${r.deltaPct}`);
    assert.ok(r.annualizedLoss > 360000 && r.annualizedLoss < 460000, `loss ${r.annualizedLoss}`);
  });

  test('series carries before/after side labels for charting', () => {
    assert.strictEqual(r.series.length, 32);
    assert.strictEqual(r.series[0].side, 'before');
    assert.strictEqual(r.series.find(s => s.weekOf === '2025-12-28').side, 'before');
    assert.strictEqual(r.series.find(s => s.weekOf === '2026-01-04').side, 'after');
  });
});

describe('beforeAfter — windowing & guardrails', () => {
  test('weeksBefore caps how many pre-event weeks are averaged', () => {
    const r = beforeAfter(EIGHTEENTH_ST, '2025-12-28', 4, null);
    // last 4 before-or-equal weeks: 12/07,12/14,12/21,12/28 = 28137,27951,27220,23507
    assert.strictEqual(r.weeksBeforeUsed, 4);
    assert.strictEqual(Math.round(r.avgBefore), Math.round((28137 + 27951 + 27220 + 23507) / 4));
  });

  test('weeksAfter caps how many post-event weeks are averaged', () => {
    const r = beforeAfter(EIGHTEENTH_ST, '2025-12-28', 13, 3);
    // first 3 after weeks: 01/04,01/11,01/18 = 23502,22479,21647
    assert.strictEqual(r.weeksAfterUsed, 3);
    assert.strictEqual(Math.round(r.avgAfter), Math.round((23502 + 22479 + 21647) / 3));
  });

  test('empty / no-after series degrades safely', () => {
    const r = beforeAfter([{ weekOf: '2025-12-21', sales: 1000 }], '2025-12-28', 13, null);
    assert.strictEqual(r.weeksAfterUsed, 0);
    assert.strictEqual(r.avgAfter, 0);
    assert.strictEqual(r.deltaPct, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/impact.test.mjs`
Expected: FAIL — `beforeAfter is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/impact.mjs`:

```javascript
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Split a store's weekly net-sales series into before/after the event week and
 * compute averages, % change, and annualized loss.
 *
 * Convention: the event week (weekOf === eventDate) is the LAST "before" week,
 * matching the manual 18th-St claim (competitor licensed the day after that Monday).
 *
 * @param {{weekOf:string, sales:number}[]} weekly  store's weekly[] (any order)
 * @param {string} eventDate  ISO Monday of the opening week, e.g. '2025-12-28'
 * @param {number} weeksBefore  max pre-event weeks to average (most recent N)
 * @param {number|null} weeksAfter  max post-event weeks to average; null = through now
 * @returns {{avgBefore:number, avgAfter:number, deltaPct:number, annualizedLoss:number,
 *            weeksBeforeUsed:number, weeksAfterUsed:number,
 *            series:{weekOf:string, sales:number, side:'before'|'after'}[]}}
 */
export function beforeAfter(weekly, eventDate, weeksBefore, weeksAfter) {
  const rows = (weekly || [])
    .filter((w) => w && w.weekOf && typeof w.sales === 'number')
    .slice()
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf)); // ascending by date

  const series = rows.map((w) => ({
    weekOf: w.weekOf,
    sales: w.sales,
    side: w.weekOf <= eventDate ? 'before' : 'after',
  }));

  const beforeAll = series.filter((s) => s.side === 'before');
  const afterAll = series.filter((s) => s.side === 'after');

  // before = the most recent `weeksBefore` pre-event weeks (tail of the before set)
  const beforeUsed = beforeAll.slice(Math.max(0, beforeAll.length - weeksBefore));
  // after = the earliest `weeksAfter` post-event weeks, or all when null
  const afterUsed = weeksAfter == null ? afterAll : afterAll.slice(0, weeksAfter);

  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x.sales, 0) / arr.length : 0);
  const avgBefore = mean(beforeUsed);
  const avgAfter = mean(afterUsed);

  const deltaPct = avgBefore && afterUsed.length ? ((avgAfter - avgBefore) / avgBefore) * 100 : 0;
  const annualizedLoss = afterUsed.length ? (avgBefore - avgAfter) * 52 : 0;

  return {
    avgBefore: round2(avgBefore),
    avgAfter: round2(avgAfter),
    deltaPct: round2(deltaPct),
    annualizedLoss: Math.round(annualizedLoss),
    weeksBeforeUsed: beforeUsed.length,
    weeksAfterUsed: afterUsed.length,
    series,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/impact.test.mjs`
Expected: PASS — all `beforeAfter` tests green (formula-exactness, real-series regression, windowing, guardrails).

- [ ] **Step 5: Commit**

```bash
git add src/impact.mjs src/impact.test.mjs
git commit -m "feat(impact): beforeAfter engine — reproduces 18th-St claim (formula-exact + real-series regression)"
```

---

## Task 3: `pickControls` — distance-matched control selection (TDD)

**Files:**
- Modify: `src/impact.mjs`
- Test: `src/impact.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `src/impact.test.mjs`:

```javascript
import { pickControls } from './impact.mjs';

describe('pickControls', () => {
  // ranked = stores sorted ascending by distance from the event (impacted is nearest)
  const ranked = [
    { pc: 'A', distance: 0.4 }, // impacted
    { pc: 'B', distance: 0.8 },
    { pc: 'C', distance: 1.6 },
    { pc: 'D', distance: 2.9 },
    { pc: 'E', distance: 4.2 },
    { pc: 'F', distance: 7.1 },
  ];

  test('excludes the impacted store and returns a near/mid/far trio', () => {
    const controls = pickControls(ranked, 'A', 3);
    assert.strictEqual(controls.length, 3);
    assert.ok(!controls.some((s) => s.pc === 'A'), 'impacted excluded');
    assert.strictEqual(controls[0].pc, 'B'); // near = closest non-impacted
    assert.strictEqual(controls[2].pc, 'F'); // far = farthest
    assert.ok(controls[1].distance > controls[0].distance && controls[1].distance < controls[2].distance, 'mid is between');
  });

  test('returns all available when fewer than n controls exist', () => {
    const controls = pickControls([{ pc: 'A', distance: 0 }, { pc: 'B', distance: 1 }], 'A', 3);
    assert.deepStrictEqual(controls.map((s) => s.pc), ['B']);
  });

  test('n=1 returns the nearest control', () => {
    assert.deepStrictEqual(pickControls(ranked, 'A', 1).map((s) => s.pc), ['B']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/impact.test.mjs`
Expected: FAIL — `pickControls is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/impact.mjs`:

```javascript
/**
 * Choose representative near/mid/far control stores from a distance-ranked list,
 * excluding the impacted store. Picks an even spread across the available range:
 * always the nearest and farthest, then evenly-indexed picks in between.
 *
 * @param {{pc:string, distance:number}[]} rankedStores  sorted ascending by distance
 * @param {string} impactedPc  the impacted store's pc (excluded)
 * @param {number} [n=3]  number of controls to return
 * @returns {{pc:string, distance:number}[]}
 */
export function pickControls(rankedStores, impactedPc, n = 3) {
  const pool = (rankedStores || [])
    .filter((s) => s && s.pc !== impactedPc)
    .slice()
    .sort((a, b) => a.distance - b.distance);

  if (pool.length <= n) return pool;
  if (n <= 1) return pool.slice(0, Math.max(0, n));

  // Even spread across [0 .. pool.length-1], inclusive of both ends.
  const picks = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (pool.length - 1)) / (n - 1));
    picks.push(pool[idx]);
  }
  // De-dupe in case rounding collides on small pools.
  const seen = new Set();
  return picks.filter((s) => (seen.has(s.pc) ? false : seen.add(s.pc)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/impact.test.mjs`
Expected: PASS — all `pickControls` tests green. Full suite for this file should now be all-green.

- [ ] **Step 5: Commit**

```bash
git add src/impact.mjs src/impact.test.mjs
git commit -m "feat(impact): pickControls near/mid/far distance-matched selection + tests"
```

---

## Task 4: `geocode.js` — address → lat/lng via US Census (Netlify Function)

**Files:**
- Create: `netlify/functions/geocode.js`

> The response-parsing logic is the only part with branching worth testing, but this repo tests `*-lib` and `src/*.mjs` modules, not function handlers directly. We keep the handler thin and verify it with a live smoke call in Step 3. (If you want a unit test, extract `parseCensus(json)` into `netlify/functions/impact-lib/geocode-parse.js` with a `.test.js` — optional, not required for v1.)

- [ ] **Step 1: Write the function**

Create `netlify/functions/geocode.js`:

```javascript
// PCG Portal — Address → {lat,lng} via the free US Census one-line geocoder.
// No API key; US-wide. CORS-gated. Manual lat/lng is the client-side fallback.

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const address = (payload.address || '').trim();
  if (!address) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing address' }) };

  const qs = new URLSearchParams({
    address,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });

  try {
    const res = await fetch(`${CENSUS_URL}?${qs.toString()}`);
    if (!res.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ matched: false, error: `Census ${res.status}` }) };
    }
    const json = await res.json();
    const match = json && json.result && json.result.addressMatches && json.result.addressMatches[0];
    if (!match || !match.coordinates) {
      return { statusCode: 200, headers, body: JSON.stringify({ matched: false }) };
    }
    // Census returns coordinates as { x: longitude, y: latitude }.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        matched: true,
        lat: match.coordinates.y,
        lng: match.coordinates.x,
        matchedAddress: match.matchedAddress || address,
      }),
    };
  } catch (err) {
    console.error('geocode error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ matched: false, error: err.message }) };
  }
};
```

- [ ] **Step 2: Lint/parse check (no build needed — functions aren't bundled into app.js)**

Run: `node -e "require('./netlify/functions/geocode.js'); console.log('ok')"`
Expected: prints `ok` (file parses, exports a handler).

- [ ] **Step 3: Live smoke (after the app is running locally OR via netlify dev)**

This step is verified during the integration smoke in Task 9. For an isolated check, run `npx netlify dev` in another terminal, then:
```bash
curl -s -X POST http://localhost:8888/.netlify/functions/geocode \
  -H 'Content-Type: application/json' \
  -d '{"address":"2654 S 18th St, Philadelphia, PA 19145"}'
```
Expected: JSON like `{"matched":true,"lat":39.92...,"lng":-75.18...,"matchedAddress":"..."}`.

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/geocode.js
git commit -m "feat(impact): geocode function — US Census one-line address → lat/lng"
```

---

## Task 5: `ImpactRadar` scaffold — tab, gating, coords cache, store ranking

From here the work is React UI in `app.jsx`. There's no DOM test harness in this repo, so these tasks follow **implement → `npm run build` → manual smoke**. Each task ends with a build + a specific thing to verify in the browser.

**Files:**
- Modify: `app.jsx` (import, component, tab registration, gating, version bump)

- [ ] **Step 1: Import the engine**

At the top of `app.jsx`, alongside the other `src/` imports (after the `deal-dates.mjs` import line ~7), add:

```javascript
import { haversineMiles, beforeAfter, pickControls } from './src/impact.mjs';
```

- [ ] **Step 2: Register the tab in `getTabs()`**

In `getTabs(user)` (`app.jsx:16527`), add an Impact Radar entry to BOTH the `executive`/`it` list and the `office_staff` list, right after the `ndcp` entry in each:

```javascript
{ id: "impact", label: "Impact Radar", icon: (c) => ICONS.map(c) },
```

- [ ] **Step 3: Add the routing + gate in the main render**

Next to the NDCP render line (`app.jsx:~33762`), add:

```javascript
{tab === "impact" && (isFullAdmin(user) || isOfficeStaff) && <ImpactRadar th={th} user={user} dark={dark} />}
```

- [ ] **Step 4: Add the `ImpactRadar` component scaffold**

Add a new component near `AdminNdcp` (anywhere among the top-level component functions in `app.jsx`). This step delivers: inputs, coords-cache load/build, and live distance ranking — no charts/PDF yet.

```javascript
const COORDS_BLOB = 'pcg_store_coords_v1';

function ImpactRadar({ th, user, dark }) {
  const [eventAddr, setEventAddr] = useState('2310 W Passyunk Ave, Philadelphia, PA 19145');
  const [eventLatLng, setEventLatLng] = useState(null); // {lat,lng}
  const [eventDate, setEventDate] = useState('2025-12-28');
  const [weeksBefore, setWeeksBefore] = useState(13);
  const [weeksAfter, setWeeksAfter] = useState(''); // '' = through now
  const [coords, setCoords] = useState(null);        // { [pc]: {lat,lng} }
  const [ranked, setRanked] = useState([]);          // [{pc,name,address,distance}]
  const [impactedPc, setImpactedPc] = useState(null);
  const [controlPcs, setControlPcs] = useState([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Load (or first-time build) the 45-store coordinate cache.
  useEffect(() => {
    (async () => {
      let c = await cloudLoad(COORDS_BLOB);
      if (!c || Object.keys(c).length < STORES_SEED.length) {
        setStatus('Geocoding store addresses (first run)…');
        c = await buildCoordsCache(c || {});
        await cloudSave(COORDS_BLOB, c);
      }
      setCoords(c);
      setStatus('');
    })();
  }, []);

  async function buildCoordsCache(existing) {
    const out = { ...existing };
    for (const s of STORES_SEED) {
      if (out[s.pc]) continue;
      const full = `${s.address}, ${s.city}, ${s.state} ${s.zip}`;
      try {
        const r = await fetch('/.netlify/functions/geocode', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: full }),
        }).then((x) => x.json());
        if (r && r.matched) out[s.pc] = { lat: r.lat, lng: r.lng };
      } catch { /* skip; left out of cache, re-geocodable later */ }
    }
    return out;
  }

  async function geocodeEvent() {
    setBusy(true); setStatus('Locating event address…');
    try {
      const r = await fetch('/.netlify/functions/geocode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: eventAddr }),
      }).then((x) => x.json());
      if (r && r.matched) { setEventLatLng({ lat: r.lat, lng: r.lng }); setStatus(''); }
      else setStatus('No match — enter lat/lng manually.');
    } catch { setStatus('Geocode failed — enter lat/lng manually.'); }
    setBusy(false);
  }

  // Rank stores by distance whenever the event location or coords cache changes.
  useEffect(() => {
    if (!eventLatLng || !coords) return;
    const rows = STORES_SEED
      .filter((s) => coords[s.pc])
      .map((s) => ({
        pc: s.pc, name: s.name, address: `${s.address}, ${s.city}`,
        distance: haversineMiles(eventLatLng, coords[s.pc]),
      }))
      .sort((a, b) => a.distance - b.distance);
    setRanked(rows);
    if (rows.length) {
      setImpactedPc(rows[0].pc);
      setControlPcs(pickControls(rows, rows[0].pc, 3).map((s) => s.pc));
    }
  }, [eventLatLng, coords]);

  return (
    <div style={{ padding: '1rem', color: th.text }}>
      <h2 style={{ fontFamily: 'Raleway, sans-serif', fontWeight: 800 }}>Impact / Cannibalization Radar</h2>
      {status && <div style={{ color: th.muted, marginBottom: 8 }}>{status}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <label style={{ flex: '1 1 320px' }}>
          Event address
          <input value={eventAddr} onChange={(e) => setEventAddr(e.target.value)} style={inp(th)} />
        </label>
        <label>Opening date
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} style={inp(th)} />
        </label>
        <label>Weeks before
          <input type="number" value={weeksBefore} onChange={(e) => setWeeksBefore(+e.target.value || 13)} style={inp(th)} />
        </label>
        <label>Weeks after (blank = now)
          <input type="number" value={weeksAfter} onChange={(e) => setWeeksAfter(e.target.value)} style={inp(th)} />
        </label>
        <button onClick={geocodeEvent} disabled={busy} style={btn(th)}>Locate & rank</button>
      </div>

      {ranked.length > 0 && (
        <div style={{ ...card(th), padding: 12 }}>
          <strong>{ranked.length}</strong> stores ranked by distance. Impacted (nearest):{' '}
          <strong>{ranked[0].name}</strong> ({ranked[0].distance.toFixed(2)} mi). Controls:{' '}
          {controlPcs.map((pc) => STORES_SEED.find((s) => s.pc === pc)?.name).join(', ')}.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Bump version**

In `app.jsx:33346`, change `v14.48` to `v14.49`.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: esbuild completes with no errors; `app.js` regenerated.

- [ ] **Step 7: Manual smoke**

Run `npx netlify dev`, log in as an executive/it/office_staff user, open the **Impact Radar** tab. Verify: the tab appears and is gated (not visible to a manager/DM); on first load it geocodes + caches store coords (status message shows, then clears); entering the Passyunk address and clicking **Locate & rank** lists 45 stores with **18th St** as the nearest impacted store (~0.4 mi) and a near/mid/far control trio named below.

- [ ] **Step 8: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(impact): ImpactRadar tab — gating, coords cache, distance ranking, auto store selection (v14.49)"
```

---

## Task 6: KPIs + control-comparison table

**Files:**
- Modify: `app.jsx` (extend `ImpactRadar`)

- [ ] **Step 1: Add compute + results state**

Inside `ImpactRadar`, add state and a compute function that loads each selected store's labor blob and runs `beforeAfter`:

```javascript
  const [results, setResults] = useState(null); // { impacted:{...}, controls:[{...}] }

  async function compute() {
    if (!impactedPc) return;
    setBusy(true); setStatus('Loading sales history…');
    const wa = weeksAfter === '' ? null : (+weeksAfter || null);
    const loadOne = async (pc) => {
      const blob = await cloudLoad(`pcg_labor_store_${pc}`);
      const weekly = (blob && blob.weekly) || [];
      const store = STORES_SEED.find((s) => s.pc === pc);
      const ba = beforeAfter(weekly, eventDate, weeksBefore, wa);
      const rankRow = ranked.find((r) => r.pc === pc);
      return { pc, name: store?.name || pc, distance: rankRow ? rankRow.distance : null, ...ba };
    };
    const impacted = await loadOne(impactedPc);
    const controls = [];
    for (const pc of controlPcs) controls.push(await loadOne(pc));
    setResults({ impacted, controls });
    setStatus('');
    setBusy(false);
  }
```

Add a **Compute impact** button next to **Locate & rank**:

```javascript
        <button onClick={compute} disabled={busy || !impactedPc} style={btn(th)}>Compute impact</button>
```

- [ ] **Step 2: Render KPI cards + comparison table**

Add below the ranked-summary card:

```javascript
      {results && (
        <div style={{ marginTop: 16 }}>
          {(() => {
            const imp = results.impacted;
            const nearestCtrl = results.controls[0];
            const ratio = nearestCtrl && nearestCtrl.deltaPct ? (imp.deltaPct / nearestCtrl.deltaPct) : null;
            return (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                <div style={{ ...accentCard(th), padding: 14, minWidth: 180 }}>
                  <div style={{ color: th.muted, fontSize: 12 }}>Impacted Δ</div>
                  <div style={{ fontSize: 26, fontWeight: 800 }}>{fmtPct(imp.deltaPct)}</div>
                  <div style={{ color: th.muted, fontSize: 12 }}>{imp.name} · {imp.weeksBeforeUsed}w before / {imp.weeksAfterUsed}w after</div>
                </div>
                <div style={{ ...accentCard(th), padding: 14, minWidth: 180 }}>
                  <div style={{ color: th.muted, fontSize: 12 }}>Annualized loss</div>
                  <div style={{ fontSize: 26, fontWeight: 800 }}>{fmtDollars(imp.annualizedLoss)}</div>
                </div>
                {ratio && (
                  <div style={{ ...accentCard(th), padding: 14, minWidth: 180 }}>
                    <div style={{ color: th.muted, fontSize: 12 }}>vs nearest control</div>
                    <div style={{ fontSize: 26, fontWeight: 800 }}>{ratio.toFixed(1)}× worse</div>
                  </div>
                )}
              </div>
            );
          })()}

          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: th.muted, fontSize: 12 }}>
                <th style={{ padding: 6 }}>Store</th><th>Distance</th><th>Before $/wk</th><th>After $/wk</th><th>%Δ</th><th>Weeks</th>
              </tr>
            </thead>
            <tbody>
              {[results.impacted, ...results.controls].map((row, i) => (
                <tr key={row.pc} style={{ borderTop: `1px solid ${th.sidebarBorder}`, fontWeight: i === 0 ? 700 : 400 }}>
                  <td style={{ padding: 6 }}>{row.name}{i === 0 ? ' (impacted)' : ''}</td>
                  <td>{row.distance != null ? `${row.distance.toFixed(1)} mi` : '—'}</td>
                  <td>{fmtDollars(row.avgBefore)}</td>
                  <td>{fmtDollars(row.avgAfter)}</td>
                  <td style={{ color: row.deltaPct < -15 ? '#dc2626' : row.deltaPct < -7 ? '#d97706' : th.text }}>{fmtPct(row.deltaPct)}</td>
                  <td style={{ color: row.weeksBeforeUsed < weeksBefore ? '#d97706' : th.muted }}>
                    {row.weeksBeforeUsed}/{row.weeksAfterUsed}{row.weeksBeforeUsed < weeksBefore ? ' ⚠' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ color: th.muted, fontSize: 11, marginTop: 8 }}>
            Source: Pulse net sales via labor blobs. ⚠ = fewer weeks than requested (live blobs retain ~13 weeks).
          </div>
        </div>
      )}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 4: Manual smoke**

In **Impact Radar**, after **Locate & rank**, click **Compute impact**. Verify KPI cards (impacted %Δ, annualized loss, "× worse than nearest control") and the control-comparison table render, with the `weeks` column flagging any store that has fewer than `weeksBefore` weeks (expected, given the 13-week retention cap).

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(impact): KPI cards + distance-matched control-comparison table"
```

---

## Task 7: Chart.js trend line

**Files:**
- Modify: `app.jsx` (extend `ImpactRadar`)

- [ ] **Step 1: Add a canvas + chart effect**

Add a `useRef` for the canvas and a Chart instance ref near the top of `ImpactRadar`:

```javascript
  const chartCanvas = useRef(null);
  const chartRef = useRef(null);
```

Add an effect that (re)draws the trend whenever `results` changes — impacted + controls as lines over the union of week labels, with an opening-date marker:

```javascript
  useEffect(() => {
    if (!results || !chartCanvas.current || !window.Chart) return;
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }

    const all = [results.impacted, ...results.controls];
    const labels = [...new Set(all.flatMap((r) => r.series.map((s) => s.weekOf)))].sort();
    const palette = ['#FF671F', '#2563eb', '#16a34a', '#9333ea', '#0891b2'];
    const datasets = all.map((r, i) => {
      const byWeek = Object.fromEntries(r.series.map((s) => [s.weekOf, s.sales]));
      return {
        label: r.name + (i === 0 ? ' (impacted)' : ''),
        data: labels.map((w) => byWeek[w] ?? null),
        borderColor: palette[i % palette.length],
        borderWidth: i === 0 ? 3 : 1.5,
        spanGaps: true, tension: 0.25, pointRadius: 2,
      };
    });

    chartRef.current = new window.Chart(chartCanvas.current.getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: th.text } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtDollars(c.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { color: th.muted, maxRotation: 60, minRotation: 60 }, grid: { color: th.sidebarBorder } },
          y: { ticks: { color: th.muted, callback: (v) => fmtDollars(v) }, grid: { color: th.sidebarBorder } },
        },
      },
    });
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, [results, dark]);
```

Add the canvas in the results block (above the KPI cards):

```javascript
          <div style={{ height: 320, marginBottom: 16 }}><canvas ref={chartCanvas} /></div>
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Manual smoke**

After **Compute impact**, verify a multi-line trend chart renders — the impacted store as a thick orange line, controls thinner, x-axis = week-of dates, y-axis dollars, tooltips show `$` values. Toggling dark/light re-renders with readable axis colors.

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(impact): Chart.js weekly-sales trend (impacted + controls)"
```

---

## Task 8: Leaflet radius map

**Files:**
- Modify: `app.jsx` (extend `ImpactRadar`)

- [ ] **Step 1: Add map refs + radius control**

Add near the top of `ImpactRadar`:

```javascript
  const mapDiv = useRef(null);
  const mapRef = useRef(null);
  const [radiusMi, setRadiusMi] = useState(1.0);
```

- [ ] **Step 2: Add the map effect**

Draws an event pin, a trade-area circle (radiusMi), and store markers colored by %Δ severity. Renders after results so markers can be colored:

```javascript
  useEffect(() => {
    if (!eventLatLng || !mapDiv.current || !window.L) return;
    if (!mapRef.current) {
      mapRef.current = window.L.map(mapDiv.current).setView([eventLatLng.lat, eventLatLng.lng], 13);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap', maxZoom: 19,
      }).addTo(mapRef.current);
    }
    const map = mapRef.current;
    // Clear prior overlay layers (keep the tile layer).
    map.eachLayer((l) => { if (!(l instanceof window.L.TileLayer)) map.removeLayer(l); });

    window.L.marker([eventLatLng.lat, eventLatLng.lng]).addTo(map).bindPopup('Event (new competitor)');
    window.L.circle([eventLatLng.lat, eventLatLng.lng], {
      radius: radiusMi * 1609.34, color: '#FF671F', weight: 1, fillOpacity: 0.06,
    }).addTo(map);

    const deltaFor = (pc) => {
      if (!results) return null;
      const row = [results.impacted, ...results.controls].find((r) => r.pc === pc);
      return row ? row.deltaPct : null;
    };
    const colorFor = (d) => (d == null ? '#94a3b8' : d < -15 ? '#dc2626' : d < -7 ? '#d97706' : '#16a34a');

    for (const r of ranked) {
      const c = coords[r.pc]; if (!c) continue;
      const d = deltaFor(r.pc);
      window.L.circleMarker([c.lat, c.lng], {
        radius: r.pc === impactedPc ? 9 : 6, color: colorFor(d), fillColor: colorFor(d), fillOpacity: 0.85, weight: 1,
      }).addTo(map).bindPopup(`${r.name} · ${r.distance.toFixed(1)} mi${d != null ? ` · ${fmtPct(d)}` : ''}`);
    }
    map.setView([eventLatLng.lat, eventLatLng.lng], 13);
  }, [eventLatLng, coords, ranked, results, radiusMi, impactedPc]);
```

- [ ] **Step 3: Add the map container + radius input in the render**

Add below the inputs row (visible once an event is located):

```javascript
      {eventLatLng && (
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: th.muted }}>
            Trade-area radius (mi){' '}
            <input type="number" step="0.1" value={radiusMi} onChange={(e) => setRadiusMi(+e.target.value || 1.0)} style={{ ...inp(th), width: 80 }} />
          </label>
          <div ref={mapDiv} style={{ height: 360, marginTop: 8, borderRadius: 8, overflow: 'hidden' }} />
        </div>
      )}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 5: Manual smoke**

Verify the Leaflet map renders with: an event pin at the Passyunk address, an orange trade-area circle (editable radius, default 1.0 mi), and store markers — gray before **Compute impact**, then recolored green/amber/red by %Δ severity after; the impacted store marker is larger; popups show name · distance · %Δ.

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(impact): Leaflet trade-area map — event pin, radius circle, severity-colored store markers"
```

---

## Task 9: jsPDF branded exhibit + integration smoke

**Files:**
- Modify: `app.jsx` (extend `ImpactRadar`)

- [ ] **Step 1: Add the PDF generator**

Mirrors the 18th-St claim sections: header/site IDs, documented sales impact, control comparison, weekly-sales-trend table. Add inside `ImpactRadar`:

```javascript
  function generatePdf() {
    if (!results) return;
    const Ctor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!Ctor) { setStatus('jsPDF not available'); return; }
    const doc = new Ctor({ unit: 'in', format: 'letter', orientation: 'portrait' });
    const margin = 0.6, contentW = 8.5 - margin * 2;
    const hx = BRAND_CONFIG.primary.replace('#', '');
    const orange = [parseInt(hx.slice(0,2),16), parseInt(hx.slice(2,4),16), parseInt(hx.slice(4,6),16)];
    let y = margin;

    // Header band
    doc.setFillColor(orange[0], orange[1], orange[2]); doc.rect(margin, y, contentW, 0.7, 'F');
    doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(16);
    doc.text('Impact / Cannibalization Analysis', margin + 0.2, y + 0.3);
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text(`Event: ${eventAddr}  ·  Opening: ${eventDate}`, margin + 0.2, y + 0.52);
    y += 0.95;

    const imp = results.impacted;
    doc.setTextColor(17,17,17); doc.setFont('helvetica','bold'); doc.setFontSize(12);
    doc.text(`Documented Sales Impact — ${imp.name}`, margin, y); y += 0.28;
    doc.setFont('helvetica','normal'); doc.setFontSize(10);
    const impLines = [
      `Avg weekly net sales BEFORE: ${fmtDollars(imp.avgBefore)}  (${imp.weeksBeforeUsed} weeks)`,
      `Avg weekly net sales AFTER:  ${fmtDollars(imp.avgAfter)}  (${imp.weeksAfterUsed} weeks)`,
      `Change: ${fmtPct(imp.deltaPct)}     Annualized revenue loss: ${fmtDollars(imp.annualizedLoss)}`,
    ];
    impLines.forEach((t) => { doc.text(t, margin, y); y += 0.22; });
    y += 0.15;

    // Control comparison table
    doc.setFont('helvetica','bold'); doc.setFontSize(12);
    doc.text('Control Store Comparison', margin, y); y += 0.26;
    doc.setFontSize(9);
    const cols = [margin, margin+2.4, margin+3.4, margin+4.7, margin+6.0];
    doc.text('Store', cols[0], y); doc.text('Dist', cols[1], y);
    doc.text('Before/wk', cols[2], y); doc.text('After/wk', cols[3], y); doc.text('%Δ', cols[4], y);
    y += 0.06; doc.setDrawColor(200,200,200); doc.line(margin, y, margin + contentW, y); y += 0.18;
    doc.setFont('helvetica','normal');
    [results.impacted, ...results.controls].forEach((r, i) => {
      if (i === 0) doc.setFont('helvetica','bold'); else doc.setFont('helvetica','normal');
      doc.text(`${r.name}${i===0?' (impacted)':''}`.slice(0, 28), cols[0], y);
      doc.text(r.distance != null ? `${r.distance.toFixed(1)}mi` : '—', cols[1], y);
      doc.text(fmtDollars(r.avgBefore), cols[2], y);
      doc.text(fmtDollars(r.avgAfter), cols[3], y);
      doc.text(fmtPct(r.deltaPct), cols[4], y);
      y += 0.2;
    });
    y += 0.2;

    // Weekly trend table (impacted only, paginated)
    doc.setFont('helvetica','bold'); doc.setFontSize(12);
    if (y > 9.5) { doc.addPage(); y = margin; }
    doc.text(`Weekly Net Sales Trend — ${imp.name}`, margin, y); y += 0.26;
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    imp.series.forEach((s) => {
      if (y > 10.4) { doc.addPage(); y = margin; }
      doc.text(s.weekOf, margin, y);
      doc.text(fmtDollars(s.sales), margin + 1.6, y);
      doc.text(s.side, margin + 3.2, y);
      y += 0.18;
    });

    doc.setFontSize(8); doc.setTextColor(120,120,120);
    doc.text('Source: Dunkin’ Pulse POS net sales. Distances are geocoded centroid estimates (US Census).', margin, 10.7);
    doc.save(`impact-${imp.name.replace(/\s+/g,'-')}-${eventDate}.pdf`);
  }
```

Add the button (in the results block, near the KPI cards):

```javascript
          <button onClick={generatePdf} style={{ ...btn(th), marginBottom: 12 }}>📄 Generate PDF exhibit</button>
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Full integration smoke**

`npx netlify dev`, log in as exec/it. In **Impact Radar**: enter the Passyunk event address + date `2025-12-28` → **Locate & rank** (18th St nearest) → **Compute impact** → verify KPIs, table, trend chart, and severity map all populate → **Generate PDF exhibit** → confirm the downloaded PDF has the orange header band, the documented-impact block, the control-comparison table, and the paginated weekly-trend table with before/after labels.

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(impact): jsPDF branded impact exhibit (header, impact block, control table, weekly trend)"
```

---

## Task 10: Finalize — full test run, PR

**Files:** none (verification + PR)

- [ ] **Step 1: Run the full engine test suite**

Run: `npm test`
Expected: all green, including the new `src/impact.test.mjs` (haversine, beforeAfter formula-exact + real-series, pickControls).

- [ ] **Step 2: Confirm tracked tree is clean except intended files**

Run: `git status --porcelain --untracked-files=no`
Expected: empty (everything committed). The 3 intentional untracked `… 2.html/.md` iCloud dups may remain.

- [ ] **Step 3: Open PR**

```bash
git push -u origin feature/impact-radar
gh pr create --title "feat: Impact / Cannibalization Radar (Task 3)" \
  --body "Implements the auto distance-matched impact analysis per docs/superpowers/specs/2026-06-08-impact-radar-design.md. Engine (src/impact.mjs) reproduces the 18th-St claim two ways (formula-exact + real-series regression). New geocode function + ImpactRadar tab (Chart.js trend, Leaflet radius map, control table, jsPDF exhibit). v14.49."
```

- [ ] **Step 4: STOP for review** (per the work-order: per-task branch → PR → preview-deploy → smoke → prod; stop for review between tasks).

---

## Self-review notes

- **Spec coverage:** `haversineMiles`/`beforeAfter`/`pickControls` (Tasks 1–3); `geocode.js` + coords cache `pcg_store_coords_v1` (Tasks 4–5); `ImpactRadar` tab gated like NDCP (Task 5); compute via `cloudLoad('pcg_labor_store_{pc}')` (Task 6); Chart.js trend (7); Leaflet radius map (8); control table + KPIs (6); jsPDF exhibit (9). 18th-St acceptance test (Task 2). All spec sections mapped.
- **Open confirms for Mike (spec §"Confirm on review" + planning decision #1):** (1) event-week→before bucketing convention; (2) near/mid/far control trio default; (3) 1.0 mi default radius; (4) full-claim PDF vs leaner one-pager. Defaults are implemented; changing them is a small edit.
- **Known v1 limitation:** live blob retains ~13 weeks (`MAX_WEEKLY`), so live deep-history analysis is bounded; engine + UI report actual weeks used and flag short stores. Retention/backfill is a labeled fast-follow. Guest count is the other labeled fast-follow (net sales only in v1).
