# Office Hourly Time Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Supersedes `2026-09-30-crew-time-clock.md` (removed) — that plan was built around
> the wrong population (Dunkin' store hourly "crew") and included an entire new
> account type, PIN login, and minors guardrail that do not apply here. The real
> population is hourly `office_staff`, who already have normal Portal accounts.

**Goal:** Give hourly office staff a new tab, inside their existing Portal login, for
clock-in / meal-start / meal-end / clock-out, captured in real time in our own
database — then let IT/exec review each closed biweekly pay period and push it to
Paycor's `CreatePunches` API with one button, before a hard lock at the same
Tuesday-night payroll deadline the existing tips flow already uses.

**Architecture:** No new account type or login. A per-user flag (`clock_enabled`) on
the existing `users` table — same shape as the existing `audits_access` grant — turns
on a new tab for a specific office_staff account. Live punches never touch Paycor —
they land in a new `office_clock_punches` table instantly. Once a pay period closes,
IT/exec reviews and edits punches across every enabled user, then triggers a
background function that batches the period into one `CreatePunches` call, polls
Paycor's async error log with correct 2xx/404/other semantics, and records the real
per-punch outcome.

**Tech Stack:** Netlify Functions (`.mjs`), Neon Postgres (self-creating tables,
idempotent `ALTER`/`CREATE ... IF NOT EXISTS`), React 18 (`app.jsx`), existing
`auth-lib` session infrastructure (entirely unchanged — no new auth code anywhere in
this plan).

**Spec:** `docs/superpowers/specs/2026-10-01-office-hourly-time-clock-design.md`

## Global Constraints

- **No new userType, no new login, no PIN, no minors logic anywhere in this plan.**
  Office staff already log in exactly as they do today; this feature only adds a
  tab some of them see.
- Two new `users` columns: `paycor_department_id` (text, nullable — sibling to the
  existing `paycor_employee_id`) and `clock_enabled` (boolean, default false), added
  via idempotent `ALTER TABLE users ADD COLUMN IF NOT EXISTS`, matching `users.mjs`'s
  existing column-ensure pattern.
- `clock_enabled` is modeled exactly like the existing `audits_access` grant in
  `users.mjs`'s `update` action: a "was this field provided at all" check (so a
  patch that doesn't touch it never clobbers it), a validity check, and an
  exec/it-only permission check — follow that existing code's shape, don't invent a
  new one.
- **Hourly status is never stored.** It's read live from the matched Paycor
  employee's `statusData.flsa` field (`HourlyNonExempt` vs anything else) at link
  time and shown to IT as a plain suggestion — `clock_enabled` is IT's own decision,
  not an automatic consequence of FLSA status.
- Reuse `fetchAllEmployees`/`fetchAllIdentifyingData` (exported from
  `tips-report-cron-background.mjs`) is **not** needed here for identifyingData (no
  birthDate/minor concern at all) — only `fetchAllEmployees` is reused, for the
  office/corporate legal entity's active roster.
- Reuse `BIWEEKLY_ANCHOR_END`, `isBiweekBoundary`, `weekEndForTrigger`,
  `dateRangeEndingAt` (import directly from `tips-report-cron-background.mjs`) for
  every pay-period boundary calculation — do not define a second biweekly anchor.
- **Punch mapping** (fixed):
  | Button | `PunchStatusType` | `ActivityTypeId` |
  |---|---|---|
  | Clock In | `In` | Work |
  | Meal Start | `Out` | Meal |
  | Meal End | `In` | Work |
  | Clock Out | `Out` | Work |
- New Paycor proxy actions (`activityTypes`, `createPunches`, `punchErrorLog`) go in
  `paycor.mjs` as their own named, server-validated actions — never through the
  generic `raw` proxy, which stays GET-only by deliberate design.
- `CreatePunches`/`punchErrorLog` resolution semantics: only a 2xx response from
  `punchErrorLog` is resolved (and may still carry per-record errors inside); 404
  means still processing, keep polling; any other status (401/403/500) is unresolved
  and must **never** be read as success.
- New tables (`office_clock_punches`, `office_clock_pay_period_sends`,
  `office_clock_activity_types`) are **self-created** (`CREATE TABLE IF NOT EXISTS`)
  inside their owning function, matching `audits.mjs`/`safe-audits.mjs`/`tickets.mjs`
  — not the older `db-migrate.js`-driven convention. `db/schema.ts` gets
  documentation-only entries.
- **Lock state is computed, never stored.** `isPeriodLocked(periodEndDate, now)` is a
  pure function; there is no cron that flips a flag.
- **Task 1's Controlled Test is never run by a dispatched subagent.** The task
  delivers code + unit tests only. The one live POST against production Paycor is
  performed by the controller directly, after an explicit go/no-go from the human.
- **The office/corporate Paycor legal entity ID** is required before Task 4 can run
  against real data. If not yet supplied when Task 4 starts, that is a `NEEDS_CONTEXT`
  stop, not a guess.
- Bump `APP_VERSION` and run `npm run build` in the final frontend task.
- Every new tab/screen gets its own distinct `ICONS.xxx` entry (see
  [[feedback_unique_tab_icons]]).

---

### Task 1: Paycor write actions (`createPunches`, `punchErrorLog`, `activityTypes`)

**Files:**
- Modify: `netlify/functions/paycor.mjs` (add three actions near the existing
  `employeePunches`/`payGroups` actions, ~line 704)
- Create: `src/paycor-punch-resolve.mjs` (pure resolution-semantics helper)
- Create: `src/paycor-punch-resolve.test.mjs`

**Interfaces:**
- Consumes: `callPaycor(path, method, body, version)` (existing)
- Produces: `resolvePunchLogResponse(status, body)` — consumed by Task 6's
  background send function; `paycor.mjs` actions `activityTypes`, `createPunches`,
  `punchErrorLog`

This task is identical regardless of population — it's purely about Paycor's own
API contract.

- [ ] **Step 1: Write the pure resolution-semantics helper and its failing tests**

```js
// src/paycor-punch-resolve.mjs
// Pure decision logic for interpreting a punchErrorLog poll response. No network
// or DB I/O here — the background send function (Task 6) is the only caller that
// actually makes the HTTP request.
//
// A real third-party Paycor integration's bug history (alexrelintex/timeclock PR
// #33, cited in the design spec) shows the dangerous mistake here: treating any
// non-404 response as "clean success" silently recorded 401/403/500 errors as
// successful punches. The correct rule, encoded below: only a genuine 2xx resolves
// anything; 404 means "still processing"; everything else is unresolved and must
// never be read as success.

// Returns one of:
//   { state: 'pending' }                                  — 404, keep polling
//   { state: 'unresolved', reason }                        — any other non-2xx
//   { state: 'resolved', succeeded: [...], failed: [...] } — 2xx, per-record outcome
export function resolvePunchLogResponse(status, body) {
  if (status === 404) return { state: 'pending' };
  if (status < 200 || status >= 300) {
    return { state: 'unresolved', reason: `HTTP ${status}` };
  }
  const records = (body && (body.records || body.Records)) || [];
  const succeeded = [];
  const failed = [];
  for (const r of records) {
    const errs = (r && (r.errors || r.Errors)) || [];
    if (Array.isArray(errs) && errs.length > 0) {
      failed.push({ record: r, errors: errs });
    } else {
      succeeded.push(r);
    }
  }
  return { state: 'resolved', succeeded, failed };
}
```

```js
// src/paycor-punch-resolve.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePunchLogResponse } from './paycor-punch-resolve.mjs';

test('404 is pending, never resolved', () => {
  assert.deepEqual(resolvePunchLogResponse(404, null), { state: 'pending' });
});

test('401 is unresolved, not success (the real bug this guards against)', () => {
  assert.equal(resolvePunchLogResponse(401, { error: 'unauthorized' }).state, 'unresolved');
});

test('403 is unresolved, not success', () => {
  assert.equal(resolvePunchLogResponse(403, {}).state, 'unresolved');
});

test('500 is unresolved, not success', () => {
  assert.equal(resolvePunchLogResponse(500, {}).state, 'unresolved');
});

test('200 with no records resolves with nothing succeeded or failed', () => {
  assert.deepEqual(resolvePunchLogResponse(200, { records: [] }), { state: 'resolved', succeeded: [], failed: [] });
});

test('200 with a mix of clean and errored records splits them correctly', () => {
  const body = { records: [{ punchId: 'p1' }, { punchId: 'p2', errors: ['Invalid DepartmentId'] }] };
  const r = resolvePunchLogResponse(200, body);
  assert.equal(r.state, 'resolved');
  assert.equal(r.succeeded.length, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].record.punchId, 'p2');
});

test('handles PascalCase Records/Errors shape too', () => {
  const body = { Records: [{ PunchId: 'p1', Errors: ['bad'] }] };
  assert.equal(resolvePunchLogResponse(200, body).failed.length, 1);
});
```

- [ ] **Step 2: Run the tests and confirm they pass**

Run: `node --test src/paycor-punch-resolve.test.mjs`
Expected: 6 passing, 0 failing.

- [ ] **Step 3: Add the three new actions to `paycor.mjs`**

Add immediately after the existing `employeePunches` action (~line 715):

```js
    // ── Proxy: activity types for a legal entity (Work/Meal/Break GUIDs) ──
    // Read-only. Used once, at office-clock enable time, to populate the
    // office_clock_activity_types cache (Task 3) — never re-fetched per punch.
    if (action === 'activityTypes') {
      const { legalEntityId } = payload;
      if (!legalEntityId) return new Response(JSON.stringify({ error: 'Missing legalEntityId' }), { status: 400, headers });
      const res = await callPaycor(`/legalentities/${legalEntityId}/activityTypes`);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Write: create time card punches for a legal entity ──────────────────────
    // POST /v1/legalentities/{legalEntityId}/CreatePunches
    // Body: array of { EmployeeId, DepartmentId, PunchDateTime, PunchStatusType,
    // ActivityTypeId, Note? }. Returns a tracking ID immediately — the real outcome
    // is only knowable via the separate punchErrorLog action below. Auth-gated
    // exec/it, matching createSchedulingShifts's pattern.
    if (action === 'createPunches') {
      const authedUser = await requireActiveUser(authEvent, sqlClient);
      if (!authedUser || (authedUser.userType !== 'executive' && authedUser.userType !== 'it')) {
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers });
      }
      const { legalEntityId, punches } = payload;
      if (!legalEntityId) return new Response(JSON.stringify({ error: 'Missing legalEntityId' }), { status: 400, headers });
      if (!Array.isArray(punches) || punches.length === 0) return new Response(JSON.stringify({ error: 'Missing punches array' }), { status: 400, headers });
      const res = await callPaycor(`/legalentities/${legalEntityId}/CreatePunches`, 'POST', punches);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Proxy: punch error log for a CreatePunches tracking ID ──────────────────
    // GET /v1/legalentities/{legalEntityId}/punchErrorLog/{trackingId}
    // Callers MUST interpret this via resolvePunchLogResponse (src/paycor-punch-
    // resolve.mjs) — never treat a bare non-2xx-but-non-404 response as success.
    if (action === 'punchErrorLog') {
      const { legalEntityId, trackingId } = payload;
      if (!legalEntityId || !trackingId) return new Response(JSON.stringify({ error: 'Missing legalEntityId or trackingId' }), { status: 400, headers });
      const res = await callPaycor(`/legalentities/${legalEntityId}/punchErrorLog/${trackingId}`);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }
```

Check how `authEvent`/`sqlClient` are named in this file's existing
`createSchedulingShifts`-style action (~line 474) before wiring this in — reuse
whatever the existing local variable names are.

- [ ] **Step 4: Confirm the file still parses and existing tests still pass**

Run: `node --check netlify/functions/paycor.mjs`
Run: `node --test src/paycor-punch-resolve.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/paycor.mjs src/paycor-punch-resolve.mjs src/paycor-punch-resolve.test.mjs
git commit -m "feat(office-clock): add Paycor createPunches/punchErrorLog/activityTypes actions"
```

**STOP — do not proceed to Task 2 yet.** After this task's review passes, the
controller must perform the Controlled Test directly (one real Clock In punch to
Ahmed's own Bustleton record, confirmed via the `punchErrorLog` poll), with an
explicit go/no-go from the human immediately before that call. Task 2 onward
assumes the result is known — correct Step 3's action code above if the real API
disagrees with it in any way once tested.

---

### Task 2: Pure logic module — punch mapping, pay periods, lock, incomplete-day detection

**Files:**
- Create: `src/office-clock-lib.mjs`
- Create: `src/office-clock-lib.test.mjs`

**Interfaces:**
- Consumes: `isBiweekBoundary`, `weekEndForTrigger`, `dateRangeEndingAt`,
  `BIWEEKLY_ANCHOR_END` (import from `../netlify/functions/tips-report-cron-background.mjs`)
- Produces: `punchStatusAndActivity`, `payPeriodEndFor`, `isPeriodLocked`,
  `findIncompleteDays` — consumed by Tasks 4, 5, 6, 8.

Population-agnostic — identical logic to what any time-clock feature in this
codebase would need.

- [ ] **Step 1: Write the failing tests**

```js
// src/office-clock-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  punchStatusAndActivity, payPeriodEndFor, isPeriodLocked, findIncompleteDays,
} from './office-clock-lib.mjs';

test('punchStatusAndActivity maps all four buttons correctly', () => {
  assert.deepEqual(punchStatusAndActivity('clock_in'), { status: 'In', activity: 'Work' });
  assert.deepEqual(punchStatusAndActivity('meal_start'), { status: 'Out', activity: 'Meal' });
  assert.deepEqual(punchStatusAndActivity('meal_end'), { status: 'In', activity: 'Work' });
  assert.deepEqual(punchStatusAndActivity('clock_out'), { status: 'Out', activity: 'Work' });
});

test('punchStatusAndActivity throws on an unknown button type', () => {
  assert.throws(() => punchStatusAndActivity('lunch'), /unknown punch type/i);
});

test('payPeriodEndFor resolves a date to the correct closing Saturday', () => {
  assert.equal(payPeriodEndFor('2026-08-15'), '2026-08-15');
  assert.equal(payPeriodEndFor('2026-08-02'), '2026-08-15');
  assert.equal(payPeriodEndFor('2026-08-16'), '2026-08-29');
  assert.equal(payPeriodEndFor('2026-08-29'), '2026-08-29');
});

test('isPeriodLocked is false right up through Tuesday-night close-of-day, true after', () => {
  const periodEnd = '2026-08-15';
  assert.equal(isPeriodLocked(periodEnd, new Date('2026-08-16T12:00:00Z')), false);
  assert.equal(isPeriodLocked(periodEnd, new Date('2026-08-17T12:00:00Z')), false);
  assert.equal(isPeriodLocked(periodEnd, new Date('2026-08-18T20:00:00Z')), false);
  assert.equal(isPeriodLocked(periodEnd, new Date('2026-08-19T00:00:01Z')), true);
});

test('findIncompleteDays flags a clock-in with no matching clock-out', () => {
  const punches = [{ punchType: 'clock_in', capturedAt: '2026-08-10T13:00:00Z' }];
  const days = findIncompleteDays(punches);
  assert.equal(days.length, 1);
  assert.equal(days[0].reason, 'open_clock_in');
});

test('findIncompleteDays does not flag a complete in/out pair', () => {
  const punches = [
    { punchType: 'clock_in', capturedAt: '2026-08-10T13:00:00Z' },
    { punchType: 'clock_out', capturedAt: '2026-08-10T21:00:00Z' },
  ];
  assert.deepEqual(findIncompleteDays(punches), []);
});

test('findIncompleteDays flags a meal_start with no matching meal_end', () => {
  const punches = [
    { punchType: 'clock_in', capturedAt: '2026-08-10T13:00:00Z' },
    { punchType: 'meal_start', capturedAt: '2026-08-10T17:00:00Z' },
    { punchType: 'clock_out', capturedAt: '2026-08-10T21:00:00Z' },
  ];
  const days = findIncompleteDays(punches);
  assert.equal(days.length, 1);
  assert.equal(days[0].reason, 'open_meal');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/office-clock-lib.test.mjs`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement**

```js
// src/office-clock-lib.mjs
// Pure logic for the Office Hourly Time Clock feature — no network or DB I/O.
import {
  isBiweekBoundary, weekEndForTrigger, dateRangeEndingAt, BIWEEKLY_ANCHOR_END,
} from '../netlify/functions/tips-report-cron-background.mjs';

const BUTTON_MAP = {
  clock_in: { status: 'In', activity: 'Work' },
  meal_start: { status: 'Out', activity: 'Meal' },
  meal_end: { status: 'In', activity: 'Work' },
  clock_out: { status: 'Out', activity: 'Work' },
};

export function punchStatusAndActivity(buttonType) {
  const m = BUTTON_MAP[buttonType];
  if (!m) throw new Error(`unknown punch type: ${buttonType}`);
  return { ...m };
}

function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// The Saturday that closes the biweekly pay period containing dateStr. Walks
// forward/backward from BIWEEKLY_ANCHOR_END in 14-day steps rather than
// re-deriving the anchor math independently, so this can never drift out of
// sync with tips-report-cron-background.mjs's own period boundaries.
export function payPeriodEndFor(dateStr) {
  const anchor = parseDateOnly(BIWEEKLY_ANCHOR_END);
  const target = parseDateOnly(dateStr);
  const diffDays = Math.round((target - anchor) / 86400000);
  const periodIndex = Math.floor(diffDays / 14);
  const end = new Date(anchor);
  end.setUTCDate(end.getUTCDate() + periodIndex * 14);
  return toDateStr(end);
}

// True once "now" is past the Tuesday-night deadline that closes out editing/
// sending for the pay period ending on periodEndDate. Tuesday is 3 days after
// Saturday; "night" is the end of that Tuesday in UTC (00:00:00 UTC the
// following Wednesday) — a plain, unambiguous UTC boundary.
export function isPeriodLocked(periodEndDate, now) {
  const end = parseDateOnly(periodEndDate);
  const lockAt = new Date(end);
  lockAt.setUTCDate(lockAt.getUTCDate() + 4);
  return now.getTime() >= lockAt.getTime();
}

// Flags days where a punch sequence is incomplete: an open clock-in with no
// later clock-out that same day, or an open meal_start with no later meal_end
// that same day. `punches` is one employee's punches for a period (or a day),
// each { punchType, capturedAt (ISO string) }, in any order.
export function findIncompleteDays(punches) {
  const sorted = [...punches].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
  const byDay = new Map();
  for (const p of sorted) {
    const day = p.capturedAt.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p);
  }
  const issues = [];
  for (const [day, dayPunches] of byDay) {
    let clockedIn = false;
    let onMeal = false;
    for (const p of dayPunches) {
      if (p.punchType === 'clock_in') clockedIn = true;
      if (p.punchType === 'clock_out') clockedIn = false;
      if (p.punchType === 'meal_start') onMeal = true;
      if (p.punchType === 'meal_end') onMeal = false;
    }
    if (onMeal) { issues.push({ day, reason: 'open_meal' }); continue; }
    if (clockedIn) issues.push({ day, reason: 'open_clock_in' });
  }
  return issues;
}

export { isBiweekBoundary, weekEndForTrigger, dateRangeEndingAt, BIWEEKLY_ANCHOR_END };
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test src/office-clock-lib.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add src/office-clock-lib.mjs src/office-clock-lib.test.mjs
git commit -m "feat(office-clock): add pure punch-mapping/pay-period/lock/incomplete-day logic"
```

---

### Task 3: `users` table support — `paycor_department_id` + `clock_enabled`

**Files:**
- Modify: `netlify/functions/users.mjs` (ensure new columns; extend `update` action)
- Modify: `db/schema.ts` (document the two new columns)

No PIN, no password changes, no new account fields beyond these two — this task is
much smaller than the first draft's equivalent.

- [ ] **Step 1: Add the two new `users` columns, idempotently**

Find `users.mjs`'s existing idempotent column-ensure logic (the same one that
presumably already added `audits_access`) and add a sibling call:

```js
// Office Hourly Time Clock: paycor_department_id mirrors paycor_employee_id's
// existing pattern. clock_enabled is the per-user opt-in flag — same shape as
// audits_access, a capability some users in a role have and others don't.
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS paycor_department_id TEXT`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS clock_enabled BOOLEAN NOT NULL DEFAULT false`;
```

- [ ] **Step 2: Extend the `update` action**

In the existing `update` action (~line 196), model this exactly on the existing
`audits_access` handling immediately above it (same "was this provided at all"
check, same permission check, same separate dedicated UPDATE so COALESCE can't
hide an explicit `false`):

```js
      // clock_enabled grant: only executive/it may change it, and only for
      // office_staff accounts — mirrors the audits_access handling directly above.
      const clockEnabledProvided = Object.prototype.hasOwnProperty.call(patch, 'clockEnabled');
      if (clockEnabledProvided) {
        if (typeof patch.clockEnabled !== 'boolean') return reply(400, { error: 'invalid clockEnabled' });
        if (!isFullAdmin(claims)) return reply(403, { error: 'only executive/IT can change clock access' });
        const effType = patch.userType || target.user_type;
        if (patch.clockEnabled && effType !== 'office_staff') {
          return reply(400, { error: 'clock access is only available to office_staff accounts' });
        }
      }
```

And, alongside the existing separate `audits_access` UPDATE statement:

```js
      if (clockEnabledProvided) {
        await db`UPDATE users SET clock_enabled = ${patch.clockEnabled}, updated_at = now() WHERE id = ${id}`;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'paycorDepartmentId')) {
        await db`UPDATE users SET paycor_department_id = ${patch.paycorDepartmentId || null}, updated_at = now() WHERE id = ${id}`;
      }
```

Check whether `paycor_employee_id` is already settable through this same `update`
action's main COALESCE block further down. If it is not, add it there the same way
— Task 4's linking flow needs to set both `paycorEmployeeId` and
`paycorDepartmentId` on an existing user via this one `update` call.

Also extend whatever `SELECT`/`toClient` projection this file uses to return a
user's current state (the same one `create` uses, ~line 79) to include
`clockEnabled: row.clock_enabled` and `paycorDepartmentId: row.paycor_department_id ?? null`, so the admin UI (Task 8) can read them back.

- [ ] **Step 3: Update `db/schema.ts`**

```ts
  paycorDepartmentId: text("paycor_department_id"), // Office Hourly Time Clock: matches paycor_employee_id's pattern
  clockEnabled: boolean("clock_enabled").notNull().default(false), // Office Hourly Time Clock: per-user opt-in, same shape as auditsAccess
```

- [ ] **Step 4: Verify**

Run: `node --check netlify/functions/users.mjs`
Manually trace: a `patch: { clockEnabled: true }` against a `manager`-type user id
must be rejected (400) before any UPDATE runs.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/users.mjs db/schema.ts
git commit -m "feat(office-clock): add clock_enabled/paycor_department_id to users.mjs"
```

---

### Task 4: Office roster + account-linking endpoint (`office-clock-roster.mjs`)

**Files:**
- Create: `netlify/functions/office-clock-roster.mjs`

**Interfaces:**
- Consumes: `fetchAllEmployees` (import from `./tips-report-cron-background.mjs`),
  `requireActiveUser`
- Produces: `POST { action: 'linkable', legalEntityId }` →
  `{ employees: [{ paycorEmployeeId, name, jobTitle, departmentId, isHourly, linkedUserId }] }`

**If the office/corporate legal entity ID has not been supplied by this point,
this task is a `NEEDS_CONTEXT` stop — do not guess a value.**

- [ ] **Step 1: Implement `linkable`**

Auth-gate exec/it only (same shape as Task 1's `createPunches` check).
1. Call `fetchAllEmployees(legalEntityId)`, filter to `statusData.status === 'Active'`.
2. Query `SELECT id, name, paycor_employee_id FROM users WHERE user_type = 'office_staff'`.
3. For each active Paycor employee, try to match an existing `office_staff` row —
   first by `paycor_employee_id` if already linked, otherwise by name (same
   match-by-name approach already established elsewhere in this codebase for Paycor
   employee matching, since employee GUIDs differ across Paycor endpoints).
4. For each: `isHourly = e.statusData?.flsa === 'HourlyNonExempt'`,
   `departmentId = e.department?.id || null`. Return
   `{ paycorEmployeeId: e.id, name, jobTitle: e.positionData?.jobTitle || '', departmentId, isHourly, linkedUserId: <matched users.id or null> }`.
5. An employee with no matching `office_staff` user at all is still returned (with
   `linkedUserId: null`) so IT can see "this Paycor employee has no office_staff
   Portal account yet" rather than it silently disappearing — but linking still
   requires an existing account; this endpoint never creates one.

- [ ] **Step 2: Verify**

Run: `node --input-type=module -e "import('./netlify/functions/office-clock-roster.mjs').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1); })"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/office-clock-roster.mjs
git commit -m "feat(office-clock): add office roster + account-matching endpoint"
```

---

### Task 5: Live punch capture (`office-clock-punch.mjs`)

**Files:**
- Create: `netlify/functions/office-clock-punch.mjs`

**Interfaces:**
- Consumes: `requireActiveUser`, `payPeriodEndFor` (from `../src/office-clock-lib.mjs`)
- Produces:
  - `POST { action: 'punch', punchType }` (authenticated `office_staff` user with
    `clock_enabled = true`) → `{ ok: true, punch: {...} }`
  - `POST { action: 'today' }` → `{ punches: [...] }`

- [ ] **Step 1: Self-create the `office_clock_punches` table idempotently**

```sql
CREATE TABLE IF NOT EXISTS office_clock_punches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL,
  punch_type TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  pay_period_end DATE NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  edited_by TEXT,
  paycor_status TEXT NOT NULL DEFAULT 'unsent',
  paycor_tracking_id TEXT,
  paycor_punch_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

- [ ] **Step 2: Implement `punch`**

1. `requireActiveUser` — must be `userType === 'office_staff'`. Also fetch
   `clock_enabled` for this user id and reject (403) if it's not `true` — an
   account losing this flag must immediately lose the ability to punch, not just
   lose the tab in the UI.
2. Server captures `capturedAt = new Date()` right now — never trust a
   client-supplied timestamp.
3. `payPeriodEnd = payPeriodEndFor(capturedAt.toISOString().slice(0, 10))`.
4. Insert the row, return it.

- [ ] **Step 3: Implement `today`**

`SELECT * FROM office_clock_punches WHERE user_id = ${claims.sub} AND captured_at >= ${startOfTodayLocal} ORDER BY captured_at ASC`.

- [ ] **Step 4: Verify**

Run: `node --input-type=module -e "import('./netlify/functions/office-clock-punch.mjs').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1); })"`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/office-clock-punch.mjs
git commit -m "feat(office-clock): add live punch capture endpoint"
```

---

### Task 6: Pay period review + batch send (`office-clock-review.mjs`, `office-clock-send-background.mjs`)

**Files:**
- Create: `netlify/functions/office-clock-review.mjs`
- Create: `netlify/functions/office-clock-send-background.mjs`

**Interfaces:**
- Consumes: `isPeriodLocked`, `findIncompleteDays`, `punchStatusAndActivity` (from
  `../src/office-clock-lib.mjs`), `resolvePunchLogResponse` (from
  `../src/paycor-punch-resolve.mjs`), `createPunches`/`punchErrorLog` Paycor actions
- Produces:
  - `POST { action: 'period', periodEnd }` (exec/it) →
    `{ locked, punches: [...], incompleteDays: [...] }` across every `clock_enabled`
    user (there is only one group here — the office/corporate legal entity — not a
    per-store loop)
  - `POST { action: 'edit', ... }` (rejected if `isPeriodLocked`)
  - `POST { action: 'send', periodEnd }` (rejected if `isPeriodLocked`)
  - `POST { action: 'sendStatus', periodEnd }`

- [ ] **Step 1: Self-create `office_clock_activity_types` and `office_clock_pay_period_sends`**

```sql
CREATE TABLE IF NOT EXISTS office_clock_activity_types (
  legal_entity_id TEXT PRIMARY KEY,
  work_activity_type_id TEXT NOT NULL,
  meal_activity_type_id TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

```sql
CREATE TABLE IF NOT EXISTS office_clock_pay_period_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pay_period_end DATE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_by TEXT NOT NULL
)
```

A helper `ensureActivityTypes(legalEntityId)`: if no row exists yet, call the
`activityTypes` Paycor action, find the records whose `name === 'Work'` and
`name === 'Meal'`, and insert the row. Throw (do not cache a partial mapping) if
either is missing from the response.

- [ ] **Step 2: Implement `period`**

`SELECT cp.* , u.name, u.paycor_employee_id, u.paycor_department_id FROM office_clock_punches cp JOIN users u ON u.id = cp.user_id WHERE cp.pay_period_end = ${periodEnd} ORDER BY u.name, cp.captured_at`.
Group by employee, run `findIncompleteDays` per employee. Return
`{ locked: isPeriodLocked(periodEnd, new Date()), punches, incompleteDays }`.

- [ ] **Step 3: Implement `edit`**

Reject with 409 if locked. Otherwise upsert the punch row with
`source = 'manual_edit'`, `edited_by = <authenticated admin's username>`, and a
`note` recording who/when.

- [ ] **Step 4: Implement `send`**

Reject with 409 if locked. Otherwise
`INSERT INTO office_clock_pay_period_sends (pay_period_end, sent_by) VALUES (${periodEnd}, ${authedUser.username})`, fire `office-clock-send-background.mjs` with
`{ periodEnd }` (fire-and-forget POST, matching this codebase's established
`*-background.js` pattern for anything past the 26s manual timeout), return
`{ started: true }`. A period can be sent more than once before it locks — each
attempt gets its own audit row.

- [ ] **Step 5: Implement the background send**

In `office-clock-send-background.mjs`:
1. `ensureActivityTypes(OFFICE_LEGAL_ENTITY_ID)`.
2. `SELECT cp.*, u.paycor_employee_id, u.paycor_department_id FROM office_clock_punches cp JOIN users u ON u.id = cp.user_id WHERE cp.pay_period_end = ${periodEnd} AND cp.paycor_status = 'unsent'`.
3. Build one array of Paycor punch objects: `punchStatusAndActivity(punchType)`
   gives `{status, activity}`; look up the cached GUID for `activity`; build
   `{ EmployeeId: u.paycor_employee_id, DepartmentId: u.paycor_department_id, PunchDateTime: row.captured_at, PunchStatusType: status, ActivityTypeId: <cached GUID>, Note: row.note || undefined }`.
4. Call `createPunches`; get a tracking ID.
5. `UPDATE office_clock_punches SET paycor_status = 'pending', paycor_tracking_id = ${trackingId} WHERE id = ANY(${ids})`.
6. Poll `punchErrorLog` via `resolvePunchLogResponse`, same semantics as the design
   spec: `'pending'` keeps polling; `'unresolved'` keeps polling but logs the reason
   each time (capped, leaving rows `pending` for a later retry rather than inventing
   a fake terminal failure); `'resolved'` updates each row to `confirmed`/`failed`
   from the real per-record result (match records back to rows by request-order
   position, confirmed against the real response shape from Task 1's Controlled
   Test — fall back to matching on `PunchDateTime` + `EmployeeId` if order isn't
   actually guaranteed).
7. Write final progress/result to a blob (`pcg_office_clock_send_{periodEnd}`, the
   standard `{ savedAt, data }` wrapper) for `sendStatus` to poll.

- [ ] **Step 6: Verify**

Run: `node --input-type=module -e "import('./netlify/functions/office-clock-review.mjs').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1); })"`
Run: `node --input-type=module -e "import('./netlify/functions/office-clock-send-background.mjs').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1); })"`

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/office-clock-review.mjs netlify/functions/office-clock-send-background.mjs
git commit -m "feat(office-clock): add pay period review, edit, and batch send to Paycor"
```

---

### Task 7: Paycor comparison view (`office-clock-compare.mjs`)

**Files:**
- Create: `netlify/functions/office-clock-compare.mjs`

**Interfaces:**
- Consumes: the existing `employeePunches` Paycor read action, this feature's
  `office_clock_punches` table
- Produces: `POST { action: 'compare', startDate, endDate }` (exec/it) →
  `{ perEmployee: [{ userId, name, appPunchCount, paycorPunchCount, mismatchDays: [...] }] }`

Optional validation tooling — useful confidence-check after the first few sends,
not tied to any "cutover" narrative (there is no physical clock being decommissioned
here, unlike the original store-based draft).

- [ ] **Step 1: Implement**

For each `clock_enabled` user: fetch their `office_clock_punches` in the date
range, fetch their Paycor `employeePunches` in the same range (existing action,
unchanged), group both by day, flag any day where the counts don't match.

- [ ] **Step 2: Verify**

Run: `node --input-type=module -e "import('./netlify/functions/office-clock-compare.mjs').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1); })"`

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/office-clock-compare.mjs
git commit -m "feat(office-clock): add Paycor comparison/validation endpoint"
```

---

### Task 8: Frontend — new tab, admin linking screen, pay-period review screen

**Files:**
- Modify: `app.jsx` (new tab for `clock_enabled` office_staff users, new admin
  screens, routing, tab registration, `APP_VERSION` bump)
- Modify: `src/icons.jsx` (new icon(s))
- Modify: `CLAUDE.md` (document the new functions/tables)

**Interfaces:** Consumes every endpoint from Tasks 4–7, plus the existing login flow
(completely unchanged — no new login UI anywhere in this task).

- [ ] **Step 1: `OfficeClockTab` component**

A normal new tab (not a separate login experience, not a kiosk-style takeover) —
visible only when the logged-in user is `office_staff` AND their `clockEnabled` is
true (read from whatever the app already stores about the logged-in user post-
login; extend that shape if `clockEnabled` isn't already carried through from the
login response/token the same way other per-user flags are, following whatever
existing pattern carries e.g. `auditsAccess` through today). Shows four buttons
(Clock In, Start Meal, End Meal, Clock Out), disabling whichever doesn't make sense
given today's last punch, and a simple list of today's punches (from
`office-clock-punch.mjs`'s `today` action) with their times. Tapping a button calls
the `punch` action and refreshes the list.

- [ ] **Step 2: Tab registration**

Add to `getTabs()` for `office_staff`, gated on `clockEnabled` (see "Adding New
Tabs" in `CLAUDE.md`) — most `office_staff` accounts will not have this tab, since
most are salaried. Add routing in the main `PCGPortal` return (search `{tab ===`).

- [ ] **Step 3: `OfficeClockAdmin` component (exec/it only)**

Calls `office-clock-roster.mjs`'s `linkable` action for the office/corporate legal
entity, showing a table: Paycor employee name, job title, FLSA-derived "Hourly" /
"Salaried" label (a plain signal, not an enforced gate), linked Portal account (or
"no office_staff account found" if `linkedUserId` is null), and a toggle calling
`users.mjs`'s extended `update` action with `{ clockEnabled, paycorDepartmentId, paycorEmployeeId }`.

- [ ] **Step 4: `OfficeClockReview` component (exec/it only)**

A pay-period picker (default to the most recently closed period), showing: a
lock/open badge (from `office-clock-review.mjs`'s `period` action), a per-employee
table of that period's punches with inline edit (disabled once locked), incomplete
days highlighted, and a "Send to Paycor" button (hidden once locked) that calls
`send` and polls `sendStatus` every ~5 seconds until done, showing per-punch
confirmed/failed results inline.

- [ ] **Step 5: Comparison view**

Fold into `OfficeClockReview` as a secondary section — calls
`office-clock-compare.mjs`'s `compare` action for the selected period.

- [ ] **Step 6: Icon + admin registration**

Add a new icon to `src/icons.jsx` (e.g. `ICONS.officeClock`), distinct from every
existing icon including the removed `ICONS.minorTimecard`/any other time-related
icon. Register `OfficeClockAdmin`/`OfficeClockReview` for `executive`/`it` only
(Tools-hub tile or Admin-area entry, matching existing precedent).

- [ ] **Step 7: Version bump and build**

Bump `APP_VERSION`. Run `npm run build`. Confirm `app.js` was regenerated.

- [ ] **Step 8: Update `CLAUDE.md`**

Add the new functions, the three new self-created tables, and a short note on the
biweekly lock behavior — matching how Minor Timecard Compliance's entry was added.

- [ ] **Step 9: Commit**

```bash
git add app.jsx app.js src/icons.jsx CLAUDE.md
git commit -m "feat(office-clock): add office hourly time clock tab and admin screens"
```
