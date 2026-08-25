# Labor Schedule Builder — Design Spec

## Overview

A new "Build Schedule" tab inside the existing `LaborDrillDown` (5th tab, alongside Hourly/Daily/Weekly/Optimizer) that lets a store manager build and approve next week's employee schedule, then push it to Paycor. The manager steps through one card per active employee (pre-filled from last week's actual shifts where available), approving or editing each, while a running weekly labor $/% total stays visible against the existing 22.9/25.9/26 thresholds. A final human-readable weekly grid review precedes one batched submission to Paycor — nothing is written to Paycor before that explicit send.

The backend write endpoints already exist and are already confirmed working against real data (`netlify/functions/paycor.mjs`, shipped v19.53): `createSchedulingShifts`, `updateSchedulingShift`, `deleteSchedulingShift`. This spec covers the net-new frontend: the card-build flow, the review grid, the plain-text share, and the batched submission + result handling.

## User Flow

1. Manager opens their store's Labor drill-down → **Build Schedule** tab
2. Picks the target week (defaults to next week)
3. App loads: full active roster for the store, last week's actual Paycor shifts (via the existing `schedulingShifts` GET action with a `startDate`/`endDate` range — **not** the `pcg_schedule_{pc}` cron cache blob, since that only holds a rolling *current* week and isn't reliably addressable as "last week"), and each employee's current pay rate (`payRates` action, already exists)
4. A card stack builds — one card per active employee:
   - Worked last week → card pre-filled with those exact shifts (same days/times)
   - New / didn't work last week → empty card
5. Manager steps through cards one at a time:
   - **Approve** — accept as-is, advance to next card
   - **Edit** — add/remove/modify individual shifts for that employee (day, start time, end time), save, advance
   - Leaving a card untouched with zero shifts (skip) → that employee gets no shifts created this week
6. A sticky header, visible the entire time, shows the store's running projected weekly labor $ and %, color-coded against the existing thresholds (`LABOR_GREEN = 22.9`, `LABOR_YELLOW = 25.9`, red ≥26 — reuse the canonical values from `app.jsx:33267-33269`), updating live as each card is approved/edited
7. After the last card: **final review screen** — a weekly grid (employee rows × day columns, colored shift blocks, per-employee hour totals like "36/44") matching the visual shape of Paycor's own native Schedules view, styled with the Portal's own theme/colors instead of Paycor's
8. From the review screen: **Share** button — generates a plain-text version of the same approved schedule (e.g. `Alisha Rao: Sun 7am-1pm, Mon 7am-1pm, ...` per employee) and opens the native share sheet via `navigator.share()` where available (mobile), falling back to a **Copy** button (desktop) — pastes cleanly into WhatsApp/SMS/group chat
9. **Send to Paycor** button — one batched `createSchedulingShifts` call (see Submission Mechanics) for every approved employee's shifts across the whole week

## Data Sources

| Need | Source | Notes |
|---|---|---|
| Active roster | `employees` action (existing) | Filter `statusData.status === 'Active'` only — GM/Store Manager ARE included (the tips-pool exclusion is unrelated to scheduling; they still work real shifts) |
| Last week's shifts | `schedulingShifts` action (existing), with `startDate`/`endDate` for the prior week | Groups by `employeeId`; each employee's set of shifts pre-fills their card |
| Pay rate | `payRates` action (existing) | Feeds the running labor $ calculation (`rate × proposed hours` per employee, summed) |
| Job/schedule group | `schedulingJobId`, `scheduleGroupId` from the same `schedulingShifts` read (each shift record already carries both) | Reused directly for employees who worked last week. For a new employee with no prior shifts: find any other employee at the same store sharing the same live `positionData.jobTitle` (from the roster we already loaded) and reuse *their* most recent `schedulingJobId`/`scheduleGroupId` from the last-week data — no new endpoint/scope needed, since the "View Legal Entity Scheduling Jobs" scope isn't enabled and a live per-job lookup isn't available. If no other employee at the store shares that title (e.g. the store's only Shift Leader is brand new), fall back to whichever `scheduleGroupId` appears most often that week (almost always a single store-wide "ALL" group, confirmed at Bustleton) and flag the job assignment for manual confirmation on that one card. |

## UI Components

- **`ScheduleBuilder`** (new) — top-level tab component, owns the target week, roster+last-week load, card stack state, running total, and mode (build vs. view)
- **`EmployeeScheduleCard`** (new) — one employee's week: shift list (editable inline in Edit mode), Approve/Edit controls, per-card hour total
- **`RunningLaborHeader`** (new) — sticky bar, reuses the canonical labor-color thresholds; also surfaces an overtime flag (informational only — does not block submission) if an employee's week exceeds 40 hours
- **`WeeklyScheduleGrid`** (new, shared) — the employee-rows × day-columns visual grid; rendered in two modes:
  - **Build mode** (manager, own store): editable, feeds into the Send flow
  - **View mode** (DM/Exec/Office Staff/IT, per their scope): same component, read-only, no Edit/Send controls
- **Share/Copy** — plain-text generator, `navigator.share()` with clipboard fallback

## Submission Mechanics

One batched `POST /legalentities/{legalEntityId}/schedulingShifts` call per store, collecting every approved employee's shifts into a single `shifts: [...]` array (the endpoint already accepts multiple shifts per call — no need for one call per employee).

Paycor's response returns a `shiftId` (success) or `warningsOrErrors` (failure) per shift. The results screen groups these by employee — a clear pass/fail list, not a single ambiguous whole-batch status. Failed shifts remain visible as "not yet sent"; the manager can fix and resend just those, without resubmitting the whole week.

## Roles & Permissions

| Role | Scope | Capability |
|---|---|---|
| `manager` | Own store only | Full build/edit/submit |
| `dm` | Their district's stores | View-only |
| `executive`, `it`, `office_staff` | All stores | View-only |

Matches existing patterns already in the codebase: DM scoping mirrors "admin views filtered to district"; Office Staff view-only mirrors "read-only admin views" already used elsewhere. The tab is visible to all these roles; `WeeklyScheduleGrid` renders in build or view mode based on role + store match.

## Error Handling

- **Partial batch failure**: covered above — failed shifts stay retryable, not a full-week do-over
- **No prior week's schedule found** (new store, or a gap): all cards start empty, same treatment as a genuinely new employee — no special-case error state
- **Missing pay rate**: employee's hours still display; their $ contribution to the running total is flagged "rate unavailable" rather than silently treated as $0, which would understate projected labor cost

## Testing Plan

1. **Standalone controlled test** (not yet done, independent of any UI): create one real shift on a real employee, verify it shows correctly in Paycor's own UI, delete it. Validates the raw write mechanics end-to-end before any UI depends on them.
2. **Incremental UI build**, each piece testable against real reads with zero write risk: role-based tab/mode visibility, roster + last-week-shift loading, card approve/edit interactions, running labor total math, final grid rendering, plain-text share generation.
3. **Second real-world test**: build one complete real schedule for one store through the actual new UI, submit for real, verify in Paycor's own UI that it matches exactly what was approved in-app.
