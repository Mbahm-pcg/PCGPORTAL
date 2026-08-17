# Pulse Period-over-Period Comparisons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "vs last week" and "vs last year" comparison rows to the Pulse sales KPI summary at network, district, and store levels.

**Architecture:** A new pure ESM module `src/pulse-comparison.mjs` owns all period math (date offsets, same-store filtering, intraday curve scaling, percent deltas). `AdminPulse` fetches prior-period dates into its existing per-store `dayStoreCache`; district and store views read that same cache, so drilling down costs zero additional API calls.

**Tech Stack:** React 18 (no JSX build step for `src/*.mjs`), esbuild bundling, `node --test` for unit tests, Pulse POS API via `/.netlify/functions/pulse`.

**Spec:** `docs/superpowers/specs/2026-08-16-pulse-period-comparisons-design.md`

## Global Constraints

- Branch: `feature/pulse-period-comparisons` (already created from `a4b6f54`, v19.98).
- Comparisons apply to **Net Sales and Guests only**. Avg Check, Discounts, Void Rate, Weekly Forecast and Pace cells stay empty on comparison rows.
- Last year = **exactly 364 days** prior (`LY_OFFSET_DAYS`). Last week = **7 days** prior.
- Partial weeks are **day-matched**: compare only the elapsed weekdays, never prorated, never against a full 7-day prior week.
- **Same-store basis**: a store missing data on either side is excluded from **both** sides.
- Intraday scaling order: **same-store filter first, then curve scaling.**
- Estimated (intraday) values must be labeled `(est. to Xam/pm)`. Never show a modeled number unlabeled.
- A comparison failure must **never** degrade the primary Today/WTD figures.
- All date math anchors at `T12:00:00` to dodge DST edges (existing repo convention).
- New pure logic goes in `src/*.mjs` with a matching `src/*.test.mjs` — both are already covered by the `npm test` glob. No new tooling.
- Repo workflow: edit `app.jsx` → `npm run build` → bump `APP_VERSION` → commit **both** `app.jsx` and `app.js`.
- Do **not** deploy. Deployment is Mike's manual step.

---

### Task 1: Date helpers and delta (pure module foundation)

**Files:**
- Create: `src/pulse-comparison.mjs`
- Test: `src/pulse-comparison.test.mjs`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `LY_OFFSET_DAYS: number`, `LW_OFFSET_DAYS: number`, `shiftDate(ymd: string, days: number) → string`, `dowFor(ymd: string) → number`, `comparisonDates(busDt: string, viewMode: 'day'|'week', todayStr: string) → { current: string[], lw: string[], ly: string[] }`, `delta(current: number, prior: number) → number|null`

> Note: `comparisonDates` takes `todayStr` as a third argument (the spec sketched two). This keeps the function pure and deterministic instead of reading the clock, and mirrors `getWeekDates`, which caps the week at today.

- [ ] **Step 1: Write the failing test**

Create `src/pulse-comparison.test.mjs`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LY_OFFSET_DAYS, shiftDate, dowFor, comparisonDates, delta } from './pulse-comparison.mjs';

describe('shiftDate', () => {
  test('shifts forward and backward', () => {
    assert.strictEqual(shiftDate('2026-08-12', 7), '2026-08-19');
    assert.strictEqual(shiftDate('2026-08-12', -7), '2026-08-05');
  });
  test('crosses month and year boundaries', () => {
    assert.strictEqual(shiftDate('2026-01-01', -1), '2025-12-31');
    assert.strictEqual(shiftDate('2026-02-28', 1), '2026-03-01');
  });
  test('LY offset lands on the same weekday', () => {
    const d = '2026-08-12';
    assert.strictEqual(dowFor(shiftDate(d, -LY_OFFSET_DAYS)), dowFor(d));
  });
});

describe('comparisonDates — day mode', () => {
  test('single current date, one lw and one ly date', () => {
    const r = comparisonDates('2026-08-12', 'day', '2026-08-14');
    assert.deepStrictEqual(r.current, ['2026-08-12']);
    assert.deepStrictEqual(r.lw, ['2026-08-05']);
    assert.deepStrictEqual(r.ly, ['2025-08-13']);
  });
});

describe('comparisonDates — week mode', () => {
  test('current week returns only elapsed days (Sun..today)', () => {
    // 2026-08-12 is a Wednesday; week starts Sun 2026-08-09; today is Wed
    const r = comparisonDates('2026-08-12', 'week', '2026-08-12');
    assert.deepStrictEqual(r.current, ['2026-08-09','2026-08-10','2026-08-11','2026-08-12']);
    assert.strictEqual(r.lw.length, 4);
    assert.strictEqual(r.ly.length, 4);
    assert.strictEqual(r.lw[0], '2026-08-02');
    assert.strictEqual(r.ly[0], '2025-08-10');
  });
  test('a fully past week returns all 7 days', () => {
    const r = comparisonDates('2026-08-05', 'week', '2026-08-14');
    assert.strictEqual(r.current.length, 7);
    assert.strictEqual(r.current[0], '2026-08-02'); // Sunday
    assert.strictEqual(r.current[6], '2026-08-08'); // Saturday
  });
  test('every comparison date keeps day-of-week alignment', () => {
    const r = comparisonDates('2026-08-12', 'week', '2026-08-12');
    r.current.forEach((d, i) => {
      assert.strictEqual(dowFor(r.lw[i]), dowFor(d));
      assert.strictEqual(dowFor(r.ly[i]), dowFor(d));
    });
  });
  test('week spanning a year boundary', () => {
    // 2026-01-01 is a Thursday; week starts Sun 2025-12-28
    const r = comparisonDates('2026-01-01', 'week', '2026-01-01');
    assert.strictEqual(r.current[0], '2025-12-28');
    assert.strictEqual(r.current.length, 5);
  });
});

describe('delta', () => {
  test('normal positive and negative movement', () => {
    assert.strictEqual(delta(110, 100), 10);
    assert.strictEqual(delta(90, 100), -10);
  });
  test('returns null rather than dividing by zero or absent prior', () => {
    assert.strictEqual(delta(100, 0), null);
    assert.strictEqual(delta(100, null), null);
    assert.strictEqual(delta(100, undefined), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 pulse-comparison`
Expected: FAIL — `Cannot find module './pulse-comparison.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `src/pulse-comparison.mjs`:

```js
// PCG Pulse — period-over-period sales comparison logic (pure, ESM, unit-tested).
// Single source of truth for the last-year convention, partial-period alignment,
// the same-store rule, and intraday curve scaling used by the Pulse KPI rows.
// Previously the 364-day rule was copy-pasted across AdminPulse, DistrictDetail
// and StoreDetail — keep it here and nowhere else.

export const LY_OFFSET_DAYS = 364;  // 52 exact weeks — preserves day-of-week
export const LW_OFFSET_DAYS = 7;

// YYYY-MM-DD shifted by `days`, anchored at local noon so DST never moves the date.
export function shiftDate(ymd, days) {
  const d = new Date(ymd + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// 0=Sun … 6=Sat
export function dowFor(ymd) {
  return new Date(ymd + 'T12:00:00').getDay();
}

// The current period's dates plus the matching last-week and last-year sets.
// Day mode  → one date each side.
// Week mode → Sunday through busDt, capped at todayStr (mirrors getWeekDates),
//             with each comparison date shifted individually so day-of-week
//             alignment holds for every element.
export function comparisonDates(busDt, viewMode, todayStr) {
  let current;
  if (viewMode === 'week') {
    const sun = shiftDate(busDt, -dowFor(busDt));
    current = [];
    for (let i = 0; i < 7; i++) {
      const ds = shiftDate(sun, i);
      if (ds <= todayStr) current.push(ds);
    }
  } else {
    current = [busDt];
  }
  return {
    current,
    lw: current.map(d => shiftDate(d, -LW_OFFSET_DAYS)),
    ly: current.map(d => shiftDate(d, -LY_OFFSET_DAYS)),
  };
}

// Percent change. Null (not Infinity/NaN) when there's no usable prior figure —
// callers render "—" for null.
export function delta(current, prior) {
  if (!prior || prior <= 0) return null;
  return (current - prior) / prior * 100;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS — all `pulse-comparison` tests green, no existing tests broken.

- [ ] **Step 5: Commit**

```bash
git add src/pulse-comparison.mjs src/pulse-comparison.test.mjs
git commit -m "Add pure date helpers for Pulse period comparisons"
```

---

### Task 2: Same-store totals

**Files:**
- Modify: `src/pulse-comparison.mjs` (append)
- Test: `src/pulse-comparison.test.mjs` (append)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (independent export in the same file)
- Produces: `comparableTotals(dayStoreCache, currentDates, priorDates, pcs) → { current: {netSales, guests}, prior: {netSales, guests}, comparablePcs: string[], excludedPcs: string[] }`

`dayStoreCache` shape is `{ [date]: { [pc]: { status: 'ok'|'error', data: { netSales, guests, voids, discounts } } } }` — this is the existing structure built by `fetchDate` in `app.jsx`.

- [ ] **Step 1: Write the failing test**

Append to `src/pulse-comparison.test.mjs`:

```js
import { comparableTotals } from './pulse-comparison.mjs';

const ok = (netSales, guests) => ({ status: 'ok', data: { netSales, guests, voids: 0, discounts: 0 } });

describe('comparableTotals', () => {
  const cache = {
    '2026-08-12': { A: ok(100, 10), B: ok(200, 20), C: ok(50, 5) },
    '2026-08-05': { A: ok(90, 9),   B: ok(180, 18) },   // C missing on the prior side
  };

  test('sums only stores present on BOTH sides', () => {
    const r = comparableTotals(cache, ['2026-08-12'], ['2026-08-05'], ['A','B','C']);
    assert.deepStrictEqual(r.comparablePcs, ['A','B']);
    assert.deepStrictEqual(r.excludedPcs, ['C']);
    assert.strictEqual(r.current.netSales, 300);  // C's 50 excluded from current too
    assert.strictEqual(r.prior.netSales, 270);
    assert.strictEqual(r.current.guests, 30);
    assert.strictEqual(r.prior.guests, 27);
  });

  test('a store erroring on either side is excluded', () => {
    const c = {
      '2026-08-12': { A: ok(100, 10), B: { status: 'error' } },
      '2026-08-05': { A: ok(90, 9),   B: ok(180, 18) },
    };
    const r = comparableTotals(c, ['2026-08-12'], ['2026-08-05'], ['A','B']);
    assert.deepStrictEqual(r.comparablePcs, ['A']);
    assert.strictEqual(r.current.netSales, 100);
  });

  test('multi-day: missing ONE day of the range excludes the store entirely', () => {
    const c = {
      '2026-08-11': { A: ok(10, 1), B: ok(20, 2) },
      '2026-08-12': { A: ok(10, 1) },                 // B missing this day
      '2026-08-04': { A: ok(10, 1), B: ok(20, 2) },
      '2026-08-05': { A: ok(10, 1), B: ok(20, 2) },
    };
    const r = comparableTotals(c, ['2026-08-11','2026-08-12'], ['2026-08-04','2026-08-05'], ['A','B']);
    assert.deepStrictEqual(r.comparablePcs, ['A']);
    assert.strictEqual(r.current.netSales, 20);
    assert.strictEqual(r.prior.netSales, 20);
  });

  test('no comparable stores yields zeros, not a throw', () => {
    const r = comparableTotals({}, ['2026-08-12'], ['2026-08-05'], ['A']);
    assert.deepStrictEqual(r.comparablePcs, []);
    assert.strictEqual(r.current.netSales, 0);
    assert.strictEqual(r.prior.netSales, 0);
  });

  test('missing cache object does not throw', () => {
    const r = comparableTotals(undefined, ['2026-08-12'], ['2026-08-05'], ['A']);
    assert.deepStrictEqual(r.excludedPcs, ['A']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -B2 -A5 comparableTotals | head -20`
Expected: FAIL — `comparableTotals is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/pulse-comparison.mjs`:

```js
// Sum the current and prior periods on a same-store basis.
//
// A store must have an 'ok' entry for EVERY date on BOTH sides to be counted. If
// it is missing anywhere it is dropped from both sides — otherwise a store that
// opened mid-period (Hatboro, relocated 2026) lands entirely on the growth side
// and inflates the delta, reading portfolio expansion as same-store improvement.
export function comparableTotals(dayStoreCache, currentDates, priorDates, pcs) {
  const cache = dayStoreCache || {};
  const hasAll = (pc, dates) =>
    dates.length > 0 && dates.every(d => cache[d] && cache[d][pc] && cache[d][pc].status === 'ok');

  const comparablePcs = [];
  const excludedPcs = [];
  for (const pc of (pcs || [])) {
    if (hasAll(pc, currentDates) && hasAll(pc, priorDates)) comparablePcs.push(pc);
    else excludedPcs.push(pc);
  }

  const sum = (dates) => {
    let netSales = 0, guests = 0;
    for (const d of dates) {
      for (const pc of comparablePcs) {
        const e = cache[d][pc];
        netSales += e.data.netSales || 0;
        guests   += e.data.guests   || 0;
      }
    }
    return { netSales, guests };
  };

  return {
    current: sum(currentDates),
    prior:   sum(priorDates),
    comparablePcs,
    excludedPcs,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/pulse-comparison.mjs src/pulse-comparison.test.mjs
git commit -m "Add same-store comparable totals for Pulse comparisons"
```

---

### Task 3: Intraday curve scaling

**Files:**
- Modify: `src/pulse-comparison.mjs` (append)
- Test: `src/pulse-comparison.test.mjs` (append)

**Interfaces:**
- Consumes: `dowFor` from Task 1
- Produces: `MIN_CURVE_SAMPLES: number`, `dayCompletionFraction(hourlyHistories, dow, throughHour, maxSamples?) → number|null`

`hourlyHistories` is an array of `pcg_hourly_history_{pc}` blobs — one per store in scope. Each blob is an array of `{ date: 'YYYY-MM-DD', hours: [{ h: 0..23, sales: number, checks: number }] }`, newest first, capped at 90 entries by `pulse-hourly-snapshot.mjs`. The `hours` array is **sparse** — only hours with activity appear.

- [ ] **Step 1: Write the failing test**

Append to `src/pulse-comparison.test.mjs`:

```js
import { dayCompletionFraction, MIN_CURVE_SAMPLES } from './pulse-comparison.mjs';

// 2026-08-05, 2026-07-29, 2026-07-22 are all Wednesdays. 2026-08-04 is a Tuesday.
const wedDay = (early, late) => ({
  date: '2026-08-05',
  hours: [{ h: 8, sales: early, checks: 1 }, { h: 14, sales: late, checks: 1 }],
});

describe('dayCompletionFraction', () => {
  test('weights across stores and days, not a mean of fractions', () => {
    const histories = [
      [{ date: '2026-08-05', hours: [{ h: 8, sales: 25 }, { h: 14, sales: 75 }] },
       { date: '2026-07-29', hours: [{ h: 8, sales: 25 }, { h: 14, sales: 75 }] },
       { date: '2026-07-22', hours: [{ h: 8, sales: 25 }, { h: 14, sales: 75 }] }],
    ];
    // through hour 8 → 25 of every 100
    assert.strictEqual(dayCompletionFraction(histories, 3, 8), 0.25);
  });

  test('includes the boundary hour itself', () => {
    const histories = [[
      { date: '2026-08-05', hours: [{ h: 8, sales: 50 }, { h: 9, sales: 50 }] },
      { date: '2026-07-29', hours: [{ h: 8, sales: 50 }, { h: 9, sales: 50 }] },
      { date: '2026-07-22', hours: [{ h: 8, sales: 50 }, { h: 9, sales: 50 }] },
    ]];
    assert.strictEqual(dayCompletionFraction(histories, 3, 8), 0.5);
    assert.strictEqual(dayCompletionFraction(histories, 3, 9), 1);
  });

  test('only matching day-of-week entries count', () => {
    const histories = [[
      { date: '2026-08-04', hours: [{ h: 8, sales: 100 }] },  // Tuesday — ignored for dow=3
      { date: '2026-08-05', hours: [{ h: 8, sales: 10 }, { h: 14, sales: 90 }] },
      { date: '2026-07-29', hours: [{ h: 8, sales: 10 }, { h: 14, sales: 90 }] },
      { date: '2026-07-22', hours: [{ h: 8, sales: 10 }, { h: 14, sales: 90 }] },
    ]];
    assert.strictEqual(dayCompletionFraction(histories, 3, 8), 0.10);
  });

  test('returns null below the sample floor', () => {
    const histories = [[{ date: '2026-08-05', hours: [{ h: 8, sales: 50 }, { h: 14, sales: 50 }] }]];
    assert.strictEqual(dayCompletionFraction(histories, 3, 8), null);
    assert.ok(MIN_CURVE_SAMPLES > 1);
  });

  test('returns null on empty, missing, or zero-sales history', () => {
    assert.strictEqual(dayCompletionFraction([], 3, 8), null);
    assert.strictEqual(dayCompletionFraction(undefined, 3, 8), null);
    assert.strictEqual(dayCompletionFraction([null, 'nope'], 3, 8), null);
    const zeroes = [[
      { date: '2026-08-05', hours: [{ h: 8, sales: 0 }] },
      { date: '2026-07-29', hours: [{ h: 8, sales: 0 }] },
      { date: '2026-07-22', hours: [{ h: 8, sales: 0 }] },
    ]];
    assert.strictEqual(dayCompletionFraction(zeroes, 3, 8), null);
  });

  test('respects maxSamples per store', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      date: shiftDate('2026-08-05', -7 * i),
      hours: [{ h: 8, sales: i === 0 ? 100 : 0 }, { h: 14, sales: 100 }],
    }));
    // With maxSamples=1 only the newest Wednesday counts → 100/200 = 0.5,
    // but that is below MIN_CURVE_SAMPLES, so null.
    assert.strictEqual(dayCompletionFraction([many], 3, 8, 1), null);
    // With the full window, later days contribute 0 early sales → well under 0.5
    const full = dayCompletionFraction([many], 3, 8, 12);
    assert.ok(full !== null && full < 0.1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 dayCompletionFraction | head -20`
Expected: FAIL — `dayCompletionFraction is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/pulse-comparison.mjs`:

```js
// Matching weekdays required before an intraday curve is trusted. Below this the
// caller shows "—" rather than an unlabeled guess.
export const MIN_CURVE_SAMPLES = 3;

// What fraction of a typical `dow` day's sales is complete by the END of
// `throughHour` (ET, 0-23), blended across the stores in scope.
//
// Weighted across all store-days (sum of early sales ÷ sum of full-day sales)
// rather than averaging each day's fraction, so one small or unusual store-day
// cannot swing the curve.
//
// Used to scale prior-period NET SALES daily totals, NOT to read sales directly:
// the hourly blobs store guest-check totals which INCLUDE TAX and run a few
// percent above net sales. Only the day's *shape* is taken from here.
export function dayCompletionFraction(hourlyHistories, dow, throughHour, maxSamples = 8) {
  let through = 0, total = 0, samples = 0;

  for (const history of (hourlyHistories || [])) {
    if (!Array.isArray(history)) continue;
    const matching = history
      .filter(e => e && typeof e.date === 'string' && dowFor(e.date) === dow)
      .slice(0, maxSamples);

    for (const entry of matching) {
      let dayTotal = 0, dayThrough = 0;
      for (const h of (entry.hours || [])) {
        const s = (h && h.sales) || 0;
        dayTotal += s;
        if (h && h.h <= throughHour) dayThrough += s;
      }
      if (dayTotal > 0) { through += dayThrough; total += dayTotal; samples++; }
    }
  }

  if (samples < MIN_CURVE_SAMPLES || total <= 0) return null;
  return through / total;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/pulse-comparison.mjs src/pulse-comparison.test.mjs
git commit -m "Add intraday curve scaling for Pulse comparisons"
```

---

### Task 4: Stop evicting last-year data from localStorage

**Files:**
- Modify: `src/pulse-comparison.mjs` (append)
- Test: `src/pulse-comparison.test.mjs` (append)
- Modify: `app.jsx` — `PULSE_DAY_CACHE_PREFIX` block, currently around lines 7882-7930

**Interfaces:**
- Consumes: `shiftDate` from Task 1
- Produces: `ARCHIVAL_THRESHOLD_DAYS: number`, `isArchivalDate(date: string, todayStr: string) → boolean`

**Background:** `listPulseDayCacheKeys()` in `app.jsx` returns `keys.sort()` — lexicographic. Keys look like `pcg_pulse_day_v1_2025-08-16`. The pruner does `while (keys.length > 29) localStorage.removeItem(keys.shift())`, so `2025-…` keys are always removed before `2026-…` keys. Last-year data is therefore evicted first, every time, and re-fetched on every visit. This already slows the existing forecast bars.

**Fix:** route dates older than 180 days into a separate prefix with its own budget, so the 30-day recency pruner cannot touch them.

- [ ] **Step 1: Write the failing test**

Append to `src/pulse-comparison.test.mjs`:

```js
import { isArchivalDate, ARCHIVAL_THRESHOLD_DAYS } from './pulse-comparison.mjs';

describe('isArchivalDate', () => {
  test('last-year dates are archival', () => {
    assert.strictEqual(isArchivalDate('2025-08-13', '2026-08-14'), true);
  });
  test('recent and last-week dates are not archival', () => {
    assert.strictEqual(isArchivalDate('2026-08-07', '2026-08-14'), false);
    assert.strictEqual(isArchivalDate('2026-08-14', '2026-08-14'), false);
  });
  test('future dates are not archival', () => {
    assert.strictEqual(isArchivalDate('2026-09-01', '2026-08-14'), false);
  });
  test('threshold boundary', () => {
    const boundary = shiftDate('2026-08-14', -ARCHIVAL_THRESHOLD_DAYS);
    assert.strictEqual(isArchivalDate(boundary, '2026-08-14'), false);
    assert.strictEqual(isArchivalDate(shiftDate(boundary, -1), '2026-08-14'), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 isArchivalDate | head -20`
Expected: FAIL — `isArchivalDate is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/pulse-comparison.mjs`:

```js
// Days before which a cached POS day is treated as long-term rather than recent.
// Comfortably past the 7-day comparison window and comfortably short of the
// 364-day one, so last-week stays in the recency cache and last-year does not.
export const ARCHIVAL_THRESHOLD_DAYS = 180;

// True when `date` is old enough to belong in the archival cache bucket.
// The recency bucket prunes lexicographically-oldest-first, which would always
// evict last-year dates ahead of current ones — this predicate keeps them apart.
export function isArchivalDate(date, todayStr) {
  return date < shiftDate(todayStr, -ARCHIVAL_THRESHOLD_DAYS);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Wire the archival bucket into app.jsx**

In `app.jsx`, add this import after line 9 (this task owns it; later tasks assume it exists):

```js
import { LY_OFFSET_DAYS, LW_OFFSET_DAYS, shiftDate, dowFor, comparisonDates, delta, comparableTotals, dayCompletionFraction, MIN_CURVE_SAMPLES, isArchivalDate } from './src/pulse-comparison.mjs';
```

Replace the cache block (currently `app.jsx:7882` through the end of `writePulseDayCache`). Find this anchor:

```js
const PULSE_DAY_CACHE_PREFIX = 'pcg_pulse_day_v1_';
```

Replace the prefix constant and the three functions with:

```js
const PULSE_DAY_CACHE_PREFIX = 'pcg_pulse_day_v1_';
// Last-year dates live in their own bucket. The recency bucket prunes
// lexicographically-oldest-first, so '2025-…' keys were always evicted before
// '2026-…' ones and LY data was re-fetched on every visit. Closed business days
// are immutable, so retaining them is always safe.
const PULSE_ARCHIVE_CACHE_PREFIX = 'pcg_pulse_arch_v1_';
const PULSE_DAY_CACHE_MAX = 30;
const PULSE_ARCHIVE_CACHE_MAX = 60;

function pulseCachePrefixFor(date, todayStr) {
  return isArchivalDate(date, todayStr) ? PULSE_ARCHIVE_CACHE_PREFIX : PULSE_DAY_CACHE_PREFIX;
}
function pulseDayCacheable(date, todayStr) {
  // Only days ≥2 calendar days old are treated as final — late transactions and
  // corrections can still post to yesterday's business date.
  const y = new Date(todayStr + 'T12:00:00'); y.setDate(y.getDate() - 1);
  const yesterday = y.getFullYear() + '-' + String(y.getMonth()+1).padStart(2,'0') + '-' + String(y.getDate()).padStart(2,'0');
  return date < yesterday;
}
function listPulseCacheKeys(prefix) {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) keys.push(k);
  }
  return keys.sort();
}
function readPulseDayCache(date, todayStr, pcs) {
  if (!pulseDayCacheable(date, todayStr)) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(pulseCachePrefixFor(date, todayStr) + date) || 'null');
    if (!saved) return null;
    const out = {};
    for (const pc of pcs) if (saved[pc]) out[pc] = saved[pc];
    return out;
  } catch { return null; }
}
function writePulseDayCache(date, todayStr, results) {
  if (!pulseDayCacheable(date, todayStr)) return;
  const prefix = pulseCachePrefixFor(date, todayStr);
  const cap = prefix === PULSE_ARCHIVE_CACHE_PREFIX ? PULSE_ARCHIVE_CACHE_MAX : PULSE_DAY_CACHE_MAX;
  const key = prefix + date;
  try {
    const prev = JSON.parse(localStorage.getItem(key) || '{}');
    for (const pc in results) if (results[pc] && results[pc].status === 'ok') prev[pc] = results[pc];
    // Prune BEFORE writing so eviction still runs even if the write itself fails.
    const keys = listPulseCacheKeys(prefix).filter(k => k !== key);
    while (keys.length > cap - 1) localStorage.removeItem(keys.shift());
    localStorage.setItem(key, JSON.stringify(prev));
  } catch {
    // Quota exceeded — drop both buckets so the cache rebuilds small rather than
    // wedging in a state where nothing new can ever be written.
    try {
      listPulseCacheKeys(PULSE_DAY_CACHE_PREFIX).forEach(k => localStorage.removeItem(k));
      listPulseCacheKeys(PULSE_ARCHIVE_CACHE_PREFIX).forEach(k => localStorage.removeItem(k));
    } catch {}
  }
}
```

Then search for any remaining callers of the removed `listPulseDayCacheKeys` and update them:

Run: `grep -n "listPulseDayCacheKeys" app.jsx`
Expected: no output. If any remain, replace with `listPulseCacheKeys(PULSE_DAY_CACHE_PREFIX)`.

- [ ] **Step 6: Build and verify manually**

```bash
npm run build
```

Expected: build succeeds with no errors.

Open the portal locally or on a preview deploy, go to Pulse, and in DevTools console run:

```js
Object.keys(localStorage).filter(k => k.startsWith('pcg_pulse_')).sort()
```

Expected: after loading a week, `pcg_pulse_day_v1_2026-…` keys appear. After the LY fetch lands (Task 5), `pcg_pulse_arch_v1_2025-…` keys appear and survive further browsing.

- [ ] **Step 7: Commit**

```bash
git add src/pulse-comparison.mjs src/pulse-comparison.test.mjs app.jsx app.js
git commit -m "Keep last-year POS days in a separate localStorage bucket"
```

---

### Task 5: Fetch comparison periods in AdminPulse

**Files:**
- Modify: `app.jsx` — import block (after line 9), `AdminPulse` state and loaders (around lines 11820-12020)

**Interfaces:**
- Consumes: `comparisonDates`, `comparableTotals`, `dayCompletionFraction`, `delta`, `dowFor` from Tasks 1-4
- Produces: state `comparisonsLoading: boolean`, `hourlyHistories: array`, and a `comparisonRows` value shaped as
  `{ lw: Row, ly: Row } | null` where `Row = { label: string, netSales: number, guests: number, netSalesDelta: number|null, guestsDelta: number|null, comparableCount: number, totalCount: number, estimated: boolean }`.
  Tasks 6 and 7 consume this exact shape.

- [ ] **Step 1: Confirm the import**

Task 4 added this import. Verify it is present after `app.jsx:9`; add it if not:

```js
import { LY_OFFSET_DAYS, LW_OFFSET_DAYS, shiftDate, dowFor, comparisonDates, delta, comparableTotals, dayCompletionFraction, MIN_CURVE_SAMPLES, isArchivalDate } from './src/pulse-comparison.mjs';
```

- [ ] **Step 2: Add state to AdminPulse**

Find this anchor in `AdminPulse` (near `app.jsx:11828`):

```js
  const [dayStoreCache,setDayStoreCache]= useState({});      // date → fetchDate() result (memoize per-day per-store)
```

Insert directly after it:

```js
  const [comparisonsLoading, setComparisonsLoading] = useState(false);
  const [hourlyHistories,    setHourlyHistories]    = useState(null);  // per-store hourly blobs, for intraday curve
```

- [ ] **Step 3: Load hourly histories once**

Insert after the `tipsSnapshot` effect (which ends around `app.jsx:11845`):

```js
  // Hourly history drives the intraday completion curve. One blob per store,
  // 90-day retention, written nightly by pulse-hourly-snapshot. Loaded once —
  // the curve is a shape, not a live figure, so it does not need refreshing.
  useEffect(() => {
    let alive = true;
    Promise.all(activePCs.map(pc =>
      cloudLoad(`pcg_hourly_history_${pc}`).then(d => (Array.isArray(d) ? d : null)).catch(() => null)
    )).then(all => { if (alive) setHourlyHistories(all.filter(Boolean)); });
    return () => { alive = false; };
  }, [activePCs.join(',')]);
```

- [ ] **Step 4: Add the comparison loader**

Insert directly after `loadLYWeek()` (which ends around `app.jsx:12014`):

```js
  // Fetch whichever prior-period dates aren't cached yet, into dayStoreCache.
  // Deliberately runs AFTER loadAll() so the main grid paints at its normal
  // speed; comparison rows fill in behind it like WTD does. Everything lands in
  // dayStoreCache (per-store), so District and Store views re-sum the same data
  // with zero additional API calls.
  async function loadComparisons() {
    const { current, lw, ly } = comparisonDates(busDt, viewMode, todayStr);
    const wanted = [...new Set([...current, ...lw, ...ly])];
    const cache = { ...dayStoreCache };
    if (!loading && Object.keys(storeData).length > 0) cache[busDt] = storeData;
    const missing = wanted.filter(d => !cache[d]);
    if (!missing.length) { setDayStoreCache(cache); return; }
    setComparisonsLoading(true);
    try {
      const fetched = await Promise.all(missing.map(async d => [d, await fetchDate(d)]));
      for (const [d, r] of fetched) cache[d] = r;
      setDayStoreCache(cache);
    } catch (e) {
      // A comparison failure must never disturb Today/WTD — swallow and leave
      // the rows absent rather than surfacing an error over the primary numbers.
      console.warn('[pulse] comparison fetch failed:', e && e.message);
    } finally {
      setComparisonsLoading(false);
    }
  }
```

- [ ] **Step 5: Trigger it after the main load**

Find the existing effect that reacts to `busDt`/`viewMode` changes and drives `loadWTD`/`loadWeekGrid`. Add an effect after it:

```js
  // Kick comparisons once the primary grid has data. Re-runs when the date or
  // view mode changes, since the comparison date set changes with both.
  useEffect(() => {
    if (loading) return;
    if (!Object.keys(storeData).length) return;
    loadComparisons();
  }, [busDt, viewMode, loading]);
```

- [ ] **Step 6: Derive the comparison rows**

Insert after the existing `wtdTotals` / `lyWeekSales` derivations (around `app.jsx:12133`):

```js
  // Comparison rows for the KPI table. Same-store filtering FIRST, then intraday
  // scaling — scaling a total that still contains non-comparable stores would
  // corrupt both adjustments.
  const comparisonRows = (() => {
    const { current, lw, ly } = comparisonDates(busDt, viewMode, todayStr);
    const cache = { ...dayStoreCache, [busDt]: dayStoreCache[busDt] || storeData };
    if (!current.every(d => cache[d])) return null;

    // Today is partial: scale the prior side by the fraction of a typical day
    // complete by now, so an 11am reading isn't compared against a full day.
    const isToday = current[current.length - 1] === todayStr;
    const nowHour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })) % 24;
    const fraction = isToday
      ? dayCompletionFraction(hourlyHistories || [], dowFor(todayStr), nowHour)
      : null;
    if (isToday && fraction == null) return null;   // no trustworthy curve → no row

    const build = (label, priorDates) => {
      if (!priorDates.every(d => cache[d])) return null;
      const t = comparableTotals(cache, current, priorDates, activePCs);
      if (!t.comparablePcs.length) return null;

      // Scale only the final (current) day of the prior range — completed days
      // compare full-to-full.
      let priorNet = t.prior.netSales, priorGuests = t.prior.guests;
      if (fraction != null) {
        const lastDate = priorDates[priorDates.length - 1];
        let lastNet = 0, lastGuests = 0;
        for (const pc of t.comparablePcs) {
          const e = cache[lastDate][pc];
          lastNet += e.data.netSales || 0;
          lastGuests += e.data.guests || 0;
        }
        priorNet    = priorNet    - lastNet    + lastNet    * fraction;
        priorGuests = priorGuests - lastGuests + lastGuests * fraction;
      }

      return {
        label,
        netSales: priorNet,
        guests: priorGuests,
        netSalesDelta: delta(t.current.netSales, priorNet),
        guestsDelta:   delta(t.current.guests,   priorGuests),
        comparableCount: t.comparablePcs.length,
        totalCount: activePCs.length,
        estimated: fraction != null,
      };
    };

    const lwRow = build(viewMode === 'week' ? 'vs PW'    : 'vs LW', lw);
    const lyRow = build(viewMode === 'week' ? 'vs SW LY' : 'vs LY', ly);
    if (!lwRow && !lyRow) return null;
    return { lw: lwRow, ly: lyRow, estimatedHour: fraction != null ? nowHour : null };
  })();
```

- [ ] **Step 7: Build and verify the data is there**

```bash
npm run build
```

Expected: build succeeds.

Load the portal, open Pulse, and in DevTools console confirm prior dates were fetched:

```js
Object.keys(localStorage).filter(k => k.startsWith('pcg_pulse_arch_v1_'))
```

Expected: last-year date keys present after the page settles.

- [ ] **Step 8: Commit**

```bash
git add app.jsx app.js
git commit -m "Fetch prior-period sales into dayStoreCache for comparisons"
```

---

### Task 6: Render comparison sub-rows in the network KPI table

**Files:**
- Modify: `app.jsx` — the KPI summary table, currently around lines 12370-12410

**Interfaces:**
- Consumes: `comparisonRows` from Task 5
- Produces: module-level components `PulseDelta({ d })` and `PulseComparisonFootnote({ rows, G })`, both reused by Task 7

> Note: the network KPI area is a `<table>`, but `DistrictDetail` renders a hero number plus a tile grid (`app.jsx:11091`) — `<tr>` elements are invalid there. So the *data* (`comparisonRows`) is shared, and there are two thin presenters: table rows here, a compact strip in Task 7. The delta formatting itself lives in `PulseDelta` so it exists in exactly one place.

- [ ] **Step 1: Add the shared delta presenter**

Insert these module-level components immediately before `function AdminPulse(` (around `app.jsx:11795`):

```jsx
// Shared by the network table rows and the district/store strip so delta
// formatting and coloring can't drift between levels.
function PulseDelta({ d, G }) {
  if (d == null) return <span style={{ color:`${G}66` }}>—</span>;
  return (
    <span style={{ color: d >= 0 ? '#69db7c' : '#ff6b6b' }}>
      {(d >= 0 ? '▲' : '▼') + Math.abs(d).toFixed(1) + '%'}
    </span>
  );
}

// "(est. to 11am)" suffix when the current period includes a partial today.
function pulseEstLabel(estimatedHour) {
  if (estimatedHour == null) return '';
  const h12 = (estimatedHour % 12) || 12;
  return ` (est. to ${h12}${estimatedHour < 12 ? 'am' : 'pm'})`;
}

function PulseComparisonFootnote({ rows, G }) {
  const partial = [rows?.lw, rows?.ly].filter(Boolean).some(r => r.comparableCount < r.totalCount);
  if (!partial) return null;
  return (
    <div style={{ fontSize:'0.6rem', color:`${G}77`, marginTop:'0.35rem' }}>
      † same-store basis — stores without data in both periods are excluded from both sides
    </div>
  );
}
```

- [ ] **Step 2: Add the sub-rows**

Find this anchor — the closing of the WTD row and the table body (around `app.jsx:12408`):

```jsx
                    </tr>
                  )}
                </tbody>
              </table>
```

Replace with:

```jsx
                    </tr>
                  )}
                  {comparisonRows && [comparisonRows.lw, comparisonRows.ly].filter(Boolean).map(row => {
                    const subVal = { ...valS2, fontSize:'0.8rem', fontWeight:700 };
                    return (
                      <tr key={row.label}>
                        <td style={{ ...lblS2, fontSize:'0.62rem', paddingLeft:'0.9rem', color:`${G}99`, textTransform:'none' }}>
                          {row.label}{pulseEstLabel(comparisonRows.estimatedHour)}
                          {row.comparableCount < row.totalCount && (
                            <span title={`${row.comparableCount} of ${row.totalCount} stores have data for both periods`}
                              style={{ marginLeft:4, color:'#ffd43b' }}>†</span>
                          )}
                        </td>
                        <td style={{ ...subVal, color:`${G}cc` }}>
                          {fmtUSD(row.netSales)} <PulseDelta d={row.netSalesDelta} G={G} />
                        </td>
                        <td style={{ ...subVal, color:'#74c0fc' }}>
                          {fmtNum(Math.round(row.guests))} <PulseDelta d={row.guestsDelta} G={G} />
                        </td>
                        <td style={subVal}></td>
                        <td style={subVal}></td>
                        <td style={subVal}></td>
                        <td style={{ ...subVal, ...divL }}></td>
                        <td style={subVal}></td>
                      </tr>
                    );
                  })}
                  {comparisonsLoading && !comparisonRows && (
                    <tr>
                      <td style={{ ...lblS2, fontSize:'0.62rem', paddingLeft:'0.9rem', color:`${G}66`, textTransform:'none' }}>
                        loading comparisons…
                      </td>
                      <td colSpan={7}></td>
                    </tr>
                  )}
                </tbody>
              </table>
              <PulseComparisonFootnote rows={comparisonRows} G={G} />
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: build succeeds with no errors.

- [ ] **Step 4: Verify in the browser**

Load Pulse at network level and confirm:

1. Day view shows `vs LW` and `vs LY` sub-rows beneath `Today`, each with a prior value and a colored delta.
2. Switching to Week view changes the labels to `vs PW` and `vs SW LY` and the figures change.
3. When the selected date is today, labels carry `(est. to Nam/pm)`.
4. Selecting a past date via the date picker removes the `(est.)` label.
5. A `†` and the footnote appear whenever fewer stores are comparable than total (expect this for LY, since Hatboro has no last-year data).
6. Avg Check / Discounts / Void Rate / Forecast / Pace cells are empty on comparison rows.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "Render period comparison sub-rows in the Pulse KPI table"
```

---

### Task 7: District and store levels reuse the shared cache

**Files:**
- Modify: `app.jsx` — `DistrictDetail` signature and its LY fetch (around lines 10593, 10826-10970)
- Modify: `app.jsx` — `StoreDetail` signature and its LY fetch (around lines 8667, 8979-9040)
- Modify: `app.jsx` — both call sites (lines 12444 and 12449)

**Interfaces:**
- Consumes: `comparisonRows` shape and `dayStoreCache` from Task 5; `comparableTotals`, `delta`, `dayCompletionFraction` from Tasks 1-3
- Produces: no new exports

- [ ] **Step 1: Pass the shared data down**

At `app.jsx:12444`, change:

```jsx
        <DistrictDetail distNum={pulseView.num} stores={stores} storeData={storeData} busDt={busDt} districts={districts} th={th} G={G} setPulseView={setPulseView} laborData={laborData} users={users} />
```

to:

```jsx
        <DistrictDetail distNum={pulseView.num} stores={stores} storeData={storeData} busDt={busDt} districts={districts} th={th} G={G} setPulseView={setPulseView} laborData={laborData} users={users} dayStoreCache={dayStoreCache} viewMode={viewMode} todayStr={todayStr} hourlyHistories={hourlyHistories} />
```

At `app.jsx:12449`, change:

```jsx
        <StoreDetail key={pulseView.pc} pc={pulseView.pc} stores={stores} storeData={storeData} busDt={busDt} th={th} G={G} setPulseView={setPulseView} user={user} users={users} laborData={laborData} txnDeepLinkRef={txnDeepLinkRef} initialTab={pulseView.initialTab || 'sales'} />
```

to:

```jsx
        <StoreDetail key={pulseView.pc} pc={pulseView.pc} stores={stores} storeData={storeData} busDt={busDt} th={th} G={G} setPulseView={setPulseView} user={user} users={users} laborData={laborData} txnDeepLinkRef={txnDeepLinkRef} initialTab={pulseView.initialTab || 'sales'} dayStoreCache={dayStoreCache} viewMode={viewMode} todayStr={todayStr} hourlyHistories={hourlyHistories} />
```

- [ ] **Step 2: Accept the new props**

Change the `DistrictDetail` signature at `app.jsx:10593`:

```js
function DistrictDetail({ distNum, stores, storeData, busDt, districts, th, G, setPulseView, laborData, users, dayStoreCache = null, viewMode = 'day', todayStr = null, hourlyHistories = null }) {
```

Change the `StoreDetail` signature at `app.jsx:8667`:

```js
function StoreDetail({ pc, stores, storeData, busDt, th, G, setPulseView, user, users, standalone = false, laborData = null, txnDeepLinkRef = null, initialTab = 'sales', dayStoreCache = null, viewMode = 'day', todayStr = null, hourlyHistories = null }) {
```

The defaults keep the `standalone` call site at `app.jsx:8224` working unchanged.

- [ ] **Step 3: Add a shared scoped-comparison helper**

Insert this module-level function immediately before `function StoreDetail(` (around `app.jsx:8666`):

```js
// Build comparison rows for a subset of stores by re-summing the network's
// dayStoreCache. No API calls — every date needed was already fetched by
// AdminPulse.loadComparisons(). Returns null when the cache isn't available
// (standalone mode) or the required dates aren't loaded yet.
function scopedComparisonRows({ dayStoreCache, pcs, busDt, viewMode, todayStr, hourlyHistories }) {
  if (!dayStoreCache || !todayStr || !pcs || !pcs.length) return null;
  const { current, lw, ly } = comparisonDates(busDt, viewMode, todayStr);
  if (!current.every(d => dayStoreCache[d])) return null;

  const isToday = current[current.length - 1] === todayStr;
  const nowHour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })) % 24;
  const fraction = isToday ? dayCompletionFraction(hourlyHistories || [], dowFor(todayStr), nowHour) : null;
  if (isToday && fraction == null) return null;

  const build = (label, priorDates) => {
    if (!priorDates.every(d => dayStoreCache[d])) return null;
    const t = comparableTotals(dayStoreCache, current, priorDates, pcs);
    if (!t.comparablePcs.length) return null;
    let priorNet = t.prior.netSales, priorGuests = t.prior.guests;
    if (fraction != null) {
      const lastDate = priorDates[priorDates.length - 1];
      let lastNet = 0, lastGuests = 0;
      for (const pc of t.comparablePcs) {
        const e = dayStoreCache[lastDate][pc];
        lastNet += e.data.netSales || 0;
        lastGuests += e.data.guests || 0;
      }
      priorNet    = priorNet    - lastNet    + lastNet    * fraction;
      priorGuests = priorGuests - lastGuests + lastGuests * fraction;
    }
    return {
      label,
      netSales: priorNet,
      guests: priorGuests,
      netSalesDelta: delta(t.current.netSales, priorNet),
      guestsDelta:   delta(t.current.guests,   priorGuests),
      comparableCount: t.comparablePcs.length,
      totalCount: pcs.length,
      estimated: fraction != null,
    };
  };

  const lwRow = build(viewMode === 'week' ? 'vs PW' : 'vs LW', lw);
  const lyRow = build(viewMode === 'week' ? 'vs SW LY' : 'vs LY', ly);
  if (!lwRow && !lyRow) return null;
  return { lw: lwRow, ly: lyRow, estimatedHour: fraction != null ? nowHour : null };
}
```

- [ ] **Step 4: Add the strip presenter**

District and store render a hero number plus a tile grid (`app.jsx:11091`), not a table, so `<tr>` elements are invalid there. Add this module-level component immediately after `scopedComparisonRows`:

```jsx
// Compact comparison strip for the district and store views, which use a hero
// number + tile grid rather than the network's table. Shares PulseDelta and
// pulseEstLabel with the network rows so formatting cannot drift.
function PulseComparisonStrip({ rows, th, G }) {
  if (!rows) return null;
  const list = [rows.lw, rows.ly].filter(Boolean);
  if (!list.length) return null;
  return (
    <div style={{ marginTop:'-0.75rem', marginBottom:'1.25rem' }}>
      {list.map(row => (
        <div key={row.label} style={{ display:'flex', alignItems:'baseline', gap:'0.6rem', fontSize:'0.72rem', marginTop:'0.3rem' }}>
          <span style={{ color:th.muted, fontWeight:700, minWidth:'5.5rem' }}>
            {row.label}{pulseEstLabel(rows.estimatedHour)}
            {row.comparableCount < row.totalCount && (
              <span title={`${row.comparableCount} of ${row.totalCount} stores have data for both periods`}
                style={{ marginLeft:4, color:'#ffd43b' }}>†</span>
            )}
          </span>
          <span style={{ color:th.text, fontWeight:700 }}>
            {fmtUSD(row.netSales)} <PulseDelta d={row.netSalesDelta} G={G} />
          </span>
          <span style={{ color:th.muted }}>·</span>
          <span style={{ color:'#74c0fc', fontWeight:700 }}>
            {fmtNum(Math.round(row.guests))} <PulseDelta d={row.guestsDelta} G={G} />
          </span>
        </div>
      ))}
      <PulseComparisonFootnote rows={rows} G={G} />
    </div>
  );
}
```

- [ ] **Step 5: Use it in DistrictDetail**

Inside `DistrictDetail`, before the return, add:

```js
  const districtPCs = stores.filter(s => Number(s.district) === Number(distNum) && s.status === 'Open').map(s => s.pc);
  const comparisonRows = scopedComparisonRows({ dayStoreCache, pcs: districtPCs, busDt, viewMode, todayStr, hourlyHistories });
```

Then render the strip directly beneath the hero Net Sales figure. Find this anchor (around `app.jsx:11087`):

```jsx
        <div style={{ fontSize:'0.72rem', color:th.muted, fontWeight:600, marginTop:'0.4rem' }}>{'Net Sales · ' + (viewMode === 'week' ? 'This Week' : 'Today')}</div>
      </div>
```

and insert immediately after the closing `</div>`:

```jsx
      <PulseComparisonStrip rows={comparisonRows} th={th} G={G} />
```

- [ ] **Step 6: Use it in StoreDetail**

Inside `StoreDetail`, before the return, add:

```js
  const comparisonRows = scopedComparisonRows({ dayStoreCache, pcs: [pc], busDt, viewMode, todayStr, hourlyHistories });
```

Render `<PulseComparisonStrip rows={comparisonRows} th={th} G={G} />` directly beneath the store's headline Net Sales figure in the Sales tab. At store level `comparableCount` and `totalCount` are both 1, so the `†` never appears — a single store either has prior data or the row is absent entirely.

- [ ] **Step 7: Remove the duplicate LY fetches**

`StoreDetail` currently refetches the whole LY week per-store even though `AdminPulse` already has it. Find this block (around `app.jsx:9016`):

```js
      const lyResults = await Promise.all(lyWeekDates.map(date =>
        fetchEndpoint('getOperationsDailyTotals', { locRef: pc, busDt: date, include: 'locRef,busDt,revenueCenters' })
      ));
```

Replace with:

```js
      // In-portal: AdminPulse already fetched this week's LY data into
      // dayStoreCache, so skip the per-store refetch entirely. Standalone
      // (manager mobile) has no parent cache and still needs its own fetch.
      const lyFromCache = dayStoreCache && lyWeekDates.every(d => dayStoreCache[d]);
      const lyResults = lyFromCache ? [] : await Promise.all(lyWeekDates.map(date =>
        fetchEndpoint('getOperationsDailyTotals', { locRef: pc, busDt: date, include: 'locRef,busDt,revenueCenters' })
      ));
```

Then find the consumer immediately below it:

```js
      let lyWeekSales = 0;
      let lyDaySales = 0;
      const dayOfWeek = dt.getDay(); // 0=Sun..6=Sat
      for (let i = 0; i < lyResults.length; i++) {
        const r = lyResults[i];
        if (r?.revenueCenters) {
          const t = sumRVCLocal(r.revenueCenters);
          lyWeekSales += t.netSales;
          if (i === dayOfWeek) lyDaySales = t.netSales;
        }
      }
```

Replace with:

```js
      let lyWeekSales = 0;
      let lyDaySales = 0;
      const dayOfWeek = dt.getDay(); // 0=Sun..6=Sat
      if (lyFromCache) {
        // Same figures, read from the cache AdminPulse already populated.
        for (let i = 0; i < lyWeekDates.length; i++) {
          const e = dayStoreCache[lyWeekDates[i]][pc];
          if (e && e.status === 'ok') {
            lyWeekSales += e.data.netSales || 0;
            if (i === dayOfWeek) lyDaySales = e.data.netSales || 0;
          }
        }
      } else {
        for (let i = 0; i < lyResults.length; i++) {
          const r = lyResults[i];
          if (r?.revenueCenters) {
            const t = sumRVCLocal(r.revenueCenters);
            lyWeekSales += t.netSales;
            if (i === dayOfWeek) lyDaySales = t.netSales;
          }
        }
      }
```

Now `DistrictDetail`. It fetches **both** the LY week and the prior week, per store — for a 6-store district that is 6 × 14 = 84 individual calls, all of which `AdminPulse` has already made.

> **Do not** try to build the comparison strip from the existing `weekTotals.lyByDay` / `weekTotals.prevByDay`. Those are district totals per day-of-week with no per-store breakdown, so they cannot support the same-store rule from decision 6. The strip must come from `dayStoreCache`.

Find this block (around `app.jsx:10879`):

```js
      const fetchOps = (s, date) => fetchEndpoint('getOperationsDailyTotals', { api: apiFor(s.pc), locRef: s.pc, busDt: date, include: 'locRef,busDt,revenueCenters' });
      const lyResults = await Promise.all(lyWeekDates.flatMap(date => distStores.map(s => fetchOps(s, date))));
```

Replace with:

```js
      const fetchOps = (s, date) => fetchEndpoint('getOperationsDailyTotals', { api: apiFor(s.pc), locRef: s.pc, busDt: date, include: 'locRef,busDt,revenueCenters' });
      // AdminPulse already fetched these dates for all stores — reuse rather than
      // re-requesting 7 dates × every store in the district.
      const lyFromCache = dayStoreCache && lyWeekDates.every(d => dayStoreCache[d]);
      const lyResults = lyFromCache ? [] : await Promise.all(lyWeekDates.flatMap(date => distStores.map(s => fetchOps(s, date))));
```

Then replace the LY accumulation loop (around `app.jsx:10887`):

```js
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        let daySum = 0;
        for (let si = 0; si < storesCount; si++) {
          const r = lyResults[dayIdx * storesCount + si];
          if (r?.revenueCenters) daySum += sumRVCLocal(r.revenueCenters).netSales;
        }
        lyByDay[dayIdx] = daySum;
        lyWeekSales += daySum;
        if (dayIdx === dayOfWeek) lyDaySales = daySum;
      }
```

with:

```js
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        let daySum = 0;
        if (lyFromCache) {
          const date = lyWeekDates[dayIdx];
          for (const s of distStores) {
            const e = dayStoreCache[date][s.pc];
            if (e && e.status === 'ok') daySum += e.data.netSales || 0;
          }
        } else {
          for (let si = 0; si < storesCount; si++) {
            const r = lyResults[dayIdx * storesCount + si];
            if (r?.revenueCenters) daySum += sumRVCLocal(r.revenueCenters).netSales;
          }
        }
        lyByDay[dayIdx] = daySum;
        lyWeekSales += daySum;
        if (dayIdx === dayOfWeek) lyDaySales = daySum;
      }
```

Apply the identical treatment to the prior-week fetch immediately below. Replace (around `app.jsx:10904`):

```js
      const prevResults = await Promise.all(prevWeekDates.flatMap(date => distStores.map(s => fetchOps(s, date))));
```

with:

```js
      const prevFromCache = dayStoreCache && prevWeekDates.every(d => dayStoreCache[d]);
      const prevResults = prevFromCache ? [] : await Promise.all(prevWeekDates.flatMap(date => distStores.map(s => fetchOps(s, date))));
```

and wrap its accumulation loop the same way, reading `dayStoreCache[prevWeekDates[dayIdx]][s.pc]` in the cached branch and leaving the `prevResults` indexing untouched in the fallback branch.

- [ ] **Step 8: Build**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 9: Verify drill-down consistency and call savings**

Open DevTools → Network, filter to `functions/pulse`, then:

1. Load Pulse at network level; wait for comparisons to settle. Note the request count.
2. Click into a district. Expected: **zero new** `functions/pulse` requests, and comparison rows render immediately.
3. Click into a store. Expected: **zero new** requests.
4. Confirm the store's `vs LY` figure matches that store's row contribution at district level.
5. Open manager mobile (standalone `StoreDetail`) and confirm its forecast still renders — that path still fetches its own LY data.

- [ ] **Step 10: Commit**

```bash
git add app.jsx app.js
git commit -m "Reuse shared cache for district and store comparisons"
```

---

### Task 8: Version bump and full verification

**Files:**
- Modify: `app.jsx` — `APP_VERSION` at line 25757

- [ ] **Step 1: Bump the version**

Change:

```js
const APP_VERSION = "v19.98";
```

to:

```js
const APP_VERSION = "v19.99";
```

Check `git log origin/main --oneline -1` first — if Ahmed has pushed past v19.99, use the next number above his.

- [ ] **Step 2: Run the full test suite**

```bash
npm test
```

Expected: all tests pass, including every pre-existing suite.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 4: Confirm no stray references**

```bash
grep -n "listPulseDayCacheKeys" app.jsx
```

Expected: no output.

```bash
grep -c "364" app.jsx
```

Expected: lower than before the change — the constant now lives in `src/pulse-comparison.mjs`. Any remaining occurrences should be in the standalone `StoreDetail` path only.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "Bump APP_VERSION for Pulse period comparisons (v19.99)"
```

- [ ] **Step 6: Hand off**

Do **not** deploy. Report to Mike:
- Branch `feature/pulse-period-comparisons` is ready.
- Suggested next steps: review the diff, merge to `main` after checking Ahmed hasn't conflicted, then `npx netlify deploy --prod`.
