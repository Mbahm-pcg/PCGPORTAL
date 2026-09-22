# Manager Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when Paycor shows a different person now holding the manager title at a store, and surface it as a one-click "create the new account / deactivate the old one" action on the existing Admin · Users page — never applying a change automatically.

**Architecture:** Detection runs inside `labor-cron.mjs`'s existing hourly per-store Paycor pull (no new Paycor calls), using a new pure decision module (`src/manager-sync.mjs`, no I/O, fully unit-tested) for the actual matching/status rules. Results persist to a new blob (`pcg_manager_pending_v1`) and a bell notification. The Users page reads that blob directly (same `cloudLoad`/`cloudSave` pattern every other admin list in this app already uses) and reuses the existing Add User form (pre-filled) and existing Deactivate control — no new user-management UI is built from scratch.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Netlify Functions + Blobs, Neon Postgres (`users` table via `_shared/db.mjs`), React (inline in `app.jsx`), Paycor REST (via `labor-cron.mjs`'s existing `employees` fetch).

**Spec:** `docs/superpowers/specs/2026-09-22-manager-sync-design.md`

## Global Constraints

- Manager-title match: active employee, title (`emp.jobTitle || emp.department || ''`) contains "manager" (case-insensitive) and does **not** also contain "assistant".
- No new Paycor calls — detection uses the exact `employees` array `processStore` (`netlify/functions/labor-cron.mjs`) already fetches and filters to `Active`.
- Exactly one match, not the linked manager (or no linked manager) → queue a `replace` item **immediately**, no waiting period.
- Two or more matches → queue a `needsReview` item. Never auto-pick.
- Zero matches → queue a `vacant` item, but only after **3 straight weeks** of zero matches for that store.
- Identity link (`users.paycor_employee_id`) is compared exactly once linked. Fuzzy name comparison happens **only once per store**, to bootstrap-link an already-correct, already-serving manager (see Task 3) — never on a routine check.
- New account email: left blank in the pre-fill (Paycor's personal-email field is not used — dropped 2026-09-22 to avoid depending on an unverified field). The admin types one in when reviewing the pre-filled form, same as creating any other user today. Never the shared store inbox.
- Outgoing account: deactivated (`active: false`), never hard-deleted.
- Nothing beyond detection is automatic — creating the new account and deactivating the old one both require an explicit admin click.
- Username suggestion: first initial + lowercased last name, alphanumeric only, `2`/`3`/... appended on collision.
- Password suggestion: random, must satisfy `validatePasswordClient` (`app.jsx:559` — 12+ chars, lowercase, uppercase, digit, special character).

---

## File Structure

- Create `src/manager-sync.mjs` — pure logic: title matching, candidate detection, bootstrap name-correspondence check, vacant-streak update, username/password suggestion. No I/O.
- Create `src/manager-sync.test.mjs` — unit tests.
- Modify `db/schema.ts` — add `paycorEmployeeId` to the `users` table.
- Modify `netlify/functions/db-migrate.mjs` — idempotent `ALTER TABLE users ADD COLUMN IF NOT EXISTS paycor_employee_id TEXT`.
- Modify `netlify/functions/labor-cron.mjs` — expose each store's manager-title matches from `processStore`; after `processAllStores`, run the aggregation (load current linked managers, load/update the pending blob, bootstrap-link, write bell notifications). No personal-email handling — dropped 2026-09-22.
- Modify `netlify/functions/users.mjs` — accept and return `paycorEmployeeId` on user create.
- Modify `app.jsx` — `AdminUsers`: load the pending blob, render the "N pending" indicator + action list; notification-bell click routing gets a `manager_change_pending` branch.

---

### Task 1: Schema + migration for `paycor_employee_id`

**Files:**
- Modify: `db/schema.ts` (the `users` table, `db/schema.ts:4-17`)
- Modify: `netlify/functions/db-migrate.mjs` (near the other `users` column additions, `netlify/functions/db-migrate.mjs:178-183`)

**Interfaces:**
- Produces: a nullable `paycor_employee_id TEXT` column on `users` (Drizzle field name `paycorEmployeeId`), consumed by Task 4 (`users.mjs`) and Task 3 (`labor-cron.mjs`'s bootstrap-link write and comparison read).

- [ ] **Step 1: Add the column to the Drizzle schema**

In `db/schema.ts`, inside the `users` table (right after `avatarUrl: text("avatar_url"),` at line 16):

```ts
  paycorEmployeeId: varchar("paycor_employee_id", { length: 64 }),
```

- [ ] **Step 2: Add the idempotent migration statement**

In `netlify/functions/db-migrate.mjs`, right after the existing `users` column additions (after `netlify/functions/db-migrate.mjs:183`, `ALTER TABLE users ADD COLUMN IF NOT EXISTS initials VARCHAR(4)`):

```js
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS paycor_employee_id TEXT`;
```

- [ ] **Step 3: Syntax-check**

Run: `node --check netlify/functions/db-migrate.mjs`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add db/schema.ts netlify/functions/db-migrate.mjs
git commit -m "feat(manager-sync): add users.paycor_employee_id column"
```

Note for the deploy step later (Task 7): this migration only takes effect once `db-migrate` is manually triggered against production (per `CLAUDE.md`'s "manual (30s timeout): create/update Postgres schema"). Task 7 calls this out explicitly — do not skip it.

---

### Task 2: Pure detection logic — `src/manager-sync.mjs`

**Files:**
- Create: `src/manager-sync.mjs`
- Test: `src/manager-sync.test.mjs`

**Interfaces:**
- Produces, all exported from `src/manager-sync.mjs` (consumed by Task 3, `labor-cron.mjs`):
  - `isManagerTitle(title) -> boolean`
  - `managerMatches(employees) -> Array<{ employeeId, name, jobTitle }>` (active-employee filtering already happened upstream in `labor-cron.mjs`; this just applies the title rule)
  - `namesCorrespond(a, b) -> boolean` (bootstrap-link fuzzy check, used once per store)
  - `detectManagerCandidate({ matches, linkedEmployeeId }) -> { status: 'ok' } | { status: 'replace', candidate } | { status: 'needsReview', candidates } | { status: 'zeroMatch' }`
  - `advanceVacantStreak({ prevWeeks, zeroMatchThisRun, nowMs, lastRunMs }) -> { weeks, shouldQueue }` (3-straight-weeks tracking; `shouldQueue` is true exactly once, the run that crosses the threshold)
  - `suggestUsername(name, existingUsernames) -> string`
  - `generatePassword() -> string` (always satisfies `PASSWORD_RULE`)
  - `PASSWORD_RULE` — a plain object `{ minLength: 12 }` exported so the test can assert against the same rule `generatePassword` uses, without hard-coding `12` twice.

- [ ] **Step 1: Write the failing tests**

Create `src/manager-sync.test.mjs`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  isManagerTitle, managerMatches, namesCorrespond, detectManagerCandidate,
  advanceVacantStreak, suggestUsername, generatePassword, PASSWORD_RULE,
} from './manager-sync.mjs';

describe('isManagerTitle', () => {
  test('matches plain manager titles', () => {
    assert.strictEqual(isManagerTitle('Store Manager'), true);
    assert.strictEqual(isManagerTitle('General Manager'), true);
    assert.strictEqual(isManagerTitle('manager'), true);
  });
  test('excludes assistant variants', () => {
    assert.strictEqual(isManagerTitle('Assistant Manager'), false);
    assert.strictEqual(isManagerTitle('Assistant General Manager'), false);
  });
  test('non-manager titles and empty/missing titles are false', () => {
    assert.strictEqual(isManagerTitle('Crew Member'), false);
    assert.strictEqual(isManagerTitle(''), false);
    assert.strictEqual(isManagerTitle(null), false);
    assert.strictEqual(isManagerTitle(undefined), false);
  });
});

describe('managerMatches', () => {
  test('keeps only manager-titled employees, normalizing id/name fields', () => {
    const employees = [
      { id: 'e1', firstName: 'Jane', lastName: 'Doe', jobTitle: 'Store Manager' },
      { employeeId: 'e2', firstName: 'Bob', lastName: 'Smith', jobTitle: 'Assistant Manager' },
      { id: 'e3', firstName: 'Ann', lastName: 'Lee', department: 'General Manager' },
      { id: 'e4', firstName: 'Sam', lastName: 'Kim', jobTitle: 'Crew Member' },
    ];
    const out = managerMatches(employees);
    assert.deepStrictEqual(out.map(m => m.employeeId), ['e1', 'e3']);
    assert.deepStrictEqual(out[0], { employeeId: 'e1', name: 'Jane Doe', jobTitle: 'Store Manager' });
    assert.deepStrictEqual(out[1], { employeeId: 'e3', name: 'Ann Lee', jobTitle: 'General Manager' });
  });
  test('skips a record with no usable id', () => {
    assert.strictEqual(managerMatches([{ firstName: 'No', lastName: 'Id', jobTitle: 'Store Manager' }]).length, 0);
  });
});

describe('namesCorrespond (bootstrap linking only)', () => {
  test('exact match', () => assert.strictEqual(namesCorrespond('MD Obaid Amin', 'MD Obaid Amin'), true));
  test('a shortened middle/last name still corresponds (first + last token)', () => {
    assert.strictEqual(namesCorrespond('MD Obaid Amin', 'MD Obaid'), true);
  });
  test('case and whitespace insensitive', () => assert.strictEqual(namesCorrespond('  jane   doe ', 'JANE DOE'), true));
  test('genuinely different people do not correspond', () => {
    assert.strictEqual(namesCorrespond('Jane Doe', 'John Smith'), false);
  });
  test('empty/missing on either side never corresponds', () => {
    assert.strictEqual(namesCorrespond('', 'Jane Doe'), false);
    assert.strictEqual(namesCorrespond('Jane Doe', null), false);
  });
});

describe('detectManagerCandidate', () => {
  const cand = (id, name = 'Jane Doe') => ({ employeeId: id, name, jobTitle: 'Store Manager' });

  test('one match, already linked → ok', () => {
    assert.deepStrictEqual(
      detectManagerCandidate({ matches: [cand('e1')], linkedEmployeeId: 'e1' }),
      { status: 'ok' }
    );
  });
  test('one match, different from linked → replace', () => {
    assert.deepStrictEqual(
      detectManagerCandidate({ matches: [cand('e2')], linkedEmployeeId: 'e1' }),
      { status: 'replace', candidate: cand('e2') }
    );
  });
  test('one match, nothing linked yet → replace', () => {
    assert.deepStrictEqual(
      detectManagerCandidate({ matches: [cand('e1')], linkedEmployeeId: null }),
      { status: 'replace', candidate: cand('e1') }
    );
  });
  test('two matches → needsReview, regardless of link state', () => {
    const matches = [cand('e1'), cand('e2', 'Bob Smith')];
    assert.deepStrictEqual(
      detectManagerCandidate({ matches, linkedEmployeeId: 'e1' }),
      { status: 'needsReview', candidates: matches }
    );
  });
  test('zero matches → zeroMatch', () => {
    assert.deepStrictEqual(
      detectManagerCandidate({ matches: [], linkedEmployeeId: 'e1' }),
      { status: 'zeroMatch' }
    );
  });
});

describe('advanceVacantStreak', () => {
  const WEEK = 7 * 86400000;
  test('first zero-match run starts the streak at 1 week, does not queue yet', () => {
    const r = advanceVacantStreak({ prevWeeks: 0, zeroMatchThisRun: true, nowMs: WEEK, lastRunMs: 0 });
    assert.strictEqual(r.weeks, 1);
    assert.strictEqual(r.shouldQueue, false);
  });
  test('crossing 3 weeks queues exactly once', () => {
    const r2 = advanceVacantStreak({ prevWeeks: 2, zeroMatchThisRun: true, nowMs: 3 * WEEK, lastRunMs: 2 * WEEK });
    assert.strictEqual(r2.weeks, 3);
    assert.strictEqual(r2.shouldQueue, true);
    const r3 = advanceVacantStreak({ prevWeeks: 3, zeroMatchThisRun: true, nowMs: 4 * WEEK, lastRunMs: 3 * WEEK });
    assert.strictEqual(r3.shouldQueue, false); // already queued, don't re-queue every run after
  });
  test('a match resets the streak to 0', () => {
    const r = advanceVacantStreak({ prevWeeks: 2, zeroMatchThisRun: false, nowMs: 3 * WEEK, lastRunMs: 2 * WEEK });
    assert.strictEqual(r.weeks, 0);
    assert.strictEqual(r.shouldQueue, false);
  });
});

describe('suggestUsername', () => {
  test('first initial + last name, lowercased', () => {
    assert.strictEqual(suggestUsername('Jane Doe', []), 'jdoe');
  });
  test('strips non-alphanumeric characters', () => {
    assert.strictEqual(suggestUsername("MD Obaid-Amin", []), 'moamin' /* first initial M + lastname "Amin" but hyphen name has 3 tokens: use first + LAST token */);
  });
  test('appends a number on collision', () => {
    assert.strictEqual(suggestUsername('Jane Doe', ['jdoe']), 'jdoe2');
    assert.strictEqual(suggestUsername('Jane Doe', ['jdoe', 'jdoe2']), 'jdoe3');
  });
  test('single-word name falls back to the whole word', () => {
    assert.strictEqual(suggestUsername('Prince', []), 'prince');
  });
});

describe('generatePassword', () => {
  test('always satisfies the password rule', () => {
    for (let i = 0; i < 20; i++) {
      const pw = generatePassword();
      assert.ok(pw.length >= PASSWORD_RULE.minLength);
      assert.match(pw, /[a-z]/);
      assert.match(pw, /[A-Z]/);
      assert.match(pw, /\d/);
      assert.match(pw, /[^A-Za-z0-9]/);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/manager-sync.test.mjs`
Expected: FAIL — `Cannot find module './manager-sync.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/manager-sync.mjs`:

```js
// src/manager-sync.mjs
// Pure Paycor-driven manager-detection logic — no I/O. Used by labor-cron.mjs.
// See docs/superpowers/specs/2026-09-22-manager-sync-design.md for the full rules.

const WEEK_MS = 7 * 86400000;
export const VACANT_WEEKS_THRESHOLD = 3;
export const PASSWORD_RULE = { minLength: 12 };

/** Title contains "manager" but not "assistant" (case-insensitive). */
export function isManagerTitle(title) {
  const t = String(title || '').toLowerCase();
  return t.includes('manager') && !t.includes('assistant');
}

/** Active employees (caller has already filtered to Active) whose title matches. */
export function managerMatches(employees) {
  const out = [];
  for (const emp of employees || []) {
    const employeeId = emp.id || emp.employeeId;
    if (!employeeId) continue;
    const jobTitle = emp.jobTitle || emp.department || '';
    if (!isManagerTitle(jobTitle)) continue;
    const name = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
    out.push({ employeeId, name, jobTitle });
  }
  return out;
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

/** Lenient first+last-token comparison — used ONLY to bootstrap-link a store's existing,
 *  already-correct manager who predates this feature. Never used for routine checks once
 *  a store has a real paycor_employee_id link (see spec). */
export function namesCorrespond(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return false;
  const ta = na.split(' '), tb = nb.split(' ');
  return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
}

/** Decide this store's status for THIS run, given today's manager-title matches and the
 *  employeeId currently linked to this store's Portal manager account (null if none/unlinked). */
export function detectManagerCandidate({ matches, linkedEmployeeId }) {
  if (matches.length === 0) return { status: 'zeroMatch' };
  if (matches.length > 1) return { status: 'needsReview', candidates: matches };
  const only = matches[0];
  if (linkedEmployeeId && only.employeeId === linkedEmployeeId) return { status: 'ok' };
  return { status: 'replace', candidate: only };
}

/** Track consecutive zero-match weeks for the "vacant" flag. Weeks are counted in whole
 *  WEEK_MS increments of elapsed time since the last run that had a match (or since the
 *  streak started); shouldQueue is true only on the run that first reaches the threshold,
 *  so the caller never re-queues an already-queued vacant item every subsequent run. */
export function advanceVacantStreak({ prevWeeks, zeroMatchThisRun, nowMs, lastRunMs }) {
  if (!zeroMatchThisRun) return { weeks: 0, shouldQueue: false };
  const elapsedWeeks = Math.max(1, Math.round((nowMs - lastRunMs) / WEEK_MS) || 1);
  const weeks = prevWeeks + (nowMs - lastRunMs >= WEEK_MS ? elapsedWeeks : (prevWeeks === 0 ? 1 : 0));
  const crossedNow = prevWeeks < VACANT_WEEKS_THRESHOLD && weeks >= VACANT_WEEKS_THRESHOLD;
  return { weeks, shouldQueue: crossedNow };
}

/** "Jane Doe" -> "jdoe"; collisions get 2, 3, ... appended. */
export function suggestUsername(name, existingUsernames) {
  const tokens = String(name || '').trim().split(/\s+/).filter(Boolean);
  const alnum = (s) => s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  let base;
  if (tokens.length === 0) base = 'user';
  else if (tokens.length === 1) base = alnum(tokens[0]);
  else base = alnum(tokens[0][0] + tokens[tokens.length - 1]);
  const existing = new Set((existingUsernames || []).map((u) => String(u).toLowerCase()));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** A random password that always satisfies validatePasswordClient's rule (app.jsx:559):
 *  12+ chars, lowercase, uppercase, digit, special character. It's only a pre-fill the
 *  admin can change, so it doesn't need to be memorable. */
export function generatePassword() {
  const lower = 'abcdefghijkmnpqrstuvwxyz', upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789', special = '!@#$%^&*-_=+';
  const all = lower + upper + digits + special;
  const pick = (set) => set[Math.floor(Math.random() * set.length)];
  let pw = pick(lower) + pick(upper) + pick(digits) + pick(special);
  while (pw.length < PASSWORD_RULE.minLength) pw += pick(all);
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/manager-sync.test.mjs`
Expected: PASS, 0 failures. (Note: the `suggestUsername("MD Obaid-Amin", [])` test asserts `'moamin'` — first initial `M` + last token `Amin` lowercased+alnum'd = `mamin`, not `moamin`; if the test fails, fix the **test's expected value** to `'mamin'`, not the implementation — the implementation's "first initial + last token" rule is correct per spec, the test comment miscalculated the example by hand.)

- [ ] **Step 5: Run the full suite to check nothing else broke**

Run: `node --test src/*.test.mjs netlify/functions/*-lib/*.test.mjs netlify/functions/*-lib/*.test.js`
Expected: PASS (same pre-existing results — including the known-unrelated 45-vs-46-store count failure in `netlify/functions/ndcp-lib/store-map.test.js` — plus the new tests).

- [ ] **Step 6: Commit**

```bash
git add src/manager-sync.mjs src/manager-sync.test.mjs
git commit -m "feat(manager-sync): pure detection/vacant-streak/credential-suggestion logic + tests"
```

---

### Task 3: `labor-cron.mjs` integration — detection + aggregation + bootstrap linking + notifications

**Files:**
- Modify: `netlify/functions/labor-cron.mjs`

**Interfaces:**
- Consumes (Task 2, `../../src/manager-sync.mjs`): `managerMatches`, `namesCorrespond`, `detectManagerCandidate`, `advanceVacantStreak`.

- [ ] **Step 1: Expose each store's manager-title matches from `processStore`**

In `netlify/functions/labor-cron.mjs`, add the import (near the top, alongside the existing `parsePaycorPunchMs` import added earlier this session):

```js
import { managerMatches } from '../../src/manager-sync.mjs';
```

In `processStore`'s return object (`netlify/functions/labor-cron.mjs:855-882`), add one field, computed from the exact `employees` array already fetched at the top of the function (no new fetch):

```js
    managerCandidates: managerMatches(employees),
```

(Add this line inside the object literal returned at `netlify/functions/labor-cron.mjs:855`, e.g. right after `employeeDetails,` at line 877.)

- [ ] **Step 2: Verify processStore still returns valid data**

Run: `node --check netlify/functions/labor-cron.mjs`
Expected: no output.

- [ ] **Step 3: Add the pending-blob key constant**

Still in `netlify/functions/labor-cron.mjs`, add near the top (directly above the aggregation function from Step 4 is fine):

```js
const MANAGER_PENDING_KEY = 'pcg_manager_pending_v1';
```

- [ ] **Step 4: Write the aggregation function**

Add this function to `netlify/functions/labor-cron.mjs` (a good spot: right before the `export default async (request) =>` handler):

```js
// Runs once per labor-cron invocation, after all stores have been processed. Compares
// each store's managerCandidates (from Step 1, no new Paycor call) against the currently
// linked Portal manager, updates the pending-change blob, bootstrap-links an
// already-correct pre-existing manager silently, and appends a bell notification for any
// NEWLY-queued item. See docs/superpowers/specs/2026-09-22-manager-sync-design.md.
async function runManagerSync(storeResults, blobStore, nowMs) {
  let linkedByPc = {};
  try {
    const db = sql();
    const rows = await db`SELECT id, name, store_pc, paycor_employee_id FROM users WHERE user_type = 'manager' AND active = true`;
    for (const r of rows) linkedByPc[String(r.store_pc)] = { id: r.id, name: r.name, employeeId: r.paycor_employee_id };
  } catch (e) {
    console.warn('[manager-sync] linked-manager lookup failed, skipping this run:', e.message);
    return;
  }

  let pending = {};
  try {
    const raw = await blobStore.get(MANAGER_PENDING_KEY, { type: 'json' });
    pending = (raw && raw.data) ? raw.data : {};
  } catch { pending = {}; }

  const lastRunMs = nowMs - 60 * 60 * 1000; // labor-cron's own schedule cadence — good enough for the weeks-elapsed estimate
  const newNotifs = [];

  for (const r of storeResults) {
    if (!r || !Array.isArray(r.managerCandidates)) continue;
    const pc = r.pc;
    const linked = linkedByPc[pc] || null;
    const prevPending = pending[pc];

    // Bootstrap linking: linked manager exists but has never been linked to a Paycor id yet.
    if (linked && !linked.employeeId && r.managerCandidates.length === 1) {
      const only = r.managerCandidates[0];
      if (namesCorrespond(only.name, linked.name)) {
        try {
          const db = sql();
          await db`UPDATE users SET paycor_employee_id = ${only.employeeId}, updated_at = now() WHERE id = ${linked.id}`;
        } catch (e) { console.warn('[manager-sync] bootstrap link failed for', pc, ':', e.message); }
        delete pending[pc];
        continue; // silent — no notification, matches spec
      }
      // Names don't correspond → fall through to the normal replace detection below,
      // treating this store as having no confirmed link (linkedEmployeeId stays null).
    }

    const linkedEmployeeId = linked?.employeeId || null;
    const result = detectManagerCandidate({ matches: r.managerCandidates, linkedEmployeeId });

    if (result.status === 'ok') { delete pending[pc]; continue; }

    if (result.status === 'replace') {
      if (prevPending?.kind === 'replace' && prevPending.candidate?.employeeId === result.candidate.employeeId) continue; // already queued, don't re-notify
      const entry = {
        kind: 'replace',
        candidate: { employeeId: result.candidate.employeeId, name: result.candidate.name, jobTitle: result.candidate.jobTitle },
        outgoingUserId: linked?.id || null,
        outgoingName: linked?.name || null,
        detectedAt: new Date(nowMs).toISOString(),
      };
      pending[pc] = entry;
      newNotifs.push({ pc, storeName: r.name, kind: 'replace', text: `Detected: replace ${linked?.name || '(no manager on file)'} with ${entry.candidate.name} at ${r.name}` });
      continue;
    }

    if (result.status === 'needsReview') {
      if (prevPending?.kind === 'needsReview') continue;
      pending[pc] = { kind: 'needsReview', candidates: result.candidates, detectedAt: new Date(nowMs).toISOString() };
      newNotifs.push({ pc, storeName: r.name, kind: 'needsReview', text: `${r.name}: multiple active employees hold a manager title — needs a human decision` });
      continue;
    }

    // zeroMatch
    const prevWeeks = prevPending?.kind === 'vacant' ? prevPending.zeroMatchWeeks : 0;
    const { weeks, shouldQueue } = advanceVacantStreak({ prevWeeks, zeroMatchThisRun: true, nowMs, lastRunMs });
    if (weeks > 0) pending[pc] = { kind: 'vacant', zeroMatchWeeks: weeks, detectedAt: prevPending?.detectedAt || new Date(nowMs).toISOString() };
    else delete pending[pc];
    if (shouldQueue) newNotifs.push({ pc, storeName: r.name, kind: 'vacant', text: `${r.name}: no active employee has held a manager title for 3+ weeks` });
  }

  try { await blobStore.setJSON(MANAGER_PENDING_KEY, { savedAt: new Date().toISOString(), data: pending }); }
  catch (e) { console.warn('[manager-sync] pending-blob write failed:', e.message); }

  if (newNotifs.length) {
    try {
      const existing = await blobStore.get('pcg_notifications_v1', { type: 'json' });
      const list = Array.isArray(existing) ? existing : (existing?.data || []);
      const appended = newNotifs.map((n) => ({
        id: `mgrsync_${n.pc}_${Date.now()}`,
        type: 'manager_change_pending',
        storePC: n.pc,
        message: n.text,
      }));
      await blobStore.setJSON('pcg_notifications_v1', [...appended, ...list].slice(0, 500));
    } catch (e) { console.warn('[manager-sync] notification write failed:', e.message); }
  }
}
```

- [ ] **Step 5: Call the aggregation after `processAllStores` completes**

In the main handler, find where `storeResults` is produced (`netlify/functions/labor-cron.mjs:1105`, `const storeResults = await processAllStores(...)`). Directly after that line (before the `pcg_labor_v1` network-blob build that already follows it), add:

```js
    try { await runManagerSync(storeResults, blobStore, Date.now()); }
    catch (e) { console.warn('[manager-sync] aggregation failed, skipping this run:', e.message); }
```

(`blobStore` here should reference whatever the surrounding code already calls its Netlify Blobs store instance in that scope — check the few lines above/below `storeResults` for the existing variable name, e.g. `getLaborStore()`'s result, and reuse it rather than opening a second store instance.)

Add the missing imports at the top of the file:

```js
import { sql } from './_shared/db.mjs';
import { namesCorrespond, detectManagerCandidate, advanceVacantStreak } from '../../src/manager-sync.mjs';
```

(combine with the `managerMatches` import from Step 1 into one `import { managerMatches, namesCorrespond, detectManagerCandidate, advanceVacantStreak } from '../../src/manager-sync.mjs';` line.)

- [ ] **Step 6: Syntax-check**

Run: `node --check netlify/functions/labor-cron.mjs`
Expected: no output.

- [ ] **Step 7: Run the full test suite**

Run: `node --test src/*.test.mjs netlify/functions/*-lib/*.test.mjs netlify/functions/*-lib/*.test.js`
Expected: PASS (same results as Task 2's Step 5 — this task only adds glue code around already-tested pure functions, no new logic to unit-test here).

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/labor-cron.mjs
git commit -m "feat(manager-sync): detect and queue manager changes in labor-cron's existing hourly run"
```

---

### Task 4: `users.mjs` — accept and return `paycorEmployeeId` on create

**Files:**
- Modify: `netlify/functions/users.mjs`

- [ ] **Step 1: Accept it on create**

In the `INSERT INTO users (...)` statement (`netlify/functions/users.mjs:146-162`), add the column and value:

```js
      const [row] = await db`
        INSERT INTO users (
          username, name, email, phone, role, user_type, district, store_pc,
          active, dark_mode, initials, is_admin, must_setup, region,
          password_hash, must_change, two_factor_required, audits_access,
          paycor_employee_id, created_at, updated_at
        ) VALUES (
          ${username}, ${u.name}, ${lc(u.email) || null}, ${u.phone || null},
          ${u.role || null}, ${u.userType}, ${u.district ?? null},
          ${u.storePC ? String(u.storePC) : null},
          ${u.active !== false}, ${u.darkMode || false},
          ${u.initials || null}, ${u.isAdmin || false}, ${forceSetup},
          ${u.region || 'PA'}, ${passwordHash}, ${forceSetup},
          ${u.twoFactorRequired || false}, ${u.auditsAccess ?? null},
          ${u.paycorEmployeeId || null}, now(), now()
        )
        ON CONFLICT (username) DO NOTHING
        RETURNING id
      `;
```

And add it to the `SELECT` immediately below (`netlify/functions/users.mjs:165-172`):

```js
      const [created] = await db`
        SELECT id, username, name, email, phone, role, user_type, district, store_pc,
               active, dark_mode, avatar_url, google_id, last_login, created_at,
               initials, is_admin, must_setup, region,
               two_factor_required, two_factor_enabled, must_change, locked, failed_attempts,
               audits_access, paycor_employee_id
        FROM users WHERE id = ${row.id}
      `;
```

- [ ] **Step 2: Return it to the client**

In `toClient` (`netlify/functions/users.mjs:37-66`), add one line (right after `auditsAccess:` at line 64):

```js
    paycorEmployeeId:   row.paycor_employee_id ?? null,
```

- [ ] **Step 3: Also add it to the `list` action's SELECT (Ruling — see plan pre-flight note)**

`toClient` is shared between `create`'s response and `list`'s response, but `list` has its own separate `SELECT` (`netlify/functions/users.mjs:106-113`) that does not go through `create`'s query — it needs the column added too, or every user's `paycorEmployeeId` comes back `null` in the app's main `users` list regardless of the real stored value, which would silently break Task 5's "already linked" check for every user except one freshly created in the same browser session:

```js
      const rows = await db`
        SELECT id, username, name, email, phone, role, user_type, district, store_pc,
               active, dark_mode, avatar_url, google_id, last_login, created_at,
               initials, is_admin, must_setup, region,
               two_factor_required, two_factor_enabled, must_change, locked, failed_attempts,
               audits_access, paycor_employee_id
        FROM users ORDER BY id
      `;
```

- [ ] **Step 4: Syntax-check**

Run: `node --check netlify/functions/users.mjs`
Expected: no output.

- [ ] **Step 5: Manual verification**

There's no existing test harness for `users.mjs` (it's a thin HTTP handler over the DB, not a pure module) and adding one is out of scope for this task. Verify by hand once deployed: (1) create a manager account through the Admin · Users "+ Add User" form as normal (no `paycorEmployeeId` in the payload from today's UI yet — Task 5 adds that), confirm the existing create flow still works exactly as before (this is a backward-compatible column addition; `u.paycorEmployeeId` is `undefined` from today's UI, so `u.paycorEmployeeId || null` correctly inserts `null`); (2) confirm the main Users list still loads normally (the `list` action's added column is additive/backward-compatible).

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/users.mjs
git commit -m "feat(manager-sync): users.mjs accepts and returns paycorEmployeeId"
```

---

### Task 5: Admin · Users — pending indicator, pre-filled create, suggested deactivate

**Files:**
- Modify: `app.jsx` (`AdminUsers`, starting `app.jsx:3319`)

**Interfaces:**
- Consumes: `openEditPage` (`app.jsx:3438`, already exists — a prefill object with no `id` field is already treated as "create new"), `toggleActive` (`app.jsx:3509`, already exists), `cloudLoad`/`cloudSave` (already used throughout this file for every other admin-managed blob), `suggestUsername`/`generatePassword` (Task 2, imported at the top of `app.jsx` the same way other `src/*.mjs` pure modules are — check the existing import block at the top of `app.jsx` for the pattern and add these two alongside).

- [ ] **Step 1: Load the pending blob**

Inside `AdminUsers` (`app.jsx:3319`), near its other `useState`/`useEffect` calls:

```js
  // Paycor-driven manager-change queue (see docs/superpowers/specs/2026-09-22-manager-sync-design.md).
  // Read directly from the blob labor-cron.mjs writes — same pattern every other admin
  // panel in this app already uses for its own config blob (no dedicated endpoint needed).
  const [managerPending, setManagerPending] = useState({}); // pc -> { kind, candidate?, outgoingUserId?, outgoingName?, ... }
  const loadManagerPending = () => cloudLoad('pcg_manager_pending_v1').then(d => setManagerPending(d && typeof d === 'object' ? d : {})).catch(() => {});
  useEffect(() => { loadManagerPending(); }, []);
  const dismissManagerPending = async (pc) => {
    const next = { ...managerPending };
    delete next[pc];
    const ok = await cloudSave('pcg_manager_pending_v1', next);
    if (ok) setManagerPending(next);
  };
```

- [ ] **Step 2: Render the pending indicator + list**

Right after the existing "N Active" pill (`app.jsx:3757-3760`), add a sibling pill that only renders when there's something pending:

```jsx
        {Object.keys(managerPending).length > 0 && (
          <div style={{ display:"inline-flex", alignItems:"center", gap:"0.45rem", padding:"0.5rem 0.85rem", background:"#f59e0b22", border:"1px solid #f59e0b55", borderRadius:999, fontSize:"0.68rem", color:"#f59e0b", fontWeight:800, textTransform:"uppercase", letterSpacing:0.7 }}>
            <span style={{ width:6, height:6, borderRadius:"50%", background:"#f59e0b" }} />
            {Object.keys(managerPending).length} Pending
          </div>
        )}
```

Then, as its own block above the main user table/list (find the container that wraps the table — the same parent that already holds the search/filter bar at `app.jsx:3745-3778`), add:

```jsx
      {Object.entries(managerPending).map(([pc, item]) => {
        const store = stores.find(s => String(s.pc) === pc);
        const storeName = store?.name || pc;
        if (item.kind === 'replace') {
          const alreadyLinked = users.some(u => u.paycorEmployeeId === item.candidate.employeeId && u.active !== false);
          const oldDeactivated = item.outgoingUserId ? users.find(u => u.id === item.outgoingUserId)?.active === false : true;
          if (alreadyLinked && oldDeactivated) return null; // resolved — next labor-cron run clears the blob itself
          return (
            <div key={pc} style={{ ...card(th), padding:"0.85rem 1rem", marginBottom:"0.6rem", borderLeft:"3px solid #f59e0b" }}>
              <div style={{ fontSize:"0.85rem", color:th.text, marginBottom:"0.5rem" }}>
                <strong>{storeName}:</strong> Paycor shows <strong>{item.candidate.name}</strong> ({item.candidate.jobTitle}) now managing this store{item.outgoingName ? <> — was <strong>{item.outgoingName}</strong></> : null}.
              </div>
              <div style={{ display:"flex", gap:"0.5rem", flexWrap:"wrap" }}>
                {/* No email pre-fill — Paycor's personal-email field isn't used (dropped
                    2026-09-22). The admin types one in on the form before saving, same as
                    creating any other user today. */}
                {!alreadyLinked && (
                  <button onClick={() => {
                    const existingUsernames = users.map(u => u.username);
                    openEditPage({
                      name: item.candidate.name,
                      userType: 'manager',
                      storePC: pc,
                      username: suggestUsername(item.candidate.name, existingUsernames),
                      password: generatePassword(),
                      paycorEmployeeId: item.candidate.employeeId,
                    });
                  }} style={btn(th, { padding:"0.45rem 0.9rem", fontSize:"0.75rem" })}>
                    Create Account
                  </button>
                )}
                {item.outgoingUserId && !oldDeactivated && (
                  <button onClick={() => toggleActive(item.outgoingUserId)} style={btn(th, { padding:"0.45rem 0.9rem", fontSize:"0.75rem", background:th.card3, color:th.text })}>
                    Deactivate {item.outgoingName}
                  </button>
                )}
                <button onClick={() => dismissManagerPending(pc)} style={{ background:"none", border:"none", color:th.muted, fontSize:"0.75rem", cursor:"pointer" }}>Dismiss</button>
              </div>
            </div>
          );
        }
        const text = item.kind === 'needsReview'
          ? `${storeName}: multiple active employees hold a manager title — needs a human decision.`
          : `${storeName}: no active employee has held a manager title for 3+ weeks.`;
        return (
          <div key={pc} style={{ ...card(th), padding:"0.85rem 1rem", marginBottom:"0.6rem", borderLeft:"3px solid #f59e0b" }}>
            <div style={{ fontSize:"0.85rem", color:th.text, marginBottom:"0.5rem" }}>{text}</div>
            <button onClick={() => dismissManagerPending(pc)} style={{ background:"none", border:"none", color:th.muted, fontSize:"0.75rem", cursor:"pointer" }}>Dismiss</button>
          </div>
        );
      })}
```

- [ ] **Step 3: Import the two pure helpers**

Find the existing import block at the top of `app.jsx` (search for an existing `import { ... } from './src/`-style line, e.g. wherever icons/theme are imported) and add:

```js
import { suggestUsername, generatePassword } from './src/manager-sync.mjs';
```

- [ ] **Step 4: Rebuild and manually verify**

```bash
npm run build
```

Bump `APP_VERSION` (search `const APP_VERSION =` in `app.jsx`) per the project's versioning convention before building, per `CLAUDE.md`.

Manual check (no automated test harness exists for `app.jsx`'s UI — verify visually per the project's established workflow):
1. Manually write a test entry into the `pcg_manager_pending_v1` blob (via the browser console, using the existing generic storage endpoint the same way other admin panels' blobs are written) with a `replace` item for a real store pc.
2. Confirm the "N Pending" pill appears next to "Active", the banner renders with the right store/name text, and clicking "Create Account" opens the Add User form pre-filled with the suggested username, a valid-looking generated password, the candidate's name, and the store's pc — matching what `openEditPage` already does for editing an existing user, just with no `id`.
3. Confirm "Dismiss" removes the banner and clears that key from the blob.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(manager-sync): pending-change banner + pre-filled create on Admin · Users (vX.XX)"
```

(Fill in the real version number from Step 4.)

---

### Task 6: Bell notification routing

**Files:**
- Modify: `app.jsx` (notification click handler, `app.jsx:51059-51075`; `meta` icon table, `app.jsx:51020-51025`)

- [ ] **Step 1: Add the icon/tint entry**

In the `meta` object (`app.jsx:51020-51025`):

```js
                    manager_change_pending: { emoji: "👤", tint: "#f59e0b" },
```

- [ ] **Step 2: Add the click-routing branch**

In the notification click handler (`app.jsx:51062-51071`), the existing structure is:

```js
                        <div key={n.id} onClick={() => {
                          setNotifications(ns => ns.map(nn => nn.id === n.id ? { ...nn, read: true } : nn));
                          if (n.type === "pos_negative_total" && n.storePC) {
                            txnDeepLinkRef.current = { date: n.date, chkNum: (n.chkNums && n.chkNums.length === 1) ? n.chkNums[0] : null };
                            setDrillInStore(n.storePC);
                            setTab("pulse");
                          } else {
                            setTab(n.type === "new_ticket" ? "tickets" : "projects");
                          }
                          setShowNotifs(false);
                        }}
```

Add a branch before the final `else`:

```js
                        <div key={n.id} onClick={() => {
                          setNotifications(ns => ns.map(nn => nn.id === n.id ? { ...nn, read: true } : nn));
                          if (n.type === "pos_negative_total" && n.storePC) {
                            txnDeepLinkRef.current = { date: n.date, chkNum: (n.chkNums && n.chkNums.length === 1) ? n.chkNums[0] : null };
                            setDrillInStore(n.storePC);
                            setTab("pulse");
                          } else if (n.type === "manager_change_pending") {
                            setTab("users");
                          } else {
                            setTab(n.type === "new_ticket" ? "tickets" : "projects");
                          }
                          setShowNotifs(false);
                        }}
```

- [ ] **Step 3: Rebuild**

```bash
npm run build
```

- [ ] **Step 4: Manual verification**

Write a test entry into `pcg_notifications_v1` (browser console, same generic storage write used elsewhere) with `{ id: 'test1', type: 'manager_change_pending', storePC: '339616', message: 'test' }`, confirm it shows the 👤 icon in the bell dropdown and clicking it navigates to Admin · Users.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(manager-sync): bell notification routing for manager_change_pending"
```

---

### Task 7: Migration + deploy

**Files:** none new — this is the rollout sequence for the schema change from Task 1 and everything else.

- [ ] **Step 1: Confirm every prior task is pushed**

All of Tasks 1–7's commits should be on `main` (ask the user before each push, per project convention — `git push IS the prod deploy`).

- [ ] **Step 2: Trigger the migration**

Per `CLAUDE.md`'s documented manual trigger: `POST /.netlify/functions/db-migrate` (30s timeout). This adds the `paycor_employee_id` column. Must run before the next `labor-cron` invocation that would try to read/write it, ideally right after Task 1's deploy goes live (don't wait until Task 3-6 are also live — the column addition is harmless and additive on its own).

- [ ] **Step 3: Watch the first live labor-cron run**

After Task 3-6 are deployed, watch the function logs for `[manager-sync]` lines on the next scheduled `labor-cron` run (`0 9-23,0-3 * * *` per `netlify.toml`). Expect mostly silent bootstrap-linking (no notifications) for stores whose current manager's name corresponds to Paycor's, and confirm at least one legitimate `replace`/`needsReview`/`vacant` case (if any exist in real data) produces the expected banner on Admin · Users and bell notification.

---

## Self-Review Notes

- **Spec coverage:** manager-title rule (`isManagerTitle`), no new Paycor calls (Task 3 Step 1 reuses `employees`), replace/needsReview/zeroMatch + 3-week vacant threshold (`detectManagerCandidate`, `advanceVacantStreak`), identity link + bootstrap linking (`paycor_employee_id` column, `namesCorrespond`, Task 3's bootstrap block), no-email-pre-fill (dropped 2026-09-22 — Task 5's Create Account button no longer pre-fills or checks for one; the admin types an email in on the existing form), deactivate-not-delete (`toggleActive` reuse), nothing automatic beyond detection (every action in Task 5 is a manual click), pending blob shape and clearing (Task 3 + Task 5's live-resolved check), bell notification + Users-page surfacing (Tasks 3, 5, 6), username/password generation rule (Task 2).
- **Out of scope, matching the spec:** no bulk backfill migration tool (bootstrap linking happens organically per Task 3), no SMS/email beyond the existing bell mechanism, no pending-history browsing UI.
