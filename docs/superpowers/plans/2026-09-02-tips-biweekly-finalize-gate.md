# Tips Biweekly Finalize Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the existing biweekly-payroll-boundary Tuesday trigger, automatically re-verify the entire just-closed 14-day pay period against live Paycor data, retry anything still broken, and record a real per-store "finalized" status — so an employee's late-entered Paycor punches can't be silently missed the way seven of them were this session.

**Architecture:** Extract the pure decision logic (what counts as "not finalized," which store/days still need retrying) into one new, fully unit-tested library file. Two already-shipped orchestration files (`tips-reconcile-cron.mjs`'s diff-based auto-heal, `tips-report-morning-sweep-background.mjs`'s error-retry) each get a small, behavior-preserving refactor to accept an explicit list of dates instead of always inferring "yesterday" / "last 3 days." The main nightly cron then calls both, computes finalize status, saves it, and emails a summary — all inside the `isBiweekBoundary` branch that already exists and already fires on the correct day.

**Tech Stack:** Node.js ES modules (`.mjs`), Netlify serverless functions, Netlify Blobs, Node's built-in test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-09-02-tips-biweekly-finalize-gate-design.md`

## Global Constraints

- No new Netlify function — this site's total env-var size sits near AWS Lambda's 4KB-per-function cap (documented in `tips-report-cron-background.mjs`'s own header comment); every function change in this plan modifies an existing file.
- No automatic send to Paycor. The manual "Send to Paycor" button and flow are completely untouched by this plan.
- No change to the manual-exclusion list, the manager-exclusion regex, or the per-day tip-split math (`hourlyRate = tipPool / totalCrewHours`).
- Every new piece of pure decision logic must be unit-tested with `node --test`; side-effecting orchestration (live Paycor calls, blob reads/writes, email) follows this codebase's existing convention of staying untested at that layer (there are no existing tests anywhere under `netlify/functions/*-cron*.mjs` or `*-background.mjs` — only extracted `-lib` helpers have test coverage).

---

### Task 1: Pure settle/finalize decision logic

**Files:**
- Create: `netlify/functions/tips-lib/period-settle.mjs`
- Create: `netlify/functions/tips-lib/period-settle.test.mjs`
- Modify: `package.json` (test script glob)

**Interfaces:**
- Consumes: nothing (pure functions, no imports from other project files)
- Produces:
  - `isZeroEligibleCrewWithTips(storeEntry): boolean`
  - `deriveWithheldSet(reconcileDetails: Array<{pc, busDt, change}>): Set<string>` (keys are `` `${pc}|${busDt}` ``)
  - `computeFinalizeStatuses(stores: Array<{pc, name}>, periodDates: string[], snapshotsByDate: Map<string, Array<{pc, crewStatus, crew, tipPool}>>, withheldSet: Set<string>): { [pc: string]: { finalized: boolean, unresolvedDays: Array<{busDt: string, reason: string}> } }`
  - `pickErrorEntries(dates: string[], snapshotByDate: Map<string, Array<{pc, crewStatus}>>): Array<{pc: string, busDt: string}>`
  - These are consumed by Task 2 (`pickErrorEntries`), Task 3 (`pickErrorEntries` again — same function, different caller), and Task 4 (`deriveWithheldSet`, `computeFinalizeStatuses`).

- [ ] **Step 1: Write the failing tests**

Create `netlify/functions/tips-lib/period-settle.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isZeroEligibleCrewWithTips,
  deriveWithheldSet,
  computeFinalizeStatuses,
  pickErrorEntries,
} from './period-settle.mjs';

test('isZeroEligibleCrewWithTips: true when crew is empty but real tips were collected', () => {
  assert.equal(isZeroEligibleCrewWithTips({ crewStatus: 'ok', crew: [], tipPool: 12.5 }), true);
});

test('isZeroEligibleCrewWithTips: false when crew has people', () => {
  assert.equal(isZeroEligibleCrewWithTips({ crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 12.5 }), false);
});

test('isZeroEligibleCrewWithTips: false when tipPool rounds to zero', () => {
  assert.equal(isZeroEligibleCrewWithTips({ crewStatus: 'ok', crew: [], tipPool: 0.001 }), false);
});

test('isZeroEligibleCrewWithTips: false when crewStatus is error (a different problem)', () => {
  assert.equal(isZeroEligibleCrewWithTips({ crewStatus: 'error', crew: [], tipPool: 12.5 }), false);
});

test('deriveWithheldSet: picks out only POSSIBLE DROP rows, keyed by pc|busDt', () => {
  const details = [
    { pc: '302642', busDt: '2026-08-23', change: 'added — 7.00h (was missing entirely)' },
    { pc: '310382', busDt: '2026-08-24', change: 'POSSIBLE DROP — missing from live fetch (was 5.00h saved); NOT auto-removed, needs manual review' },
    { pc: '310382', busDt: '2026-08-24', change: 'added — 3.00h (was missing entirely) — NOT APPLIED (withheld: a different employee looked dropped in this same fetch, see below)' },
  ];
  const set = deriveWithheldSet(details);
  assert.equal(set.size, 1);
  assert.equal(set.has('310382|2026-08-24'), true);
  assert.equal(set.has('302642|2026-08-23'), false);
});

test('deriveWithheldSet: empty input gives empty set', () => {
  assert.equal(deriveWithheldSet([]).size, 0);
  assert.equal(deriveWithheldSet(undefined).size, 0);
});

test('pickErrorEntries: finds crewStatus error entries across multiple dates', () => {
  const snapshotByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'ok' }, { pc: '200', crewStatus: 'error' }]],
    ['2026-08-17', [{ pc: '100', crewStatus: 'error' }, { pc: '200', crewStatus: 'ok' }]],
  ]);
  const result = pickErrorEntries(['2026-08-16', '2026-08-17'], snapshotByDate);
  assert.deepEqual(result, [
    { pc: '200', busDt: '2026-08-16' },
    { pc: '100', busDt: '2026-08-17' },
  ]);
});

test('pickErrorEntries: a date with no saved snapshot is skipped, not an error', () => {
  const snapshotByDate = new Map([['2026-08-16', [{ pc: '100', crewStatus: 'ok' }]]]);
  const result = pickErrorEntries(['2026-08-16', '2026-08-17'], snapshotByDate);
  assert.deepEqual(result, []);
});

test('computeFinalizeStatuses: a fully clean store across the period is finalized', () => {
  const stores = [{ pc: '100', name: 'Test Store' }];
  const periodDates = ['2026-08-16', '2026-08-17'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 10 }]],
    ['2026-08-17', [{ pc: '100', crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 10 }]],
  ]);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, new Set());
  assert.deepEqual(result, { '100': { finalized: true, unresolvedDays: [] } });
});

test('computeFinalizeStatuses: a crew-fetch-error day blocks finalization with the right reason', () => {
  const stores = [{ pc: '100', name: 'Test Store' }];
  const periodDates = ['2026-08-16'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'error', crew: [], tipPool: 10 }]],
  ]);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, new Set());
  assert.equal(result['100'].finalized, false);
  assert.deepEqual(result['100'].unresolvedDays, [{ busDt: '2026-08-16', reason: 'crew-fetch-error' }]);
});

test('computeFinalizeStatuses: zero-eligible-crew-with-tips blocks finalization', () => {
  const stores = [{ pc: '100', name: 'Test Store' }];
  const periodDates = ['2026-08-16'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'ok', crew: [], tipPool: 19.35 }]],
  ]);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, new Set());
  assert.equal(result['100'].finalized, false);
  assert.deepEqual(result['100'].unresolvedDays, [{ busDt: '2026-08-16', reason: 'zero-eligible-crew-with-tips' }]);
});

test('computeFinalizeStatuses: a reconcile-withheld day blocks finalization', () => {
  const stores = [{ pc: '100', name: 'Test Store' }];
  const periodDates = ['2026-08-16'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 10 }]],
  ]);
  const withheldSet = new Set(['100|2026-08-16']);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, withheldSet);
  assert.equal(result['100'].finalized, false);
  assert.deepEqual(result['100'].unresolvedDays, [{ busDt: '2026-08-16', reason: 'reconcile-withheld-possible-drop' }]);
});

test('computeFinalizeStatuses: a missing snapshot for a period date blocks finalization', () => {
  const stores = [{ pc: '100', name: 'Test Store' }];
  const periodDates = ['2026-08-16', '2026-08-17'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 10 }]],
    // 2026-08-17 missing entirely
  ]);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, new Set());
  assert.equal(result['100'].finalized, false);
  assert.deepEqual(result['100'].unresolvedDays, [{ busDt: '2026-08-17', reason: 'missing-snapshot' }]);
});

test('computeFinalizeStatuses: stores are evaluated independently', () => {
  const stores = [{ pc: '100', name: 'Clean Store' }, { pc: '200', name: 'Stuck Store' }];
  const periodDates = ['2026-08-16'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [
      { pc: '100', crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 10 },
      { pc: '200', crewStatus: 'error', crew: [], tipPool: 5 },
    ]],
  ]);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, new Set());
  assert.equal(result['100'].finalized, true);
  assert.equal(result['200'].finalized, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test netlify/functions/tips-lib/period-settle.test.mjs`
Expected: FAIL — `Cannot find module './period-settle.mjs'` (the file doesn't exist yet)

- [ ] **Step 3: Write the implementation**

Create `netlify/functions/tips-lib/period-settle.mjs`:

```js
// tips-lib/period-settle.mjs — Pure decision logic for the biweekly
// finalize-gate settle pass (see docs/superpowers/specs/2026-09-02-tips-
// biweekly-finalize-gate-design.md). No network or blob I/O here — the
// orchestration that actually fetches live Paycor data and reads/writes
// snapshot blobs lives in tips-report-morning-sweep-background.mjs
// (retryErrorDays) and tips-reconcile-cron.mjs (runReconcileForDates);
// both consume these helpers so the underlying "is this store/day
// actually trustworthy" logic is tested once, here, instead of embedded
// untested inside side-effecting cron code.

// Mirrors the exact same check tips-report-cron-background.mjs's nightly
// run already uses to flag a store in its own warning email: real tip
// money collected, but nobody eligible found in Paycor that day.
export function isZeroEligibleCrewWithTips(storeEntry) {
  return storeEntry.crewStatus === 'ok'
    && Array.isArray(storeEntry.crew)
    && storeEntry.crew.length === 0
    && Number((storeEntry.tipPool || 0).toFixed(2)) > 0;
}

// tips-reconcile-cron.mjs's runReconcile/runReconcileForDates withholds an
// entire store/day's corrections (rather than silently deleting someone's
// pay) whenever a saved crew member looks dropped from a live re-fetch —
// those rows carry the literal substring "POSSIBLE DROP" in their
// `change` field. Extracting the (pc, busDt) pairs here lets the settle
// pass treat "withheld, needs manual review" as its own finalize-blocking
// reason without re-deriving reconcile's own drop-detection logic.
export function deriveWithheldSet(reconcileDetails) {
  const set = new Set();
  for (const d of reconcileDetails || []) {
    if (typeof d.change === 'string' && d.change.includes('POSSIBLE DROP')) {
      set.add(`${d.pc}|${d.busDt}`);
    }
  }
  return set;
}

// Which (pc, busDt) pairs still need a fetchStoreCrew retry — i.e. their
// saved snapshot says crewStatus:'error'. A date with no saved snapshot
// at all is skipped (nothing to retry from), not treated as an error.
export function pickErrorEntries(dates, snapshotByDate) {
  const entries = [];
  for (const busDt of dates) {
    const arr = snapshotByDate.get(busDt);
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      if (r.crewStatus === 'error') entries.push({ pc: String(r.pc), busDt });
    }
  }
  return entries;
}

// Per-store finalize status across a closed pay period. A store is only
// finalized when every day in periodDates has a saved snapshot entry that
// is crewStatus:'ok', is not the zero-eligible-crew-with-tips anomaly, and
// was not withheld by the reconcile pass as a possible drop.
export function computeFinalizeStatuses(stores, periodDates, snapshotsByDate, withheldSet) {
  const result = {};
  for (const store of stores) {
    const pc = String(store.pc);
    const unresolvedDays = [];
    for (const busDt of periodDates) {
      const arr = snapshotsByDate.get(busDt);
      const entry = Array.isArray(arr) ? arr.find(r => String(r.pc) === pc) : null;
      if (!entry) {
        unresolvedDays.push({ busDt, reason: 'missing-snapshot' });
        continue;
      }
      if (entry.crewStatus === 'error') {
        unresolvedDays.push({ busDt, reason: 'crew-fetch-error' });
        continue;
      }
      if (isZeroEligibleCrewWithTips(entry)) {
        unresolvedDays.push({ busDt, reason: 'zero-eligible-crew-with-tips' });
        continue;
      }
      if (withheldSet.has(`${pc}|${busDt}`)) {
        unresolvedDays.push({ busDt, reason: 'reconcile-withheld-possible-drop' });
      }
    }
    result[pc] = { finalized: unresolvedDays.length === 0, unresolvedDays };
  }
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test netlify/functions/tips-lib/period-settle.test.mjs`
Expected: PASS — all 13 tests green

- [ ] **Step 5: Add this test file to the project's test script**

Modify `package.json` — find the `"test"` line under `"scripts"` and add the new glob:

```json
    "test": "node --test 'netlify/functions/analyst-lib/*.test.mjs' 'src/*.test.mjs' 'netlify/functions/deal-lib/*.test.js' 'netlify/functions/ndcp-lib/*.test.js' 'netlify/functions/auth-lib/*.test.js' 'netlify/functions/audit-lib/*.test.js' 'netlify/functions/tips-lib/*.test.mjs'",
```

- [ ] **Step 6: Run the full project test suite to confirm nothing else broke**

Run: `npm test`
Expected: PASS — existing suites unaffected, plus the 13 new tests

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/tips-lib/period-settle.mjs netlify/functions/tips-lib/period-settle.test.mjs package.json
git commit -m "Add pure finalize/settle decision logic for tips biweekly gate"
```

---

### Task 2: Explicit-dates reconcile (`tips-reconcile-cron.mjs`)

**Files:**
- Modify: `netlify/functions/tips-reconcile-cron.mjs:50-218`

**Interfaces:**
- Consumes: nothing new (this is a mechanical extraction of already-shipped logic; no dependency on Task 1)
- Produces: `runReconcileForDates(dates: string[], onlyPc?: string | null): Promise<{ ok: boolean, daysChecked: number, storesChecked: number, corrections: number, details: Array<{store, pc, busDt, employee, change}>, skippedForBudget: boolean }>` — consumed by Task 4. `runReconcile(daysBack?: number, onlyPc?: string | null)` keeps its exact existing signature and behavior, now implemented as a thin wrapper.

This task changes nothing about *how* the reconciliation diff works — it only stops `runReconcile` from computing its own date range internally, so a caller can hand it an exact list of dates (the whole closed pay period) instead of always "last N days back from today." `tips-reconcile-refresh-background.mjs` and the daily scheduled `default` export both keep calling `runReconcile(...)` exactly as before — their behavior is unchanged.

- [ ] **Step 1: Replace the top of `runReconcile` with the extracted, parameterized version**

In `netlify/functions/tips-reconcile-cron.mjs`, replace the function signature and its first two lines (currently lines 50-53):

```js
export async function runReconcile(daysBack = 3, onlyPc = null) {
  const dates = [];
  for (let i = 1; i <= daysBack; i++) dates.push(etDate(i));
  const targetStores = onlyPc ? STORES.filter(s => String(s.pc) === String(onlyPc)) : STORES;
```

with:

```js
// Shared by the daily cron (short lookback), the manual refresh sibling
// (longer on-demand trace-back), and the biweekly-boundary settle pass in
// tips-report-cron-background.mjs (which needs the exact dates of a
// closed pay period, not "N days back from today" — those aren't the
// same thing once the settle runs days after the period actually ended).
export async function runReconcileForDates(dates, onlyPc = null) {
  const targetStores = onlyPc ? STORES.filter(s => String(s.pc) === String(onlyPc)) : STORES;
```

Then, further down, replace everything from the closing of the function body's date/store setup through the end of the function (the remainder of the original `runReconcile`, i.e. everything from the `const corrections = [];` line through the final `return summary;` and closing `}`) so that it now belongs to `runReconcileForDates` — **no other line inside that body changes**, only the enclosing function's name and its no-longer-self-computed `dates`.

Immediately after that closing `}`, add the new thin wrapper:

```js
export async function runReconcile(daysBack = 3, onlyPc = null) {
  const dates = [];
  for (let i = 1; i <= daysBack; i++) dates.push(etDate(i));
  return runReconcileForDates(dates, onlyPc);
}
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check netlify/functions/tips-reconcile-cron.mjs`
Expected: no output (valid syntax)

- [ ] **Step 3: Confirm the existing callers still resolve correctly**

Run: `node -e "import('./netlify/functions/tips-reconcile-cron.mjs').then(m => console.log('exports:', Object.keys(m)))"`
Expected: `exports: [ 'runReconcile', 'runReconcileForDates', 'default' ]` (or similar — both names present, module loads without throwing)

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/tips-reconcile-cron.mjs
git commit -m "Extract runReconcileForDates so callers can pass an exact date range"
```

---

### Task 3: Multi-date error retry (`tips-report-morning-sweep-background.mjs`)

**Files:**
- Modify: `netlify/functions/tips-report-morning-sweep-background.mjs` (full file — see below)

**Interfaces:**
- Consumes: `pickErrorEntries` from `./tips-lib/period-settle.mjs` (Task 1)
- Produces: `retryErrorDays(dates: string[], opts?: { budgetMs?: number, maxPasses?: number }): Promise<{ healedCount: number, stillFailing: Array<{pc, busDt}>, skippedForBudget: boolean }>` — consumed by Task 4. The scheduled `default` export keeps its exact current behavior (single date, same response shape), now implemented by calling `retryErrorDays([busDt])` internally.

The current file loads one day's snapshot, finds `crewStatus:'error'` stores, and retries them in bounded passes. This task generalizes that loop to accept a list of dates (so the settle pass can retry an entire 14-day period in one call) while keeping the single-date scheduled path byte-for-byte equivalent in behavior.

- [ ] **Step 1: Replace the full file**

Replace the entire contents of `netlify/functions/tips-report-morning-sweep-background.mjs` with:

```js
// tips-report-morning-sweep-background.mjs — Runs a few hours after the nightly tips
// report (7am ET, vs. the main report's 3am ET), rechecking whatever's still
// marked crewStatus:'error' in that day's saved snapshot and retrying ONLY
// those stores — not the full 46-store sweep again. Confirmed directly
// (2026-08-11/12): individually retrying failures is far more reliable than
// re-running everyone (fewer total Paycor calls per attempt means much less
// surface area for intermittent flakiness to land on), and by 7am any
// Paycor issue from a few hours earlier has often cleared on its own.
//
// Does NOT re-send the daily email — this only repairs the saved snapshot so
// the in-app Tips Report (and any later weekly/biweekly rollup, which reads
// these same snapshots) reflects the most accurate data available. A store
// still failing after this (e.g. a genuine Paycor permissions gap, not
// flakiness — confirmed on Hatboro, 2026-08-12) needs a human to look at it;
// this can't fix problems retrying doesn't fix.
//
// retryErrorDays (below) generalizes this to an arbitrary list of dates —
// added 2026-09-02 so the biweekly finalize-gate settle pass
// (tips-report-cron-background.mjs, isBiweekBoundary branch) can retry
// every crewStatus:'error' day across a whole closed pay period in one
// call, sharing a single time budget across all of them, instead of one
// date at a time. The scheduled export below is unchanged in behavior —
// it just calls retryErrorDays with a single-element date array.
export const config = { schedule: '0 11 * * *' }; // 7am ET

import { STORES, fetchStoreCrew, saveDaySnapshot, getBlobStore, etDate } from './tips-report-cron-background.mjs';
import { pickErrorEntries } from './tips-lib/period-settle.mjs';

// Deliberately NOT tips-report-cron-background.mjs's loadDaySnapshot — it
// memoizes per busDt in a module-level Map that survives across invocations
// on a warm serverless instance, which caused real data loss the last time
// this pattern was used without an uncached read (tips-report-refresh-
// background.mjs, 2026-08-11 — see that file's history). Always read fresh.
async function loadDaySnapshotUncached(busDt) {
  try {
    const raw = await getBlobStore().get(`pcg_tips_snapshot_${busDt}`, { type: 'json' });
    return raw?.data || null;
  } catch { return null; }
}

// Retries every crewStatus:'error' entry across `dates`, sharing one time
// budget and up to `maxPasses` bounded passes across the whole set (not
// per-date) — a store healed in pass 1 isn't retried again in pass 2.
// Persists each touched date once, after all passes finish.
export async function retryErrorDays(dates, opts = {}) {
  const budgetMs = opts.budgetMs ?? 11 * 60 * 1000;
  const maxPasses = opts.maxPasses ?? 6;
  const invocationStart = Date.now();

  const snapshotByDate = new Map();
  for (const busDt of dates) {
    const arr = await loadDaySnapshotUncached(busDt);
    if (Array.isArray(arr)) snapshotByDate.set(busDt, arr);
  }

  let remaining = pickErrorEntries(dates, snapshotByDate);
  let healedCount = 0;
  let skippedForBudget = false;

  for (let pass = 1; pass <= maxPasses && remaining.length > 0; pass++) {
    if (Date.now() - invocationStart > budgetMs) { skippedForBudget = true; break; }
    for (const { pc, busDt } of remaining) {
      if (Date.now() - invocationStart > budgetMs) { skippedForBudget = true; break; }
      const store = STORES.find(s => String(s.pc) === pc);
      if (!store) continue;
      const { crew, crewStatus } = await fetchStoreCrew(store, busDt);
      const arr = snapshotByDate.get(busDt);
      const idx = arr ? arr.findIndex(r => String(r.pc) === pc) : -1;
      if (idx >= 0) arr[idx] = { ...arr[idx], crew, crewStatus };
      if (crewStatus === 'ok') healedCount++;
    }
    remaining = pickErrorEntries(dates, snapshotByDate);
  }

  for (const busDt of dates) {
    const arr = snapshotByDate.get(busDt);
    if (arr) await saveDaySnapshot(busDt, arr);
  }

  return { healedCount, stillFailing: pickErrorEntries(dates, snapshotByDate), skippedForBudget };
}

export default async (request) => {
  const busDt = etDate(1); // same day the 3am report just covered

  try {
    const { healedCount, stillFailing, skippedForBudget } = await retryErrorDays([busDt]);
    const stillBad = stillFailing.map(({ pc }) => STORES.find(s => String(s.pc) === pc)?.name || pc);
    const summary = { ok: true, busDt, retried: healedCount + stillFailing.length, fixed: healedCount, stillFailing: stillBad, skippedForBudget };
    console.log('[tips-morning-sweep] done:', JSON.stringify(summary));
    return new Response(JSON.stringify(summary), { status: 200 });
  } catch (err) {
    console.error('[tips-morning-sweep] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
```

Note the small, deliberate behavior change in `default`'s summary shape versus the original: `retried` used to mean "how many were error at the start of the run" (`failedPcs.size`); it's now `healedCount + stillFailing.length`, which is the same number by construction (every entry that started in error either got healed or is still failing) — just derived from the new function's return values instead of a separately-tracked set. The original's early-return branches ("no snapshot found" / "nothing to retry") are also now folded into `retryErrorDays` returning `healedCount: 0, stillFailing: []` for those cases, which the `default` handler reports the same way.

- [ ] **Step 2: Syntax-check the file**

Run: `node --check netlify/functions/tips-report-morning-sweep-background.mjs`
Expected: no output (valid syntax)

- [ ] **Step 3: Confirm the module loads and exports correctly**

Run: `node -e "import('./netlify/functions/tips-report-morning-sweep-background.mjs').then(m => console.log('exports:', Object.keys(m)))"`
Expected: `exports: [ 'config', 'retryErrorDays', 'default' ]` (module loads without throwing — this also exercises the new import of `./tips-lib/period-settle.mjs`, confirming Task 1's file resolves correctly from here)

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/tips-report-morning-sweep-background.mjs
git commit -m "Generalize morning-sweep's error retry to accept multiple dates"
```

---

### Task 4: Wire the settle pass into the biweekly boundary

**Files:**
- Modify: `netlify/functions/tips-report-cron-background.mjs` (imports near top, and the `isBiweekBoundary(busDt)` branch at lines 1175-1187)

**Interfaces:**
- Consumes: `runReconcileForDates` (Task 2), `retryErrorDays` (Task 3), `computeFinalizeStatuses` + `deriveWithheldSet` (Task 1)
- Produces: new blob `pcg_tips_period_status_{periodStart}`, shape `{ [pc]: { finalized: boolean, unresolvedDays: Array<{busDt, reason}>, lastCheckedAt: string } }` — read by nothing yet in this plan (a later, separate task could surface it in the Tips Report UI; out of scope here per the spec's non-goals).

This task creates the circular-import pair `tips-report-cron-background.mjs` ↔ `tips-reconcile-cron.mjs` and `tips-report-cron-background.mjs` ↔ `tips-report-morning-sweep-background.mjs` (both of those files already import shared helpers like `STORES`/`fetchStoreCrew`/`saveDaySnapshot` *from* `tips-report-cron-background.mjs`, and this task adds the reverse import). This is safe here because every new import is only ever called from inside the exported `default` async handler — i.e. at request time, long after Node has finished resolving the whole module graph — never at module top-level. Step 3 below verifies this concretely.

- [ ] **Step 1: Add the three new imports**

In `netlify/functions/tips-report-cron-background.mjs`, find the existing import section near the top of the file and add:

```js
import { runReconcileForDates } from './tips-reconcile-cron.mjs';
import { retryErrorDays } from './tips-report-morning-sweep-background.mjs';
import { computeFinalizeStatuses, deriveWithheldSet } from './tips-lib/period-settle.mjs';
```

- [ ] **Step 2: Replace the `isBiweekBoundary` branch**

Replace the existing block (currently lines 1175-1187):

```js
  if (isBiweekBoundary(busDt)) {
    const weekEnd = weekEndForTrigger(busDt);
    const [periodStart] = dateRangeEndingAt(weekEnd, 14);
    const label = `Pay Period ${periodStart} – ${weekEnd}`;
    try {
      const { storeResults: biweekResults, missingDates, zeroEligibleDays, pulseGapDays, crewErrorDays } = await buildPeriodStoreResults(weekEnd, 14);
      biweeklyResult = await buildAndSend(label, `PayPeriod-${periodStart}-to-${weekEnd}`, biweekResults, 'PCG Tips Report — Biweekly (Payroll)', missingDates, undefined, false, zeroEligibleDays, pulseGapDays, crewErrorDays);
    } catch (err) {
      console.error('[tips-report-cron] Biweekly report build FAILED:', err.message);
      await sendAlertEmail(recipient, `⚠ PCG Tips Report — Biweekly — ${label} — FAILED TO BUILD`, `<p>The biweekly (payroll) tips report for <b>${label}</b> could not be built and was not sent: ${err.message}</p>`).catch(() => {});
      biweeklyResult = { error: err.message };
    }
  }
```

with:

```js
  if (isBiweekBoundary(busDt)) {
    const weekEnd = weekEndForTrigger(busDt);
    const periodDates = dateRangeEndingAt(weekEnd, 14);
    const [periodStart] = periodDates;
    const label = `Pay Period ${periodStart} – ${weekEnd}`;

    // Full-period finalize-gate settle — runs BEFORE the biweekly rollup is
    // built, so the rollup itself benefits from anything healed here. See
    // docs/superpowers/specs/2026-09-02-tips-biweekly-finalize-gate-design.md.
    try {
      await retryErrorDays(periodDates); // heal any day still stuck in crewStatus:'error' before diffing
      const reconcileResult = await runReconcileForDates(periodDates);
      const withheldSet = deriveWithheldSet(reconcileResult.details);

      const snapshotsByDate = new Map();
      for (const d of periodDates) {
        const arr = await loadDaySnapshot(d);
        if (Array.isArray(arr)) snapshotsByDate.set(d, arr);
      }

      const lastCheckedAt = new Date().toISOString();
      const rawStatuses = computeFinalizeStatuses(STORES, periodDates, snapshotsByDate, withheldSet);
      const statusRecord = {};
      for (const pc of Object.keys(rawStatuses)) statusRecord[pc] = { ...rawStatuses[pc], lastCheckedAt };
      await getBlobStore().setJSON(`pcg_tips_period_status_${periodStart}`, { savedAt: lastCheckedAt, data: statusRecord });

      const notFinalized = Object.entries(statusRecord).filter(([, v]) => !v.finalized);
      if (notFinalized.length > 0) {
        const rows = notFinalized.map(([pc, v]) => {
          const store = STORES.find(s => String(s.pc) === pc);
          const reasons = v.unresolvedDays.map(d => `${d.busDt}: ${d.reason}`).join('; ');
          return `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee;">${store ? store.name : pc}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;">${reasons}</td></tr>`;
        }).join('');
        const html = `<p>Pay Period ${periodStart} – ${weekEnd}: ${notFinalized.length} store(s) still NOT finalized after the automatic settle pass — review before entering payroll manually.</p><table style="border-collapse:collapse;width:100%;margin-top:10px;font-size:13px;"><tr style="background:#f5f5f5;"><th style="padding:4px 10px;text-align:left;">Store</th><th style="padding:4px 10px;text-align:left;">Unresolved</th></tr>${rows}</table>`;
        await sendAlertEmail(recipient, `⚠ Pay Period ${periodStart} – ${weekEnd} — ${notFinalized.length} store(s) NOT finalized`, html).catch(() => {});
      }
    } catch (err) {
      console.error('[tips-report-cron] Biweekly finalize settle FAILED:', err.message);
      await sendAlertEmail(recipient, `⚠ Pay Period ${periodStart} – ${weekEnd} — finalize settle FAILED`, `<p>The biweekly finalize settle pass threw before building the payroll report: ${err.message}</p>`).catch(() => {});
    }

    try {
      const { storeResults: biweekResults, missingDates, zeroEligibleDays, pulseGapDays, crewErrorDays } = await buildPeriodStoreResults(weekEnd, 14);
      biweeklyResult = await buildAndSend(label, `PayPeriod-${periodStart}-to-${weekEnd}`, biweekResults, 'PCG Tips Report — Biweekly (Payroll)', missingDates, undefined, false, zeroEligibleDays, pulseGapDays, crewErrorDays);
    } catch (err) {
      console.error('[tips-report-cron] Biweekly report build FAILED:', err.message);
      await sendAlertEmail(recipient, `⚠ PCG Tips Report — Biweekly — ${label} — FAILED TO BUILD`, `<p>The biweekly (payroll) tips report for <b>${label}</b> could not be built and was not sent: ${err.message}</p>`).catch(() => {});
      biweeklyResult = { error: err.message };
    }
  }
```

Note the settle pass is wrapped in its own `try/catch`, separate from the existing biweekly-report `try/catch` right after it — a failure in the new settle logic must never prevent the biweekly payroll report from still being built and sent (that report going out is the more critical of the two).

- [ ] **Step 3: Syntax-check and confirm the full module graph resolves (circular-import safety check)**

Run: `node --check netlify/functions/tips-report-cron-background.mjs`
Expected: no output (valid syntax)

Run: `node -e "import('./netlify/functions/tips-report-cron-background.mjs').then(m => console.log('exports:', Object.keys(m))).catch(e => { console.error('LOAD FAILED:', e.message); process.exit(1); })"`
Expected: `exports: [...]` listing the file's existing exports (`STORES`, `fetchStoreCrew`, `saveDaySnapshot`, `getBlobStore`, `loadDaySnapshot`, `etDate`, `dateRangeEndingAt`, `MANUALLY_EXCLUDED_EMPLOYEES`, `default`, ...) with no `LOAD FAILED` — this concretely proves the new circular import (this file ↔ `tips-reconcile-cron.mjs`, this file ↔ `tips-report-morning-sweep-background.mjs`) resolves cleanly under Node's real ESM loader, not just in theory.

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/tips-report-cron-background.mjs
git commit -m "Wire full-period finalize settle into the biweekly boundary trigger"
```

---

### Task 5: Deploy and real-environment smoke check

**Files:** none (verification-only task)

**Interfaces:**
- Consumes: everything from Tasks 1-4, deployed to production.

This plan cannot fully integration-test the new settle pass without waiting for the next real biweekly-boundary Tuesday (it's gated behind `isBiweekBoundary`, and manually POSTing to any scheduled function is blocked by the platform — confirmed multiple times this session). This task instead does the strongest verification actually available right now: exercise the refactored `runReconcile` → `runReconcileForDates` path for real, in production, against a real store and date range, using the manual trigger that already exists for exactly this purpose.

- [ ] **Step 1: Run the full test suite one more time**

Run: `npm test`
Expected: PASS (all suites, including the 13 new tests from Task 1)

- [ ] **Step 2: Push to main**

This repo deploys straight to production on any push to `main` via Netlify. Merge/push this branch's commits to `main` per the user's explicit instruction to do so.

- [ ] **Step 3: Confirm the deploy succeeded**

Run: `npx netlify status` and check the latest production deploy in the Netlify dashboard (or `netlify.toml`-configured build hook output) shows a successful build with no errors from the four modified files.

- [ ] **Step 4: Smoke-test the refactored reconcile path against real data**

POST to the already-existing manual trigger, scoped to one known store and a short, already-fully-verified date range from the closed 8/16–8/29 period (e.g. County Line, pc `302642`):

```bash
curl -s -X POST "https://uop.peoplecapitalgroup.com/.netlify/functions/tips-reconcile-refresh-background" \
  -H "Content-Type: application/json" \
  -d '{"daysBack": 3, "storePc": "302642"}'
```

Expected: the function accepts the request (background functions return immediately; check the Netlify function logs for `[tips-reconcile-refresh] done:` with `"ok":true`), proving `runReconcile` → `runReconcileForDates` still behaves correctly end-to-end in the real deployed environment, exercising the exact refactor from Task 2.

- [ ] **Step 5: Note the residual monitoring item**

The morning-sweep's generalized `retryErrorDays` (Task 3) and the new biweekly settle branch (Task 4) only run on their own schedules (7am ET daily; the Tuesday biweekly boundary). Neither can be manually triggered post-deploy the way Task 2's path can. Per the spec's own Rollout section: monitor the next real biweekly-boundary Tuesday's run (logs + the finalize-status email, if any store isn't finalized) to confirm this end of the change works as designed before relying on it as the sole check.

---

## Self-Review Notes

- **Spec coverage:** every numbered design section (full-period reconcile, retry-until-clean for both error-days and diff-based staleness, the finalized blob, the notification email, and the "no new Netlify function" / "no auto-send" non-goals) has a corresponding task above. The spec's testing-plan bullet about unit-testing the finalize computation and the bounded retry loop against fixtures is Task 1's test suite.
- **Placeholder scan:** no TBD/TODO; every step shows complete, real code, not a description of code.
- **Type/name consistency:** `runReconcileForDates`, `retryErrorDays`, `pickErrorEntries`, `deriveWithheldSet`, and `computeFinalizeStatuses` are named and shaped identically everywhere they're defined, imported, and called across Tasks 1-4.
