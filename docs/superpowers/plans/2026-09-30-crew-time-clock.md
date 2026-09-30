# Crew Time Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give enabled hourly crew a phone-based clock-in / meal-start / meal-end /
clock-out screen that captures punches in real time in our own database, then lets
IT/exec review each closed biweekly pay period per store and push it to Paycor's
`CreatePunches` API with one button — before a hard lock at the same Tuesday-night
payroll deadline the existing tips flow already uses.

**Architecture:** Crew accounts are ordinary rows in the existing `users` table
(`userType = 'crew'`), reusing 100% of the existing login/session/lockout machinery.
Live punches never touch Paycor — they land in a new `crew_punches` table instantly.
Once a pay period closes, IT/exec reviews and edits that store's punches, then
triggers a background function that batches the period into one `CreatePunches` call
per store, polls Paycor's async error log with correct 2xx/404/other semantics, and
records the real per-punch outcome. A period becomes fully read-only at the same
biweekly Tuesday-night deadline `tips-report-cron-background.mjs` already computes.

**Tech Stack:** Netlify Functions (`.mjs`), Neon Postgres (self-creating tables,
idempotent `ALTER`/`CREATE ... IF NOT EXISTS`), React 18 (`app.jsx`), existing
`auth-lib` session/password infrastructure.

**Spec:** `docs/superpowers/specs/2026-09-30-crew-time-clock-design.md`

## Global Constraints

- Crew accounts are rows in the existing `users` table, **not** a separate table —
  reuse `username` (holds the crew member's phone number), `password_hash` (holds
  the hashed PIN), `active` (the enable/disable opt-out), `must_change`/`must_setup`
  (first-login PIN setup), `failed_attempts`/`locked` (5-try lockout — crew is
  **never** added to `isSharedDevice()`; a short PIN needs the lockout protection
  more than a long password does, not less), `paycor_employee_id` (already exists),
  `store_pc` (already exists).
- Two new `users` columns only: `paycor_department_id` (text, nullable) and
  `is_minor` (boolean, nullable), added via an idempotent
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS ...`, matching `users.mjs`'s existing
  `ensureAuditsColumn` pattern exactly.
- **Never persist a birthDate.** `is_minor` is computed once at account-creation time
  from the matched Paycor employee's birthDate (via the existing birthDate-only
  `identifyingData` scope — see [[project_paycor_identifying_data_scope]]) and only
  the boolean result is stored. The birthDate itself is discarded before the response
  leaves the function, same rule as everywhere else this scope is used.
- **An account with `is_minor = true` can never be created with (or later set to)
  `active = true`.** Enforced server-side in `users.mjs`, not just in the UI.
- Crew login reuses `portal-auth.mjs`'s existing `action: 'login'` **completely
  unchanged** — a phone number is just a `username`, a PIN is just a `password_hash`.
  The only new piece is a PIN-shaped complexity rule (4–6 digits, numeric only) used
  instead of `validatePasswordComplexity` specifically when `userType === 'crew'` —
  crew is not exempted from complexity via `isSharedDevice()` (see above), it gets its
  own, separately-shaped rule.
- Crew account creation reuses `users.mjs`'s existing generic `create` action,
  extended (not replaced) to accept `paycorDepartmentId`/`isMinor` and to apply the
  PIN-shaped complexity rule for `userType === 'crew'`.
- Reuse `fetchAllEmployees` and `fetchAllIdentifyingData` (exported from
  `tips-report-cron-background.mjs`) for the roster picker and `is_minor` derivation —
  do not write a second Paycor-employee-fetch implementation.
- Reuse `BIWEEKLY_ANCHOR_END`, `isBiweekBoundary`, `weekEndForTrigger`,
  `dateRangeEndingAt` (import directly from `tips-report-cron-background.mjs`) for
  every pay-period boundary calculation in this feature — do not define a second
  biweekly anchor that could drift out of sync with the one payroll actually runs on.
- **Punch mapping** (fixed, not configurable in v1):
  | Button | `PunchStatusType` | `ActivityTypeId` |
  |---|---|---|
  | Clock In | `In` | Work |
  | Meal Start | `Out` | Meal |
  | Meal End | `In` | Work |
  | Clock Out | `Out` | Work |
- New Paycor proxy actions (`activityTypes`, `createPunches`, `punchErrorLog`) go in
  `paycor.mjs` as their own named, server-validated actions — **never** through the
  generic `raw` proxy, which stays GET-only by deliberate design (see its own comment
  in `paycor.mjs`).
- `CreatePunches`/`punchErrorLog` resolution semantics (from the design spec, verified
  against a real third-party integration's bug history): only a 2xx response from
  `punchErrorLog` is resolved (and may still carry per-record errors inside); 404
  means still processing, keep polling; any other status (401/403/500) is unresolved
  and must **never** be read as success.
- New tables (`crew_punches`, `crew_pay_period_sends`, `crew_activity_types`) are
  **self-created** (`CREATE TABLE IF NOT EXISTS`, run idempotently inside their
  owning function) — matching `audits.mjs`/`safe-audits.mjs`/`tickets.mjs`, **not**
  the older `db-migrate.js`-driven convention. `db/schema.ts` gets documentation-only
  entries for them, exactly like those three files' tables.
- **Lock state is computed, never stored.** `isPeriodLocked(periodEndDate, now)` is a
  pure function comparing `now` against that period's Tuesday-night deadline — there
  is no cron that flips a `locked` flag, and no `locked_at` column. This avoids a
  whole scheduled function and any risk of the flag being stale relative to the real
  deadline.
- **Task 1's Controlled Test is never run by a dispatched subagent.** The task
  delivers code + unit tests only. The one live POST against production Paycor
  (Ahmed's own Bustleton record) is performed by the controller directly, after an
  explicit go/no-go from the human, because there is no delete-punch API and a bad
  outcome needs manual cleanup in Paycor's own UI.
- Minors are never eligible for `enabled` (`active = true`) on a crew account in v1 —
  Minor Timecard Compliance integration is explicitly out of scope for this plan.
- Bump the `APP_VERSION` constant in `app.jsx` and run `npm run build` as part of the
  final frontend task, per this repo's standing convention.
- Every new tab/screen gets its own distinct `ICONS.xxx` entry — never a reused icon,
  never a raw emoji (see [[feedback_unique_tab_icons]]).

---

### Task 1: Paycor write actions (`createPunches`, `punchErrorLog`, `activityTypes`)

**Files:**
- Modify: `netlify/functions/paycor.mjs` (add three actions near the existing
  `employeePunches`/`payGroups` actions, ~line 704)
- Create: `src/paycor-punch-resolve.mjs` (pure resolution-semantics helper)
- Create: `src/paycor-punch-resolve.test.mjs`

**Interfaces:**
- Consumes: `callPaycor(path, method, body, version)` (existing, already imported in
  `paycor.mjs`)
- Produces: `resolvePunchLogResponse(status, body)` — used by Task 6's background send
  function; `paycor.mjs` actions `activityTypes`, `createPunches`, `punchErrorLog`

- [ ] **Step 1: Write the pure resolution-semantics helper and its failing tests**

```js
// src/paycor-punch-resolve.mjs
// Pure decision logic for interpreting a punchErrorLog poll response. No network
// or DB I/O here — netlify/functions/crew-clock-send-background.mjs (Task 6) is the
// only caller that actually makes the HTTP request.
//
// A real third-party Paycor integration's bug history (alexrelintex/timeclock PR
// #33, cited in the design spec) shows the dangerous mistake here: treating any
// non-404 response as "clean success" silently recorded 401/403/500 errors as
// successful punches. The correct rule, encoded below: only a genuine 2xx resolves
// anything; 404 means "still processing"; everything else is unresolved and must
// never be read as success.

// Returns one of:
//   { state: 'pending' }                                — 404, keep polling
//   { state: 'unresolved', reason }                      — any other non-2xx
//   { state: 'resolved', succeeded: [...], failed: [...] } — 2xx, per-record outcome
//
// `body` is the parsed JSON from GET punchErrorLog/{trackingId}. Paycor's per-record
// shape is not fully documented; this treats any record with a non-empty `errors`
// (or `Errors`) array as failed, and everything else in `records`/`Records` as
// succeeded — records missing entirely (empty array on a 2xx) count as succeeded
// with nothing to report, per Paycor's own "no errors logged" semantics.
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
  const r = resolvePunchLogResponse(401, { error: 'unauthorized' });
  assert.equal(r.state, 'unresolved');
});

test('403 is unresolved, not success', () => {
  const r = resolvePunchLogResponse(403, {});
  assert.equal(r.state, 'unresolved');
});

test('500 is unresolved, not success', () => {
  const r = resolvePunchLogResponse(500, {});
  assert.equal(r.state, 'unresolved');
});

test('200 with no records resolves with nothing succeeded or failed', () => {
  const r = resolvePunchLogResponse(200, { records: [] });
  assert.deepEqual(r, { state: 'resolved', succeeded: [], failed: [] });
});

test('200 with a mix of clean and errored records splits them correctly', () => {
  const body = {
    records: [
      { punchId: 'p1' },
      { punchId: 'p2', errors: ['Invalid DepartmentId'] },
    ],
  };
  const r = resolvePunchLogResponse(200, body);
  assert.equal(r.state, 'resolved');
  assert.equal(r.succeeded.length, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].record.punchId, 'p2');
});

test('handles PascalCase Records/Errors shape too', () => {
  const body = { Records: [{ PunchId: 'p1', Errors: ['bad'] }] };
  const r = resolvePunchLogResponse(200, body);
  assert.equal(r.failed.length, 1);
});
```

- [ ] **Step 2: Run the tests and confirm they pass**

Run: `node --test src/paycor-punch-resolve.test.mjs`
Expected: 6 passing, 0 failing.

- [ ] **Step 3: Add the three new actions to `paycor.mjs`**

Add immediately after the existing `employeePunches` action (~line 715), before
`schedulingJobs`:

```js
    // ── Proxy: activity types for a legal entity (Work/Meal/Break GUIDs) ──
    // Read-only. Used once per store, at crew-clock enable time, to populate the
    // crew_activity_types cache (Task 3) — never re-fetched per punch or per employee.
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
    // exec/it, matching createSchedulingShifts's pattern: this writes real payroll
    // time data, so unlike most read proxies here, it needs its own server-side
    // check rather than trusting the caller.
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
whatever the existing local variable names are; do not introduce new ones.

- [ ] **Step 4: Confirm the file still parses and existing tests still pass**

Run: `node --check netlify/functions/paycor.mjs`
Run: `node --test src/paycor-punch-resolve.test.mjs`
Expected: no syntax errors, tests still passing.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/paycor.mjs src/paycor-punch-resolve.mjs src/paycor-punch-resolve.test.mjs
git commit -m "feat(crew-clock): add Paycor createPunches/punchErrorLog/activityTypes actions"
```

**STOP — do not proceed to Task 2 yet.** After this task's review passes, the
controller must perform the Controlled Test described in the design spec
(one real Clock In punch to Ahmed's own Bustleton record, confirmed via the
`punchErrorLog` poll) directly, with an explicit go/no-go from the human immediately
before that specific call — not delegated to a subagent. Task 2 onward assumes the
result of that test is known (write access confirmed, and the real required-field
list for `CreatePunches` is now known for certain, correcting Step 3's action code
above if the real API disagrees with it in any way).

---

### Task 2: Pure logic module — punch mapping, pay periods, lock, incomplete-day detection

**Files:**
- Create: `src/crew-clock-lib.mjs`
- Create: `src/crew-clock-lib.test.mjs`

**Interfaces:**
- Consumes: `isBiweekBoundary`, `weekEndForTrigger`, `dateRangeEndingAt`,
  `BIWEEKLY_ANCHOR_END` (import from `../netlify/functions/tips-report-cron-background.mjs`)
- Produces: `punchStatusAndActivity(buttonType)`, `payPeriodEndFor(dateStr)`,
  `isPeriodLocked(periodEndDate, nowDate)`, `findIncompleteDays(punchesForPeriod)` —
  consumed by Tasks 4, 5, 6, 8.

- [ ] **Step 1: Write the failing tests**

```js
// src/crew-clock-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  punchStatusAndActivity, payPeriodEndFor, isPeriodLocked, findIncompleteDays,
} from './crew-clock-lib.mjs';

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
  // 2026-08-15 is the confirmed real anchor Saturday. The following Sunday
  // (2026-08-16) starts a new 14-day period ending Sat 2026-08-29.
  assert.equal(payPeriodEndFor('2026-08-15'), '2026-08-15');
  assert.equal(payPeriodEndFor('2026-08-02'), '2026-08-15'); // mid-period, same anchor period
  assert.equal(payPeriodEndFor('2026-08-16'), '2026-08-29'); // first day of the next period
  assert.equal(payPeriodEndFor('2026-08-29'), '2026-08-29');
});

test('isPeriodLocked is false right up through Tuesday-night close-of-day, true after', () => {
  const periodEnd = '2026-08-15'; // Saturday
  // Sunday, Monday, Tuesday daytime — still open
  assert.equal(isPeriodLocked(periodEnd, new Date('2026-08-16T12:00:00Z')), false);
  assert.equal(isPeriodLocked(periodEnd, new Date('2026-08-17T12:00:00Z')), false);
  assert.equal(isPeriodLocked(periodEnd, new Date('2026-08-18T20:00:00Z')), false);
  // Wednesday — locked
  assert.equal(isPeriodLocked(periodEnd, new Date('2026-08-19T00:00:01Z')), true);
});

test('findIncompleteDays flags a clock-in with no matching clock-out', () => {
  const punches = [
    { punchType: 'clock_in', capturedAt: '2026-08-10T13:00:00Z' },
  ];
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

Run: `node --test src/crew-clock-lib.test.mjs`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement**

```js
// src/crew-clock-lib.mjs
// Pure logic for the Crew Time Clock feature — no network or DB I/O. Consumed by
// netlify/functions/crew-punch.mjs, crew-review.mjs, crew-clock-send-background.mjs,
// and app.jsx's admin review screen.
import {
  isBiweekBoundary, weekEndForTrigger, dateRangeEndingAt, BIWEEKLY_ANCHOR_END,
} from '../netlify/functions/tips-report-cron-background.mjs';

const BUTTON_MAP = {
  clock_in: { status: 'In', activity: 'Work' },
  meal_start: { status: 'Out', activity: 'Meal' },
  meal_end: { status: 'In', activity: 'Work' },
  clock_out: { status: 'Out', activity: 'Work' },
};

// Maps a crew punch button to Paycor's PunchStatusType + which cached
// crew_activity_types column ('Work' or 'Meal') to use for ActivityTypeId.
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

// The Saturday that closes the biweekly pay period containing dateStr (a
// 'YYYY-MM-DD' string). Walks forward/backward from BIWEEKLY_ANCHOR_END in
// 14-day steps rather than re-deriving the anchor math independently, so this
// can never drift out of sync with tips-report-cron-background.mjs's own
// period boundaries (both are ultimately Paycor's real payroll calendar).
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
// sending for the pay period ending on periodEndDate (a 'YYYY-MM-DD' Saturday).
// Tuesday is 3 days after Saturday; "night" is treated as the end of that
// Tuesday in UTC (00:00:00 UTC the following Wednesday) — deliberately a plain,
// unambiguous UTC boundary rather than a timezone-sensitive "9pm ET" cutoff,
// since a payroll lock deadline should never be ambiguous by even a few hours.
export function isPeriodLocked(periodEndDate, now) {
  const end = parseDateOnly(periodEndDate);
  const lockAt = new Date(end);
  lockAt.setUTCDate(lockAt.getUTCDate() + 4); // Sat -> Wed 00:00 UTC = end of Tuesday
  return now.getTime() >= lockAt.getTime();
}

// Flags days where a crew member's punch sequence is incomplete: an open
// clock-in with no later clock-out that same day, or an open meal_start with
// no later meal_end that same day. `punches` is one employee's punches for
// a period (or a day), each { punchType, capturedAt (ISO string) }, in any
// order — this sorts internally.
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

Run: `node --test src/crew-clock-lib.test.mjs`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/crew-clock-lib.mjs src/crew-clock-lib.test.mjs
git commit -m "feat(crew-clock): add pure punch-mapping/pay-period/lock/incomplete-day logic"
```

---

### Task 3: PIN complexity rule + `users` table support for crew

**Files:**
- Modify: `netlify/functions/auth-lib/passwords.js` (add `validatePinComplexity`)
- Modify: `netlify/functions/users.mjs` (ensure new columns; extend `create` action)
- Modify: `db/schema.ts` (document the two new columns)

**Interfaces:**
- Consumes: `hashPassword` (existing, in `passwords.js`)
- Produces: `validatePinComplexity(pin)` — consumed by Task 8's account-creation UI
  indirectly (via `users.mjs`'s `create` action, which is the actual enforcement
  point)

- [ ] **Step 1: Add `validatePinComplexity` to `passwords.js`**

```js
// A crew PIN is deliberately much shorter than the standard password policy —
// it's typed several times a day on a phone, not once per session. 4-6 digits,
// numeric only. This does NOT exempt crew from the failed-attempt lockout (see
// isSharedDevice below, which crew is deliberately never added to) — a short
// PIN needs that protection more than a long password does, not less.
function validatePinComplexity(pin) {
  const p = String(pin == null ? '' : pin);
  if (!/^\d{4,6}$/.test(p)) return { ok: false, message: 'PIN must be 4 to 6 digits.' };
  return { ok: true };
}
```

Add `validatePinComplexity` to the file's final `module.exports` line alongside the
existing exports.

- [ ] **Step 2: Add the two new `users` columns, idempotently**

Find `users.mjs`'s existing `ensureAuditsColumn` (or equivalently-named idempotent
column-ensure function) and add a sibling call, following its exact existing
pattern (same batching-into-one-transaction approach already used there):

```js
// Crew Time Clock: paycor_department_id (the crew member's Paycor department GUID,
// captured once at account-creation time from their matched employee record — see
// paycor_employee_id above, which already follows this exact pattern) and is_minor
// (a boolean derived once from their Paycor birthDate at creation time; the
// birthDate itself is never stored — see project_paycor_identifying_data_scope).
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS paycor_department_id TEXT`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_minor BOOLEAN`;
```

- [ ] **Step 3: Extend the `create` action**

In the existing `create` action (~line 138), after the existing password-complexity
branch:

```js
      const username = lc(u.username);
      // Crew accounts use a PIN, not a password — same idea as the shared-device
      // exemption below but a DIFFERENT rule, not an exemption: crew still gets the
      // full failed-attempt lockout (isSharedDevice is never true for 'crew'), it
      // just validates against a PIN shape instead of the 12-char password policy.
      if (u.password) {
        if (u.userType === 'crew') {
          const v = validatePinComplexity(String(u.password));
          if (!v.ok) return reply(400, { error: v.message });
        } else if (!isSharedDevice(u.userType)) {
          const v = validatePasswordComplexity(String(u.password));
          if (!v.ok) return reply(400, { error: v.message });
        }
      }
      // A minor is never eligible to be enabled on this feature (Minor Timecard
      // Compliance integration is explicitly out of scope for this build — see
      // docs/superpowers/specs/2026-09-30-crew-time-clock-design.md).
      if (u.userType === 'crew' && u.isMinor && u.active !== false) {
        return reply(400, { error: 'A minor cannot be enabled on the crew time clock. Leave them on the physical clock.' });
      }
```

Then extend the `INSERT INTO users (...)` column list and values to also include
`paycor_department_id` and `is_minor`:

```js
      const [row] = await db`
        INSERT INTO users (
          username, name, email, phone, role, user_type, district, store_pc,
          active, dark_mode, initials, is_admin, must_setup, region,
          password_hash, must_change, two_factor_required, audits_access,
          paycor_employee_id, paycor_department_id, is_minor, created_at, updated_at
        ) VALUES (
          ${username}, ${u.name}, ${lc(u.email) || null}, ${u.phone || null},
          ${u.role || null}, ${u.userType}, ${u.district ?? null},
          ${u.storePC ? String(u.storePC) : null},
          ${u.active !== false}, ${u.darkMode || false},
          ${u.initials || null}, ${u.isAdmin || false}, ${forceSetup},
          ${u.region || 'PA'}, ${passwordHash}, ${forceSetup},
          ${u.twoFactorRequired || false}, ${u.auditsAccess ?? null},
          ${u.paycorEmployeeId || null}, ${u.paycorDepartmentId || null},
          ${u.isMinor || false}, now(), now()
        )
        ON CONFLICT (username) DO NOTHING
        RETURNING id
      `;
```

Add `validatePinComplexity` to this file's import from `./auth-lib/passwords.js`.

Also find wherever an existing `update`/`edit` action in this same file lets an
admin change `active` for a user, and add the identical minor guard there (an
admin must not be able to flip an existing crew account's `active` to `true` after
the fact either) — match that action's existing structure exactly; do not restructure
it.

- [ ] **Step 4: Update `db/schema.ts`**

Add a short comment block near the `users` table definition documenting the two new
columns (matching the style of the existing `paycorEmployeeId` inline comment) —
this file is not migrated from for `users` in the self-creating sense, but it's kept
as the canonical reference for the table's shape:

```ts
  paycorDepartmentId: text("paycor_department_id"), // Crew Time Clock: matches paycor_employee_id's pattern
  isMinor: boolean("is_minor"), // Crew Time Clock: derived once at creation from Paycor birthDate, never the birthDate itself
```

- [ ] **Step 5: Verify**

Run: `node --check netlify/functions/auth-lib/passwords.js`
Run: `node --check netlify/functions/users.mjs`
Manually trace: a `create` call with `userType: 'crew', password: '1234', isMinor: true, active: true` must be rejected with the minor-guard error, before it ever reaches the INSERT.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/auth-lib/passwords.js netlify/functions/users.mjs db/schema.ts
git commit -m "feat(crew-clock): add PIN complexity rule and crew fields to users.mjs"
```

---

### Task 4: Crew roster picker (`crew-roster.mjs`)

**Files:**
- Create: `netlify/functions/crew-roster.mjs`

**Interfaces:**
- Consumes: `fetchAllEmployees`, `fetchAllIdentifyingData` (import from
  `./tips-report-cron-background.mjs`), `requireActiveUser` (from
  `./auth-lib/require-user.js`), `ageFromBirthDate`/`isMinor` (import from
  `../src/minor-timecard-detect.mjs` — reuse, do not re-derive)
- Produces: `POST /.netlify/functions/crew-roster { action: 'linkable', legalEntityId }`
  → `{ employees: [{ id, name, jobTitle, departmentId, isMinor }] }`, filtered to
  active employees not already linked to a `users` row via `paycor_employee_id`.
  Consumed by Task 8's account-creation UI.

- [ ] **Step 1: Implement**

Auth-gate exec/it only (same shape as the `createPunches` check added in Task 1).
For the `linkable` action:
1. Call `fetchAllEmployees(legalEntityId)`, filter to `statusData.status === 'Active'`.
2. Call `fetchAllIdentifyingData(legalEntityId)`, build a `Map<employeeId, birthDate>`.
3. Query `SELECT paycor_employee_id FROM users WHERE paycor_employee_id IS NOT NULL`
   to build the set of already-linked employee IDs.
4. For each active, unlinked employee: compute `isMinor` via
   `isMinor(ageFromBirthDate(birthDateMap.get(e.id), new Date()))` — if no birthDate
   is found for someone, mark `isMinor: null` (indeterminate) rather than guessing
   false, and surface that plainly in the response so the create-account UI can
   refuse to enable them until it's known, matching this codebase's established
   never-guess-on-indeterminate-data rule.
5. Return `{ employees: [{ id: e.id, name: `${e.firstName} ${e.lastName}`.trim(),
   jobTitle: e.positionData?.jobTitle || '', departmentId: e.department?.id || null,
   isMinor }] }`. **Discard the birthDate immediately after computing `isMinor` —
   it must never appear in this response.**

- [ ] **Step 2: Verify**

`node --check` only parses syntax — it does NOT catch a wrong relative import path
(exactly the mistake that shipped in Minor Timecard Compliance's first draft, caught
only by an actual import attempt). Run an import-resolution smoke test instead:

Run: `node --input-type=module -e "import('./netlify/functions/crew-roster.mjs').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1); })"`
Expected: `OK`, no `ERR_MODULE_NOT_FOUND` or similar.

Manually trace: an employee with no `identifyingData` birthDate on file gets
`isMinor: null`, not `false`.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/crew-roster.mjs
git commit -m "feat(crew-clock): add crew roster picker endpoint"
```

---

### Task 5: Live punch capture (`crew-punch.mjs`)

**Files:**
- Create: `netlify/functions/crew-punch.mjs`

**Interfaces:**
- Consumes: `requireActiveUser`, `payPeriodEndFor` (from `../src/crew-clock-lib.mjs`)
- Produces:
  - `POST { action: 'punch', punchType }` (crew-authenticated) →
    `{ ok: true, punch: {...} }`
  - `POST { action: 'today' }` (crew-authenticated) → `{ punches: [...] }`

- [ ] **Step 1: Self-create the `crew_punches` table idempotently**

```sql
CREATE TABLE IF NOT EXISTS crew_punches (
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

Run this the same way `audits.mjs`/`tickets.mjs` self-create their tables
(idempotent, once per warm instance, swallowing errors so a real query failure
surfaces separately rather than being masked).

- [ ] **Step 2: Implement `punch`**

1. `requireActiveUser` — must be `userType === 'crew'` and `active === true` (an
   account that somehow became inactive mid-session must not be able to punch).
2. Server captures `capturedAt = new Date()` right now — **never** trust a
   client-supplied timestamp.
3. `payPeriodEnd = payPeriodEndFor(capturedAt.toISOString().slice(0, 10))`.
4. `INSERT INTO crew_punches (user_id, punch_type, captured_at, pay_period_end, source) VALUES (${claims.sub}, ${punchType}, ${capturedAt}, ${payPeriodEnd}, 'live')`.
5. Return the inserted row.

- [ ] **Step 3: Implement `today`**

`SELECT * FROM crew_punches WHERE user_id = ${claims.sub} AND captured_at >= ${startOfTodayInStoreLocalTime} ORDER BY captured_at ASC` — return as `{ punches }`.

- [ ] **Step 4: Verify**

Run: `node --input-type=module -e "import('./netlify/functions/crew-punch.mjs').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1); })"`
Expected: `OK` — confirms every relative import (e.g. `../src/crew-clock-lib.mjs`)
actually resolves, which `node --check` alone would not catch.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/crew-punch.mjs
git commit -m "feat(crew-clock): add live punch capture endpoint"
```

---

### Task 6: Pay period review + batch send (`crew-review.mjs`, `crew-clock-send-background.mjs`)

**Files:**
- Create: `netlify/functions/crew-review.mjs`
- Create: `netlify/functions/crew-clock-send-background.mjs`

**Interfaces:**
- Consumes: `isPeriodLocked`, `findIncompleteDays`, `punchStatusAndActivity` (from
  `../src/crew-clock-lib.mjs`), `resolvePunchLogResponse` (from
  `../src/paycor-punch-resolve.mjs`), `createPunches`/`punchErrorLog` Paycor actions
  (Task 1), `crew_activity_types` cache (self-created here — see Step 1)
- Produces:
  - `POST crew-review { action: 'period', storePC, periodEnd }` (exec/it) →
    `{ locked, punches: [...], incompleteDays: [...] }`
  - `POST crew-review { action: 'edit', punchId or newPunch }` (exec/it, rejected if
    `isPeriodLocked`) → updates/inserts a `crew_punches` row with
    `source = 'manual_edit'`, `edited_by = <admin username>`
  - `POST crew-review { action: 'send', storePC, periodEnd }` (exec/it, rejected if
    `isPeriodLocked`) → fires `crew-clock-send-background.mjs`, returns
    `{ started: true }` immediately
  - `POST crew-review { action: 'sendStatus', storePC, periodEnd }` → polls the result
    blob, matching this codebase's established fire-and-forget-then-poll pattern

- [ ] **Step 1: Self-create `crew_activity_types` and `crew_pay_period_sends`**

```sql
CREATE TABLE IF NOT EXISTS crew_activity_types (
  legal_entity_id TEXT PRIMARY KEY,
  work_activity_type_id TEXT NOT NULL,
  meal_activity_type_id TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

```sql
-- One row per store per pay period that has ever been sent — audit trail only
-- (crew_punches.paycor_status already carries the per-punch outcome; this
-- records WHO triggered a send and WHEN, since a period can be sent more than
-- once before it locks — see Step 4).
CREATE TABLE IF NOT EXISTS crew_pay_period_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_pc TEXT NOT NULL,
  pay_period_end DATE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_by TEXT NOT NULL
)
```

A helper `ensureActivityTypes(legalEntityId)`: if no row exists for
`legalEntityId`, call the `activityTypes` Paycor action (Task 1), find the record
whose `name === 'Work'` and whose `name === 'Meal'` (case-sensitive match against
the confirmed real values), and insert the row. If either is missing from Paycor's
response, throw rather than caching a partial/wrong mapping — this store cannot be
sent until that's resolved.

- [ ] **Step 2: Implement `period`**

`SELECT * FROM crew_punches cp JOIN users u ON u.id = cp.user_id WHERE u.store_pc = ${storePC} AND cp.pay_period_end = ${periodEnd} ORDER BY u.name, cp.captured_at`.
Group by employee, run `findIncompleteDays` per employee. Return
`{ locked: isPeriodLocked(periodEnd, new Date()), punches, incompleteDays }`.

- [ ] **Step 3: Implement `edit`**

Reject with 409 if `isPeriodLocked(periodEnd, new Date())` is true — this is the
hard lock, no override. Otherwise upsert the punch row with
`source = 'manual_edit'`, `edited_by = <the authenticated admin's username>`, and a
`note` recording who/when (e.g. `"Manually added by <name> on <date> — missed punch"`).

- [ ] **Step 4: Implement `send`**

Reject with 409 if locked. Otherwise `INSERT INTO crew_pay_period_sends (store_pc, pay_period_end, sent_by) VALUES (${storePC}, ${periodEnd}, ${authedUser.username})`, fire
`crew-clock-send-background.mjs` with `{ storePC, periodEnd }` (fire-and-forget POST,
matching the existing `*-background.js` pattern for anything past the 26s manual
timeout), and immediately return `{ started: true }`. A period can be sent more than
once before it locks (Global Constraints) — each attempt gets its own audit row.

- [ ] **Step 5: Implement the background send**

In `crew-clock-send-background.mjs`:
1. `ensureActivityTypes(legalEntityId)` for this store.
2. `SELECT * FROM crew_punches cp JOIN users u ON u.id = cp.user_id WHERE u.store_pc = ${storePC} AND cp.pay_period_end = ${periodEnd} AND cp.paycor_status = 'unsent'`.
3. Build one array of Paycor punch objects: for each row, `punchStatusAndActivity(punchType)` gives `{status, activity}`; look up the cached GUID for `activity` ('Work' or 'Meal'); build
   `{ EmployeeId: u.paycor_employee_id, DepartmentId: u.paycor_department_id, PunchDateTime: row.captured_at, PunchStatusType: status, ActivityTypeId: <cached GUID>, Note: row.note || undefined }`.
4. Call the `createPunches` Paycor action with that array; get back a tracking ID.
5. `UPDATE crew_punches SET paycor_status = 'pending', paycor_tracking_id = ${trackingId} WHERE id = ANY(${ids})`.
6. Poll `punchErrorLog` in a loop (a few seconds apart, bounded by this function's
   15-minute background budget) via `resolvePunchLogResponse(status, body)`:
   - `'pending'` → keep polling
   - `'unresolved'` → keep polling, but log the reason each time (do not silently
     spin forever without any trace — cap total attempts and, if the cap is hit
     while still unresolved, leave the rows `pending` and let the next manual
     `sendStatus` poll or a subsequent `send` retry pick it back up rather than
     inventing a fake terminal failure state)
   - `'resolved'` → for each Paycor record in `succeeded`, match it back to its
     `crew_punches` row (by array position, since `CreatePunches`'s response order
     matches its request order — confirm this against the real response shape
     captured during Task 1's Controlled Test before relying on it; if order isn't
     guaranteed, match on `PunchDateTime` + `EmployeeId` instead) and
     `UPDATE ... SET paycor_status = 'confirmed'`; for each in `failed`,
     `UPDATE ... SET paycor_status = 'failed', note = note || ' — Paycor error: ' || <error text>`.
7. Write final progress/result to a blob (`pcg_crew_clock_send_{storePC}_{periodEnd}`,
   using the standard `{ savedAt, data }` wrapper) for `sendStatus` to poll.

- [ ] **Step 6: Verify**

Run: `node --input-type=module -e "import('./netlify/functions/crew-review.mjs').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1); })"`
Run: `node --input-type=module -e "import('./netlify/functions/crew-clock-send-background.mjs').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1); })"`
Expected: `OK` for both — confirms real import resolution, not just syntax.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/crew-review.mjs netlify/functions/crew-clock-send-background.mjs
git commit -m "feat(crew-clock): add pay period review, edit, and batch send to Paycor"
```

---

### Task 7: Store cutover comparison (`crew-cutover.mjs`)

**Files:**
- Create: `netlify/functions/crew-cutover.mjs`

**Interfaces:**
- Consumes: the existing `punches`/`employeePunches` Paycor read actions, this
  feature's `crew_punches` table
- Produces: `POST crew-cutover { action: 'compare', storePC, startDate, endDate }`
  (exec/it) → `{ perEmployee: [{ userId, name, appPunchCount, paycorPunchCount, mismatchDays: [...] }] }`

- [ ] **Step 1: Implement**

For each crew account at `storePC`: fetch their `crew_punches` in the date range,
fetch their Paycor `employeePunches` in the same range (existing action, unchanged),
group both by day, and flag any day where the two don't agree on count or don't
roughly agree on In/Out timing (a simple count-mismatch check is sufficient for v1 —
this is a human-reviewed comparison view, not an automated reconciliation).

- [ ] **Step 2: Verify**

Run: `node --input-type=module -e "import('./netlify/functions/crew-cutover.mjs').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1); })"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/crew-cutover.mjs
git commit -m "feat(crew-clock): add store cutover comparison endpoint"
```

---

### Task 8: Frontend — crew screen, PIN login/setup, admin account + review UI

**Files:**
- Modify: `app.jsx` (new `crew` userType handling, new components, routing, tab
  registration, `APP_VERSION` bump)
- Modify: `src/icons.jsx` (new icon(s), per [[feedback_unique_tab_icons]])
- Modify: `CLAUDE.md` (document the new functions/table/env behavior, matching how
  Minor Timecard Compliance's entry was added)

**Interfaces:**
- Consumes: every endpoint from Tasks 4–7, plus the existing login flow (unchanged)

This task wires up everything the backend tasks built. Precise requirements (not a
placeholder — an implementer builds exactly this, matching this codebase's existing
component conventions: plain function components, `useState`/`useEffect` destructured
from `React`, inline `style={}`, `btn`/`inp`/`card` helpers from `src/theme.js`):

- [ ] **Step 1: Crew login variant**

When the existing login screen's `userType` lookup (post-username-entry, or however
this codebase currently detects which login form to show — trace the existing
`store_tablet`/`kiosk_*` special-cased login UI, since those are the closest existing
precedent for "a role with a non-standard login experience") resolves to `crew`,
label the two fields "Phone Number" and "PIN" instead of "Username"/"Password", and
render the PIN field as a numeric-only input. Submits to the exact same
`portal-auth.mjs` `login` action, unchanged.

- [ ] **Step 2: First-login PIN setup**

`must_change`/`must_setup` is already `true` on every newly-created crew account
(inherited from `users.mjs`'s existing `forceSetup` logic, unchanged in Task 3).
Find wherever the app currently renders a "you must change your password" flow on
first login, and branch it: for `userType === 'crew'`, render a PIN-appropriate
version (two 4-6-digit numeric inputs, "enter a new PIN" / "confirm it") instead of
the standard password-change form, submitting through the existing
change-password action (which already accepts a new value — a 4-6 digit numeric
string is just a valid value for it once `validatePinComplexity`, not
`validatePasswordComplexity`, is applied server-side for `userType === 'crew'` — if
the existing change-password action doesn't yet branch on `userType` the same way
Task 3's `create` action was extended to, extend it identically here, within this
task, since it's the same rule in a second call site).

- [ ] **Step 3: `CrewClockScreen` component**

The entire Portal experience for a `crew` user — no sidebar, no other tabs. Shows:
four large buttons (Clock In, Start Meal, End Meal, Clock Out — labels matching the
design spec's "Meal" naming), disabling whichever button doesn't make sense given
today's last punch (e.g. Clock In disabled if already clocked in and not on a meal),
and a simple list of today's punches (from `crew-punch.mjs`'s `today` action) with
their times. Tapping a button calls `crew-punch.mjs`'s `punch` action and refreshes
the day's list. A punch failure (network error, non-200) shows a plain inline error —
there is no Paycor-write failure to report here, since live punches never touch
Paycor at all (Task 5) — only the batch send (Step 6 below) can fail against Paycor.

- [ ] **Step 4: `crew` userType routing**

Add `crew` to the top-level userType switch that decides what renders after login:
route straight to `CrewClockScreen`, bypassing the normal tab/sidebar shell entirely
(same idea as the existing kiosk userTypes' single-purpose views — follow whichever
one of those is structured most similarly, e.g. `kiosk_upload`).

- [ ] **Step 5: `CrewAccountsAdmin` component (exec/it only)**

A store picker, then: a table of that store's existing crew accounts (name, phone,
enabled toggle — disabled/greyed with a tooltip if `isMinor`) and an "Add Crew
Member" flow that calls `crew-roster.mjs`'s `linkable` action for a dropdown of
unlinked active Paycor employees at that store (each row showing name + job title;
an employee with `isMinor: null` shown with a clear "age unknown — cannot enable"
marker per Task 4's never-guess rule), then a small form (phone number, initial PIN)
that calls `users.mjs`'s extended `create` action with `userType: 'crew'` and the
selected employee's `id`/`departmentId`/`isMinor`.

- [ ] **Step 6: `CrewPayPeriodReview` component (exec/it only)**

A store + pay-period picker (default to the most recently closed period), showing:
a lock/open badge (from `crew-review.mjs`'s `period` action), a per-employee table
of that period's punches with inline edit (disabled entirely once locked), incomplete
days highlighted, and a "Send to Paycor" button (hidden once locked) that calls
`crew-review.mjs`'s `send` action and then polls `sendStatus` every ~5 seconds
(matching this codebase's established background-poll pattern) until it reports
done, showing per-punch confirmed/failed results inline once resolved.

- [ ] **Step 7: Cutover comparison view**

Fold into `CrewPayPeriodReview` as a secondary section/tab within the same screen
(not a separate top-level screen) — calls `crew-cutover.mjs`'s `compare` action for
the selected store/period and shows any flagged mismatch days.

- [ ] **Step 8: Icon + Tools-hub tile + routing**

Add a new icon to `src/icons.jsx` (e.g. `ICONS.crewClock`) distinct from every
existing icon. Register a Tools-hub tile (or Admin-area entry, matching how Minor
Timecard Compliance was registered) for `CrewAccountsAdmin`/`CrewPayPeriodReview`,
visible to `executive`/`it` only. Add routing for both in the main `PCGPortal`
return block (search `{tab ===`).

- [ ] **Step 9: Version bump and build**

Bump `APP_VERSION` in `app.jsx`. Run `npm run build`. Confirm `app.js` was
regenerated.

- [ ] **Step 10: Update `CLAUDE.md`**

Add the new functions to the Netlify Functions list, the two new self-created
tables to the Netlify Blobs/data section (or a short new subsection, matching how
Minor Timecard Compliance's tables/functions were documented), and a short note on
the biweekly lock behavior.

- [ ] **Step 11: Commit**

```bash
git add app.jsx app.js src/icons.jsx CLAUDE.md
git commit -m "feat(crew-clock): add crew clock UI, PIN login, and IT/exec admin screens"
```
