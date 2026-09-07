# System Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make silent failures in PCGPORTAL's data pipeline visible and alert on them — monitor every scheduled function's data-feed freshness (per-store where applicable), surface it on an exec/IT dashboard, and push+email critical outages.

**Architecture:** A single pure module (`src/system-health.mjs`) holds the FEEDS registry and all classification logic (`classifyFeed`, `classifyPerStore`, `rollup`, `diffForAlerts`, `buildSnapshot`) with `buildSnapshot` taking an injected async blob reader so it is 100% unit-testable. Two thin `.mjs` Netlify functions wrap it with real Netlify-Blobs I/O: a 30-minute cron (`system-health-cron.mjs`) that classifies → diffs → alerts → snapshots, and an exec/IT-gated on-demand endpoint (`system-health.mjs`) that recomputes live for the dashboard's "Refresh now". A `recordHealth()` heartbeat helper lets key crons enrich feeds with last-error/duration. The frontend adds a `SystemHealth` React component surfaced as a tile under the existing `system-hub`.

**Tech Stack:** Node ES modules (`.mjs`), `@netlify/blobs`, `web-push`, Resend (email), Neon Postgres (`_shared/db.mjs`), React 18 (authored in JSX, esbuild-bundled), `node:test` + `node:assert`.

## Global Constraints

_Every task's requirements implicitly include this section._

- **All new function and `src` modules are ES modules (`.mjs`).** Functions are `export default async (request, context) => { ... }` handlers returning a `new Response(...)`. (CLAUDE.md's `exports.handler`/`.js` description is stale — the live codebase is `.mjs`.)
- **Blob store handle (verbatim):** `getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN })` from `import { getStore } from '@netlify/blobs'`.
- **Blob wrapper (verbatim):** every blob is written as `store.setJSON(key, { savedAt: new Date().toISOString(), data })`. To read freshness, `const raw = await store.get(key, { type: 'json' })` then use `raw.savedAt` (ISO string) and `raw.data`.
- **Tests:** run with `node --test`. A new `src/system-health.test.mjs` is auto-discovered by the existing `package.json` `"test"` glob `'src/*.test.mjs'` — **no package.json change**.
- **Build/deploy workflow:** edit `app.jsx` → `npm run build` (esbuild → `app.js`) → bump `APP_VERSION` constant in `app.jsx` → commit **both** `app.jsx` and `app.js` → `npx netlify deploy --prod` (manual). Deploy is Mike's call — do not auto-deploy.
- **Shared main branch:** Ahmed (pcg-preeom) commits to `main`. Always `git fetch` + fast-forward before committing.
- **Snapshot/alert/beat blob keys (fixed names used across tasks):** `pcg_system_health_v1` (latest snapshot), `pcg_system_health_alerts_v1` (alert log + re-alert timestamps), `pcg_system_health_beats_v1` (heartbeats).
- **Statuses** are exactly `'OK' | 'STALE' | 'DOWN'` per feed and `'GREEN' | 'YELLOW' | 'RED'` for the overall rollup.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/system-health.mjs` | **New.** FEEDS registry + all pure logic: `classifyFeed`, `rollup`, `classifyPerStore`, `diffForAlerts`, `buildSnapshot`. Zero I/O (`buildSnapshot` takes an injected `readSavedAt`). | 1–3 |
| `src/system-health.test.mjs` | **New.** `node:test` unit tests for every pure function + registry sanity. | 1–3 |
| `netlify/functions/health-lib/record-health.mjs` | **New.** `recordHealth(name, {ok,error,durationMs})` heartbeat helper → `pcg_system_health_beats_v1`. Never throws into caller. | 4 |
| `netlify/functions/system-health-cron.mjs` | **New.** Scheduled (30 min): build snapshot → diff vs previous → push+email critical transitions (6h re-alert guard) → save snapshot + alert log. | 5 |
| `netlify.toml` | **Modify.** Add `[functions.system-health-cron]` with `schedule = "*/30 * * * *"`. | 5 |
| `netlify/functions/system-health.mjs` | **New.** Exec/IT-gated on-demand recompute (same `buildSnapshot`, no alerting) for "Refresh now". | 6 |
| `app.jsx` | **Modify.** `SystemHealth` component + `system-hub` tile + route + mobile subtitle + `APP_VERSION` bump. | 7 |
| `netlify/functions/labor-cron.mjs`, `pulse-notify.mjs`, `tips-report-cron-background.mjs`, `paycor.mjs` | **Modify (additive).** Call `recordHealth()` at end/failure. | 8 |

---

## Task 1: Pure feed classification — `classifyFeed` + `rollup`

**Files:**
- Create: `src/system-health.mjs`
- Test: `src/system-health.test.mjs`

**Interfaces:**
- Produces: `classifyFeed(savedAtMs: number|null, nowMs: number, spec: { expectedMaxAgeMin: number }) → 'OK'|'STALE'|'DOWN'` and `rollup(feedStatuses: Array<{ status: string, critical: boolean }>) → 'GREEN'|'YELLOW'|'RED'`.
- Rules: `OK` when age ≤ `expectedMaxAgeMin`; `STALE` when age ≤ `2×`; else `DOWN`; missing `savedAt` → `DOWN`. Rollup: any **critical** `DOWN` → `RED`; else any `STALE` or any non-critical `DOWN` → `YELLOW`; else `GREEN` (non-critical never forces `RED`).

- [ ] **Step 1: Write the failing test**

Create `src/system-health.test.mjs`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyFeed, rollup } from './system-health.mjs';

const MIN = 60000;
const NOW = 1_000_000_000_000;

describe('classifyFeed', () => {
  const spec = { expectedMaxAgeMin: 90 };
  test('fresh (age < expected) → OK', () => {
    assert.strictEqual(classifyFeed(NOW - 10 * MIN, NOW, spec), 'OK');
  });
  test('exactly at expected boundary → OK', () => {
    assert.strictEqual(classifyFeed(NOW - 90 * MIN, NOW, spec), 'OK');
  });
  test('between 1x and 2x → STALE', () => {
    assert.strictEqual(classifyFeed(NOW - 120 * MIN, NOW, spec), 'STALE');
  });
  test('exactly 2x boundary → STALE', () => {
    assert.strictEqual(classifyFeed(NOW - 180 * MIN, NOW, spec), 'STALE');
  });
  test('beyond 2x → DOWN', () => {
    assert.strictEqual(classifyFeed(NOW - 181 * MIN, NOW, spec), 'DOWN');
  });
  test('missing savedAt (null) → DOWN', () => {
    assert.strictEqual(classifyFeed(null, NOW, spec), 'DOWN');
  });
});

describe('rollup', () => {
  test('all OK → GREEN', () => {
    assert.strictEqual(rollup([{ status: 'OK', critical: true }, { status: 'OK', critical: false }]), 'GREEN');
  });
  test('critical DOWN → RED', () => {
    assert.strictEqual(rollup([{ status: 'DOWN', critical: true }, { status: 'OK', critical: false }]), 'RED');
  });
  test('critical STALE (no critical DOWN) → YELLOW', () => {
    assert.strictEqual(rollup([{ status: 'STALE', critical: true }]), 'YELLOW');
  });
  test('non-critical DOWN caps at YELLOW (never RED)', () => {
    assert.strictEqual(rollup([{ status: 'DOWN', critical: false }, { status: 'OK', critical: true }]), 'YELLOW');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./system-health.mjs` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/system-health.mjs`:

```js
// src/system-health.mjs
// Pure system-health logic — no I/O. Single source of truth for the
// System Health dashboard, the 30-min monitor cron, and the on-demand endpoint.

/**
 * Classify one feed by the freshness of its blob's savedAt.
 * @param {number|null} savedAtMs  epoch ms of the blob's savedAt, or null if missing
 * @param {number} nowMs
 * @param {{expectedMaxAgeMin:number}} spec
 * @returns {'OK'|'STALE'|'DOWN'}
 */
export function classifyFeed(savedAtMs, nowMs, spec) {
  if (savedAtMs == null || !Number.isFinite(savedAtMs)) return 'DOWN';
  const ageMin = (nowMs - savedAtMs) / 60000;
  if (ageMin <= spec.expectedMaxAgeMin) return 'OK';
  if (ageMin <= spec.expectedMaxAgeMin * 2) return 'STALE';
  return 'DOWN';
}

/**
 * Roll feed statuses up to one overall banner colour.
 * Critical DOWN drives RED. Non-critical issues (and any STALE) cap at YELLOW.
 * @param {Array<{status:string,critical:boolean}>} feedStatuses
 * @returns {'GREEN'|'YELLOW'|'RED'}
 */
export function rollup(feedStatuses) {
  let anyCriticalDown = false;
  let anyYellow = false;
  for (const f of feedStatuses) {
    if (f.critical && f.status === 'DOWN') anyCriticalDown = true;
    else if (f.status === 'STALE' || f.status === 'DOWN') anyYellow = true;
  }
  if (anyCriticalDown) return 'RED';
  if (anyYellow) return 'YELLOW';
  return 'GREEN';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `classifyFeed` and `rollup` cases green.

- [ ] **Step 5: Commit**

```bash
git fetch && git merge --ff-only origin/main
git add src/system-health.mjs src/system-health.test.mjs
git commit -m "feat(system-health): pure classifyFeed + rollup with tests"
```

---

## Task 2: Per-store classification + alert diffing — `classifyPerStore` + `diffForAlerts`

**Files:**
- Modify: `src/system-health.mjs`
- Test: `src/system-health.test.mjs`

**Interfaces:**
- Consumes: `classifyFeed` from Task 1.
- Produces:
  - `classifyPerStore(perStoreSavedAt: {[pc:string]: number|null}, nowMs: number, spec: {expectedMaxAgeMin:number}, activePcs: string[]) → { status:'OK'|'STALE'|'DOWN', storesOk:number, storesTotal:number, staleStores: Array<{pc:string,status:string}> }`. All fresh → `OK`; some not-fresh → `STALE`; every store DOWN (or zero stores) → `DOWN`.
  - `diffForAlerts(prevSnapshot: {feeds:Array<{key,status}>}|null, nextSnapshot: {feeds:Array<{key,status,critical}>}) → Array<{key:string, from:string, to:string, critical:boolean}>`. Emits only status transitions (incl. recovery →OK); a feed unseen in prev is treated as `from:'OK'`.

- [ ] **Step 1: Write the failing test**

Append to `src/system-health.test.mjs`:

```js
import { classifyPerStore, diffForAlerts } from './system-health.mjs';

describe('classifyPerStore', () => {
  const spec = { expectedMaxAgeMin: 90 };
  const pcs = ['100', '200', '300'];
  test('all fresh → OK, storesOk = total, no stale', () => {
    const per = { '100': NOW, '200': NOW, '300': NOW };
    const r = classifyPerStore(per, NOW, spec, pcs);
    assert.strictEqual(r.status, 'OK');
    assert.strictEqual(r.storesOk, 3);
    assert.strictEqual(r.storesTotal, 3);
    assert.deepStrictEqual(r.staleStores, []);
  });
  test('one stale → STALE with that store listed', () => {
    const per = { '100': NOW, '200': NOW - 120 * MIN, '300': NOW };
    const r = classifyPerStore(per, NOW, spec, pcs);
    assert.strictEqual(r.status, 'STALE');
    assert.strictEqual(r.storesOk, 2);
    assert.deepStrictEqual(r.staleStores, [{ pc: '200', status: 'STALE' }]);
  });
  test('all missing → DOWN', () => {
    const per = { '100': null, '200': null, '300': null };
    const r = classifyPerStore(per, NOW, spec, pcs);
    assert.strictEqual(r.status, 'DOWN');
    assert.strictEqual(r.storesOk, 0);
  });
  test('zero active stores → DOWN', () => {
    assert.strictEqual(classifyPerStore({}, NOW, spec, []).status, 'DOWN');
  });
});

describe('diffForAlerts', () => {
  const next = { feeds: [
    { key: 'labor', status: 'DOWN', critical: true },
    { key: 'reviews', status: 'OK', critical: false },
  ] };
  test('OK→DOWN emits a critical transition', () => {
    const prev = { feeds: [{ key: 'labor', status: 'OK' }, { key: 'reviews', status: 'OK' }] };
    assert.deepStrictEqual(diffForAlerts(prev, next), [{ key: 'labor', from: 'OK', to: 'DOWN', critical: true }]);
  });
  test('STALE→STALE emits nothing', () => {
    const prev = { feeds: [{ key: 'labor', status: 'STALE' }] };
    const nx = { feeds: [{ key: 'labor', status: 'STALE', critical: true }] };
    assert.deepStrictEqual(diffForAlerts(prev, nx), []);
  });
  test('DOWN→OK emits a recovery transition', () => {
    const prev = { feeds: [{ key: 'labor', status: 'DOWN' }] };
    const nx = { feeds: [{ key: 'labor', status: 'OK', critical: true }] };
    assert.deepStrictEqual(diffForAlerts(prev, nx), [{ key: 'labor', from: 'DOWN', to: 'OK', critical: true }]);
  });
  test('new feed absent in prev treated as from OK', () => {
    const nx = { feeds: [{ key: 'newfeed', status: 'DOWN', critical: true }] };
    assert.deepStrictEqual(diffForAlerts(null, nx), [{ key: 'newfeed', from: 'OK', to: 'DOWN', critical: true }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `classifyPerStore`/`diffForAlerts` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/system-health.mjs`:

```js
/**
 * Classify a per-store feed across the active store set.
 * @param {{[pc:string]: number|null}} perStoreSavedAt  savedAt ms per store pc
 * @param {number} nowMs
 * @param {{expectedMaxAgeMin:number}} spec
 * @param {string[]} activePcs
 */
export function classifyPerStore(perStoreSavedAt, nowMs, spec, activePcs) {
  const staleStores = [];
  let storesOk = 0;
  let downCount = 0;
  const total = activePcs.length;
  for (const pc of activePcs) {
    const st = classifyFeed(perStoreSavedAt[pc] ?? null, nowMs, spec);
    if (st === 'OK') storesOk++;
    else {
      staleStores.push({ pc, status: st });
      if (st === 'DOWN') downCount++;
    }
  }
  let status;
  if (total === 0) status = 'DOWN';
  else if (storesOk === total) status = 'OK';
  else if (downCount === total) status = 'DOWN';
  else status = 'STALE';
  return { status, storesOk, storesTotal: total, staleStores };
}

/**
 * Diff two snapshots, returning only feeds whose status changed.
 * A feed missing from prev is treated as previously 'OK'.
 * @param {{feeds:Array<{key:string,status:string}>}|null} prevSnapshot
 * @param {{feeds:Array<{key:string,status:string,critical?:boolean}>}} nextSnapshot
 */
export function diffForAlerts(prevSnapshot, nextSnapshot) {
  const prevMap = {};
  for (const f of (prevSnapshot?.feeds || [])) prevMap[f.key] = f.status;
  const out = [];
  for (const f of (nextSnapshot?.feeds || [])) {
    const from = prevMap[f.key] ?? 'OK';
    if (from !== f.status) out.push({ key: f.key, from, to: f.status, critical: !!f.critical });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/system-health.mjs src/system-health.test.mjs
git commit -m "feat(system-health): classifyPerStore + diffForAlerts with tests"
```

---

## Task 3: FEEDS registry + `buildSnapshot` orchestration

**Files:**
- Modify: `src/system-health.mjs`
- Test: `src/system-health.test.mjs`

**Interfaces:**
- Consumes: `classifyFeed`, `classifyPerStore`, `rollup` from Tasks 1–2.
- Produces:
  - `FEEDS: Array<{ key, label, blobKey, expectedMaxAgeMin, perStore, critical, category }>`. For `perStore:true`, `blobKey` is a **prefix** to which the store `pc` is appended (e.g. `'pcg_labor_store_'` + `'339616'`).
  - `buildSnapshot({ readSavedAt: (key:string)=>Promise<number|null>, activePcs?: string[], nowMs: number, beats?: {[key:string]: {ok:boolean,error:string|null,durationMs:number|null,at:string}} }) → Promise<{ overall:'GREEN'|'YELLOW'|'RED', feeds: Array<object>, asOf:number }>`. Each feed entry carries `{ key, label, category, critical, perStore, status, ... }` plus `savedAt` (network feeds) or `storesOk/storesTotal/staleStores` (per-store feeds), and `beat` when a matching heartbeat exists. A blob read that throws is isolated per-feed → that feed becomes `DOWN` with an `error` string; the whole snapshot never crashes.

**Registry note:** these 11 feeds cover the critical money/ops pipeline plus the highest-value non-critical feeds, each mapped to a **stable** blob key confirmed to exist in the codebase. Crons whose only output is date-keyed with no stable `*_last_run` marker (reconciliation, kb-sync, ndcp, deal-alerts) are intentionally deferred to incremental heartbeat coverage (Task 8 and beyond) per the spec's "instrumenting all 27 crons is out of scope." Expanding the registry later is additive — append entries, no logic change.

- [ ] **Step 1: Write the failing test**

Append to `src/system-health.test.mjs`:

```js
import { FEEDS, buildSnapshot } from './system-health.mjs';

describe('FEEDS registry sanity', () => {
  test('every entry has the required fields', () => {
    for (const f of FEEDS) {
      assert.ok(f.key && typeof f.key === 'string', `key on ${JSON.stringify(f)}`);
      assert.ok(f.label && typeof f.label === 'string', `label on ${f.key}`);
      assert.ok(f.blobKey && typeof f.blobKey === 'string', `blobKey on ${f.key}`);
      assert.ok(Number.isFinite(f.expectedMaxAgeMin) && f.expectedMaxAgeMin > 0, `expectedMaxAgeMin on ${f.key}`);
      assert.strictEqual(typeof f.perStore, 'boolean', `perStore on ${f.key}`);
      assert.strictEqual(typeof f.critical, 'boolean', `critical on ${f.key}`);
      assert.ok(f.category && typeof f.category === 'string', `category on ${f.key}`);
    }
  });
  test('feed keys are unique', () => {
    const keys = FEEDS.map(f => f.key);
    assert.strictEqual(new Set(keys).size, keys.length);
  });
});

describe('buildSnapshot', () => {
  const NOW2 = 2_000_000_000_000;
  const pcs = ['100', '200'];
  test('all feeds fresh → GREEN', async () => {
    const readSavedAt = async () => NOW2; // every blob fresh
    const snap = await buildSnapshot({ readSavedAt, activePcs: pcs, nowMs: NOW2, beats: {} });
    assert.strictEqual(snap.overall, 'GREEN');
    assert.strictEqual(snap.asOf, NOW2);
    assert.strictEqual(snap.feeds.length, FEEDS.length);
  });
  test('a critical blob missing (null) → that feed DOWN → RED', async () => {
    const laborSpec = FEEDS.find(f => f.critical && !f.perStore);
    const readSavedAt = async (key) => (key === laborSpec.blobKey ? null : NOW2);
    const snap = await buildSnapshot({ readSavedAt, activePcs: pcs, nowMs: NOW2, beats: {} });
    const feed = snap.feeds.find(f => f.key === laborSpec.key);
    assert.strictEqual(feed.status, 'DOWN');
    assert.strictEqual(snap.overall, 'RED');
  });
  test('a throwing blob read is isolated → that feed DOWN with error, others fine', async () => {
    const target = FEEDS[0];
    const readSavedAt = async (key) => { if (key.startsWith(target.blobKey)) throw new Error('boom'); return NOW2; };
    const snap = await buildSnapshot({ readSavedAt, activePcs: pcs, nowMs: NOW2, beats: {} });
    const feed = snap.feeds.find(f => f.key === target.key);
    assert.strictEqual(feed.status, 'DOWN');
    assert.match(feed.error, /boom/);
  });
  test('a heartbeat with ok:false downgrades an otherwise-OK feed to STALE', async () => {
    const target = FEEDS[0];
    const readSavedAt = async () => NOW2;
    const beats = { [target.key]: { ok: false, error: 'token expired', durationMs: 12, at: 'x' } };
    const snap = await buildSnapshot({ readSavedAt, activePcs: pcs, nowMs: NOW2, beats });
    const feed = snap.feeds.find(f => f.key === target.key);
    assert.strictEqual(feed.status, 'STALE');
    assert.strictEqual(feed.error, 'token expired');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `FEEDS` and `buildSnapshot` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/system-health.mjs`. Blob keys and cadences are copied from the real crons (`labor-cron.mjs`, `pulse-notify.mjs`, `pulse-hourly-snapshot.mjs`, `tips-report-cron-background.mjs`, `reviews-cron.mjs`, `weather-forecast-cron.mjs`, `analyst-cron.mjs`) and `netlify.toml` schedules; `expectedMaxAgeMin` = cadence × tolerance.

```js
// ── FEEDS registry ────────────────────────────────────────────────────────
// expectedMaxAgeMin derives from each cron's schedule with a tolerance multiple.
export const FEEDS = [
  // Sales
  { key: 'pulse-sales', label: 'Pulse Sales (daily notify)', blobKey: 'pcg_pulse_notify_last_run',
    expectedMaxAgeMin: 1560, perStore: false, critical: true, category: 'Sales' }, // daily 9pm ET, 26h tol
  { key: 'pulse-hourly', label: 'Pulse Hourly Snapshot', blobKey: 'pcg_hourly_history_',
    expectedMaxAgeMin: 1560, perStore: true, critical: true, category: 'Sales' }, // daily snapshot per store
  // Labor
  { key: 'labor', label: 'Labor (network)', blobKey: 'pcg_labor_v1',
    expectedMaxAgeMin: 90, perStore: false, critical: true, category: 'Labor' }, // hourly 9-23 ET, 90m tol
  { key: 'labor-store', label: 'Labor (per-store history)', blobKey: 'pcg_labor_store_',
    expectedMaxAgeMin: 90, perStore: true, critical: true, category: 'Labor' },
  { key: 'schedule-alerts', label: 'Labor Schedule Alerts', blobKey: 'pcg_schedule_alerts_v1',
    expectedMaxAgeMin: 5760, perStore: false, critical: false, category: 'Labor' }, // Mon/Thu, 4d tol
  // Cash
  { key: 'tips', label: 'Tips Report', blobKey: 'pcg_tips_report_last_run',
    expectedMaxAgeMin: 1680, perStore: false, critical: true, category: 'Cash' }, // daily 7am ET, 28h tol
  { key: 'pnl-live', label: 'P&L (live)', blobKey: 'pcg_pnl_live_v1',
    expectedMaxAgeMin: 1560, perStore: false, critical: true, category: 'Cash' }, // written by labor-cron
  { key: 'pnl-store', label: 'P&L (per-store)', blobKey: 'pcg_pnl_store_',
    expectedMaxAgeMin: 1560, perStore: true, critical: true, category: 'Cash' },
  // Comms / AI / Platform (non-critical)
  { key: 'reviews', label: 'Google Reviews', blobKey: 'pcg_reviews_network',
    expectedMaxAgeMin: 11520, perStore: false, critical: false, category: 'Comms' }, // weekly, 8d tol
  { key: 'analyst', label: 'Orion Analyst (DM scorecard)', blobKey: 'pcg_dm_scorecard',
    expectedMaxAgeMin: 1560, perStore: false, critical: false, category: 'AI' }, // twice daily
  { key: 'weather', label: 'Weather Forecast', blobKey: 'pcg_weather_forecast',
    expectedMaxAgeMin: 1560, perStore: false, critical: false, category: 'Platform' }, // daily 8am ET
];

/**
 * Build a full snapshot by reading each feed's blob freshness via an injected
 * async reader (kept injectable so this stays pure and unit-testable).
 * @param {{ readSavedAt:(key:string)=>Promise<number|null>, activePcs?:string[], nowMs:number, beats?:object }} args
 */
export async function buildSnapshot({ readSavedAt, activePcs = [], nowMs, beats = {} }) {
  const feeds = [];
  for (const spec of FEEDS) {
    let entry;
    try {
      if (spec.perStore) {
        const perStoreSavedAt = {};
        for (const pc of activePcs) perStoreSavedAt[pc] = await readSavedAt(spec.blobKey + pc);
        const r = classifyPerStore(perStoreSavedAt, nowMs, spec, activePcs);
        entry = { key: spec.key, label: spec.label, category: spec.category, critical: spec.critical, perStore: true, ...r };
      } else {
        const savedAt = await readSavedAt(spec.blobKey);
        entry = { key: spec.key, label: spec.label, category: spec.category, critical: spec.critical, perStore: false,
          status: classifyFeed(savedAt, nowMs, spec), savedAt };
      }
    } catch (e) {
      entry = { key: spec.key, label: spec.label, category: spec.category, critical: spec.critical,
        perStore: !!spec.perStore, status: 'DOWN', error: String(e?.message || e) };
    }
    const b = beats[spec.key];
    if (b) {
      entry.beat = b;
      if (b.ok === false && entry.status === 'OK') entry.status = 'STALE';
      entry.error = entry.error || b.error || null;
    }
    feeds.push(entry);
  }
  const overall = rollup(feeds.map(f => ({ status: f.status, critical: f.critical })));
  return { overall, feeds, asOf: nowMs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — registry sanity + all `buildSnapshot` cases green. `src/system-health.mjs` is now feature-complete and fully unit-tested.

- [ ] **Step 5: Commit**

```bash
git add src/system-health.mjs src/system-health.test.mjs
git commit -m "feat(system-health): FEEDS registry + buildSnapshot orchestration with tests"
```

---

## Task 4: Heartbeat helper — `record-health.mjs`

**Files:**
- Create: `netlify/functions/health-lib/record-health.mjs`

**Interfaces:**
- Produces: `recordHealth(name: string, opts?: { ok?: boolean, error?: any, durationMs?: number|null }) → Promise<void>`. Merges one entry `{ ok, error, durationMs, at }` into the `pcg_system_health_beats_v1` map keyed by `name` (which must match a `FEEDS[].key`). **Never throws** — a heartbeat failure must not break the caller cron.

- [ ] **Step 1: Write the implementation**

Create `netlify/functions/health-lib/record-health.mjs`:

```js
// netlify/functions/health-lib/record-health.mjs
// Additive heartbeat helper. Key crons call recordHealth() so the monitor can
// enrich the matching feed with last-error text + run duration. Best-effort:
// any failure here is swallowed so it never breaks the calling cron.
import { getStore } from '@netlify/blobs';

const BEATS_KEY = 'pcg_system_health_beats_v1';

export async function recordHealth(name, { ok = true, error = null, durationMs = null } = {}) {
  try {
    const store = getStore({
      name: 'pcg-portal', consistency: 'strong',
      siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN,
    });
    const raw = await store.get(BEATS_KEY, { type: 'json' });
    const beats = (raw && raw.data) ? raw.data : {};
    beats[name] = {
      ok: !!ok,
      error: error ? String(error?.message || error) : null,
      durationMs: durationMs == null ? null : Number(durationMs),
      at: new Date().toISOString(),
    };
    await store.setJSON(BEATS_KEY, { savedAt: new Date().toISOString(), data: beats });
  } catch {
    /* heartbeat must never throw into the caller */
  }
}
```

- [ ] **Step 2: Verify the module parses**

Run: `node --check netlify/functions/health-lib/record-health.mjs`
Expected: no output, exit 0 (syntax OK). _(This is an I/O helper against live Netlify Blobs — it is exercised for real in Task 8 and manual verification, not unit-tested.)_

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/health-lib/record-health.mjs
git commit -m "feat(system-health): recordHealth heartbeat helper"
```

---

## Task 5: Scheduled monitor — `system-health-cron.mjs` + `netlify.toml`

**Files:**
- Create: `netlify/functions/system-health-cron.mjs`
- Modify: `netlify.toml` (add `[functions.system-health-cron]`)

**Interfaces:**
- Consumes: `buildSnapshot`, `diffForAlerts`, `FEEDS` from `../../src/system-health.mjs`; `sql` from `./_shared/db.mjs`.
- Produces: writes `pcg_system_health_v1` (`{ overall, feeds, asOf }`) and `pcg_system_health_alerts_v1` (`{ lastAlerted: {[key]: ms}, events: [...] }`). Sends push+email for critical transitions and for still-not-OK critical feeds whose last alert is older than `REALERT_HOURS` (6h). Returns `new Response(JSON.stringify({ ok, overall, alerted }))`.

**Shared patterns used (verbatim from the codebase):** blob store handle (Global Constraints); `sendPush`/`sendEmail` helpers copied from `deal-alerts-cron.mjs:52-102`; `export const config = { schedule }` per `deal-alerts-cron.mjs:16`; active PCs discovered via `store.list({ prefix: 'pcg_labor_store_' })` (avoids duplicating the 45-store array).

- [ ] **Step 1: Write the implementation**

Create `netlify/functions/system-health-cron.mjs`:

```js
// netlify/functions/system-health-cron.mjs
// Every 30 min: classify all FEEDS by blob freshness, diff vs the previous
// snapshot, push+email critical transitions (6h re-alert guard), and persist.
import https from 'node:https';
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { sql } from './_shared/db.mjs';
import { buildSnapshot, diffForAlerts } from '../../src/system-health.mjs';

export const config = { schedule: '*/30 * * * *' };

const SNAPSHOT_KEY = 'pcg_system_health_v1';
const ALERTS_KEY = 'pcg_system_health_alerts_v1';
const BEATS_KEY = 'pcg_system_health_beats_v1';
const REALERT_MS = 6 * 60 * 60 * 1000;

function healthStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

// ── recipient lookup: all active exec/IT users (id for push, email for email) ──
async function recipients(db) {
  try {
    const rows = await db`SELECT id, email FROM users WHERE user_type IN ('executive','it') AND active = true`;
    return { pushIds: rows.map(r => String(r.id)), emails: rows.map(r => r.email).filter(Boolean) };
  } catch { return { pushIds: [], emails: [] }; }
}

// ── email via Resend (copied from deal-alerts-cron.mjs:52-64) ──
function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const key = process.env.RESEND_API_KEY;
    if (!key || !to.length) return resolve(false);
    const payload = JSON.stringify({ from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>', to, subject, html });
    const req = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('error', () => resolve(false)); req.write(payload); req.end();
  });
}

// ── web push (copied from deal-alerts-cron.mjs:89-102) ──
async function sendPush(pushIds, title, body, tag) {
  if (!pushIds.length) return { sent: 0 };
  const vpub = process.env.VAPID_PUBLIC_KEY, vpriv = process.env.VAPID_PRIVATE_KEY;
  if (!vpub || !vpriv) return { sent: 0 };
  const store = healthStore();
  const w = await store.get('pcg_push_subscriptions_v1', { type: 'json' });
  const subs = (w && w.data) ? w.data : {};
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:${process.env.VAPID_EMAIL || 'noreply@pcgops.com'}`, vpub, vpriv);
  const payload = JSON.stringify({ title, body: body || '', icon: '/apple-touch-icon.png', url: '/', tag: tag || undefined });
  let sent = 0;
  for (const uid of pushIds) for (const sub of (subs[String(uid)] || [])) {
    try { await webpush.sendNotification(sub, payload); sent++; } catch { /* expired sub, ignore */ }
  }
  return { sent };
}

export default async (request) => {
  const nowMs = Date.now();
  const store = healthStore();

  // Discover active store pcs from the per-store labor blobs (no hardcoded list).
  let activePcs = [];
  try {
    const { blobs } = await store.list({ prefix: 'pcg_labor_store_' });
    activePcs = blobs.map(b => b.key.replace('pcg_labor_store_', ''));
  } catch { activePcs = []; }

  // Injected reader: returns savedAt epoch ms or null (missing/error).
  const readSavedAt = async (key) => {
    try {
      const raw = await store.get(key, { type: 'json' });
      if (!raw || !raw.savedAt) return null;
      const ms = Date.parse(raw.savedAt);
      return Number.isFinite(ms) ? ms : null;
    } catch { return null; }
  };

  // Heartbeats (best-effort enrichment).
  let beats = {};
  try { const raw = await store.get(BEATS_KEY, { type: 'json' }); beats = (raw && raw.data) ? raw.data : {}; } catch {}

  // Previous snapshot for diffing.
  let prev = null;
  try { const raw = await store.get(SNAPSHOT_KEY, { type: 'json' }); prev = (raw && raw.data) ? raw.data : null; } catch {}

  const snapshot = await buildSnapshot({ readSavedAt, activePcs, nowMs, beats });

  // Alert log { lastAlerted:{key:ms}, events:[...] }.
  let log = { lastAlerted: {}, events: [] };
  try { const raw = await store.get(ALERTS_KEY, { type: 'json' }); if (raw && raw.data) log = { lastAlerted: raw.data.lastAlerted || {}, events: raw.data.events || [] }; } catch {}

  // Transitions to alert on: critical status changes...
  const transitions = diffForAlerts(prev, snapshot).filter(t => t.critical);
  const alertKeys = new Map(transitions.map(t => [t.key, t]));
  // ...plus still-not-OK critical feeds whose last alert is older than the guard.
  for (const f of snapshot.feeds) {
    if (f.critical && f.status !== 'OK' && !alertKeys.has(f.key)) {
      const last = log.lastAlerted[f.key] || 0;
      if (nowMs - last >= REALERT_MS) alertKeys.set(f.key, { key: f.key, from: f.status, to: f.status, critical: true });
    }
  }

  let alerted = 0;
  if (alertKeys.size) {
    const db = sql();
    const { pushIds, emails } = await recipients(db);
    for (const t of alertKeys.values()) {
      const feed = snapshot.feeds.find(f => f.key === t.key) || {};
      const recovered = t.to === 'OK';
      const title = recovered ? `✅ System Health: ${feed.label} recovered` : `⚠️ System Health: ${feed.label} ${t.to}`;
      const detail = feed.error ? ` — ${feed.error}` : '';
      const body = recovered ? `${feed.label} is OK again.` : `${feed.label} is ${t.to}${detail}.`;
      try { await sendPush(pushIds, title, body, 'system_health'); } catch {}
      try { await sendEmail(emails, title, `<p>${body}</p><p>As of ${new Date(nowMs).toISOString()}.</p>`); } catch {}
      log.lastAlerted[t.key] = recovered ? 0 : nowMs; // reset guard on recovery
      log.events.unshift({ key: t.key, from: t.from, to: t.to, at: new Date(nowMs).toISOString() });
      alerted++;
    }
    log.events = log.events.slice(0, 200);
  }

  // Persist snapshot + alert log (alerting failures never block these writes).
  await store.setJSON(SNAPSHOT_KEY, { savedAt: new Date().toISOString(), data: snapshot });
  await store.setJSON(ALERTS_KEY, { savedAt: new Date().toISOString(), data: log });

  return new Response(JSON.stringify({ ok: true, overall: snapshot.overall, alerted }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
```

- [ ] **Step 2: Verify the module parses**

Run: `node --check netlify/functions/system-health-cron.mjs`
Expected: exit 0.

- [ ] **Step 3: Add the schedule to `netlify.toml`**

Add this block alongside the other `[functions.*]` schedule blocks (e.g. after the `pulse-compare-cron` block, ~line 52):

```toml
[functions.system-health-cron]
  schedule = "*/30 * * * *"
```

- [ ] **Step 4: Verify `netlify.toml` still parses**

Run: `node -e "require('fs').readFileSync('netlify.toml','utf8'); console.log('toml read ok')"`
Expected: `toml read ok` (sanity that the file is intact; Netlify validates the schedule on deploy).

- [ ] **Step 5: Run the full test suite (guards the imported pure module)**

Run: `npm test`
Expected: PASS — no regressions in `src/system-health.test.mjs`.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/system-health-cron.mjs netlify.toml
git commit -m "feat(system-health): 30-min monitor cron + schedule"
```

---

## Task 6: On-demand endpoint — `system-health.mjs` (exec/IT only)

**Files:**
- Create: `netlify/functions/system-health.mjs`

**Interfaces:**
- Consumes: `buildSnapshot` from `../../src/system-health.mjs`; `resolveCaller` from `./_shared/auth.mjs`; `sql` from `./_shared/db.mjs`; `sessionGate` from `./auth-lib/require-user.js`.
- Produces: `POST { action:'refresh', userId }` → `{ ok:true, snapshot }` recomputed live (no alerting, no persistence). Rejects non-exec/IT with 403. Also serves `action:'get'` → returns the persisted `pcg_system_health_v1` (cheap read) for parity, though the client normally uses `cloudLoad` for that.

**Shared patterns (verbatim):** CORS `headers` + `json()` helper and the OPTIONS/405 + `resolveCaller`/`sessionGate` exec gate from `analyst.mjs:22-95`.

- [ ] **Step 1: Write the implementation**

Create `netlify/functions/system-health.mjs`:

```js
// netlify/functions/system-health.mjs
// On-demand System Health recompute for the dashboard's "Refresh now".
// Exec/IT only (server-enforced). Same buildSnapshot as the cron, minus alerting.
import { getStore } from '@netlify/blobs';
import { buildSnapshot } from '../../src/system-health.mjs';
import { resolveCaller } from './_shared/auth.mjs';
import { sql } from './_shared/db.mjs';
import { sessionGate } from './auth-lib/require-user.js';

const EXEC_ROLES = new Set(['executive', 'it']);
const SNAPSHOT_KEY = 'pcg_system_health_v1';
const BEATS_KEY = 'pcg_system_health_beats_v1';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
function json(status, body) { return new Response(JSON.stringify(body), { status, headers }); }

function healthStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return json(405, { error: 'POST only' });

  const payload = await request.json().catch(() => ({}));
  const { action = 'refresh', userId, userRole } = payload;

  // Auth gate (mirrors analyst.mjs): revoked session → 401; non-exec/IT → 403.
  const eventShim = { headers: { authorization: request.headers.get('authorization') || '', cookie: request.headers.get('cookie') || '' } };
  if (await sessionGate(eventShim, sql()) === 'revoked') return json(401, { error: 'Session ended. Please sign in again.' });
  const caller = await resolveCaller(userId);
  const effRole = caller?.role || userRole;
  if (!EXEC_ROLES.has(effRole)) return json(403, { error: 'This information is limited to Exec/IT.' });

  const store = healthStore();

  if (action === 'get') {
    try { const raw = await store.get(SNAPSHOT_KEY, { type: 'json' }); return json(200, { ok: true, snapshot: (raw && raw.data) || null }); }
    catch { return json(200, { ok: true, snapshot: null }); }
  }

  // action === 'refresh' → live recompute.
  const nowMs = Date.now();
  let activePcs = [];
  try { const { blobs } = await store.list({ prefix: 'pcg_labor_store_' }); activePcs = blobs.map(b => b.key.replace('pcg_labor_store_', '')); } catch {}
  const readSavedAt = async (key) => {
    try { const raw = await store.get(key, { type: 'json' }); if (!raw || !raw.savedAt) return null; const ms = Date.parse(raw.savedAt); return Number.isFinite(ms) ? ms : null; } catch { return null; }
  };
  let beats = {};
  try { const raw = await store.get(BEATS_KEY, { type: 'json' }); beats = (raw && raw.data) ? raw.data : {}; } catch {}

  const snapshot = await buildSnapshot({ readSavedAt, activePcs, nowMs, beats });
  return json(200, { ok: true, snapshot });
};
```

- [ ] **Step 2: Verify the module parses**

Run: `node --check netlify/functions/system-health.mjs`
Expected: exit 0.

- [ ] **Step 3: Confirm the auth import path exists**

Run: `ls netlify/functions/auth-lib/require-user.js netlify/functions/_shared/auth.mjs`
Expected: both paths listed (imports resolve).

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/system-health.mjs
git commit -m "feat(system-health): exec/IT-gated on-demand recompute endpoint"
```

---

## Task 7: Frontend — `SystemHealth` tab in `app.jsx`

**Files:**
- Modify: `app.jsx` (component + `system-hub` tile + route + mobile subtitle + `APP_VERSION`)
- Regenerate: `app.js` (via `npm run build`)

**Interfaces:**
- Consumes: `pcg_system_health_v1` via `cloudLoad(key)` (returns unwrapped `data`, or `null`); the on-demand endpoint via a local `systemHealthApi` helper (copies `auditsApi`: `credentials:"include"` + `...authHeader()`). Component signature: `SystemHealth({ th, user })`. Renders the `{ overall, feeds, asOf }` snapshot shape produced by `buildSnapshot`.
- Surfaced as a tile in the existing `system-hub` (no new sidebar hub → `ADMIN_GROUPS` untouched), gated `isFullAdmin(user)`.

**Anchor lines (from current `app.jsx`, verify before editing — file is edited often):** `APP_VERSION` at ~26340; `system-hub` `sysTiles` at ~49313–49321; route lines near ~49330; mobile section subtitles ~48889–48915; `isFullAdmin` helper at ~25038.

- [ ] **Step 1: Add the `SystemHealth` component**

Insert this component near the other admin tab components (e.g. just before `AuditsTab`). It reads the snapshot, groups feeds by `category`, and renders the Green/Yellow/Red banner + per-category cards using the existing theme helpers (`th`, `card`, `btn`) and inline styles:

```jsx
function SystemHealth({ th, user }) {
  const [snap, setSnap] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    const d = await cloudLoad('pcg_system_health_v1');
    setSnap(d || null);
    setLoading(false);
  }, []);
  React.useEffect(() => { load(); }, [load]);

  const refreshNow = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/.netlify/functions/system-health', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ action: 'refresh', userId: user?.id, userRole: user?.userType }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.snapshot) setSnap(j.snapshot);
    } finally { setRefreshing(false); }
  };

  const BANNER = { GREEN: { bg: '#1B8F5C', label: 'All systems healthy' }, YELLOW: { bg: '#C9922B', label: 'Degraded — non-critical or stale feeds' }, RED: { bg: '#C0392B', label: 'Critical outage' } };
  const PILL = { OK: '#1B8F5C', STALE: '#C9922B', DOWN: '#C0392B' };
  const rel = (ms) => {
    if (!ms) return '—';
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
  };

  if (loading) return <div style={{ ...card(th), padding: '2rem', textAlign: 'center', color: th.muted, maxWidth: 1100, margin: '0 auto' }}>Loading…</div>;
  if (!snap) return <div style={{ ...card(th), padding: '2rem', textAlign: 'center', color: th.muted, maxWidth: 1100, margin: '0 auto' }}>System Health is initializing — the first snapshot appears after the monitor runs (within 30 minutes).</div>;

  const counts = snap.feeds.reduce((a, f) => { a[f.status] = (a[f.status] || 0) + 1; return a; }, {});
  const cats = [...new Set(snap.feeds.map(f => f.category))];
  const b = BANNER[snap.overall] || BANNER.YELLOW;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 0 2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ ...card(th), flex: 1, minWidth: 260, padding: '1rem 1.25rem', background: b.bg, color: '#fff', border: 'none' }}>
          <div style={{ fontWeight: 800, fontSize: '1.15rem' }}>{b.label}</div>
          <div style={{ opacity: 0.9, fontSize: '.85rem', marginTop: 4 }}>
            {counts.OK || 0} OK · {counts.STALE || 0} stale · {counts.DOWN || 0} down · updated {rel(snap.asOf)}
          </div>
        </div>
        <button onClick={refreshNow} disabled={refreshing} style={{ ...btn(th), minHeight: 42 }}>
          {refreshing ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>

      {cats.map(cat => (
        <div key={cat} style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 700, color: th.muted, textTransform: 'uppercase', fontSize: '.75rem', letterSpacing: '.05em', margin: '0 0 8px 2px' }}>{cat}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {snap.feeds.filter(f => f.category === cat).map(f => (
              <div key={f.key} style={{ ...card(th), padding: '0.9rem 1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, color: th.text }}>{f.label}</span>
                  <span style={{ background: PILL[f.status] || th.muted, color: '#fff', borderRadius: 999, padding: '2px 10px', fontSize: '.72rem', fontWeight: 700 }}>{f.status}</span>
                </div>
                <div style={{ color: th.muted, fontSize: '.8rem', marginTop: 6 }}>
                  {f.perStore
                    ? <span>{f.storesOk}/{f.storesTotal} stores{f.staleStores && f.staleStores.length ? ` · stale: ${f.staleStores.map(s => s.pc).join(', ')}` : ''}</span>
                    : <span>updated {rel(f.savedAt)}</span>}
                  {f.critical ? <span style={{ marginLeft: 8, color: '#C0392B', fontWeight: 700 }}>critical</span> : null}
                </div>
                {f.error ? <div style={{ color: '#C0392B', fontSize: '.75rem', marginTop: 6 }}>{f.error}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Add the tile to `system-hub`**

In the `system-hub` `sysTiles` array (~line 49315), add an entry alongside `admin`/`email`/`reports`:

```jsx
{ id: 'system-health', name: 'System Health', sub: 'Feed freshness, cron monitoring, and outage alerts.', show: isFullAdmin(user) && accessSubOn(accessOverrides, user?.userType, 'system-hub', 'system-health'), icon: <>{ICONS.folder(SYS)}</> },
```

- [ ] **Step 3: Add the route**

Near the other admin route lines (~line 49330), add:

```jsx
{tab === "system-health" && isFullAdmin(user) && <SystemHealth th={th} user={user} />}
```

- [ ] **Step 4: Add the mobile section subtitle**

In the mobile subtitle block (~line 48906, next to `{tab === "system-hub" && ...}`), add:

```jsx
{tab === "system-health" && "Pipeline health, feed freshness, and outage alerts."}
```

- [ ] **Step 5: Bump `APP_VERSION`**

Change the `APP_VERSION` constant (~line 26340) — bump the minor:

```jsx
const APP_VERSION = "v20.49";
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: esbuild writes `app.js` with no errors (exit 0).

- [ ] **Step 7: Verify the build wired the component**

Run: `grep -c "SystemHealth" app.js`
Expected: a count ≥ 2 (the component definition + the route reference made it into the bundle).

- [ ] **Step 8: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(system-health): dashboard tab under system-hub (v20.49)"
```

---

## Task 8: Heartbeat instrumentation of key crons + Paycor

**Files:**
- Modify: `netlify/functions/labor-cron.mjs`
- Modify: `netlify/functions/pulse-notify.mjs`
- Modify: `netlify/functions/tips-report-cron-background.mjs`
- Modify: `netlify/functions/paycor.mjs`

**Interfaces:**
- Consumes: `recordHealth` from `./health-lib/record-health.mjs` (Task 4). The `name` passed **must equal the matching `FEEDS[].key`** so `buildSnapshot` merges the beat onto the right feed: `labor` → `'labor'`, `pulse-notify` → `'pulse-sales'`, tips → `'tips'`, Paycor refresh failure → `'labor'` (Paycor backs the labor feed).
- Additive only — no behavior change to the crons beyond one best-effort call.

**Note:** `recordHealth` never throws, so these calls are safe to add at the end of a successful run and in the catch/failure path. This task covers only the four highest-value instrumentation points; the freshness layer already covers every feed without beats. Line numbers are approximate — locate the function's final `return`/success point and its Paycor-refresh error path.

- [ ] **Step 1: Instrument `labor-cron.mjs`**

Add the import at the top with the other imports:

```js
import { recordHealth } from './health-lib/record-health.mjs';
```

Wrap the run outcome. At the successful end of the handler (just before the final `return new Response(...)`), add:

```js
await recordHealth('labor', { ok: true, durationMs: Date.now() - startMs });
```

If the handler has no `startMs`, add `const startMs = Date.now();` at the top of the handler. In the handler's top-level `catch` (if present), add before rethrowing/returning the error:

```js
await recordHealth('labor', { ok: false, error: err });
```

- [ ] **Step 2: Instrument `pulse-notify.mjs`**

Add the import:

```js
import { recordHealth } from './health-lib/record-health.mjs';
```

At the successful end (after the run writes `pcg_pulse_notify_last_run`), add:

```js
await recordHealth('pulse-sales', { ok: true });
```

In the failure path (top-level catch), add:

```js
await recordHealth('pulse-sales', { ok: false, error: err });
```

- [ ] **Step 3: Instrument `tips-report-cron-background.mjs`**

Add the import:

```js
import { recordHealth } from './health-lib/record-health.mjs';
```

At the successful end (after writing `pcg_tips_report_last_run`), add:

```js
await recordHealth('tips', { ok: true });
```

In the failure path, add:

```js
await recordHealth('tips', { ok: false, error: err });
```

- [ ] **Step 4: Instrument `paycor.mjs` refresh failure**

Add the import:

```js
import { recordHealth } from './health-lib/record-health.mjs';
```

In the token-refresh error path (where a failed refresh is caught — the exact failure the whole feature exists to surface), add:

```js
await recordHealth('labor', { ok: false, error: `Paycor token refresh failed: ${err?.message || err}` });
```

- [ ] **Step 5: Verify all four modules parse**

Run: `node --check netlify/functions/labor-cron.mjs && node --check netlify/functions/pulse-notify.mjs && node --check netlify/functions/tips-report-cron-background.mjs && node --check netlify/functions/paycor.mjs`
Expected: exit 0 for all four.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/labor-cron.mjs netlify/functions/pulse-notify.mjs netlify/functions/tips-report-cron-background.mjs netlify/functions/paycor.mjs
git commit -m "feat(system-health): heartbeat instrumentation for labor/pulse/tips/paycor"
```

---

## Manual Verification (after deploy)

Per the spec's manual-verification checklist — run once the branch is deployed (Mike deploys):

1. **Dashboard renders:** log in as exec/IT → System (hub) → System Health. Confirm the Green/Yellow/Red banner, the `N OK / M stale / K down` counts, and per-category cards.
2. **Known-fresh feeds show OK:** `labor` and `pulse-sales` should be `OK` shortly after their crons run.
3. **Deliberate stale check:** a monthly feed (e.g. `pnl-live` mid-cycle) or the weekly `reviews` should show the expected age-based status, not a false `DOWN`.
4. **Per-store chip:** a per-store feed (`labor-store`) shows `X/Y stores`; if any store is behind, its `pc` appears in the stale list.
5. **On-demand endpoint:** click **Refresh now** → the snapshot updates live (network tab shows a 200 from `/.netlify/functions/system-health`); confirm a non-exec/IT session gets 403.
6. **Cron:** confirm `system-health-cron` appears in Netlify's scheduled functions and that `pcg_system_health_v1` updates within 30 min. To rehearse alerting, temporarily lower a critical feed's `expectedMaxAgeMin` or point its `blobKey` at a missing key on a branch, and confirm a push+email fires and the alert log records it (revert after).

---

## Self-Review

**1. Spec coverage:**
- FEEDS registry + `classifyFeed`/`classifyPerStore`/`rollup`/`diffForAlerts` → Tasks 1–3. ✅
- `expectedMaxAgeMin` from cadence × tolerance, per-store keys, `critical`, `category` → Task 3 registry. ✅
- 30-min cron: load blobs → classify → diff → push+email criticals to IT+exec → alert log → save snapshot → 6h re-alert guard → per-feed isolation → alert failures never block save → Task 5. ✅
- On-demand recompute, exec/IT server-enforced → Task 6. ✅
- Heartbeat layer `recordHealth` + enrichment (last error/duration) + dashboard works on freshness alone → Task 4 (helper), Task 3 (`buildSnapshot` merges beats), Task 8 (instrumentation). ✅
- Frontend tab, exec/IT, banner + counts, per-category cards, per-store chip w/ stale list, heartbeat error text, initializing state, inline-style/theme conventions → Task 7. ✅
- `netlify.toml` schedule `*/30 * * * *` → Task 5. ✅ · `APP_VERSION` bump → Task 7. ✅
- Sidebar gotcha: surfaced as a `system-hub` tile (no new hub) → `ADMIN_GROUPS` correctly untouched, avoiding the "getTabs alone isn't enough" trap → Task 7. ✅
- Error handling (missing blob → DOWN; per-feed try/catch; alert failure logged not fatal; dashboard renders whatever exists / "initializing") → Tasks 3, 5, 7. ✅
- Out-of-scope respected: only 4 crons instrumented (not all 27); no uptime charts/SLA; no auto-remediation. ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N"/"add error handling" — every code step contains complete code. Line-number anchors in Task 7/8 are marked "approximate, verify before editing" because `app.jsx` and the crons change frequently; the surrounding code snippets make the target unambiguous. ✅

**3. Type consistency:** `classifyFeed(savedAtMs, nowMs, spec)`, `rollup([{status,critical}])`, `classifyPerStore(perStoreSavedAt, nowMs, spec, activePcs)→{status,storesOk,storesTotal,staleStores}`, `diffForAlerts(prev,next)→[{key,from,to,critical}]`, `buildSnapshot({readSavedAt,activePcs,nowMs,beats})→{overall,feeds,asOf}` — used identically in cron (Task 5), endpoint (Task 6), and UI (Task 7). Blob keys `pcg_system_health_v1` / `_alerts_v1` / `_beats_v1` and `recordHealth` `name` values match `FEEDS[].key` (`labor`, `pulse-sales`, `tips`) across Tasks 3/5/8. ✅
