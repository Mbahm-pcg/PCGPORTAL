# Labor Schedule Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a manager-facing "Build Schedule" tab that builds/approves next week's employee schedule via a card-per-employee flow, then pushes it to Paycor.

**Architecture:** A new 5th tab inside the existing `LaborDrillDown` component in `app.jsx`. Pure data-transformation logic (grouping, job/group defaulting, labor-total math) is built and unit-tested first as standalone functions, then three new UI components (`WeeklyScheduleGrid`, `RunningLaborHeader`, `EmployeeScheduleCard`) are composed into a top-level `ScheduleBuilder`, which is wired into `LaborDrillDown` with role-based build/view mode. The backend write endpoint (`createSchedulingShifts` in `netlify/functions/paycor.mjs`) already exists — no backend changes are needed.

**Tech Stack:** React 18 (no build step beyond esbuild — plain `.jsx` bundled to `app.js`), inline styles via `th`/`btn`/`inp`/`card` helpers from `src/theme.js`, Netlify Functions (existing `paycor.mjs` proxy, unchanged), Node.js standalone scripts for logic testing (this codebase has no Jest/RTL — verification is via direct Node scripts and live preview deploys, per established project convention).

**Spec:** `docs/superpowers/specs/2026-08-25-labor-schedule-builder-design.md`

## Global Constraints

- Nothing may write to Paycor except through the existing, already-shipped `createSchedulingShifts` action in `netlify/functions/paycor.mjs` — no new backend code.
- All new frontend code goes into `app.jsx` as inline function components, matching this codebase's existing single-file convention (confirmed: `LaborDrillDown`, `TipsReportBuilder`, and every other feature already live inline in `app.jsx` — do not create new files).
- Labor threshold colors: Green ≤22.9%, Yellow 23–25.9%, Red ≥26% (`LABOR_GREEN = 22.9`, `LABOR_YELLOW = 25.9` — reuse the canonical constants at `app.jsx:33267-33269`, do not redefine new ones).
- Role scope, exactly as the spec defines: `manager` = own store, build/edit/submit. `dm` = own district (`String(store.district) === String(user.district)`), view-only. `executive`/`it`/`office_staff` = all stores, view-only.
- Bump `APP_VERSION` (search `const APP_VERSION =` near `app.jsx:26078`) and run `npm run build` before every commit that touches `app.jsx`, per this project's standing convention. Increment the last digit for each task's commit (e.g. v20.06 → v20.07 → v20.08...).
- After every build, run `npx netlify deploy` (no `--prod`) and note the preview URL — this project's standing convention is to preview every change, never push straight to production without being asked.
- **`schedulingShifts` reads treat `endDate` as exclusive** (confirmed live in Task 1, 2026-08-25: a query with `endDate: '2026-09-01'` returns zero shifts dated `2026-09-01`, including real, pre-existing shifts unrelated to any test). Every date-range read against this action must request `endDate = <last desired day> + 1 day` to include that final day's shifts — do not pass the last desired day directly as `endDate`.

---

## Task 1: Validate the Paycor write path with a real, controlled test

**Files:**
- Create: `<scratchpad>/test_schedule_write_live.mjs` (temporary — this is a one-off validation script, not part of the app; save it to the scratchpad directory, not the repo)

**Interfaces:**
- Consumes: the already-deployed `createSchedulingShifts` / `deleteSchedulingShift` actions at `https://uop.peoplecapitalgroup.com/.netlify/functions/paycor` (no code changes — these already exist and are already deployed)
- Produces: confidence that the write path works end-to-end; no code artifact carries forward to later tasks

This task has no unit test of its own — it *is* the test. Nothing in later tasks can be trusted to work against real Paycor data until this passes.

- [ ] **Step 1: Get the real values needed for one test shift**

Run this to confirm Ahmed Bhuiyan's real IDs at Bustleton are still valid (they were confirmed earlier this project, but re-verify since state can drift):

```bash
curl -s -X POST "https://uop.peoplecapitalgroup.com/.netlify/functions/paycor" -H "Content-Type: application/json" -d '{"action":"employees","legalEntityId":"193884"}' | node -e '
let d="";process.stdin.on("data",c=>d+=c);
process.stdin.on("end",()=>{
  const r = JSON.parse(d);
  const me = (r.records||[]).find(e => e.id === "f0c42817-b32d-0000-0000-00005cf50200");
  console.log(me ? JSON.stringify(me.positionData) : "NOT FOUND");
});
'
```

Expected: real JSON output confirming the employee exists and is Active. If `NOT FOUND`, find a different real, Active employee at legal entity `193884` via the same `employees` action and use their `id` for the rest of this task instead.

- [ ] **Step 2: Write the test script**

Create `test_schedule_write_live.mjs` in the scratchpad directory:

```js
// One-off LIVE test against real Paycor data. Creates one real shift on
// one real employee, verifies it via a read, then deletes it. Run once
// to validate the write path before any UI depends on it.
const BASE = 'https://uop.peoplecapitalgroup.com/.netlify/functions/paycor';
const LEGAL_ENTITY_ID = '193884'; // Bustleton
const EMPLOYEE_ID = 'f0c42817-b32d-0000-0000-00005cf50200'; // Ahmed Bhuiyan
const SCHEDULE_GROUP_ID = '6215c7c0-1380-42c4-860b-f03187ae2f9e'; // "ALL", confirmed real at Bustleton
const SCHEDULING_JOB_ID = 'b8e28fce-0288-4a15-9ab4-bd57f4d84afd'; // Crew Member, confirmed real at Bustleton
const DEPARTMENT_ID = '270d012c-65d6-0000-0000-00005cf50200'; // "101 - Payroll - Cust Svc", confirmed real at Bustleton for Crew Member

async function call(action, body) {
  const res = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }) });
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  // Pick a near-term test date/time — a few days out, low-traffic hour.
  // (This is the SHIFT's own date, unrelated to the read-verification date
  // range below — Paycor accepts a future shift date fine, it only rejects
  // a future *startDate* on the schedulingShifts READ query.)
  const start = '2026-09-01T02:00:00Z'; // arbitrary test slot
  const end = '2026-09-01T03:00:00Z';

  console.log('--- Step A: create the test shift ---');
  const created = await call('createSchedulingShifts', {
    legalEntityId: LEGAL_ENTITY_ID,
    shifts: [{
      employeeId: EMPLOYEE_ID,
      scheduleGroupId: SCHEDULE_GROUP_ID,
      schedulingJobId: SCHEDULING_JOB_ID,
      startDateTime: start,
      endDateTime: end,
      title: 'PLAN VALIDATION TEST — SAFE TO DELETE',
      isPublished: true,
      departmentId: DEPARTMENT_ID,
      // Per Paycor's own docs (confirmed 2026-08-25): shiftModelId is NOT a
      // reference to an existing entity to look up — it's a caller-generated
      // GUID, unique within this batch, used only during the creation
      // process itself (same idea as processId elsewhere in this codebase).
      shiftModelId: crypto.randomUUID(),
    }],
    ignoreWarnings: true,
  });
  console.log(JSON.stringify(created, null, 2));

  // Response shape is not yet confirmed against the real API — Paycor's
  // docs show a collapsed "shift" field in the 201 sample without the
  // nested detail expanded. Log the full response above and inspect it
  // directly; adjust this extraction to match whatever key/shape actually
  // comes back (likely `created.data.shift[0].shiftId` or
  // `created.data.shifts[0].shiftId` — try both, and fall back to printing
  // `Object.keys(created.data)` if neither matches so the real shape is
  // visible rather than silently failing).
  const shiftId = created.data?.shift?.[0]?.shiftId || created.data?.shifts?.[0]?.shiftId || created.data?.[0]?.shiftId;
  if (!shiftId) {
    console.error('FAILED: no shiftId found at any expected path. Full response logged above.');
    console.error('Top-level response keys:', created.data && typeof created.data === 'object' ? Object.keys(created.data) : typeof created.data);
    process.exit(1);
  }
  console.log('Created shiftId:', shiftId);

  console.log('--- Step B: verify it shows up on a live read ---');
  // startDate must be <= today (Paycor rejects a future startDate on this
  // read, confirmed 2026-08-25) even though the shift itself is dated in
  // the future — use today's date as startDate, the shift's own date as endDate.
  const todayISO = new Date().toISOString().slice(0, 10);
  const read = await call('schedulingShifts', { legalEntityId: LEGAL_ENTITY_ID, startDate: todayISO, endDate: '2026-09-01' });
  const found = (read.data?.records || []).find(s => s.id === shiftId);
  console.log('Found on live read:', !!found, found ? JSON.stringify(found) : '(not found — investigate before proceeding)');

  console.log('--- Step C: delete the test shift ---');
  const deleted = await call('deleteSchedulingShift', { legalEntityId: LEGAL_ENTITY_ID, shiftId });
  console.log(JSON.stringify(deleted, null, 2));

  console.log('--- Step D: confirm deletion ---');
  const readAfter = await call('schedulingShifts', { legalEntityId: LEGAL_ENTITY_ID, startDate: todayISO, endDate: '2026-09-01' });
  const stillThere = (readAfter.data?.records || []).find(s => s.id === shiftId);
  console.log('Still present after delete (should be false):', !!stillThere);
}

main();
```

- [ ] **Step 3: Run it**

```bash
node test_schedule_write_live.mjs
```

Expected output, in order: a real `shiftId` from Step A, `Found on live read: true` in Step B, a successful (non-error) response in Step C, and `Still present after delete (should be false): false` in Step D.

**If any step fails:** stop here. Do not proceed to Task 2 or any later task — the whole feature depends on this write path working. Debug the specific failure (check the response body for the real Paycor error) before continuing.

- [ ] **Step 4: Also verify manually in Paycor's own UI**

Before deleting (pause between Step A and Step C if needed, or re-run Step A alone first), have a human check Paycor's own Schedules view for Bustleton on 2026-09-01 and confirm the shift is visible there with the correct employee/time — the API read in Step B confirms the API sees it, but a human check confirms it actually renders correctly in Paycor's product too.

- [ ] **Step 5: Delete the temporary test script**

```bash
rm test_schedule_write_live.mjs
```

Nothing from this task ships — it's pure validation. No commit for this task.

---

## Task 2: Pure data-transformation helpers

**Files:**
- Modify: `app.jsx` — add new functions near the existing `LaborDrillDown` component (insert before `function LaborDrillDown` at `app.jsx:32204`)

**Interfaces:**
- Consumes: nothing from earlier tasks (Task 1 produced no code)
- Produces:
  - `scheduleGroupShiftsByEmployee(shiftRecords)` → `{ [employeeId]: Array<{dayOffset, startTime, endTime, schedulingJobId, scheduleGroupId, departmentId}> }`
  - `scheduleDefaultJobGroupForEmployee(jobTitle, employees, shiftsByEmployee)` → `{ schedulingJobId, scheduleGroupId, departmentId, needsConfirmation }`
  - `scheduleComputeWeeklyTotal(cards, payRatesByEmployeeId)` → `{ totalHours, totalDollars, byEmployee: Array<{employeeId, hours, dollars, rateAvailable}> }`
  - A shared shift-card shape used by every later task: `{ employeeId, employeeName, jobTitle, schedulingJobId, scheduleGroupId, departmentId, shifts: Array<{dayOffset: 0-6, startTime: "HH:MM", endTime: "HH:MM"}> }` (`dayOffset` 0 = Sunday of the target week, matching how the rest of this codebase's tips period logic treats weeks — see `tipsAddDays`/`tipsFormatISODate` near `app.jsx:37905` for the existing date-handling convention to match). `departmentId` is required on every Paycor shift write (confirmed via Task 1's live validation, 2026-08-25) and is carried on the card the same way `schedulingJobId`/`scheduleGroupId` are.

- [ ] **Step 1: Write the failing tests**

Create `test_schedule_helpers.mjs` in the scratchpad directory:

```js
// Mirrors the real implementation to be added to app.jsx. Run standalone
// with Node — this codebase has no Jest/RTL, verification is done via
// direct script execution (matching this project's established pattern).

function scheduleGroupShiftsByEmployee(shiftRecords, weekStartISO) {
  const weekStart = new Date(weekStartISO + 'T00:00:00Z');
  const byEmployee = {};
  (shiftRecords || []).forEach(s => {
    const start = new Date(s.startDateTime);
    const end = new Date(s.endDateTime);
    const dayOffset = Math.round((Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()) - Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate())) / 86400000);
    const fmt = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    if (!byEmployee[s.employeeId]) byEmployee[s.employeeId] = [];
    byEmployee[s.employeeId].push({ dayOffset, startTime: fmt(start), endTime: fmt(end), schedulingJobId: s.schedulingJobId, scheduleGroupId: s.scheduleGroupId, departmentId: s.departmentId });
  });
  return byEmployee;
}

// departmentId is required on every Paycor shift write (confirmed via
// Task 1's live validation, 2026-08-25 — a bare shift without it gets
// rejected with a 400). Reused via the exact same same-job-title-employee
// pattern as schedulingJobId/scheduleGroupId, since a department is tied
// to a role the same way a scheduling job is.
function scheduleDefaultJobGroupForEmployee(jobTitle, employees, shiftsByEmployee) {
  const sameTitle = (employees || []).find(e => e.positionData?.jobTitle === jobTitle && shiftsByEmployee[e.id]?.length);
  if (sameTitle) {
    const s = shiftsByEmployee[sameTitle.id][0];
    return { schedulingJobId: s.schedulingJobId, scheduleGroupId: s.scheduleGroupId, departmentId: s.departmentId, needsConfirmation: false };
  }
  const allShifts = Object.values(shiftsByEmployee).flat();
  if (allShifts.length === 0) return { schedulingJobId: null, scheduleGroupId: null, departmentId: null, needsConfirmation: true };
  const groupCounts = {};
  const deptCounts = {};
  allShifts.forEach(s => {
    groupCounts[s.scheduleGroupId] = (groupCounts[s.scheduleGroupId] || 0) + 1;
    if (s.departmentId) deptCounts[s.departmentId] = (deptCounts[s.departmentId] || 0) + 1;
  });
  const mostCommonGroup = Object.entries(groupCounts).sort((a, b) => b[1] - a[1])[0][0];
  const mostCommonDept = Object.keys(deptCounts).length ? Object.entries(deptCounts).sort((a, b) => b[1] - a[1])[0][0] : null;
  return { schedulingJobId: null, scheduleGroupId: mostCommonGroup, departmentId: mostCommonDept, needsConfirmation: true };
}

function scheduleComputeWeeklyTotal(cards, payRatesByEmployeeId) {
  let totalHours = 0, totalDollars = 0;
  const byEmployee = (cards || []).map(card => {
    const hours = (card.shifts || []).reduce((sum, sh) => {
      const [sh1, sm1] = sh.startTime.split(':').map(Number);
      const [sh2, sm2] = sh.endTime.split(':').map(Number);
      return sum + ((sh2 * 60 + sm2) - (sh1 * 60 + sm1)) / 60;
    }, 0);
    const rate = payRatesByEmployeeId[card.employeeId];
    const rateAvailable = rate != null;
    const dollars = rateAvailable ? hours * rate : 0;
    totalHours += hours;
    if (rateAvailable) totalDollars += dollars;
    return { employeeId: card.employeeId, hours: Math.round(hours * 100) / 100, dollars: Math.round(dollars * 100) / 100, rateAvailable };
  });
  return { totalHours: Math.round(totalHours * 100) / 100, totalDollars: Math.round(totalDollars * 100) / 100, byEmployee };
}

let pass = true;
function check(label, cond) { console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) pass = false; }

// Test 1: grouping shifts by employee, correct dayOffset/time extraction
{
  const shifts = [
    { employeeId: 'e1', startDateTime: '2026-09-06T09:00:00Z', endDateTime: '2026-09-06T17:00:00Z', schedulingJobId: 'job1', scheduleGroupId: 'grp1', departmentId: 'dept1' }, // Sunday = dayOffset 0
    { employeeId: 'e1', startDateTime: '2026-09-07T10:00:00Z', endDateTime: '2026-09-07T18:00:00Z', schedulingJobId: 'job1', scheduleGroupId: 'grp1', departmentId: 'dept1' }, // Monday = dayOffset 1
    { employeeId: 'e2', startDateTime: '2026-09-08T08:00:00Z', endDateTime: '2026-09-08T16:00:00Z', schedulingJobId: 'job2', scheduleGroupId: 'grp1', departmentId: 'dept2' },
  ];
  const grouped = scheduleGroupShiftsByEmployee(shifts, '2026-09-06');
  check('1a. two employees grouped', Object.keys(grouped).length === 2);
  check('1b. e1 has 2 shifts', grouped.e1.length === 2);
  check('1c. Sunday shift has dayOffset 0', grouped.e1[0].dayOffset === 0);
  check('1d. Monday shift has dayOffset 1', grouped.e1[1].dayOffset === 1);
  check('1e. start time extracted correctly', grouped.e1[0].startTime === '09:00');
  check('1f. end time extracted correctly', grouped.e1[0].endTime === '17:00');
  check('1g. departmentId carried through', grouped.e1[0].departmentId === 'dept1');
}

// Test 2: new-employee job/group/department defaulting via shared job title
{
  const employees = [
    { id: 'e1', positionData: { jobTitle: 'Crew Member' } },
    { id: 'e2', positionData: { jobTitle: 'Crew Member' } },
  ];
  const shiftsByEmployee = { e1: [{ dayOffset: 0, startTime: '09:00', endTime: '17:00', schedulingJobId: 'jobCrew', scheduleGroupId: 'grpAll', departmentId: 'deptCrew' }] };
  const result = scheduleDefaultJobGroupForEmployee('Crew Member', employees, shiftsByEmployee);
  check('2a. reuses job/group from same-title employee', result.schedulingJobId === 'jobCrew' && result.scheduleGroupId === 'grpAll');
  check('2b. reuses department from same-title employee', result.departmentId === 'deptCrew');
  check('2c. does not need confirmation when a match is found', result.needsConfirmation === false);
}

// Test 3: new-employee fallback when no one shares their title
{
  const employees = [{ id: 'e1', positionData: { jobTitle: 'Crew Member' } }];
  const shiftsByEmployee = {
    e1: [
      { dayOffset: 0, startTime: '09:00', endTime: '17:00', schedulingJobId: 'jobCrew', scheduleGroupId: 'grpAll', departmentId: 'deptCrew' },
      { dayOffset: 1, startTime: '09:00', endTime: '17:00', schedulingJobId: 'jobCrew', scheduleGroupId: 'grpAll', departmentId: 'deptCrew' },
    ],
  };
  const result = scheduleDefaultJobGroupForEmployee('Shift Leader', employees, shiftsByEmployee);
  check('3a. falls back to most common group', result.scheduleGroupId === 'grpAll');
  check('3b. falls back to most common department', result.departmentId === 'deptCrew');
  check('3c. flags for manual confirmation', result.needsConfirmation === true);
  check('3d. no job guessed (left null, not a wrong guess)', result.schedulingJobId === null);
}

// Test 4: weekly labor total math, including a missing-rate case
{
  const cards = [
    { employeeId: 'e1', shifts: [{ dayOffset: 0, startTime: '09:00', endTime: '17:00' }] }, // 8 hours
    { employeeId: 'e2', shifts: [{ dayOffset: 0, startTime: '10:00', endTime: '14:30' }] }, // 4.5 hours
  ];
  const rates = { e1: 15 }; // e2 has no rate on file
  const result = scheduleComputeWeeklyTotal(cards, rates);
  check('4a. total hours correct', result.totalHours === 12.5);
  check('4b. total dollars only counts employees with a rate', result.totalDollars === 120);
  check('4c. e1 marked rateAvailable', result.byEmployee.find(e => e.employeeId === 'e1').rateAvailable === true);
  check('4d. e2 marked rate unavailable, not silently $0-and-hidden', result.byEmployee.find(e => e.employeeId === 'e2').rateAvailable === false);
}

console.log('\n' + (pass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
process.exit(pass ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails first**

Since the implementation is inline in the test file above (not yet in `app.jsx`), this actually passes immediately when run standalone — that's expected for this project's convention (the test *is* the spec for the `app.jsx` port). Run it now to confirm the reference implementation itself is correct:

```bash
node test_schedule_helpers.mjs
```

Expected: `ALL TESTS PASSED`. If any test fails, fix the reference implementation in the test file itself before proceeding — do not port broken logic into `app.jsx`.

- [ ] **Step 3: Port the three functions into `app.jsx`**

Insert immediately before `function LaborDrillDown({ store, stores, th, user, users, laborData, onBack }) {` at `app.jsx:32204`:

```js
// Groups a schedulingShifts API read (flat array of shift records) by
// employeeId, converting each shift's absolute startDateTime/endDateTime
// into a { dayOffset (0=Sunday of the given week), startTime, endTime }
// shape relative to weekStartISO — used to pre-fill each employee's card
// with last week's actual shifts. See docs/superpowers/specs/2026-08-25-labor-schedule-builder-design.md.
function scheduleGroupShiftsByEmployee(shiftRecords, weekStartISO) {
  const weekStart = new Date(weekStartISO + 'T00:00:00Z');
  const byEmployee = {};
  (shiftRecords || []).forEach(s => {
    const start = new Date(s.startDateTime);
    const end = new Date(s.endDateTime);
    const dayOffset = Math.round((Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()) - Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate())) / 86400000);
    const fmt = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    if (!byEmployee[s.employeeId]) byEmployee[s.employeeId] = [];
    byEmployee[s.employeeId].push({ dayOffset, startTime: fmt(start), endTime: fmt(end), schedulingJobId: s.schedulingJobId, scheduleGroupId: s.scheduleGroupId, departmentId: s.departmentId });
  });
  return byEmployee;
}

// A new employee (no shifts last week) has no schedulingJobId/scheduleGroupId/
// departmentId to reuse. Paycor doesn't expose a live job lookup (the "View
// Legal Entity Scheduling Jobs" Data Access scope isn't enabled), so this
// reuses another employee's known values instead: first choice is someone at
// the same store sharing the same live job title; fallback is whichever
// scheduleGroupId/departmentId appears most often, flagged for manual
// confirmation since the job itself couldn't be determined. departmentId is
// required on every Paycor shift write (confirmed via live 400 response —
// see Task 1), so it's carried through the same reuse/fallback logic as
// scheduleGroupId.
function scheduleDefaultJobGroupForEmployee(jobTitle, employees, shiftsByEmployee) {
  const sameTitle = (employees || []).find(e => e.positionData?.jobTitle === jobTitle && shiftsByEmployee[e.id]?.length);
  if (sameTitle) {
    const s = shiftsByEmployee[sameTitle.id][0];
    return { schedulingJobId: s.schedulingJobId, scheduleGroupId: s.scheduleGroupId, departmentId: s.departmentId, needsConfirmation: false };
  }
  const allShifts = Object.values(shiftsByEmployee).flat();
  if (allShifts.length === 0) return { schedulingJobId: null, scheduleGroupId: null, departmentId: null, needsConfirmation: true };
  const groupCounts = {};
  const deptCounts = {};
  allShifts.forEach(s => {
    groupCounts[s.scheduleGroupId] = (groupCounts[s.scheduleGroupId] || 0) + 1;
    if (s.departmentId) deptCounts[s.departmentId] = (deptCounts[s.departmentId] || 0) + 1;
  });
  const mostCommonGroup = Object.entries(groupCounts).sort((a, b) => b[1] - a[1])[0][0];
  const mostCommonDept = Object.keys(deptCounts).length ? Object.entries(deptCounts).sort((a, b) => b[1] - a[1])[0][0] : null;
  return { schedulingJobId: null, scheduleGroupId: mostCommonGroup, departmentId: mostCommonDept, needsConfirmation: true };
}

// Running weekly labor $/hours total across every card currently in the
// builder. An employee with no pay rate on file still contributes their
// hours to the total but is flagged rateAvailable:false rather than being
// silently counted as $0, which would understate projected labor cost.
function scheduleComputeWeeklyTotal(cards, payRatesByEmployeeId) {
  let totalHours = 0, totalDollars = 0;
  const byEmployee = (cards || []).map(card => {
    const hours = (card.shifts || []).reduce((sum, sh) => {
      const [sh1, sm1] = sh.startTime.split(':').map(Number);
      const [sh2, sm2] = sh.endTime.split(':').map(Number);
      return sum + ((sh2 * 60 + sm2) - (sh1 * 60 + sm1)) / 60;
    }, 0);
    const rate = payRatesByEmployeeId[card.employeeId];
    const rateAvailable = rate != null;
    const dollars = rateAvailable ? hours * rate : 0;
    totalHours += hours;
    if (rateAvailable) totalDollars += dollars;
    return { employeeId: card.employeeId, hours: Math.round(hours * 100) / 100, dollars: Math.round(dollars * 100) / 100, rateAvailable };
  });
  return { totalHours: Math.round(totalHours * 100) / 100, totalDollars: Math.round(totalDollars * 100) / 100, byEmployee };
}
```

- [ ] **Step 4: Rebuild and verify no syntax errors**

```bash
npm run build
```

Expected: `app.js` rebuilds with no errors (esbuild will fail loudly on any syntax mistake).

- [ ] **Step 5: Delete the temporary test script and commit**

```bash
rm test_schedule_helpers.mjs
```

Bump `APP_VERSION` (one digit) in `app.jsx`, rebuild again, then:

```bash
git add app.jsx app.js
git commit -m "Add pure data-transformation helpers for schedule builder"
```

---

## Task 3: `WeeklyScheduleGrid` component (shared, view mode first)

**Files:**
- Modify: `app.jsx` — add after the Task 2 helper functions, still before `function LaborDrillDown` at `app.jsx:32204`

**Interfaces:**
- Consumes: the shared card shape from Task 2 — `Array<{employeeId, employeeName, shifts: Array<{dayOffset, startTime, endTime}>}>`
- Produces: `WeeklyScheduleGrid({ weekStartISO, cards, th, mode })` component. `mode` is `'view'` for this task (read-only rendering); Task 6 will pass `'build'` mode with edit controls layered on top by `EmployeeScheduleCard`, not by this component itself — `WeeklyScheduleGrid` only ever renders, it never owns edit state.

- [ ] **Step 1: Add the component**

Insert after the Task 2 functions:

```js
const SCHEDULE_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Employee-rows x day-columns weekly grid, matching the visual shape of
// Paycor's own native Schedules view (confirmed via screenshot during
// design) but styled with this app's own theme instead of Paycor's colors.
// Pure rendering only — no edit state lives here even in 'build' mode.
function WeeklyScheduleGrid({ weekStartISO, cards, th }) {
  const weekStart = new Date(weekStartISO + 'T00:00:00Z');
  const dayDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + i);
    return d;
  });

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '0.5rem', borderBottom: `2px solid ${th.cardBorder}`, color: th.muted, position: 'sticky', left: 0, background: th.bg }}>Employee</th>
            {dayDates.map((d, i) => (
              <th key={i} style={{ textAlign: 'center', padding: '0.5rem', borderBottom: `2px solid ${th.cardBorder}`, color: th.muted, minWidth: 130 }}>
                {SCHEDULE_DOW[i]}, {d.getUTCMonth() + 1}/{d.getUTCDate()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(cards || []).map(card => {
            const totalHours = (card.shifts || []).reduce((sum, sh) => {
              const [sh1, sm1] = sh.startTime.split(':').map(Number);
              const [sh2, sm2] = sh.endTime.split(':').map(Number);
              return sum + ((sh2 * 60 + sm2) - (sh1 * 60 + sm1)) / 60;
            }, 0);
            return (
              <tr key={card.employeeId} style={{ borderBottom: `1px solid ${th.cardBorder}` }}>
                <td style={{ padding: '0.5rem', color: th.text, fontWeight: 600, position: 'sticky', left: 0, background: th.bg }}>
                  {card.employeeName}
                  <div style={{ fontSize: '0.68rem', color: th.muted, fontWeight: 400 }}>{Math.round(totalHours * 10) / 10}h</div>
                </td>
                {dayDates.map((_, dayOffset) => {
                  const shift = (card.shifts || []).find(sh => sh.dayOffset === dayOffset);
                  return (
                    <td key={dayOffset} style={{ padding: '0.35rem', textAlign: 'center' }}>
                      {shift && (
                        <div style={{ background: '#FF671F18', border: '1px solid #FF671F55', borderRadius: 6, padding: '0.3rem 0.4rem', color: th.text }}>
                          {shift.startTime}–{shift.endTime}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Rebuild**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 3: Test it renders with real data via a preview deploy**

Bump `APP_VERSION`, rebuild, deploy preview:

```bash
npx netlify deploy
```

Temporarily render `<WeeklyScheduleGrid weekStartISO="2026-09-06" cards={[{employeeId:'e1', employeeName:'Test Employee', shifts:[{dayOffset:1, startTime:'09:00', endTime:'17:00'}]}]} th={th} />` somewhere reachable (e.g. temporarily inside the Optimizer tab's render, or any convenient existing screen) to visually confirm the grid renders a Monday shift correctly for "Test Employee" with "8h" showing under their name. Remove the temporary test render before committing.

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "Add WeeklyScheduleGrid component"
```

---

## Task 4: `RunningLaborHeader` component

**Files:**
- Modify: `app.jsx` — add after `WeeklyScheduleGrid`

**Interfaces:**
- Consumes: `scheduleComputeWeeklyTotal`'s return shape from Task 2 — `{ totalHours, totalDollars, byEmployee }`; also needs the week's total projected sales to compute a percentage (passed in as `projectedSales`, sourced from existing labor-projection data already read elsewhere in `LaborDrillDown`'s Optimizer tab — see `app.jsx:32904` for the existing pattern this reuses)
- Produces: `RunningLaborHeader({ weeklyTotal, projectedSales, th })` component

- [ ] **Step 1: Add the component**

```js
// Sticky header showing the store's running projected weekly labor $ and %,
// color-coded against the canonical thresholds (LABOR_GREEN=22.9,
// LABOR_YELLOW=25.9, red >=26 — app.jsx:33267-33269). Also flags (does not
// block) any employee whose week exceeds 40 hours.
function RunningLaborHeader({ weeklyTotal, projectedSales, th }) {
  const pct = projectedSales > 0 ? (weeklyTotal.totalDollars / projectedSales) * 100 : 0;
  const color = pct <= 22.9 ? '#4caf50' : pct <= 25.9 ? '#ff9800' : '#f44336';
  const overtimeEmployees = (weeklyTotal.byEmployee || []).filter(e => e.hours > 40);

  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 10, background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 8, padding: '0.85rem 1.1rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.6rem' }}>
      <div>
        <div style={{ fontSize: '0.68rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Projected Weekly Labor</div>
        <div style={{ fontSize: '1.1rem', fontWeight: 800, color }}>
          ${weeklyTotal.totalDollars.toFixed(2)} <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>({pct.toFixed(1)}%)</span>
        </div>
      </div>
      <div style={{ fontSize: '0.78rem', color: th.muted }}>{weeklyTotal.totalHours.toFixed(1)} total hours</div>
      {overtimeEmployees.length > 0 && (
        <div style={{ fontSize: '0.76rem', color: '#f59e0b', fontWeight: 600 }}>
          ⚠ {overtimeEmployees.length} employee(s) over 40h this week
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Rebuild**

```bash
npm run build
```

- [ ] **Step 3: Verify with a quick temporary render** (same pattern as Task 3 Step 3): render `<RunningLaborHeader weeklyTotal={{totalHours: 45, totalDollars: 700, byEmployee: [{employeeId:'e1', hours: 45, dollars: 700, rateAvailable: true}]}} projectedSales={3000} th={th} />` and visually confirm the overtime warning shows (45 > 40) and the color reflects 700/3000 = 23.3% (yellow). Remove before committing.

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "Add RunningLaborHeader component"
```

---

## Task 5: `EmployeeScheduleCard` component

**Files:**
- Modify: `app.jsx` — add after `RunningLaborHeader`

**Interfaces:**
- Consumes: one card object `{employeeId, employeeName, jobTitle, shifts}` (Task 2's shape)
- Produces: `EmployeeScheduleCard({ card, th, onApprove, onSave })` component. `onApprove()` — no args, called when the manager accepts as-is. `onSave(updatedShifts)` — called with a new `shifts` array when the manager finishes editing.

- [ ] **Step 1: Add the component**

Note before writing this: the prop holding one employee's data is named `cardData`, not `card` — `card` is already the name of an imported style helper from `src/theme.js` (used elsewhere in this file as `card(th)`), so naming the prop `card` would shadow it. Use `cardData` throughout, as shown below.

```js
// One employee's proposed week — Approve as-is, or Edit to add/remove/
// change individual shifts before advancing. Local edit state only;
// nothing is saved to Paycor from this component (that happens in the
// final batched submission — see Task 9). Prop is named cardData (not
// card) since `card` is already the src/theme.js style helper used
// elsewhere in this file.
function EmployeeScheduleCard({ card: cardData, th, onApprove, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draftShifts, setDraftShifts] = useState(cardData.shifts || []);

  const updateShift = (idx, field, value) => {
    setDraftShifts(prev => prev.map((s, i) => i === idx ? { ...s, [field]: value } : s));
  };
  const removeShift = (idx) => setDraftShifts(prev => prev.filter((_, i) => i !== idx));
  const addShift = () => setDraftShifts(prev => [...prev, { dayOffset: 0, startTime: '09:00', endTime: '17:00' }]);

  return (
    <div style={{ background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 10, padding: '1.1rem', maxWidth: 480 }}>
      <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '1rem', color: th.text, marginBottom: '0.2rem' }}>{cardData.employeeName}</div>
      <div style={{ fontSize: '0.75rem', color: th.muted, marginBottom: '0.9rem' }}>{cardData.jobTitle || 'Crew Member'}</div>

      {!editing && (
        <>
          {(cardData.shifts || []).length === 0 && <div style={{ fontSize: '0.8rem', color: th.muted, marginBottom: '0.8rem' }}>No shifts proposed (new employee, or none last week)</div>}
          {(cardData.shifts || []).map((s, i) => (
            <div key={i} style={{ fontSize: '0.8rem', color: th.text, marginBottom: '0.3rem' }}>
              {SCHEDULE_DOW[s.dayOffset]}: {s.startTime}–{s.endTime}
            </div>
          ))}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.9rem' }}>
            <button onClick={onApprove} style={{ ...btn(th, { background: '#1B8F5C' }) }}>Approve</button>
            <button onClick={() => { setDraftShifts(cardData.shifts || []); setEditing(true); }} style={{ ...btn(th, { background: th.card2, color: th.text }) }}>Edit</button>
          </div>
        </>
      )}

      {editing && (
        <>
          {draftShifts.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.4rem' }}>
              <select value={s.dayOffset} onChange={e => updateShift(i, 'dayOffset', Number(e.target.value))} style={{ ...inp(th), fontSize: '0.75rem', padding: '0.25rem' }}>
                {SCHEDULE_DOW.map((d, di) => <option key={di} value={di}>{d}</option>)}
              </select>
              <input type="time" value={s.startTime} onChange={e => updateShift(i, 'startTime', e.target.value)} style={{ ...inp(th), fontSize: '0.75rem', padding: '0.25rem' }} />
              <input type="time" value={s.endTime} onChange={e => updateShift(i, 'endTime', e.target.value)} style={{ ...inp(th), fontSize: '0.75rem', padding: '0.25rem' }} />
              <button onClick={() => removeShift(i)} style={{ ...btn(th, { background: '#ef444422', color: '#ef4444' }), padding: '0.25rem 0.5rem' }}>✕</button>
            </div>
          ))}
          <button onClick={addShift} style={{ ...btn(th, { background: th.card2, color: th.text }), fontSize: '0.75rem', marginBottom: '0.8rem' }}>+ Add shift</button>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={() => { onSave(draftShifts); setEditing(false); }} style={{ ...btn(th, { background: '#1B8F5C' }) }}>Save & Continue</button>
            <button onClick={() => setEditing(false)} style={{ ...btn(th, { background: th.card2, color: th.text }) }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Rebuild**

```bash
npm run build
```

- [ ] **Step 3: Verify with a temporary render** — same pattern as prior tasks: render `<EmployeeScheduleCard card={{employeeId:'e1', employeeName:'Test Employee', jobTitle:'Crew Member', shifts:[{dayOffset:1, startTime:'09:00', endTime:'17:00'}]}} th={th} onApprove={() => console.log('approved')} onSave={(s) => console.log('saved', s)} />` somewhere reachable, click Edit, change a time, click Save & Continue, confirm the console logs the updated shift array. Remove before committing.

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "Add EmployeeScheduleCard component"
```

---

## Task 6: `ScheduleBuilder` top-level component

**Files:**
- Modify: `app.jsx` — add after `EmployeeScheduleCard`

**Interfaces:**
- Consumes: `scheduleGroupShiftsByEmployee`, `scheduleDefaultJobGroupForEmployee`, `scheduleComputeWeeklyTotal` (Task 2), `WeeklyScheduleGrid` (Task 3), `RunningLaborHeader` (Task 4), `EmployeeScheduleCard` (Task 5); the existing `employees`, `schedulingShifts`, `payRates` Paycor actions (already exist, unchanged)
- Produces: `ScheduleBuilder({ store, th, mode })` component — `mode` is `'build'` (manager, own store — full card-stack flow) or `'view'` (everyone else — read-only grid of whatever's already scheduled for the upcoming week, no card stack, no submit). Internally holds `approvedCards` state, which Task 8 (Share) and Task 9 (Submit) both read from.

- [ ] **Step 1: Add the component**

```js
// Top-level Build Schedule flow: loads roster + last week's shifts + pay
// rates, builds a card stack (one per active employee, pre-filled from
// last week where available), and tracks approved cards as the manager
// steps through. 'view' mode skips the card stack entirely and just shows
// whatever's already scheduled for the target week, read-only.
function ScheduleBuilder({ store, th, mode }) {
  const todayStr = tipsFormatISODate(new Date()); // reuse existing date helper, app.jsx ~37905
  const [weekStart, setWeekStart] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cards, setCards] = useState(null); // null until loaded
  const [cardIndex, setCardIndex] = useState(0);
  const [approvedCards, setApprovedCards] = useState([]);
  const [payRates, setPayRates] = useState({});

  const load = async () => {
    if (!weekStart) return;
    setLoading(true); setError(null); setCards(null); setCardIndex(0); setApprovedCards([]);
    try {
      const lastWeekStart = tipsFormatISODate(tipsAddDays(tipsParseISODate(weekStart), -7));
      // schedulingShifts treats `endDate` as EXCLUSIVE (confirmed live in Task 1,
      // 2026-08-25) — the last day of the prior week is weekStart - 1 (Saturday),
      // so weekStart itself (its exclusive +1 boundary) is passed as endDate to
      // include that Saturday's shifts without dropping them.
      const lastWeekEndExclusive = weekStart;

      const [empRes, shiftRes] = await Promise.all([
        fetch('/.netlify/functions/paycor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'employees', legalEntityId: store.paycor }) }),
        fetch('/.netlify/functions/paycor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'schedulingShifts', legalEntityId: store.paycor, startDate: lastWeekStart, endDate: lastWeekEndExclusive }) }),
      ]);
      const empData = await empRes.json();
      const shiftData = await shiftRes.json();
      const employees = (empData.records || []).filter(e => e?.statusData?.status === 'Active');
      const shiftsByEmployee = scheduleGroupShiftsByEmployee(shiftData.records || [], weekStart);

      const rates = {};
      await Promise.all(employees.map(async (e) => {
        try {
          const r = await fetch('/.netlify/functions/paycor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'payRates', employeeId: e.id }) });
          const rd = await r.json();
          const rate = (rd.records || rd)?.[0]?.payRate || (rd.records || rd)?.[0]?.rate;
          if (rate != null) rates[e.id] = Number(rate);
        } catch (err) { /* leave unset — flagged as rate-unavailable downstream */ }
      }));
      setPayRates(rates);

      const builtCards = employees.map(e => {
        const name = `${e.firstName || ''} ${e.lastName || ''}`.trim();
        const priorShifts = shiftsByEmployee[e.id] || [];
        let schedulingJobId = priorShifts[0]?.schedulingJobId || null;
        let scheduleGroupId = priorShifts[0]?.scheduleGroupId || null;
        let departmentId = priorShifts[0]?.departmentId || null;
        if (!schedulingJobId) {
          const defaulted = scheduleDefaultJobGroupForEmployee(e.positionData?.jobTitle, employees, shiftsByEmployee);
          schedulingJobId = defaulted.schedulingJobId;
          scheduleGroupId = defaulted.scheduleGroupId;
          departmentId = defaulted.departmentId;
        }
        return {
          employeeId: e.id,
          employeeName: name,
          jobTitle: e.positionData?.jobTitle || 'Crew Member',
          schedulingJobId,
          scheduleGroupId,
          departmentId,
          shifts: priorShifts.map(s => ({ dayOffset: s.dayOffset, startTime: s.startTime, endTime: s.endTime })),
        };
      });
      setCards(builtCards);
    } catch (e) {
      setError(e.message || 'Failed to load schedule data.');
    } finally {
      setLoading(false);
    }
  };

  const currentCard = cards && cards[cardIndex];
  const allCardsDone = cards && cardIndex >= cards.length;
  const weeklyTotal = React.useMemo(() => scheduleComputeWeeklyTotal(cards && !allCardsDone ? approvedCards.concat(currentCard ? [currentCard] : []) : approvedCards, payRates), [cards, approvedCards, currentCard, allCardsDone, payRates]);

  const handleApprove = () => {
    setApprovedCards(prev => [...prev, currentCard]);
    setCardIndex(i => i + 1);
  };
  const handleSave = (updatedShifts) => {
    setApprovedCards(prev => [...prev, { ...currentCard, shifts: updatedShifts }]);
    setCardIndex(i => i + 1);
  };

  if (mode === 'view') {
    return (
      <div>
        <div style={{ marginBottom: '1rem' }}>
          <input type="date" value={weekStart} onChange={e => setWeekStart(e.target.value)} style={{ ...inp(th), width: 200 }} />
          <button onClick={load} disabled={!weekStart || loading} style={{ ...btn(th), marginLeft: '0.6rem', opacity: (!weekStart || loading) ? 0.6 : 1 }}>{loading ? 'Loading…' : 'Load week'}</button>
        </div>
        {error && <div style={{ color: '#ef4444', fontSize: '0.82rem', marginBottom: '1rem' }}>{error}</div>}
        {cards && <WeeklyScheduleGrid weekStartISO={weekStart} cards={cards.filter(c => (c.shifts || []).length > 0)} th={th} />}
      </div>
    );
  }

  return (
    <div>
      {!cards && (
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', marginBottom: '0.35rem' }}>Week start (Sunday)</div>
          <input type="date" value={weekStart} onChange={e => setWeekStart(e.target.value)} style={{ ...inp(th), width: 200 }} />
          <button onClick={load} disabled={!weekStart || loading} style={{ ...btn(th), marginLeft: '0.6rem', opacity: (!weekStart || loading) ? 0.6 : 1 }}>{loading ? 'Loading…' : 'Start building'}</button>
        </div>
      )}
      {error && <div style={{ color: '#ef4444', fontSize: '0.82rem', marginBottom: '1rem' }}>{error}</div>}

      {cards && !allCardsDone && (
        <>
          <RunningLaborHeader weeklyTotal={weeklyTotal} projectedSales={0} th={th} />
          <div style={{ fontSize: '0.78rem', color: th.muted, marginBottom: '0.6rem' }}>Employee {cardIndex + 1} of {cards.length}</div>
          <EmployeeScheduleCard card={currentCard} th={th} onApprove={handleApprove} onSave={handleSave} />
        </>
      )}

      {cards && allCardsDone && (
        <>
          <RunningLaborHeader weeklyTotal={weeklyTotal} projectedSales={0} th={th} />
          <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '0.95rem', color: th.text, margin: '1rem 0 0.6rem' }}>Final review</div>
          <WeeklyScheduleGrid weekStartISO={weekStart} cards={approvedCards.filter(c => (c.shifts || []).length > 0)} th={th} />
          {/* Share and Send-to-Paycor controls are added in Tasks 8 and 9 */}
        </>
      )}
    </div>
  );
}
```

Note on `projectedSales={0}`: this deliberately punts on wiring real projected-sales data into the labor % calculation for this task — that requires reading the same sales-projection source the existing Optimizer tab uses (`app.jsx:32904` area). Wiring that is explicitly out of scope for this task to keep it testable in isolation; do NOT invent a fake sales number. Task 7 (wiring into `LaborDrillDown`) will replace this with the real data already available in that scope.

- [ ] **Step 2: Rebuild**

```bash
npm run build
```

- [ ] **Step 3: Verify with a temporary render against real data** — render `<ScheduleBuilder store={stores.find(s => s.pc === '332941')} th={th} mode="build" />` (Bustleton) somewhere temporarily reachable, pick a real Sunday date, click "Start building," confirm real employee cards load with real names and (for anyone who worked the prior week) real pre-filled shift times. Step through a couple of cards (Approve one, Edit-and-Save another), confirm the running header updates. Remove the temporary render before committing — **do not click any Send-to-Paycor button, since it doesn't exist yet in this task.**

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "Add ScheduleBuilder top-level component"
```

---

## Task 7: Wire into `LaborDrillDown` as the 5th tab, with role-based mode

**Files:**
- Modify: `app.jsx:32204` (function signature — no change needed, `user` and `stores` are already passed in) and `app.jsx:32727-32733` (tab row) and the area after the existing `optimizer` content block (~`app.jsx:33267`, immediately after the Optimizer tab's closing, before `LaborDrillDown`'s own closing brace)

**Interfaces:**
- Consumes: `ScheduleBuilder` (Task 6), `canPaycorPush`-style role check pattern (existing, `app.jsx:38076`), `isFullAdmin` (existing, `app.jsx:24796`)
- Produces: the "Build Schedule" tab, visible and correctly scoped for all 5 roles per the spec

- [ ] **Step 1: Add the 5th tab button**

In the tab row at `app.jsx:32727-32733`, change:

```jsx
<div style={{ display: 'flex', borderRadius: '0.5rem', overflow: 'hidden', border: `1px solid ${th.cardBorder}`, marginBottom: '1.25rem', width: 'fit-content' }}>
  {tabBtn('hourly',    'Hourly')}
  {tabBtn('daily',     'Daily')}
  {tabBtn('weekly',    'Weekly')}
  {tabBtn('optimizer', '⚡ Optimizer')}
</div>
```

to:

```jsx
<div style={{ display: 'flex', borderRadius: '0.5rem', overflow: 'hidden', border: `1px solid ${th.cardBorder}`, marginBottom: '1.25rem', width: 'fit-content' }}>
  {tabBtn('hourly',    'Hourly')}
  {tabBtn('daily',     'Daily')}
  {tabBtn('weekly',    'Weekly')}
  {tabBtn('optimizer', '⚡ Optimizer')}
  {tabBtn('buildSchedule', 'Build Schedule')}
</div>
```

- [ ] **Step 2: Add the role-scoping logic and content branch**

Immediately before `LaborDrillDown`'s closing `return (...)` — i.e. right after wherever the optimizer content block at `app.jsx:32842` area ends, insert this new block using the SAME `{activeTab === '<tab>' && (...)}` pattern as the other four tabs:

```jsx
{activeTab === 'buildSchedule' && (() => {
  const isManager = user?.userType === 'manager';
  const isDM = user?.userType === 'dm';
  const isViewAllRole = ['executive', 'it', 'office_staff'].includes(user?.userType);
  const canBuild = isManager && String(store.pc) === String(user?.storePC || user?.pc); // manager scoped to their own store — see note below
  const canView = isDM ? String(store.district) === String(user?.district) : isViewAllRole;

  if (!canBuild && !canView) {
    return <div style={{ fontSize: '0.82rem', color: th.muted }}>You don't have access to this store's schedule.</div>;
  }

  return <ScheduleBuilder store={store} th={th} mode={canBuild ? 'build' : 'view'} />;
})()}
```

**Note on `user?.storePC || user?.pc`:** the exact field name that ties a `manager`-type user to their own store needs to be confirmed against how the existing "My Store mobile mode" (mentioned in the spec's Roles & Permissions section as the pattern to match) actually identifies a manager's store — search `app.jsx` for how `userType === 'manager'` is already scoped to a single store elsewhere (e.g. search for `"My Store"` or wherever mobile manager mode restricts to one store) and use that exact field name in place of `user?.storePC || user?.pc` above. Do not guess — if the exact field can't be found, ask before proceeding, since scoping this wrong would let a manager build schedules for a store that isn't theirs.

- [ ] **Step 3: Rebuild**

```bash
npm run build
```

- [ ] **Step 4: Test all 3 access patterns via preview deploy**

Bump `APP_VERSION`, rebuild, `npx netlify deploy`. On the preview URL:
- Log in (or simulate) as a `manager` user scoped to a specific store, navigate to that store's Labor drill-down → Build Schedule tab. Confirm the interactive card-stack flow renders (`canBuild` true).
- Same manager, navigate to a DIFFERENT store's drill-down if reachable. Confirm the "don't have access" message shows, not the builder.
- As a `dm` user, open Build Schedule for a store in their own district. Confirm the read-only grid (`mode='view'`) renders, no Approve/Edit buttons anywhere.
- As `executive`/`it`/`office_staff`, open Build Schedule for any store. Confirm read-only view renders.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "Wire ScheduleBuilder into LaborDrillDown as 5th tab with role scoping"
```

---

## Task 7b (supersedes Task 7's mounting point): Relocate to a new "Schedule" tile in Pulse's per-store hub

**Why:** After Task 7 shipped and was previewed live, the user (2026-08-27) asked for the entry point to move. Reasoning: `LaborDrillDown` is the SAME component embedded in two places — the standalone top-level "Labor" nav tab (`AdminLabor`), AND a "👷 Labor" tile inside `StoreDetail` (`app.jsx:8681` — the Pulse per-store hub shown in the screenshot the user shared, rail tiles: Sales/Labor/Forecast/Daypart/Food Cost/Transactions/(Drive-Thru)/Reviews/Complaints, `app.jsx:9434`). Reaching "Build Schedule" required loading all of `LaborDrillDown`'s other tabs first (Hourly/Daily/Weekly data), which the user found slow. Decision: give the schedule its own top-level tile in that same Pulse per-store rail (positioned right after "Labor"), and remove the sub-tab from inside `LaborDrillDown` entirely — not keep both. `ScheduleBuilder` and everything underneath it (Tasks 1-6, 8) is unchanged and fully reused; only the mounting location moves.

**Files:**
- Modify: `app.jsx` — remove Task 7's tab button + content branch from `LaborDrillDown` (`app.jsx:33152`, `33633-33654` as of Task 7's commit — re-locate by searching `buildSchedule` since line numbers shift); add a new tile + content branch to `StoreDetail` (`app.jsx:8681`)

**Interfaces:**
- Consumes: `ScheduleBuilder` (Task 6, unchanged), `getManagerStore` (existing, `app.jsx:706`) — same role-scoping logic as Task 7, just re-hosted
- Produces: a "📅 Schedule" tile in `StoreDetail`'s rail, role-scoped identically to Task 7's removed tab (manager → own store build; dm → own district view; executive/it/office_staff → view all; everyone else → denied)

- [ ] **Step 1: Remove from `LaborDrillDown`**

Delete `{tabBtn('buildSchedule', 'Build Schedule')}` from the tab row, and delete the entire `{activeTab === 'buildSchedule' && (() => { ... })()}` block (including its explanatory comment) from `LaborDrillDown`'s render. `LaborDrillDown` goes back to exactly 4 tabs (Hourly/Daily/Weekly/Optimizer), matching its pre-Task-7 shape.

- [ ] **Step 2: Add the tile to `StoreDetail`'s rail**

In the tile array at `app.jsx:9434`, insert a new tile immediately after `{id:'labor',label:'👷 Labor'}`:

```js
{id:'schedule', label:'📅 Schedule'},
```

(Full array becomes: `sales, labor, schedule, forecast, daypart, foodcost, transactions, (driveThru), reviews, complaints` — order matters, "under labor" means directly after it.)

- [ ] **Step 3: Add the content branch to `StoreDetail`**

Immediately after the existing `{storeTab === 'labor' && (<LaborDrillDown ... />)}` block (`app.jsx:9452-9454`), insert:

```jsx
{/* ════ SCHEDULE TAB — relocated from inside LaborDrillDown (Task 7) so it doesn't ════
     require loading Hourly/Daily/Weekly first. Same role-scoping as before: manager
     builds their OWN store only (via the canonical getManagerStore helper, app.jsx:706);
     dm/executive/it/office_staff get a read-only view (dm scoped to their own district);
     everyone else is denied. */}
{storeTab === 'schedule' && (() => {
  const isManager = user?.userType === 'manager';
  const isDM = user?.userType === 'dm';
  const isViewAllRole = ['executive', 'it', 'office_staff'].includes(user?.userType);
  const managerStore = getManagerStore(stores, user);
  const canBuild = isManager && !!managerStore && String(s.pc) === String(managerStore.pc);
  const canView = isDM ? String(s.district) === String(user?.district) : isViewAllRole;

  if (!canBuild && !canView) {
    return <div style={{ fontSize: '0.82rem', color: th.muted }}>You don't have access to this store's schedule.</div>;
  }

  return <ScheduleBuilder store={s} th={th} mode={canBuild ? 'build' : 'view'} />;
})()}
```

Note: uses `s` (the current store, `StoreDetail`'s own local var — `const s = stores.find(st => st.pc === pc)`), not `store`, since `StoreDetail`'s scope names it differently than `LaborDrillDown`'s did. `stores` and `user` are already `StoreDetail` props, already in scope (used identically one block above for the `labor` tab's `LaborDrillDown` call).

- [ ] **Step 4: Rebuild**

```bash
npm run build
```

- [ ] **Step 5: Verify the relocation**

No browser tool available in this environment (established pattern across this plan) — verify via code trace: re-derive `canBuild`/`canView` for the same scenarios Task 7's review already covered (manager/own store, manager/different store, dm/in-district, dm/out-of-district, exec/it/office_staff, every other role), confirm `LaborDrillDown` no longer references `buildSchedule` anywhere (grep for the string — should be zero matches after removal, since it's fully gone, not just hidden), and confirm the new tile renders in the correct rail position. A preview deploy is optional and not required to block on if slow.

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js
git commit -m "Relocate Schedule from LaborDrillDown sub-tab to its own Pulse store-hub tile"
```

---

## Task 8: Share/Copy plain-text export

**Files:**
- Modify: `app.jsx` — add a helper function near the Task 2 helpers, and add Share/Copy buttons to `ScheduleBuilder`'s final-review block (Task 6, the `allCardsDone` branch)

**Interfaces:**
- Consumes: `approvedCards` (from `ScheduleBuilder`'s existing state, Task 6)
- Produces: `scheduleBuildShareText(weekStartISO, approvedCards)` → plain-text string; wires into a Share button using `navigator.share()` with a Copy-to-clipboard fallback

- [ ] **Step 1: Write the failing test**

Create `test_schedule_share_text.mjs` in the scratchpad:

```js
const SCHEDULE_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function scheduleBuildShareText(weekStartISO, approvedCards) {
  const weekStart = new Date(weekStartISO + 'T00:00:00Z');
  const dateFor = (dayOffset) => {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };
  const lines = [`Schedule — week of ${dateFor(0)}`, ''];
  (approvedCards || []).filter(c => (c.shifts || []).length > 0).forEach(c => {
    const shiftParts = [...c.shifts].sort((a, b) => a.dayOffset - b.dayOffset).map(s => `${SCHEDULE_DOW[s.dayOffset]} ${s.startTime}-${s.endTime}`);
    lines.push(`${c.employeeName}: ${shiftParts.join(', ')}`);
  });
  return lines.join('\n');
}

let pass = true;
function check(label, cond) { console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) pass = false; }

{
  const cards = [
    { employeeName: 'Alisha Rao', shifts: [{ dayOffset: 1, startTime: '07:00', endTime: '13:00' }, { dayOffset: 0, startTime: '07:00', endTime: '13:00' }] },
    { employeeName: 'No Shifts This Week', shifts: [] },
  ];
  const text = scheduleBuildShareText('2026-09-06', cards);
  check('starts with a week header', text.startsWith('Schedule — week of 9/6'));
  check('includes the employee with shifts', text.includes('Alisha Rao:'));
  check('shifts sorted by day (Sun before Mon)', text.indexOf('Sun 07:00-13:00') < text.indexOf('Mon 07:00-13:00'));
  check('excludes employees with zero shifts', !text.includes('No Shifts This Week'));
}

console.log('\n' + (pass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
process.exit(pass ? 0 : 1);
```

- [ ] **Step 2: Run it**

```bash
node test_schedule_share_text.mjs
```

Expected: `ALL TESTS PASSED`.

- [ ] **Step 3: Port the function into `app.jsx`**

Insert near the Task 2 helpers (e.g. immediately after `scheduleComputeWeeklyTotal`):

```js
// Plain-text schedule for sharing via WhatsApp/SMS/group chat — no image
// generation, just a clean text block (per design spec: plain text was
// chosen over a visual graphic for reliability across share targets).
function scheduleBuildShareText(weekStartISO, approvedCards) {
  const weekStart = new Date(weekStartISO + 'T00:00:00Z');
  const dateFor = (dayOffset) => {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };
  const lines = [`Schedule — week of ${dateFor(0)}`, ''];
  (approvedCards || []).filter(c => (c.shifts || []).length > 0).forEach(c => {
    const shiftParts = [...c.shifts].sort((a, b) => a.dayOffset - b.dayOffset).map(s => `${SCHEDULE_DOW[s.dayOffset]} ${s.startTime}-${s.endTime}`);
    lines.push(`${c.employeeName}: ${shiftParts.join(', ')}`);
  });
  return lines.join('\n');
}
```

- [ ] **Step 4: Add Share/Copy buttons to `ScheduleBuilder`'s final-review block**

In Task 6's `ScheduleBuilder`, find the comment `{/* Share and Send-to-Paycor controls are added in Tasks 8 and 9 */}` inside the `allCardsDone` branch and replace it with:

```jsx
<div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem' }}>
  <button onClick={async () => {
    const text = scheduleBuildShareText(weekStart, approvedCards);
    if (navigator.share) {
      try { await navigator.share({ text }); } catch (e) { /* user cancelled share — not an error */ }
    } else {
      await navigator.clipboard.writeText(text);
      alert('Copied to clipboard');
    }
  }} style={{ ...btn(th, { background: th.card2, color: th.text }) }}>
    {typeof navigator !== 'undefined' && navigator.share ? 'Share' : 'Copy'}
  </button>
</div>
```

- [ ] **Step 5: Rebuild**

```bash
npm run build
```

- [ ] **Step 6: Delete the temp test script, test on preview deploy**

```bash
rm test_schedule_share_text.mjs
```

Bump `APP_VERSION`, rebuild, `npx netlify deploy`. On a mobile device (or Chrome DevTools mobile emulation with a real device, since `navigator.share` isn't available in desktop Chrome), go through the build flow to the final review screen, tap Share, confirm the native share sheet opens with correct, readable text. On desktop, confirm the button reads "Copy" and copies the same text to clipboard.

- [ ] **Step 7: Commit**

```bash
git add app.jsx app.js
git commit -m "Add plain-text share/copy export for approved schedule"
```

---

## Task 8b: Surface real Paycor fetch failures instead of silently showing zero employees

**Why:** Live testing (2026-08-27, real manager account, real store) hit a case where `ScheduleBuilder`'s final review showed "$0.00, 0.0 total hours" with an empty grid, even though a direct trace of the exact same query against real Paycor data confirmed 16 of 19 active employees had real pre-fillable shifts. Root cause: `load()` does `(empData.records || [])` / `(shiftData.records || [])` with no check that the fetch actually succeeded — if Paycor returns an error shape (e.g. during a token-refresh window; this project has a documented history of exactly this failure class, see `project_tips_reliability_overhaul` memory) instead of `{records: [...]}`, the code silently treats it as "zero employees" rather than surfacing an error. The manager sees a plausible-looking empty schedule with no indication anything went wrong.

**Files:**
- Modify: `app.jsx` — `ScheduleBuilder`'s `load()` function (search `const empData = await empRes.json()`)

**Interfaces:**
- Consumes: nothing new
- Produces: no interface change — `load()` still sets `cards`/`error` exactly as before, just distinguishes "real zero-employee response" from "the fetch itself failed"

- [ ] **Step 1: Add response validation**

Immediately after the existing two lines:
```js
const empData = await empRes.json();
const shiftData = await shiftRes.json();
```
Add:
```js
if (!empRes.ok || !Array.isArray(empData?.records)) {
  throw new Error(empData?.error || empData?.Detail || empData?.title || 'Failed to load the employee roster from Paycor. Try again in a moment.');
}
if (!shiftRes.ok || !Array.isArray(shiftData?.records)) {
  throw new Error(shiftData?.error || shiftData?.Detail || shiftData?.title || 'Failed to load posted shifts from Paycor. Try again in a moment.');
}
```
This throws inside the existing `try` block, which the existing `catch (e) { setError(e.message || 'Failed to load schedule data.'); }` already handles — `cards` stays `null` (not an empty array), so the UI shows the real error message instead of an empty "Final review."

- [ ] **Step 2: Rebuild**

```bash
npm run build
```

- [ ] **Step 3: Verify**

No browser tool in this environment (established pattern). Verify via a real, controlled negative test: call the deployed `/.netlify/functions/paycor` endpoint with a deliberately invalid `legalEntityId` (e.g. `"000000"`) for both `employees` and `schedulingShifts` actions, confirm the real response shape does NOT have `records` as an array (it should be an error object), and confirm the new guard's condition (`!Array.isArray(empData?.records)`) would correctly catch it. Also confirm the HAPPY path is unaffected: re-run the real Bustleton query (legalEntityId `193884`) and confirm `Array.isArray(empData.records)` is `true` so the new guard does NOT throw on valid data.

- [ ] **Step 4: Bump version, commit**

```bash
git add app.jsx app.js
git commit -m "Surface Paycor fetch failures instead of silently showing zero employees"
```

---

## Task 9: Batched submission + per-shift result handling

**Files:**
- Modify: `app.jsx` — add a submission handler + results UI to `ScheduleBuilder`'s final-review block

**Interfaces:**
- Consumes: `approvedCards` (Task 6 state), the existing `createSchedulingShifts` action (unchanged, validated in Task 1)
- Produces: a "Send to Paycor" button and a per-employee results display in `ScheduleBuilder`

- [ ] **Step 1: Add submission state and handler to `ScheduleBuilder`**

Add near the other `useState` calls in `ScheduleBuilder` (Task 6):

```js
const [submitResult, setSubmitResult] = useState(null); // null | { running, results: [{employeeId, employeeName, status, detail}] }
```

Add this handler function inside `ScheduleBuilder`, alongside `handleApprove`/`handleSave`:

```js
const handleSendToPaycor = async () => {
  const cardsToSend = approvedCards.filter(c => (c.shifts || []).length > 0);
  if (cardsToSend.length === 0) { setSubmitResult({ running: false, results: [] }); return; }
  setSubmitResult({ running: true, results: [] });

  const shifts = [];
  cardsToSend.forEach(c => {
    c.shifts.forEach(s => {
      const dayDate = new Date(weekStart + 'T00:00:00Z');
      dayDate.setUTCDate(dayDate.getUTCDate() + s.dayOffset);
      const dateStr = dayDate.toISOString().slice(0, 10);
      shifts.push({
        employeeId: c.employeeId,
        scheduleGroupId: c.scheduleGroupId,
        schedulingJobId: c.schedulingJobId,
        departmentId: c.departmentId,
        startDateTime: `${dateStr}T${s.startTime}:00Z`,
        endDateTime: `${dateStr}T${s.endTime}:00Z`,
        isPublished: true,
        // Per Paycor's own docs (confirmed 2026-08-25): shiftModelId is a
        // caller-generated GUID, not a lookup value — one per shift, unique
        // within the batch (same pattern as processId used elsewhere in
        // this codebase). See Task 1's corrected script for the source.
        shiftModelId: crypto.randomUUID(),
        _employeeName: c.employeeName, // stripped before sending, kept for result mapping
      });
    });
  });

  try {
    const res = await fetch('/.netlify/functions/paycor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'createSchedulingShifts',
        legalEntityId: store.paycor,
        shifts: shifts.map(({ _employeeName, ...s }) => s),
        ignoreWarnings: true,
      }),
    });
    const data = await res.json();
    const returned = data?.shifts || data || [];
    const results = shifts.map((s, i) => {
      const r = returned[i] || {};
      const ok = !!r.shiftId && !(r.warningsOrErrors && r.warningsOrErrors.some(w => w.severity === 'Error'));
      return { employeeId: s.employeeId, employeeName: s._employeeName, status: ok ? 'ok' : 'error', detail: ok ? `Shift ${SCHEDULE_DOW[Math.round((new Date(s.startDateTime) - new Date(weekStart + 'T00:00:00Z')) / 86400000)]} created` : JSON.stringify(r.warningsOrErrors || r) };
    });
    setSubmitResult({ running: false, results });
  } catch (e) {
    setSubmitResult({ running: false, results: [{ employeeId: null, employeeName: 'All', status: 'error', detail: e.message || 'Request failed' }] });
  }
};
```

- [ ] **Step 2: Add the Send button and results display to the final-review JSX**

In the same block from Task 8, add below the Share button:

```jsx
<button onClick={handleSendToPaycor} disabled={submitResult?.running} style={{ ...btn(th, { background: '#FF671F' }), opacity: submitResult?.running ? 0.6 : 1 }}>
  {submitResult?.running ? 'Sending…' : 'Send to Paycor'}
</button>
```

And after the button row:

```jsx
{submitResult && !submitResult.running && (
  <div style={{ marginTop: '1rem' }}>
    {submitResult.results.map((r, i) => (
      <div key={i} style={{ fontSize: '0.78rem', color: r.status === 'ok' ? '#16a34a' : '#ef4444', marginBottom: '0.3rem' }}>
        <strong>{r.employeeName}:</strong> {r.detail}
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 3: Rebuild**

```bash
npm run build
```

- [ ] **Step 4: Bump version, deploy preview — do NOT click Send yet**

```bash
npx netlify deploy
```

Walk through the build flow on the preview URL up to the final review screen and confirm the Send button and (empty, pre-click) layout look right. Do not click Send on this preview — real submission testing happens in Task 10 as a deliberate, controlled step, not an incidental UI check.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "Add batched Paycor submission with per-shift results"
```

---

## Task 10: Second real-world end-to-end test

**Files:** none (validation only, no code changes)

**Interfaces:** none — this is the spec's final testing-plan step

- [ ] **Step 1: Deploy the finished feature to production** (only after explicit user approval — this project's standing convention requires asking before any production push)

- [ ] **Step 2: Pick one real, low-risk store and one real target week** — ideally a week that hasn't been scheduled in Paycor yet, so there's nothing to accidentally overwrite

- [ ] **Step 3: Build a complete real schedule through the actual UI** as a real manager (or simulated manager access) — go through every employee's card (Approve or Edit+Save), reach the final review

- [ ] **Step 4: Visually confirm the final review grid matches intent**, then click Share and confirm the generated text is accurate and readable

- [ ] **Step 5: Click Send to Paycor**, confirm every employee shows `status: 'ok'` in the results

- [ ] **Step 6: Verify directly in Paycor's own Schedules UI** that the submitted week matches exactly what was approved in-app — same employees, same days, same times

- [ ] **Step 7: If everything matches, the feature is done.** If anything is wrong, do not attempt further live writes to fix it blind — go back to the specific task whose output produced the wrong result, fix it there, and repeat from Step 3 with a fresh test week.

---

## Self-Review Notes

- **Spec coverage:** every section of the spec maps to a task — Overview/User Flow → Tasks 6-9, Data Sources → Task 2 + Task 6's `load()`, UI Components → Tasks 3-6, Submission Mechanics → Task 9, Roles & Permissions → Task 7, Error Handling → covered inline in Task 2 (missing rate), Task 6 (empty last-week data), Task 9 (partial batch failure), Testing Plan → Tasks 1, 10, and the per-task manual-verification steps throughout.
- **Placeholder scan:** no TBD/TODO markers; Task 7's manager-store field name is flagged as "confirm before proceeding" rather than guessed, since guessing wrong here is a real access-control risk — this is a deliberate stop-and-verify instruction, not an unresolved placeholder.
- **Type/naming consistency:** the card shape (`employeeId, employeeName, jobTitle, schedulingJobId, scheduleGroupId, departmentId, shifts: [{dayOffset, startTime, endTime}]`) is used identically across Tasks 2, 3, 5, 6, 8, 9. `scheduleComputeWeeklyTotal`'s return shape (`totalHours, totalDollars, byEmployee`) matches between Task 2's definition and Task 4/6's consumption. `departmentId`/`isPublished`/`shiftModelId` were added to the plan on 2026-08-25 after Task 1's live-API validation surfaced them as required fields Paycor's `createSchedulingShifts` rejects without (see Task 1, Task 2, Task 6, Task 9) — every task touching the card shape or the submission payload was checked and updated to carry them through consistently.
