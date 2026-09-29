# Minor Timecard Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the weekly Minor Timecard Compliance system — Sunday detection of PA minor-labor-law timecard violations, an escalating Manager → DM+Office Staff notification cycle until each is resolved, and a new role-scoped Admin screen showing live status.

**Architecture:** Pure-logic modules (`src/minor-timecard-*.mjs`, unit tested with `node --test`) hold every decision (is this a violation, has it escalated, who gets notified, what does the email say). Three thin Netlify Functions wrap that logic with the actual I/O (Paycor calls, Netlify Blobs, Resend email). A new Admin screen in `app.jsx` reads the resulting blob and renders it, scoped by role.

**Tech Stack:** Node.js (Netlify Functions, ESM `.mjs`), `node --test` for pure-logic unit tests, Netlify Blobs (`@netlify/blobs`) for storage, Resend for email, React (existing `app.jsx` patterns) for the UI, esbuild for the bundle.

**Spec:** `docs/superpowers/specs/2026-09-29-minor-timecard-compliance-design.md` — read this first; it is the authority this plan argues from. Every task below implements a specific section of it.

## Global Constraints

- **Birthdate scope (non-negotiable, from the spec's Background section):** `identifyingData`/`employeesIdentifyingData` responses also contain `socialSecurityNumber`. Every function that touches this endpoint must discard everything except `employeeId`/`birthDate` at the mapping step — never store, log, or forward anything else from that response.
- **PA legal threshold:** a violation is 5.0+ consecutive hours worked with no intervening break of at least 30 minutes. A shorter gap does not satisfy the requirement and does not reset the consecutive-hours count.
- **Week boundary:** Sunday–Saturday (Pulse/Tips convention), not the Labor page's Monday-start convention.
- **Never guess on ambiguous punch data.** An odd number of punches in a day (unpaired) must be treated as indeterminate, not silently assumed to be a violation or a non-violation — this project was burned hard by exactly this kind of guess earlier (2026-09-29 tips-week incidents).
- **No push/SMS for this feature** — email only, via Resend, matching `tips-reconcile-cron.mjs`'s and `schedule-alerts.mjs`'s existing pattern.
- **Shadow-mode testing, before this ever reaches real managers:** matching the established `NO_CLOCKIN_SHADOW_USER` pattern already used by `no-clockin-cron.mjs` (see `no-clockin-lib/run.mjs`), a new env var `MINOR_TIMECARD_SHADOW_EMAIL` redirects every email this feature sends to that one address instead of the real manager/DM/office-staff recipients, with the subject prefixed `[TEST]` and the email body annotated with who it would really have gone to. When the env var is unset, everything behaves normally (real recipients). This lets Ahmed test the whole real pipeline — real Paycor data, real violation detection, real escalation timing — against his own inbox before it ever reaches a real manager. Both crons (Tasks 4 and 5) implement this the same way.
- **Blob storage, not Neon Postgres** — this data doesn't need relational queries; matches the pattern the original (reverted) `break-compliance-cron.mjs` already used successfully.
- **Version bump:** bump `APP_VERSION` in `app.jsx` once, in the final UI task (Task 7) — this is the only task that touches user-visible frontend code.
- **`STORES` comes from the existing export**, not a new duplicate array: `import { STORES } from './tips-report-cron-background.mjs';` (both files live in `netlify/functions/`, so the path is `./`, not `../` — see `tips-reconcile-cron.mjs` for the precedent, which already imports `STORES` this same way).

---

### Task 1: Core violation-detection logic

**Files:**
- Create: `src/minor-timecard-detect.mjs`
- Test: `src/minor-timecard-detect.test.mjs`

**Interfaces:**
- Consumes: nothing (pure, no dependencies on other new files)
- Produces (used by Task 2 and Task 4/5):
  - `ageFromBirthDate(birthDate, asOfDate = new Date()) -> number|null`
  - `isMinor(age) -> boolean` (true when `age != null && age < 18`)
  - `weekRangeEndingYesterday(now = new Date()) -> { weekStart: 'YYYY-MM-DD', weekEnd: 'YYYY-MM-DD', days: ['YYYY-MM-DD', ...7 entries] }` — the Sunday-Saturday week ending on the day before `now`'s date (i.e., called Sunday morning, returns last week's Sun–Sat).
  - `groupPunchesByDate(punches) -> { [dateStr: string]: punch[] }` — buckets a flat punch array by the calendar date (America/New_York) portion of each punch's timestamp.
  - `analyzeDayForViolation(dayPunches) -> { status: 'ok'|'indeterminate', consecutiveHours: number|null, longestGapMinutes: number|null, violates: boolean }`

- [ ] **Step 1: Write the failing tests**

```js
// src/minor-timecard-detect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageFromBirthDate, isMinor, weekRangeEndingYesterday, groupPunchesByDate, analyzeDayForViolation } from './minor-timecard-detect.mjs';

test('ageFromBirthDate: exact age before and after the birthday this year', () => {
  assert.equal(ageFromBirthDate('2010-03-15', new Date('2026-03-14T12:00:00Z')), 15);
  assert.equal(ageFromBirthDate('2010-03-15', new Date('2026-03-15T12:00:00Z')), 16);
  assert.equal(ageFromBirthDate('2010-03-15', new Date('2026-06-01T12:00:00Z')), 16);
});

test('ageFromBirthDate: null/invalid input returns null, never throws', () => {
  assert.equal(ageFromBirthDate(null), null);
  assert.equal(ageFromBirthDate('not-a-date'), null);
});

test('isMinor: true under 18, false at or above, false for null', () => {
  assert.equal(isMinor(17), true);
  assert.equal(isMinor(18), false);
  assert.equal(isMinor(25), false);
  assert.equal(isMinor(null), false);
});

test('weekRangeEndingYesterday: called Sunday morning returns the just-finished Sun-Sat week', () => {
  // Sunday 2026-09-27 "now" -> the week that just ended is Sun 9/20 - Sat 9/26
  const { weekStart, weekEnd, days } = weekRangeEndingYesterday(new Date('2026-09-27T10:00:00Z'));
  assert.equal(weekStart, '2026-09-20');
  assert.equal(weekEnd, '2026-09-26');
  assert.deepEqual(days, ['2026-09-20','2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26']);
});

test('groupPunchesByDate: buckets by America/New_York calendar date', () => {
  const punches = [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:24:00' },
    { punchDateTime: '2026-09-20T07:00:00' },
  ];
  const grouped = groupPunchesByDate(punches);
  assert.equal(grouped['2026-09-19'].length, 2);
  assert.equal(grouped['2026-09-20'].length, 1);
  assert.equal(grouped['2026-09-21'], undefined);
});

test('analyzeDayForViolation: no break at all over 5h is a violation', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:24:00' },
  ]);
  assert.equal(result.status, 'ok');
  assert.equal(Math.round(result.consecutiveHours * 10) / 10, 5.4);
  assert.equal(result.violates, true);
});

test('analyzeDayForViolation: a genuine 30+ minute break resets the consecutive-hours clock, no violation', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' }, // in
    { punchDateTime: '2026-09-19T10:00:00' }, // out (4h stretch)
    { punchDateTime: '2026-09-19T10:35:00' }, // in (35 min break — qualifies)
    { punchDateTime: '2026-09-19T14:00:00' }, // out (3.42h stretch)
  ]);
  assert.equal(result.status, 'ok');
  assert.equal(result.violates, false);
  assert.ok(result.consecutiveHours < 5.0);
  assert.equal(Math.round(result.longestGapMinutes), 35);
});

test('analyzeDayForViolation: a break under 30 minutes does not reset the clock and does not prevent a violation', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' }, // in
    { punchDateTime: '2026-09-19T09:00:00' }, // out (3h)
    { punchDateTime: '2026-09-19T09:10:00' }, // in (10 min gap — does not qualify)
    { punchDateTime: '2026-09-19T12:30:00' }, // out (3.33h) -> combined stretch 6.5h
  ]);
  assert.equal(result.status, 'ok');
  assert.equal(result.violates, true);
  assert.equal(Math.round(result.longestGapMinutes), 10);
  assert.ok(result.consecutiveHours > 5.0);
});

test('analyzeDayForViolation: exactly 5.0 hours is a violation (>=, not >)', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:00:00' },
  ]);
  assert.equal(result.violates, true);
});

test('analyzeDayForViolation: under 5.0 hours total is never a violation even with zero break', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T10:30:00' },
  ]);
  assert.equal(result.violates, false);
});

test('analyzeDayForViolation: no punches at all is ok, zero hours, no violation', () => {
  const result = analyzeDayForViolation([]);
  assert.deepEqual(result, { status: 'ok', consecutiveHours: 0, longestGapMinutes: null, violates: false });
});

test('analyzeDayForViolation: an odd/unpaired punch count is indeterminate, never guessed as a violation', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:24:00' },
    { punchDateTime: '2026-09-19T21:52:00' }, // trailing unpaired punch, e.g. a forgotten clock-out
  ]);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.violates, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/minor-timecard-detect.test.mjs`
Expected: FAIL — `minor-timecard-detect.mjs` does not exist yet.

- [ ] **Step 3: Write the implementation**

```js
// src/minor-timecard-detect.mjs — pure PA minor-labor-law violation detection.
// No network, no blobs — every function here takes plain data in and returns
// plain data out, so the legally-sensitive math (§ analyzeDayForViolation) can
// be tested exhaustively without touching Paycor.
//
// PA's Child Labor Act requires employees under 18 to get an uninterrupted
// 30-minute break after 5 consecutive hours worked. A shorter gap does NOT
// satisfy the requirement and does NOT reset the consecutive-hours clock —
// time on either side of a sub-30-minute gap still counts as one continuous
// stretch for compliance purposes.
const VIOLATION_HOURS = 5.0;
const QUALIFYING_BREAK_MINUTES = 30;

export function ageFromBirthDate(birthDate, asOfDate = new Date()) {
  if (!birthDate) return null;
  const dob = new Date(birthDate);
  if (isNaN(dob)) return null;
  let age = asOfDate.getFullYear() - dob.getFullYear();
  const beforeBirthdayThisYear = (asOfDate.getMonth() < dob.getMonth())
    || (asOfDate.getMonth() === dob.getMonth() && asOfDate.getDate() < dob.getDate());
  if (beforeBirthdayThisYear) age--;
  return age;
}

export function isMinor(age) {
  return age != null && age < 18;
}

function toISODate(d) { return d.toISOString().slice(0, 10); }

// Called any day; returns the most recently COMPLETED Sun-Sat week (the week
// ending on the Saturday before `now`, even if `now` isn't a Sunday — the
// detection cron always calls this on Sunday, but keeping it correct for any
// day makes it safe to re-run manually without recomputing the boundary by hand).
export function weekRangeEndingYesterday(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Walk back to the most recent Saturday strictly before `start`.
  const dow = start.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceLastSaturday = dow === 6 ? 7 : dow + 1;
  const weekEndDate = new Date(start.getTime() - daysSinceLastSaturday * 86400000);
  const weekStartDate = new Date(weekEndDate.getTime() - 6 * 86400000);
  const days = [];
  for (let i = 0; i < 7; i++) days.push(toISODate(new Date(weekStartDate.getTime() + i * 86400000)));
  return { weekStart: toISODate(weekStartDate), weekEnd: toISODate(weekEndDate), days };
}

const punchTime = (p) => p.punchDateTime || p.punchIn || p.timeIn || null;

// Buckets by America/New_York calendar date, since punch timestamps from
// Paycor are ET wall-clock values with no timezone suffix (confirmed via
// direct API responses, e.g. "2026-09-16T05:37:00").
export function groupPunchesByDate(punches) {
  const grouped = {};
  for (const p of (punches || [])) {
    const t = punchTime(p);
    if (!t) continue;
    const dateStr = String(t).slice(0, 10);
    if (!grouped[dateStr]) grouped[dateStr] = [];
    grouped[dateStr].push(p);
  }
  return grouped;
}

// Analyzes ONE employee's punches for ONE already-completed day. Punches must
// pair up (clock-in, clock-out, clock-in, clock-out, ...) for a completed day
// — an odd count means a punch is missing/unpaired and the day cannot be
// safely analyzed, so this returns 'indeterminate' rather than guessing
// either way. (Confirmed necessary 2026-09-29: real punch data for overnight/
// irregular shifts is sometimes genuinely ambiguous, and guessing produced a
// wrong answer that had to be manually caught and corrected that same day.)
export function analyzeDayForViolation(dayPunches) {
  const sorted = [...(dayPunches || [])]
    .map(p => ({ raw: p, t: new Date(punchTime(p)) }))
    .filter(p => !isNaN(p.t))
    .sort((a, b) => a.t - b.t);

  if (sorted.length === 0) {
    return { status: 'ok', consecutiveHours: 0, longestGapMinutes: null, violates: false };
  }
  if (sorted.length % 2 !== 0) {
    return { status: 'indeterminate', consecutiveHours: null, longestGapMinutes: null, violates: false };
  }

  const pairs = [];
  for (let i = 0; i < sorted.length; i += 2) pairs.push({ in: sorted[i].t, out: sorted[i + 1].t });

  let longestGapMinutes = null;
  let stretchStart = pairs[0].in;
  let maxStretchHours = 0;
  const closeStretch = (end) => {
    const hours = (end - stretchStart) / 3600000;
    if (hours > maxStretchHours) maxStretchHours = hours;
  };

  for (let i = 1; i < pairs.length; i++) {
    const gapMinutes = (pairs[i].in - pairs[i - 1].out) / 60000;
    if (longestGapMinutes === null || gapMinutes > longestGapMinutes) longestGapMinutes = gapMinutes;
    if (gapMinutes >= QUALIFYING_BREAK_MINUTES) {
      closeStretch(pairs[i - 1].out);
      stretchStart = pairs[i].in;
    }
    // A sub-qualifying gap does NOT close the stretch — the clock keeps running
    // across it, per PA law's actual intent (see file header).
  }
  closeStretch(pairs[pairs.length - 1].out);

  return {
    status: 'ok',
    consecutiveHours: maxStretchHours,
    longestGapMinutes,
    violates: maxStretchHours >= VIOLATION_HOURS,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/minor-timecard-detect.test.mjs`
Expected: PASS, all 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/minor-timecard-detect.mjs src/minor-timecard-detect.test.mjs
git commit -m "feat(minor-timecard): add pure PA violation-detection logic"
```

---

### Task 2: Issue lifecycle, escalation, and recipient logic

**Files:**
- Create: `src/minor-timecard-lifecycle.mjs`
- Test: `src/minor-timecard-lifecycle.test.mjs`

**Interfaces:**
- Consumes: nothing directly (pure; takes plain issue-record objects shaped per the spec's Data Model section)
- Produces (used by Task 4/5/7):
  - `buildIssueId(pc, employeeId, violationDate) -> string`
  - `buildIssueRecord({ pc, storeName, district, employeeId, employeeName, weekStart, weekEnd, violationDate, consecutiveHours, now }) -> issueRecord` (per the spec's schema; `status:'open'`, `firstFlaggedAt: now.toISOString()`, `escalatedAt: null`, `resolvedAt: null`, `resolvedVia: null`, `resolvedBy: null`, `notifications: []`)
  - `mondayAfter(dateStr) -> 'YYYY-MM-DD'` — the ISO date of the Monday strictly after the given date's week (i.e., `mondayAfter(weekEnd)` where `weekEnd` is a Saturday).
  - `shouldEscalateToday(issue, todayDateStr) -> boolean` — true only when `issue.status === 'open'`, `issue.escalatedAt == null`, and `todayDateStr >= mondayAfter(issue.weekEnd)`.
  - `execBackstopDue(issue, todayDateStr) -> boolean` — true only when `issue.status === 'open'`, `issue.escalatedAt` is set, no notification in `issue.notifications` has `recipientRole === 'exec_backstop'` yet, and `todayDateStr` is 7+ calendar days after `issue.escalatedAt`'s date.
  - `resolveNotificationRecipients(issue, users) -> [{ role: 'manager'|'dm'|'office_staff'|'exec_backstop', email: string }]` — `users` is the shape already used elsewhere in this codebase (array with `userType`, `storePC`/`district`, `email`, `active`). Only returns entries with a real, non-empty email.
  - `filterIssuesForRole(issues, user) -> issue[]` — `executive`/`it`/`office_staff` see everything; `dm` sees issues where `issue.district === Number(user.district)`; `manager` sees issues where `issue.pc === user.storePC`; any other role sees nothing (`[]`).
  - `applyResolutionCheck(issue, freshDayResult, now) -> issue` — given the Task-1 `analyzeDayForViolation` result for the SAME violation date, re-fetched live: if `freshDayResult.status === 'ok' && !freshDayResult.violates`, returns `{ ...issue, status: 'resolved', resolvedAt: now.toISOString(), resolvedVia: 'auto' }`; otherwise returns `issue` unchanged (including when `status === 'indeterminate'` — never auto-resolve OR keep escalating off ambiguous data, just leave it exactly as-is and let the next day's check try again).

- [ ] **Step 1: Write the failing tests**

```js
// src/minor-timecard-lifecycle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIssueId, buildIssueRecord, mondayAfter, shouldEscalateToday,
  execBackstopDue, resolveNotificationRecipients, filterIssuesForRole, applyResolutionCheck,
} from './minor-timecard-lifecycle.mjs';

test('buildIssueId is stable and unique per store/employee/day', () => {
  assert.equal(buildIssueId('340538', 'emp-1', '2026-09-19'), buildIssueId('340538', 'emp-1', '2026-09-19'));
  assert.notEqual(buildIssueId('340538', 'emp-1', '2026-09-19'), buildIssueId('340538', 'emp-2', '2026-09-19'));
});

test('buildIssueRecord matches the spec schema with status open and empty escalation/resolution fields', () => {
  const now = new Date('2026-09-21T10:04:00Z');
  const issue = buildIssueRecord({ pc: '340538', storeName: 'Easton', district: 5, employeeId: 'emp-1', employeeName: 'Brajbala Mehta', weekStart: '2026-09-13', weekEnd: '2026-09-19', violationDate: '2026-09-19', consecutiveHours: 5.4, now });
  assert.equal(issue.status, 'open');
  assert.equal(issue.escalatedAt, null);
  assert.equal(issue.resolvedAt, null);
  assert.equal(issue.resolvedVia, null);
  assert.deepEqual(issue.notifications, []);
  assert.equal(issue.firstFlaggedAt, now.toISOString());
  assert.equal(issue.id, buildIssueId('340538', 'emp-1', '2026-09-19'));
});

test('mondayAfter: the Monday strictly after the week-ending Saturday', () => {
  assert.equal(mondayAfter('2026-09-19'), '2026-09-21'); // Sat 9/19 -> Mon 9/21
  assert.equal(mondayAfter('2026-09-26'), '2026-09-28');
});

test('shouldEscalateToday: false on the Sunday it was flagged, true from Monday onward', () => {
  const issue = { status: 'open', escalatedAt: null, weekEnd: '2026-09-19' };
  assert.equal(shouldEscalateToday(issue, '2026-09-20'), false); // still Sunday
  assert.equal(shouldEscalateToday(issue, '2026-09-21'), true);  // Monday
  assert.equal(shouldEscalateToday(issue, '2026-09-25'), true);  // later, still not escalated
});

test('shouldEscalateToday: false once already escalated or resolved', () => {
  assert.equal(shouldEscalateToday({ status: 'open', escalatedAt: '2026-09-21T10:00:00Z', weekEnd: '2026-09-19' }, '2026-09-22'), false);
  assert.equal(shouldEscalateToday({ status: 'resolved', escalatedAt: null, weekEnd: '2026-09-19' }, '2026-09-22'), false);
});

test('execBackstopDue: fires once, exactly 7+ days after escalation, only if not already sent', () => {
  const issue = { status: 'open', escalatedAt: '2026-09-21T10:00:00Z', notifications: [] };
  assert.equal(execBackstopDue(issue, '2026-09-27'), false); // day 6
  assert.equal(execBackstopDue(issue, '2026-09-28'), true);  // day 7
  const alreadySent = { ...issue, notifications: [{ recipientRole: 'exec_backstop', recipientEmail: 'x@y.com', sentAt: '2026-09-28T10:00:00Z', success: true, error: null }] };
  assert.equal(execBackstopDue(alreadySent, '2026-09-29'), false);
});

test('resolveNotificationRecipients: manager only before escalation', () => {
  const issue = { pc: '340538', district: 5, escalatedAt: null };
  const users = [
    { userType: 'manager', storePC: '340538', district: 5, email: 'mgr@x.com', active: true },
    { userType: 'dm', storePC: null, district: 5, email: 'dm@x.com', active: true },
    { userType: 'office_staff', email: 'office1@x.com', active: true },
  ];
  const recipients = resolveNotificationRecipients(issue, users);
  assert.deepEqual(recipients, [{ role: 'manager', email: 'mgr@x.com' }]);
});

test('resolveNotificationRecipients: manager + DM + all active office_staff once escalated', () => {
  const issue = { pc: '340538', district: 5, escalatedAt: '2026-09-21T10:00:00Z' };
  const users = [
    { userType: 'manager', storePC: '340538', district: 5, email: 'mgr@x.com', active: true },
    { userType: 'dm', storePC: null, district: 5, email: 'dm@x.com', active: true },
    { userType: 'office_staff', email: 'office1@x.com', active: true },
    { userType: 'office_staff', email: 'office2@x.com', active: true },
    { userType: 'office_staff', email: '', active: true }, // no email on file — excluded
    { userType: 'office_staff', email: 'inactive@x.com', active: false }, // inactive — excluded
  ];
  const recipients = resolveNotificationRecipients(issue, users);
  assert.deepEqual(recipients, [
    { role: 'manager', email: 'mgr@x.com' },
    { role: 'dm', email: 'dm@x.com' },
    { role: 'office_staff', email: 'office1@x.com' },
    { role: 'office_staff', email: 'office2@x.com' },
  ]);
});

test('filterIssuesForRole: exec/it/office_staff see everything, dm sees their district, manager sees their store, anyone else sees nothing', () => {
  const issues = [
    { pc: '340538', district: 5 },
    { pc: '342144', district: 6 },
  ];
  assert.equal(filterIssuesForRole(issues, { userType: 'executive' }).length, 2);
  assert.equal(filterIssuesForRole(issues, { userType: 'it' }).length, 2);
  assert.equal(filterIssuesForRole(issues, { userType: 'office_staff' }).length, 2);
  assert.deepEqual(filterIssuesForRole(issues, { userType: 'dm', district: 5 }), [issues[0]]);
  assert.deepEqual(filterIssuesForRole(issues, { userType: 'manager', storePC: '342144' }), [issues[1]]);
  assert.deepEqual(filterIssuesForRole(issues, { userType: 'construction' }), []);
});

test('applyResolutionCheck: resolves when the fresh check comes back clean', () => {
  const issue = { status: 'open' };
  const now = new Date('2026-09-22T10:00:00Z');
  const result = applyResolutionCheck(issue, { status: 'ok', violates: false }, now);
  assert.equal(result.status, 'resolved');
  assert.equal(result.resolvedVia, 'auto');
  assert.equal(result.resolvedAt, now.toISOString());
});

test('applyResolutionCheck: leaves the issue open when still violating', () => {
  const issue = { status: 'open' };
  const result = applyResolutionCheck(issue, { status: 'ok', violates: true }, new Date());
  assert.equal(result.status, 'open');
});

test('applyResolutionCheck: leaves the issue unchanged (never auto-resolves) on indeterminate data', () => {
  const issue = { status: 'open' };
  const result = applyResolutionCheck(issue, { status: 'indeterminate', violates: false }, new Date());
  assert.deepEqual(result, issue);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/minor-timecard-lifecycle.test.mjs`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```js
// src/minor-timecard-lifecycle.mjs — pure issue lifecycle: creation, escalation
// timing, notification-recipient resolution, role-based visibility, and
// resolution checking. No network, no blobs. See the spec (docs/superpowers/
// specs/2026-09-29-minor-timecard-compliance-design.md) for the schema and
// the escalation timeline this implements.
const EXEC_BACKSTOP_DAYS = 7;

export function buildIssueId(pc, employeeId, violationDate) {
  return `${pc}_${employeeId}_${violationDate}`;
}

export function buildIssueRecord({ pc, storeName, district, employeeId, employeeName, weekStart, weekEnd, violationDate, consecutiveHours, now = new Date() }) {
  return {
    id: buildIssueId(pc, employeeId, violationDate),
    pc, storeName, district, employeeId, employeeName,
    weekStart, weekEnd, violationDate, consecutiveHours,
    status: 'open',
    firstFlaggedAt: now.toISOString(),
    escalatedAt: null,
    resolvedAt: null,
    resolvedVia: null,
    resolvedBy: null,
    notifications: [],
  };
}

function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toISODate(d) { return d.toISOString().slice(0, 10); }
function addDays(dateStr, days) { return toISODate(new Date(parseDateOnly(dateStr).getTime() + days * 86400000)); }

// weekEnd is always a Saturday (see minor-timecard-detect.mjs's weekRangeEndingYesterday)
// -> the following Monday is always exactly 2 days later.
export function mondayAfter(weekEndDateStr) {
  return addDays(weekEndDateStr, 2);
}

export function shouldEscalateToday(issue, todayDateStr) {
  if (issue.status !== 'open' || issue.escalatedAt != null) return false;
  return todayDateStr >= mondayAfter(issue.weekEnd);
}

export function execBackstopDue(issue, todayDateStr) {
  if (issue.status !== 'open' || issue.escalatedAt == null) return false;
  const alreadySent = (issue.notifications || []).some(n => n.recipientRole === 'exec_backstop');
  if (alreadySent) return false;
  const escalatedDateStr = issue.escalatedAt.slice(0, 10);
  return todayDateStr >= addDays(escalatedDateStr, EXEC_BACKSTOP_DAYS);
}

export function resolveNotificationRecipients(issue, users) {
  const list = users || [];
  const out = [];
  const manager = list.find(u => u.active !== false && u.userType === 'manager' && String(u.storePC) === String(issue.pc) && u.email);
  if (manager) out.push({ role: 'manager', email: manager.email });
  if (issue.escalatedAt) {
    const dm = list.find(u => u.active !== false && u.userType === 'dm' && String(u.district) === String(issue.district) && u.email);
    if (dm) out.push({ role: 'dm', email: dm.email });
    list.filter(u => u.active !== false && u.userType === 'office_staff' && u.email)
      .forEach(u => out.push({ role: 'office_staff', email: u.email }));
  }
  return out;
}

export function filterIssuesForRole(issues, user) {
  const ut = user?.userType;
  if (ut === 'executive' || ut === 'it' || ut === 'office_staff') return issues;
  if (ut === 'dm') return issues.filter(i => String(i.district) === String(user.district));
  if (ut === 'manager') return issues.filter(i => String(i.pc) === String(user.storePC));
  return [];
}

export function applyResolutionCheck(issue, freshDayResult, now = new Date()) {
  if (freshDayResult.status === 'ok' && !freshDayResult.violates) {
    return { ...issue, status: 'resolved', resolvedAt: now.toISOString(), resolvedVia: 'auto' };
  }
  return issue;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/minor-timecard-lifecycle.test.mjs`
Expected: PASS, all 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/minor-timecard-lifecycle.mjs src/minor-timecard-lifecycle.test.mjs
git commit -m "feat(minor-timecard): add issue lifecycle, escalation, and recipient logic"
```

---

### Task 3: Email content builders

**Files:**
- Create: `src/minor-timecard-email.mjs`
- Test: `src/minor-timecard-email.test.mjs`

**Interfaces:**
- Consumes: issue records shaped per Task 2's `buildIssueRecord` output (specifically: `employeeName`, `violationDate`, `consecutiveHours`, `escalatedAt`, `firstFlaggedAt`), plus per-issue `dayPunches` (the raw punch array for that violation day, for the timeline).
- Produces (used by Task 4/5):
  - `buildEmailSubject(storeName, escalated, dayN) -> string`
  - `buildViolationCardHtml(issue, dayPunches) -> string` — an HTML fragment: employee name, date, a clock-in/break-or-gap/clock-out timeline line, and a summary strip (hours worked / 5.0h limit / break minutes taken).
  - `buildDigestEmailHtml(storeName, issuesWithPunches) -> string` — `issuesWithPunches` is `[{ issue, dayPunches }]`; wraps one or more violation cards in the full email body (title, PA-law explainer line, cards, a Paycor CTA link, and the standing HR/legal disclaimer footer).

- [ ] **Step 1: Write the failing tests**

```js
// src/minor-timecard-email.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmailSubject, buildViolationCardHtml, buildDigestEmailHtml } from './minor-timecard-email.mjs';

test('buildEmailSubject: calm framing before escalation', () => {
  assert.equal(buildEmailSubject('Easton', false, null), '⚠ Minor Timecard Review Needed — Easton');
});

test('buildEmailSubject: escalated framing includes the day count', () => {
  assert.equal(buildEmailSubject('Westchester', true, 3), '⚠ Minor Timecard Still Open — Westchester (Day 3)');
});

test('buildViolationCardHtml: includes employee name, date, hours, and a clean-break timeline', () => {
  const issue = { employeeName: 'Brajbala Mehta', violationDate: '2026-09-19', consecutiveHours: 5.4 };
  const dayPunches = [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:24:00' },
  ];
  const html = buildViolationCardHtml(issue, dayPunches);
  assert.match(html, /Brajbala Mehta/);
  assert.match(html, /5\.4/);
  assert.match(html, /No break recorded/i);
  assert.match(html, /6:00 AM/);
  assert.match(html, /11:24 AM/);
});

test('buildViolationCardHtml: a sub-qualifying break shows its actual length, not "no break"', () => {
  const issue = { employeeName: 'Test Person', violationDate: '2026-09-19', consecutiveHours: 6.5 };
  const dayPunches = [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T09:00:00' },
    { punchDateTime: '2026-09-19T09:10:00' },
    { punchDateTime: '2026-09-19T12:30:00' },
  ];
  const html = buildViolationCardHtml(issue, dayPunches);
  assert.match(html, /10 min/);
  assert.doesNotMatch(html, /No break recorded/i);
});

test('buildDigestEmailHtml: bundles multiple issues for the same store into one email with multiple cards', () => {
  const issues = [
    { issue: { employeeName: 'Person A', violationDate: '2026-09-19', consecutiveHours: 5.4 }, dayPunches: [{ punchDateTime: '2026-09-19T06:00:00' }, { punchDateTime: '2026-09-19T11:24:00' }] },
    { issue: { employeeName: 'Person B', violationDate: '2026-09-20', consecutiveHours: 6.0 }, dayPunches: [{ punchDateTime: '2026-09-20T07:00:00' }, { punchDateTime: '2026-09-20T13:00:00' }] },
  ];
  const html = buildDigestEmailHtml('Easton', issues);
  assert.match(html, /Person A/);
  assert.match(html, /Person B/);
  assert.match(html, /30-minute break/i);
  assert.match(html, /not a substitute for confirming/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/minor-timecard-email.test.mjs`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```js
// src/minor-timecard-email.mjs — pure HTML builders for the weekly minor-
// timecard-compliance emails. No network calls here; netlify/functions/
// minor-timecard-detect-cron.mjs and -followup-cron.mjs call these to get a
// string, then send it themselves via Resend.
function fmtTime(isoLocal) {
  // Paycor punch timestamps are ET wall-clock with no timezone suffix
  // (e.g. "2026-09-19T06:00:00") — format directly, no timezone conversion.
  const [, h, m] = /T(\d{2}):(\d{2})/.exec(isoLocal) || [];
  if (h == null) return '--';
  let hour = Number(h);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12; if (hour === 0) hour = 12;
  return `${hour}:${m} ${ampm}`;
}

const punchTime = (p) => p.punchDateTime || p.punchIn || p.timeIn || null;

export function buildEmailSubject(storeName, escalated, dayN) {
  return escalated
    ? `⚠ Minor Timecard Still Open — ${storeName} (Day ${dayN})`
    : `⚠ Minor Timecard Review Needed — ${storeName}`;
}

export function buildViolationCardHtml(issue, dayPunches) {
  const sorted = [...(dayPunches || [])].sort((a, b) => new Date(punchTime(a)) - new Date(punchTime(b)));
  const clockIn = sorted[0] ? fmtTime(punchTime(sorted[0])) : '--';
  const clockOut = sorted[sorted.length - 1] ? fmtTime(punchTime(sorted[sorted.length - 1])) : '--';

  let longestGapMinutes = 0;
  for (let i = 1; i < sorted.length; i += 2) {
    if (!sorted[i] || !sorted[i + 1]) break;
    const gap = (new Date(punchTime(sorted[i + 1])) - new Date(punchTime(sorted[i]))) / 60000;
    if (gap > longestGapMinutes) longestGapMinutes = gap;
  }
  const breakLine = longestGapMinutes >= 30
    ? `Break taken: ${Math.round(longestGapMinutes)} min`
    : longestGapMinutes > 0
      ? `Break attempt: ${Math.round(longestGapMinutes)} min (below the 30-minute requirement)`
      : 'No break recorded during shift';

  const dateLabel = new Date(issue.violationDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

  return `
<div style="background:#1c1c1c;border:1px solid #2a2a2a;border-left:3px solid #f59e0b;border-radius:0.65rem;padding:16px 18px;margin-bottom:14px;">
  <div style="font-weight:700;color:#e8e8e8;font-size:0.92rem;font-family:'Raleway',sans-serif;">${issue.employeeName}</div>
  <div style="color:#8a8a8a;font-size:0.78rem;margin-top:1px;">${dateLabel}</div>
  <div style="margin-top:12px;padding-top:12px;border-top:1px solid #2a2a2a;font-size:0.82rem;color:#d0d0d0;">
    Clocked in ${clockIn} · ${breakLine} · Clocked out ${clockOut}
  </div>
  <div style="display:flex;gap:0;margin-top:12px;background:#161616;border-radius:0.5rem;overflow:hidden;">
    <div style="flex:1;text-align:center;padding:9px 6px;border-right:1px solid #262626;">
      <div style="font-weight:800;font-size:0.95rem;color:#f0f0f0;">${issue.consecutiveHours.toFixed(1)}h</div>
      <div style="font-size:0.62rem;color:#7a7a7a;text-transform:uppercase;">Worked</div>
    </div>
    <div style="flex:1;text-align:center;padding:9px 6px;border-right:1px solid #262626;">
      <div style="font-weight:800;font-size:0.95rem;color:#f0f0f0;">5.0h</div>
      <div style="font-size:0.62rem;color:#7a7a7a;text-transform:uppercase;">PA Limit</div>
    </div>
    <div style="flex:1;text-align:center;padding:9px 6px;">
      <div style="font-weight:800;font-size:0.95rem;color:${longestGapMinutes >= 30 ? '#4ade80' : '#f87171'};">${Math.round(longestGapMinutes)} min</div>
      <div style="font-size:0.62rem;color:#7a7a7a;text-transform:uppercase;">Break Taken</div>
    </div>
  </div>
</div>`;
}

export function buildDigestEmailHtml(storeName, issuesWithPunches) {
  const cards = issuesWithPunches.map(({ issue, dayPunches }) => buildViolationCardHtml(issue, dayPunches)).join('\n');
  return `
<!DOCTYPE html><html><body style="background:#0f0f0f;color:#e8e8e8;font-family:'Source Sans 3',Arial,sans-serif;padding:26px;margin:0;">
  <div style="max-width:520px;margin:0 auto;">
    <div style="font-family:'Raleway',sans-serif;font-weight:800;font-size:1.15rem;color:#f0f0f0;margin-bottom:4px;">${storeName} — ${issuesWithPunches.length} timecard${issuesWithPunches.length !== 1 ? 's' : ''} need${issuesWithPunches.length === 1 ? 's' : ''} a look</div>
    <div style="color:#8a8a8a;font-size:0.85rem;margin-bottom:20px;">Pennsylvania requires a 30-minute break after 5 consecutive hours for employees under 18. Please review and correct the timecard(s) below in Paycor.</div>
    ${cards}
    <a href="https://apps.paycor.com" style="display:inline-block;background:#FF671F;color:#fff;text-decoration:none;padding:11px 22px;border-radius:0.55rem;font-weight:700;font-size:0.85rem;margin-top:6px;">Open Paycor</a>
    <div style="color:#5a5a5a;font-size:0.7rem;margin-top:22px;line-height:1.5;">Automated message from PCG Operations Portal — not a substitute for confirming PA minor labor rules with HR/legal.</div>
  </div>
</body></html>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/minor-timecard-email.test.mjs`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/minor-timecard-email.mjs src/minor-timecard-email.test.mjs
git commit -m "feat(minor-timecard): add email subject/content builders"
```

---

### Task 4: Sunday detection cron

**Files:**
- Create: `netlify/functions/minor-timecard-detect-cron.mjs`
- Modify: `netlify.toml` (add the schedule entry)

**Interfaces:**
- Consumes: `weekRangeEndingYesterday`, `groupPunchesByDate`, `analyzeDayForViolation`, `ageFromBirthDate`, `isMinor` (Task 1); `buildIssueRecord`, `resolveNotificationRecipients` (Task 2); `buildEmailSubject`, `buildDigestEmailHtml` (Task 3); `STORES` (from `../tips-report-cron-background.mjs`, existing export).
- Produces: writes `pcg_minor_timecard_issues_v1` and `pcg_minor_roster_v1` blobs (consumed by Task 5 and Task 7).

- [ ] **Step 1: Write the implementation** (no unit test for this file — it's an I/O wrapper around already-tested pure logic, consistent with how every other cron in this codebase is verified: manually via a preview/prod run, not `node --test`)

```js
// netlify/functions/minor-timecard-detect-cron.mjs — Sunday morning: scans
// every store's under-18 employees for the week that just ended, flags any
// PA minor-labor-law violation (5+ consecutive hours, no qualifying 30-min
// break), and emails each affected store's manager.
//
// IMPORTANT — data scope: Paycor's employeesIdentifyingData endpoint also
// returns socialSecurityNumber alongside birthDate. Only ever read/store
// `birthDate` from that response. See memory: project_paycor_identifying_data_scope.
import https from 'node:https';
import { getStore } from '@netlify/blobs';
import { STORES } from './tips-report-cron-background.mjs';
import { weekRangeEndingYesterday, groupPunchesByDate, analyzeDayForViolation, ageFromBirthDate, isMinor } from '../../src/minor-timecard-detect.mjs';
import { buildIssueRecord, resolveNotificationRecipients } from '../../src/minor-timecard-lifecycle.mjs';
import { buildEmailSubject, buildDigestEmailHtml } from '../../src/minor-timecard-email.mjs';

export const config = { schedule: '0 10 * * 0' }; // 6:00 AM ET, Sundays

const ROSTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ── Paycor OAuth (same pattern as the removed break-compliance-cron.mjs / labor-cron.mjs) ──
let tokenCache = { accessToken: null, refreshToken: process.env.PAYCOR_REFRESH_TOKEN || null, expiresAt: 0 };
let refreshPromise = null;
const PAYCOR_API_HOST = 'apis.paycor.com';

function httpsRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const options = { hostname, port: 443, path, method, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, data: raw }); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const clientId = process.env.PAYCOR_CLIENT_ID, clientSecret = process.env.PAYCOR_CLIENT_SECRET, subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;
  if (!clientId || !clientSecret || !subscriptionKey) throw new Error('Missing Paycor credentials');
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.accessToken;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    if (!tokenCache.refreshToken) throw new Error('NO_TOKEN');
    const formBody = [`grant_type=refresh_token`, `refresh_token=${encodeURIComponent(tokenCache.refreshToken)}`, `client_id=${encodeURIComponent(clientId)}`, `client_secret=${encodeURIComponent(clientSecret)}`].join('&');
    const res = await httpsRequest(PAYCOR_API_HOST, `/sts/v1/common/token?subscription-key=${subscriptionKey}`, 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' }, formBody);
    if (res.status === 200 && res.data.access_token) {
      tokenCache = { accessToken: res.data.access_token, refreshToken: res.data.refresh_token || tokenCache.refreshToken, expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000 };
      return tokenCache.accessToken;
    }
    throw new Error(`Token refresh failed: ${res.status}`);
  })();
  try { return await refreshPromise; } finally { refreshPromise = null; }
}

async function callPaycor(path) {
  const token = await getAccessToken();
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;
  const makeCall = async (tok) => httpsRequest(PAYCOR_API_HOST, path, 'GET', { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}`, 'Ocp-Apim-Subscription-Key': subscriptionKey });
  let res = await makeCall(token);
  if (res.status === 401) { tokenCache.accessToken = null; tokenCache.expiresAt = 0; res = await makeCall(await getAccessToken()); }
  return res;
}

function getBlobStore() { return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN }); }
async function blobLoad(key) { try { const raw = await getBlobStore().get(key, { type: 'json' }); return raw ? (raw.data !== undefined ? raw.data : raw) : null; } catch { return null; } }
async function blobSave(key, data) { await getBlobStore().setJSON(key, { savedAt: new Date().toISOString(), data }); }

// Only ever extracts employeeId + birthDate. See file header.
function mapIdentifyingRecord(rec) { return { employeeId: rec.employeeId, birthDate: rec.birthDate || null }; }

// Non-200/thrown failures are logged, not silently swallowed — confirmed
// necessary the hard way (2026-07-21, the original break-compliance-cron.mjs):
// a Paycor call failing this way is otherwise indistinguishable from "this
// store genuinely has no minors," which for a legal-compliance detector means
// silently reporting "all fine" while never actually checking anything.
async function fetchIdentifyingData(legalEntityId) {
  try {
    let all = [], path = `/v2/legalentities/${legalEntityId}/employeesIdentifyingData`;
    while (path) {
      const res = await callPaycor(path);
      if (res.status !== 200) { console.error(`[minor-timecard-detect] identifyingData ${legalEntityId} failed: HTTP ${res.status}`); break; }
      all = all.concat((res.data?.records || []).map(mapIdentifyingRecord));
      const token = res.data?.continuationToken;
      path = token ? `/v2/legalentities/${legalEntityId}/employeesIdentifyingData?continuationToken=${encodeURIComponent(token)}` : null;
    }
    return all;
  } catch (err) { console.error(`[minor-timecard-detect] identifyingData ${legalEntityId} error:`, err.message); return []; }
}

async function fetchActiveEmployees(legalEntityId) {
  try {
    const res = await callPaycor(`/v1/legalentities/${legalEntityId}/employees?include=All`);
    if (res.status !== 200) { console.error(`[minor-timecard-detect] employees ${legalEntityId} failed: HTTP ${res.status}`); return []; }
    return (res.data?.records || []).filter(e => e.statusData?.status === 'Active').map(e => ({ employeeId: e.id, name: `${e.firstName || ''} ${e.lastName || ''}`.trim() }));
  } catch (err) { console.error(`[minor-timecard-detect] employees ${legalEntityId} error:`, err.message); return []; }
}

async function getMinorRoster(store, cache) {
  const cached = cache?.[store.pc];
  if (cached && Date.now() - new Date(cached.updatedAt).getTime() < ROSTER_MAX_AGE_MS) return cached.minors;
  const [employees, identifying] = await Promise.all([fetchActiveEmployees(store.paycor), fetchIdentifyingData(store.paycor)]);
  const birthDateById = new Map(identifying.map(r => [r.employeeId, r.birthDate]));
  const minors = employees
    .map(e => ({ ...e, birthDate: birthDateById.get(e.employeeId) || null }))
    .map(e => ({ ...e, age: ageFromBirthDate(e.birthDate) }))
    .filter(e => isMinor(e.age))
    .map(e => ({ employeeId: e.employeeId, name: e.name }));
  return minors;
}

// Single call spanning the whole week, grouped locally by day — far fewer
// Paycor calls than fetching each of the 7 days separately across every minor
// at every store.
async function fetchWeekPunches(employeeId, weekStart, weekEnd) {
  try {
    const res = await callPaycor(`/v1/employees/${employeeId}/employeePunches?startDate=${weekStart}&endDate=${weekEnd}`);
    if (res.status !== 200) { console.error(`[minor-timecard-detect] employeePunches ${employeeId} failed: HTTP ${res.status}`); return []; }
    const punches = res.data?.records || res.data || [];
    return Array.isArray(punches) ? punches : [];
  } catch (err) { console.error(`[minor-timecard-detect] employeePunches ${employeeId} error:`, err.message); return []; }
}

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: process.env.NOTIFY_FROM || 'PCG Portal <alerts@peoplecapitalgroup.com>', to: Array.isArray(to) ? to : [to], subject, html });
    const req = https.request({ hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

// Shadow-mode testing (matches the established NO_CLOCKIN_SHADOW_USER pattern
// in no-clockin-lib/run.mjs): when MINOR_TIMECARD_SHADOW_EMAIL is set, every
// real recipient is collapsed into that one address instead, labelled with
// who it would really have gone to — lets this be tested against real Paycor
// data without ever reaching a real manager/DM/office-staff inbox. Unset in
// production once testing is done.
function applyShadowMode(recipients, subject, html) {
  const shadowEmail = process.env.MINOR_TIMECARD_SHADOW_EMAIL;
  if (!shadowEmail) return { recipients, subject, html };
  const wouldGoTo = recipients.map(r => `${r.role}: ${r.email}`).join(', ') || '(no recipients)';
  return {
    recipients: [{ role: 'shadow', email: shadowEmail }],
    subject: `[TEST] ${subject}`,
    html: `<div style="background:#f59e0b18;border:1px solid #f59e0b55;border-radius:0.5rem;padding:10px 14px;margin-bottom:16px;font-family:sans-serif;font-size:0.8rem;color:#fbbf24;">SHADOW MODE — would really go to: ${wouldGoTo}</div>${html}`,
  };
}

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try { await getAccessToken(); }
  catch (err) {
    console.error('[minor-timecard-detect] Paycor auth failed — aborting:', err.message);
    return new Response(JSON.stringify({ ok: false, error: `Paycor auth failed: ${err.message}` }), { status: 502, headers });
  }

  const now = new Date();
  const { weekStart, weekEnd } = weekRangeEndingYesterday(now);

  const [rosterCache, existingIssuesRaw, usersRaw] = await Promise.all([
    blobLoad('pcg_minor_roster_v1'),
    blobLoad('pcg_minor_timecard_issues_v1'),
    blobLoad('pcg_users_v1'),
  ]);
  const existingIssues = Array.isArray(existingIssuesRaw) ? existingIssuesRaw : [];
  const users = Array.isArray(usersRaw) ? usersRaw : [];
  const existingIds = new Set(existingIssues.map(i => i.id));
  const newRosterCache = { ...(rosterCache || {}) };

  const newIssues = [];
  const emailsSent = [];

  const BATCH = 6;
  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async (store) => {
      try {
        const minors = await getMinorRoster(store, rosterCache);
        newRosterCache[store.pc] = { minors, updatedAt: now.toISOString() };
        if (!minors.length) return;

        const storeNewIssues = [];
        for (const minor of minors) {
          const punches = await fetchWeekPunches(minor.employeeId, weekStart, weekEnd);
          const byDate = groupPunchesByDate(punches);
          for (const [dateStr, dayPunches] of Object.entries(byDate)) {
            const result = analyzeDayForViolation(dayPunches);
            if (result.status !== 'ok' || !result.violates) continue;
            const issue = buildIssueRecord({
              pc: store.pc, storeName: store.name, district: store.district,
              employeeId: minor.employeeId, employeeName: minor.name,
              weekStart, weekEnd, violationDate: dateStr,
              consecutiveHours: result.consecutiveHours, now,
            });
            if (existingIds.has(issue.id)) continue; // already tracked from a prior run this week
            storeNewIssues.push({ issue, dayPunches });
          }
        }
        if (!storeNewIssues.length) return;

        const realRecipients = resolveNotificationRecipients(storeNewIssues[0].issue, users); // manager-only pre-escalation, same for every issue at this store today
        const { recipients, subject, html } = applyShadowMode(realRecipients, buildEmailSubject(store.name, false, null), buildDigestEmailHtml(store.name, storeNewIssues));
        const notifications = [];
        for (const r of recipients) {
          const status = await sendEmail(r.email, subject, html);
          notifications.push({ recipientRole: r.role, recipientEmail: r.email, sentAt: now.toISOString(), success: status >= 200 && status < 300, error: status >= 200 && status < 300 ? null : `HTTP ${status}` });
        }
        for (const { issue } of storeNewIssues) { issue.notifications = notifications; newIssues.push(issue); }
        emailsSent.push({ pc: store.pc, storeName: store.name, issueCount: storeNewIssues.length });
      } catch (err) {
        console.error(`[minor-timecard-detect] ${store.name} error:`, err.message);
      }
    }));
  }

  await Promise.all([
    blobSave('pcg_minor_roster_v1', newRosterCache),
    blobSave('pcg_minor_timecard_issues_v1', [...existingIssues, ...newIssues]),
  ]);

  const summary = { ok: true, weekStart, weekEnd, newIssues: newIssues.length, storesEmailed: emailsSent.length };
  console.log('[minor-timecard-detect] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
```

- [ ] **Step 2: Add the schedule entry**

Add to `netlify.toml`, in the same style as the other scheduled functions already there:

```toml
[functions.minor-timecard-detect-cron]
  schedule = "0 10 * * 0"
```

- [ ] **Step 3: Verify syntax**

Run: `node --check netlify/functions/minor-timecard-detect-cron.mjs`
Expected: no output (valid syntax).

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/minor-timecard-detect-cron.mjs netlify.toml
git commit -m "feat(minor-timecard): add Sunday detection cron"
```

---

### Task 5: Daily follow-up / escalation cron

**Files:**
- Create: `netlify/functions/minor-timecard-followup-cron.mjs`
- Modify: `netlify.toml` (add the schedule entry)

**Interfaces:**
- Consumes: `analyzeDayForViolation` (Task 1 — note: `groupPunchesByDate` is NOT needed here, unlike Task 4; this cron fetches exactly one day's punches per issue via `fetchDayPunches`, so the result is already a single day's punch array with nothing to group); `shouldEscalateToday`, `execBackstopDue`, `resolveNotificationRecipients`, `applyResolutionCheck` (Task 2); `buildEmailSubject`, `buildDigestEmailHtml` (Task 3). Note: unlike Task 4, this cron does NOT import `STORES` — it operates on the existing issues array (each issue already carries its own `pc`/`storeName`/`district`), never needing to enumerate all 46 stores itself. Reuses the same Paycor-OAuth/blob-helper code pattern as Task 4 (duplicated in this file, consistent with how `tips-report-refresh-background.mjs` and `tips-report-cron-background.mjs` each keep their own copy rather than sharing a module across scheduled functions in this codebase).
- Produces: updates `pcg_minor_timecard_issues_v1` (read by Task 7's UI).

- [ ] **Step 1: Write the implementation**

```js
// netlify/functions/minor-timecard-followup-cron.mjs — runs every morning.
// For every currently-open minor-timecard issue: re-checks that one specific
// employee/day against live Paycor data. Resolves it automatically if the
// violation is gone; otherwise escalates it (Manager -> +DM +Office Staff)
// once it crosses into the Monday after the week it was flagged, and sends a
// fresh reminder to whoever is currently in the loop — every day, until
// resolved. See docs/superpowers/specs/2026-09-29-minor-timecard-compliance-design.md.
import https from 'node:https';
import { getStore } from '@netlify/blobs';
import { analyzeDayForViolation } from '../../src/minor-timecard-detect.mjs';
import { shouldEscalateToday, execBackstopDue, resolveNotificationRecipients, applyResolutionCheck } from '../../src/minor-timecard-lifecycle.mjs';
import { buildEmailSubject, buildDigestEmailHtml } from '../../src/minor-timecard-email.mjs';

export const config = { schedule: '0 10 * * *' }; // 6:00 AM ET, every day

// ── Paycor OAuth (same as minor-timecard-detect-cron.mjs) ──
let tokenCache = { accessToken: null, refreshToken: process.env.PAYCOR_REFRESH_TOKEN || null, expiresAt: 0 };
let refreshPromise = null;
const PAYCOR_API_HOST = 'apis.paycor.com';

function httpsRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const options = { hostname, port: 443, path, method, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, data: raw }); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const clientId = process.env.PAYCOR_CLIENT_ID, clientSecret = process.env.PAYCOR_CLIENT_SECRET, subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;
  if (!clientId || !clientSecret || !subscriptionKey) throw new Error('Missing Paycor credentials');
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.accessToken;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    if (!tokenCache.refreshToken) throw new Error('NO_TOKEN');
    const formBody = [`grant_type=refresh_token`, `refresh_token=${encodeURIComponent(tokenCache.refreshToken)}`, `client_id=${encodeURIComponent(clientId)}`, `client_secret=${encodeURIComponent(clientSecret)}`].join('&');
    const res = await httpsRequest(PAYCOR_API_HOST, `/sts/v1/common/token?subscription-key=${subscriptionKey}`, 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' }, formBody);
    if (res.status === 200 && res.data.access_token) {
      tokenCache = { accessToken: res.data.access_token, refreshToken: res.data.refresh_token || tokenCache.refreshToken, expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000 };
      return tokenCache.accessToken;
    }
    throw new Error(`Token refresh failed: ${res.status}`);
  })();
  try { return await refreshPromise; } finally { refreshPromise = null; }
}

async function callPaycor(path) {
  const token = await getAccessToken();
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;
  const makeCall = async (tok) => httpsRequest(PAYCOR_API_HOST, path, 'GET', { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}`, 'Ocp-Apim-Subscription-Key': subscriptionKey });
  let res = await makeCall(token);
  if (res.status === 401) { tokenCache.accessToken = null; tokenCache.expiresAt = 0; res = await makeCall(await getAccessToken()); }
  return res;
}

function getBlobStore() { return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN }); }
async function blobLoad(key) { try { const raw = await getBlobStore().get(key, { type: 'json' }); return raw ? (raw.data !== undefined ? raw.data : raw) : null; } catch { return null; } }
async function blobSave(key, data) { await getBlobStore().setJSON(key, { savedAt: new Date().toISOString(), data }); }

async function fetchDayPunches(employeeId, dateStr) {
  try {
    const res = await callPaycor(`/v1/employees/${employeeId}/employeePunches?startDate=${dateStr}&endDate=${dateStr}`);
    if (res.status !== 200) { console.error(`[minor-timecard-followup] employeePunches ${employeeId} failed: HTTP ${res.status}`); return null; } // fetch failure — distinct from "no punches", never treat as resolved
    const punches = res.data?.records || res.data || [];
    return Array.isArray(punches) ? punches : [];
  } catch (err) { console.error(`[minor-timecard-followup] employeePunches ${employeeId} error:`, err.message); return null; }
}

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: process.env.NOTIFY_FROM || 'PCG Portal <alerts@peoplecapitalgroup.com>', to: Array.isArray(to) ? to : [to], subject, html });
    const req = https.request({ hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

// Same shadow-mode testing as minor-timecard-detect-cron.mjs — see that
// file's comment for the full rationale. Both crons must apply this the same
// way so a shadow-mode test sees the complete Sunday-through-escalation flow
// in one inbox, not just the initial email.
function applyShadowMode(recipients, subject, html) {
  const shadowEmail = process.env.MINOR_TIMECARD_SHADOW_EMAIL;
  if (!shadowEmail) return { recipients, subject, html };
  const wouldGoTo = recipients.map(r => `${r.role}: ${r.email}`).join(', ') || '(no recipients)';
  return {
    recipients: [{ role: 'shadow', email: shadowEmail }],
    subject: `[TEST] ${subject}`,
    html: `<div style="background:#f59e0b18;border:1px solid #f59e0b55;border-radius:0.5rem;padding:10px 14px;margin-bottom:16px;font-family:sans-serif;font-size:0.8rem;color:#fbbf24;">SHADOW MODE — would really go to: ${wouldGoTo}</div>${html}`,
  };
}

const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try { await getAccessToken(); }
  catch (err) {
    console.error('[minor-timecard-followup] Paycor auth failed — aborting:', err.message);
    return new Response(JSON.stringify({ ok: false, error: `Paycor auth failed: ${err.message}` }), { status: 502, headers });
  }

  const now = new Date();
  const todayDateStr = now.toISOString().slice(0, 10);

  const [issuesRaw, usersRaw] = await Promise.all([blobLoad('pcg_minor_timecard_issues_v1'), blobLoad('pcg_users_v1')]);
  const issues = Array.isArray(issuesRaw) ? issuesRaw : [];
  const users = Array.isArray(usersRaw) ? usersRaw : [];

  // Group open issues (not first-flagged today — see the file's own schedule
  // comment) by store, so each store gets exactly one digest email covering
  // every one of its still-open issues today.
  const openByStore = {};
  let resolvedCount = 0, escalatedCount = 0;

  // Each issue is processed inside its own try/catch — one malformed record
  // (e.g. a corrupted date field) must never abort the whole run and lose
  // every other store's already-computed resolutions/escalations, matching
  // the per-store isolation the sibling detect-cron already uses.
  for (const issue of issues) {
    if (issue.status !== 'open') continue;
    if (issue.firstFlaggedAt.slice(0, 10) === todayDateStr) continue; // don't double-notify the day it was created

    try {
      const dayPunches = await fetchDayPunches(issue.employeeId, issue.violationDate);
      if (dayPunches !== null) {
        const freshResult = analyzeDayForViolation(dayPunches);
        const updated = applyResolutionCheck(issue, freshResult, now);
        if (updated.status === 'resolved') { resolvedCount++; Object.assign(issue, updated); continue; }
      }
      // still open (or fetch failed this run — leave it open, try again tomorrow)

      if (shouldEscalateToday(issue, todayDateStr)) { issue.escalatedAt = now.toISOString(); escalatedCount++; }

      if (!openByStore[issue.pc]) openByStore[issue.pc] = { storeName: issue.storeName, issues: [] };
      openByStore[issue.pc].issues.push({ issue, dayPunches: dayPunches || [] });
    } catch (err) {
      console.error(`[minor-timecard-followup] issue ${issue.id} error:`, err.message);
    }
  }

  let emailsSent = 0;
  for (const [pc, { storeName, issues: storeIssues }] of Object.entries(openByStore)) {
    try {
      const anyEscalated = storeIssues.some(({ issue }) => issue.escalatedAt);
      // Recipients must reflect the STORE's aggregate escalation state, not
      // just the first issue's — a store can have one long-escalated issue
      // and one freshly-flagged one in the same run. Picking whichever issue
      // is actually escalated (if any) keeps resolveNotificationRecipients'
      // per-issue contract correct without changing that function itself.
      // Confirmed necessary via review (2026-09-29): the naive
      // storeIssues[0].issue version silently dropped DM/office-staff from
      // an escalated issue's email whenever a not-yet-escalated issue
      // happened to sort first in the array.
      const representativeIssue = anyEscalated ? storeIssues.find(({ issue }) => issue.escalatedAt).issue : storeIssues[0].issue;
      const oldestFlagged = storeIssues.reduce((min, { issue }) => issue.firstFlaggedAt < min ? issue.firstFlaggedAt : min, storeIssues[0].issue.firstFlaggedAt);
      const dayN = daysBetween(oldestFlagged.slice(0, 10), todayDateStr) + 1;
      const realRecipients = resolveNotificationRecipients(representativeIssue, users);
      const { recipients, subject, html } = applyShadowMode(realRecipients, buildEmailSubject(storeName, anyEscalated, anyEscalated ? dayN : null), buildDigestEmailHtml(storeName, storeIssues));
      for (const r of recipients) {
        const status = await sendEmail(r.email, subject, html);
        const record = { recipientRole: r.role, recipientEmail: r.email, sentAt: now.toISOString(), success: status >= 200 && status < 300, error: status >= 200 && status < 300 ? null : `HTTP ${status}` };
        storeIssues.forEach(({ issue }) => issue.notifications.push(record));
      }
      if (recipients.length) emailsSent++;

      // 7-day exec backstop — once per issue, independent of the regular digest above.
      for (const { issue } of storeIssues) {
        if (execBackstopDue(issue, todayDateStr)) {
          const realExecUsers = users.filter(u => u.active !== false && (u.userType === 'executive' || u.userType === 'it') && u.email).map(u => ({ role: 'exec_backstop', email: u.email }));
          const backstop = applyShadowMode(realExecUsers, `⚠ Minor Timecard Unresolved 7+ Days — ${storeName}`, buildDigestEmailHtml(storeName, [{ issue, dayPunches: [] }]));
          for (const r of backstop.recipients) {
            const status = await sendEmail(r.email, backstop.subject, backstop.html);
            issue.notifications.push({ recipientRole: 'exec_backstop', recipientEmail: r.email, sentAt: now.toISOString(), success: status >= 200 && status < 300, error: status >= 200 && status < 300 ? null : `HTTP ${status}` });
          }
        }
      }
    } catch (err) {
      console.error(`[minor-timecard-followup] store ${pc} notification error:`, err.message);
    }
  }

  await blobSave('pcg_minor_timecard_issues_v1', issues);

  const summary = { ok: true, checked: issues.filter(i => i.status === 'open').length + resolvedCount, resolved: resolvedCount, newlyEscalated: escalatedCount, storesEmailed: emailsSent };
  console.log('[minor-timecard-followup] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
```

- [ ] **Step 2: Add the schedule entry**

Add to `netlify.toml`:

```toml
[functions.minor-timecard-followup-cron]
  schedule = "0 10 * * *"
```

- [ ] **Step 3: Verify syntax**

Run: `node --check netlify/functions/minor-timecard-followup-cron.mjs`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/minor-timecard-followup-cron.mjs netlify.toml
git commit -m "feat(minor-timecard): add daily follow-up/escalation cron"
```

---

### Task 6: Manual resolve endpoint

**Files:**
- Create: `netlify/functions/minor-timecard-resolve.mjs`

**Interfaces:**
- Consumes: `requireActiveUser` from `./auth-lib/require-user.js` (existing helper, see `tips-grant-check.mjs` for the exact call pattern); `neon` from `@neondatabase/serverless` (for the `requireActiveUser` DB check only — this feature's own data stays in Blobs per the Global Constraints).
- Produces: an authenticated POST endpoint the UI (Task 7) calls to manually resolve one issue.

- [ ] **Step 1: Write the implementation**

```js
// netlify/functions/minor-timecard-resolve.mjs — manual "Mark Resolved"
// override for exec/it/dm, for the case where Paycor's punch data hasn't
// caught up to a real fix yet (a confirmed real gap — see the Omar Ali/
// Westchester case, 2026-09-29). Restricted to exec/it/dm per the spec.
import { requireActiveUser } from './auth-lib/require-user.js';
import { neon } from '@neondatabase/serverless';
import { getStore } from '@netlify/blobs';

const db = () => neon(process.env.NEON_DATABASE_URL);
function getBlobStore() { return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN }); }

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db());
  if (!caller || !['executive', 'it', 'dm'].includes(caller.userType)) {
    return new Response(JSON.stringify({ error: 'Exec/IT/DM session required.' }), { status: 403, headers });
  }

  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers }); }
  const issueId = body?.issueId;
  if (!issueId) return new Response(JSON.stringify({ error: 'Missing issueId' }), { status: 400, headers });

  const store = getBlobStore();
  const raw = await store.get('pcg_minor_timecard_issues_v1', { type: 'json' });
  const issues = Array.isArray(raw?.data) ? raw.data : [];
  const idx = issues.findIndex(i => i.id === issueId);
  if (idx === -1) return new Response(JSON.stringify({ error: 'Issue not found' }), { status: 404, headers });

  // A DM may only resolve issues for their own district — exec/it can resolve any.
  if (caller.userType === 'dm' && String(issues[idx].district) !== String(caller.district)) {
    return new Response(JSON.stringify({ error: 'Not your district.' }), { status: 403, headers });
  }

  issues[idx] = { ...issues[idx], status: 'manually_resolved', resolvedAt: new Date().toISOString(), resolvedVia: 'manual', resolvedBy: caller.username || caller.sub };
  await store.setJSON('pcg_minor_timecard_issues_v1', { savedAt: new Date().toISOString(), data: issues });

  return new Response(JSON.stringify({ ok: true, issue: issues[idx] }), { status: 200, headers });
};
```

- [ ] **Step 2: Verify syntax**

Run: `node --check netlify/functions/minor-timecard-resolve.mjs`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/minor-timecard-resolve.mjs
git commit -m "feat(minor-timecard): add auth-gated manual resolve endpoint"
```

---

### Task 7: Admin UI screen, icon, tile registration, version bump, build, preview deploy

**Files:**
- Modify: `src/icons.jsx` (add a new, unique icon — do not reuse any existing tab's icon, per this project's standing rule)
- Modify: `app.jsx` (new `MinorTimecardComplianceTab` component; Tools-hub tile registration in 4 role blocks; tab render routing; `APP_VERSION` bump)

**Interfaces:**
- Consumes: `filterIssuesForRole` (Task 2, via a bundled copy or direct import — see note below); the `pcg_minor_timecard_issues_v1` blob (read via the existing `cloudLoad` helper already used throughout `app.jsx`); `POST /.netlify/functions/minor-timecard-resolve` (Task 6); `authHeader()` from `./src/portal-auth.mjs` (existing import already present at the top of `app.jsx`).

**Note on importing `src/minor-timecard-lifecycle.mjs` into `app.jsx`:** `app.jsx` is bundled by esbuild, and this project's existing pattern is for `app.jsx` to import small logic modules directly from `src/` (e.g. check the existing imports at the top of `app.jsx` for `./src/portal-auth.mjs`). Add `import { filterIssuesForRole } from './src/minor-timecard-lifecycle.mjs';` alongside the existing `src/` imports at the top of `app.jsx`, rather than reimplementing the role-filter logic a second time in JSX.

- [ ] **Step 1: Add a unique icon**

In `src/icons.jsx`, add a `minorTimecard` entry to the exported `ICONS` object (match the existing SVG-path style of a neighboring icon, e.g. `ICONS.incident` — find it and follow the exact same function signature `(c) => (<svg ...>...</svg>)` taking a color `c`). Use a clock-with-alert glyph (distinct from every other icon already in the file — confirm by searching `src/icons.jsx` for any existing clock/alert icon before finalizing the path data, per this project's "every tab needs a unique icon" rule).

- [ ] **Step 2: Add the import**

At the top of `app.jsx`, alongside the existing `./src/portal-auth.mjs` import line, add:

```js
import { filterIssuesForRole } from './src/minor-timecard-lifecycle.mjs';
```

- [ ] **Step 3: Build the `MinorTimecardComplianceTab` component**

Add a new component to `app.jsx` (place it near `IncidentReportsTab` for locality, since they're both Tools-hub tile components). It should:
- Load the issues blob via the existing `cloudLoad('pcg_minor_timecard_issues_v1')` helper on mount.
- Call `filterIssuesForRole(issues, user)` to scope the list.
- Render the header (icon, title, subtitle showing last-run time from the blob's `savedAt`/derived from the freshest issue), three clickable stat panels (Open/Escalated/Resolved-this-week, filtering the list below on click), and one row per issue group (grouped by `pc`) — status accent color, avatar-circle with the store's first letter, store name/district/pc, status badge, a mini notification trail (from `issue.notifications`), and for `exec`/`it`/`dm` users only, a "Mark Resolved" button that calls:

```js
const markResolved = async (issueId) => {
  if (!window.confirm('Mark this resolved? This stops the daily reminders for this issue.')) return;
  const res = await fetch('/.netlify/functions/minor-timecard-resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ issueId }),
  });
  if (res.ok) {
    const { issue } = await res.json();
    setIssues(prev => prev.map(i => i.id === issueId ? issue : i));
  } else {
    showAlert('Could not mark resolved — try again.');
  }
};
```

Match the app's real theme tokens exactly (`th.bg`, `th.card`, `th.cardBorder`, `th.text`, `th.muted` from the `th` prop every tab component already receives — not the hardcoded hex values used in the brainstorming mockups, which were a stand-in for the real theme object). Status colors: amber `#f59e0b` (open), red `#ef4444` (escalated), green `#22c55e` (resolved) — always paired with the text label already in the badge, never color alone.

- [ ] **Step 4: Register the Tools-hub tile**

In the `toolsTiles` array inside the `tab === "tools-hub"` block (find via searching for `id: 'incident-reports'` inside that array), add, immediately after the `incident-reports` entry:

```js
{ id: 'minor-timecard', name: 'Minor Timecard Compliance', sub: 'Weekly PA minor-labor-law timecard review — who needs a fix, and who\'s already been notified.', show: ['executive','it','office_staff','dm','manager'].includes(user?.userType) && accessSubOn(accessOverrides, user?.userType, 'tools-hub', 'minor-timecard'), icon: <>{ICONS.minorTimecard(TOOLS)}</> },
```

- [ ] **Step 5: Register the tab entry for the roles that should see it**

`getTabs()` needs a `{ id: "minor-timecard", label: "Minor Timecard Compliance", icon: (c) => ICONS.minorTimecard(c) }` entry (same shape as the existing `incident-reports` lines) added to exactly these role blocks, matching the spec's visibility list — search for `{ id: "incident-reports", label: "Incident Reports"` and add the new line immediately after it in:
1. The top/exec-it block (the one starting the function, before the first `if (ut === ...)`)
2. `if (ut === "office_staff")`
3. `if (ut === "dm")`
4. `if (ut === "manager")`

Do **not** add it to `auditor`, `construction`, `vendor`, or `maintenance` — those roles are outside the spec's visibility list.

- [ ] **Step 6: Wire the render route**

Immediately after the line `{tab === "incident-reports" && <IncidentReportsTab .../>}` add:

```js
{tab === "minor-timecard" && <MinorTimecardComplianceTab user={user} th={th} showAlert={showAlert} />}
```

- [ ] **Step 7: Bump the version**

In `app.jsx`, find `const APP_VERSION = "v21.19";` and bump the last digit: `const APP_VERSION = "v21.20";` (minor addition, per this project's versioning convention).

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: esbuild completes with no errors, `app.js` is regenerated.

- [ ] **Step 9: Scan for hook-order/role-rendering regressions**

Re-read the new `MinorTimecardComplianceTab` component and its call sites once more specifically for: hooks called conditionally or after an early return, and any role check that could render `undefined`/crash for a role not in the visibility list (e.g., a `manager` with no `storePC` set). Fix anything found before moving on — per this project's standing rule to proactively check for exactly this class of bug after any major change.

- [ ] **Step 10: Preview deploy**

Run: `netlify deploy` (no `--prod`) and share the resulting draft URL — per this project's standing preference, do this automatically after every build without being asked.

- [ ] **Step 11: Commit**

```bash
git add app.jsx app.js src/icons.jsx
git commit -m "feat(minor-timecard): add Admin UI screen, icon, and tile registration (v21.20)"
```

---

## Testing With Your Own Email

Once Tasks 4–6 are deployed, set the Netlify env var `MINOR_TIMECARD_SHADOW_EMAIL` to your own address (all deploy contexts, same as any other env var here) **before** the crons run for real. Every email this feature would send goes to you instead, labelled `[TEST]` in the subject and with a banner at the top of the email body saying exactly who it would really have gone to (manager/DM/office staff, by name/email). This lets you see the real detection results against real Paycor data, the real escalation timing, and the real email content — without a single real manager ever being touched. Once you're happy with it, remove the env var and it switches to real recipients.

## Self-Review Notes

- **Spec coverage:** Detection (Task 1+4), escalation/daily follow-up (Task 2+5), manual override (Task 6), email content (Task 3), Admin UI scoped by role (Task 7) — every section of the spec has a task. The 7-day exec backstop, the Sunday/same-day double-notification guard, and the indeterminate-punch-data safety behavior are each explicitly implemented and tested (Tasks 1, 2, 5).
- **Placeholder scan:** no TBD/TODO remain; every task has complete, runnable code.
- **Type/interface consistency:** `analyzeDayForViolation`'s `{status, consecutiveHours, longestGapMinutes, violates}` shape is used identically by Task 2's `applyResolutionCheck`, Task 4, and Task 5. The issue record shape from Task 2's `buildIssueRecord` matches what Task 3's email builders and Task 7's UI both expect (`employeeName`, `violationDate`, `consecutiveHours`, `escalatedAt`, `notifications`, etc.) — checked field-by-field against the spec's Data Model section.
- **Known deferred item:** this plan does not attempt to fix the separate Omar Ali/Westchester "Paycor raw punch vs. corrected timecard" gap — Task 5's daily re-check can occasionally take longer than expected to auto-resolve a real fix for exactly that reason, which is precisely why Task 6's manual override exists.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-29-minor-timecard-compliance.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
