# Crew Time Clock — Design Spec

## Overview

Hourly crew members currently have no Portal accounts and punch in/out via Paycor's
physical time clock (or some other unintegrated scanning app). This feature gives
enabled crew a phone-based clock-in / meal-start / meal-end / clock-out screen that
captures every punch in real time in our own system, then lets IT/exec review a full
biweekly pay period and push it to Paycor's `CreatePunches` API with one button —
mirroring the existing tips biweekly flow's shape, and sharing its real payroll-lock
deadline.

This is the write-side companion to [[project_minor_timecard_compliance]] (which only
reads Paycor's punches today) and is architecturally distinct from the earlier
[[project_paycor_payroll_auto_import]] effort — that work targets Paycor's **payroll
dollar-amount staging** (`payrollhours`), which is permanently blocked by a
Trackforce/Integration Payroll Time Partner account-tier requirement. Punches are a
different Paycor product surface (**Perform Time**), gated differently, and PCG's
account already demonstrably has *read* access under that same gate (`punches` /
`employeePunches` already work in production). Write access is not yet confirmed —
see "Controlled Test" below.

**Explicitly parked, not part of this build:** wiring this feature's data into Minor
Timecard Compliance. Because of that, **minors are not eligible for this app in v1** —
see Non-Goals and Accounts & Permissions.

## Background — what's actually true about Paycor's punch API

Confirmed via Paycor's own documentation and corroborated by a real third-party
integration's (alexrelintex/timeclock) public PR history — not guessed:

- **Write endpoint exists:** `POST /v1/legalentities/{legalEntityId}/CreatePunches`,
  body is an array of punch objects. Confirmed pattern elsewhere in this codebase
  (`stagePayrollHours`) of batching one call per legal entity/store rather than per
  employee or per punch — this feature follows the same shape.
- **Gate:** "Employee Time Card Punches APIs will only work with Perform Time-enabled
  clients... will not work for Time on Demand or Attendance on Demand clients." This is
  the same gate that already covers punches *reads*, which PCG's account passes today.
  Write-scope grant on our specific OAuth client/subscription is a separate, unconfirmed
  variable — Paycor's schedule-write feature ([[project_paycor_schedule_write]]) needed
  its own explicit activation before it worked, and this may too.
- **No native "Break" punch type.** `PunchStatusType` only accepts `Auto`, `In`, `Out`,
  `Transfer`. A meal break is represented as an `Out`/`In` pair tagged with a
  break-specific `ActivityTypeId`, not a distinct punch status.
- **Confirmed against PCG's real Bustleton data** (legal entity 193884, via the
  existing read-only `raw` GET proxy):
  - Activity Types: **Work** (`95c8fb2d-955f-47ce-bc32-8d4d534f536f`, Productive),
    **Meal** (`fc95b5ca-db28-4089-b08f-babd3cfb2f7d`, NonProductive), **Break**
    (`0e3b5971-2d14-4086-b393-0788e279a051`, NonProductive — unused by this feature;
    Meal is used for the break action per the PA minor-law "meal period" language).
  - Departments are job-classification-based (e.g. "Payroll - Cust Svc",
    "Payroll - Shift Leaders"), each with its own GUID — **and an employee's own
    Paycor record already includes `department.id`**, so it never needs to be typed
    or looked up separately.
- **Async, not synchronous.** `CreatePunches` returns a tracking ID immediately: the
  real outcome is only knowable via `GET punchErrorLog/{trackingId}`. A real bug found
  in the third-party integration's history: treating any non-404 response as "clean
  success" silently recorded permission/server errors (401/403/500) as successful
  punches. Correct semantics: only a 2xx response is resolved (and may still contain
  per-record errors inside); 404 means still processing, keep polling; anything else is
  unresolved — never treat it as success. Because this feature only calls
  `CreatePunches` once per store per pay period (not once per tap), this confirmation
  logic runs at a manageable scale inside a background function, not under per-punch
  latency pressure.
- **No delete/void-punch API exists.** If a test or a sent batch is wrong, the only
  fix is a manual correction inside Paycor's own UI.
- Exact required-vs-optional field list for `CreatePunches` could not be retrieved from
  Paycor's JS-rendered developer portal via automated tooling. Best-known fields from
  documentation excerpts: `EmployeeId`, `DepartmentId`, `PunchDateTime`,
  `PunchStatusType`, `ActivityTypeId` (believed required); `IsTransfer`, `Note`,
  `LaborCodes` (believed optional). **This will be confirmed for real by the Controlled
  Test below** — a real 400/validation response names exactly which field is wrong,
  which is more reliable than a secondhand doc excerpt.

## Pay Period Cadence (reused, not reinvented)

This codebase already has a confirmed, Paycor-verified biweekly boundary in
`tips-report-cron-background.mjs`, anchored against Paycor's own pay-group frequency
("Bi-weekly"). This feature imports and reuses it directly rather than defining a
second copy that could drift out of sync:

- Pay weeks run **Sunday–Saturday**.
- Biweekly periods are anchored to `BIWEEKLY_ANCHOR_END = '2026-08-15'` (a confirmed
  real period-closing Saturday), recurring every 14 days (`isBiweekBoundary`,
  `dateRangeEndingAt`).
- **Payroll hard-locks the Tuesday night 3 days after the period's Saturday close** —
  confirmed by the user as the same real Paycor lock for both tips/earnings and
  worked-time hours, not something specific to tip corrections.

**Lock behavior for this feature:** from the moment a period closes (Saturday night)
until that Tuesday night lock, IT/exec can freely view, edit, and send that period's
crew punches to Paycor — as many times as needed, with no requirement to edit before
sending. At the Tuesday-night lock, the period becomes **fully read-only**: no further
edits, no further sends, no override, matching payroll's own hard lock.

## Goals

1. Give enabled hourly crew a personal-phone clock-in / meal-break / clock-out screen
   that captures every punch the instant it happens, in our own system.
2. Give IT/exec full control over rollout: which stores are live, which individual
   crew are enabled/disabled — independent of role (managers/DM/IT/kiosk never see
   this at all).
3. Once each biweekly pay period closes, give IT/exec a single review screen per
   store to edit any gaps and push the whole period to Paycor with one button —
   mirroring the tips biweekly flow's shape and sharing its real payroll-lock deadline.
4. Let a store safely cut over from its physical Paycor clock via a parallel-run
   period with a punch-comparison view, rather than a blind hard switch.

## Non-Goals (v1)

- Not available to any existing role (manager, dm, it, executive, office_staff,
  construction, maintenance, vendor, kiosk_pulse, kiosk_upload) — scoped to a
  brand-new `crew` userType only.
- **Not available to minors.** Because this build does not touch Minor Timecard
  Compliance (explicitly deferred — see Overview), a minor whose punches only reach
  Paycor once every two weeks would create a real blind spot in that system's weekly
  detection. Minors stay on the physical clock until that integration is revisited.
  Enforced at account-creation time (see Accounts & Permissions).
- Not a real-time write to Paycor. Punches are captured live in our own system, but
  reach Paycor only via the biweekly reviewed batch send.
- Not a second Paycor-side staging/approval step. No such mechanism exists for
  punches (unlike the tips `payrollhours` paygrid) — once IT clicks Send, it's a real,
  live set of punches in Paycor immediately.
- Not self-registration or manager-created crew accounts — IT/exec creates every
  account centrally in v1.

## Controlled Test (required before any UI work — Task 1 of the implementation plan)

A single real test punch (Clock In) will be posted to Ahmed's own Bustleton employee
record via `CreatePunches`, then confirmed via the `punchErrorLog` poll using the
correct 2xx/404/other semantics above. This is the only way to learn, for real: the
exact required field list, whether PCG's OAuth client actually has write scope granted
(a 401/403 here would mean it doesn't, the same way tips-import hit its wall), and
whether the Activity Type / Department mapping actually produces an accepted punch.

Because there is no delete-punch API, this requires an **explicit go-ahead at the
moment it is about to run**, separate from approval of this design — if it succeeds,
cleanup means manually correcting/removing it in Paycor's own UI afterward.

## Data Model

### New Postgres tables (`db/schema.ts`)

**`crew_accounts`**
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| name | text | from the matched Paycor employee, not retyped |
| phone | text, nullable | login identifier; optional at creation (see Open Questions) |
| pin_hash | text, nullable | set on first login if phone present |
| store_pc | int | Pulse Cloud store number, links to `STORES` |
| paycor_employee_id | text | Paycor GUID, captured from the roster match |
| paycor_department_id | text | Paycor GUID, from the same employee record |
| is_minor | boolean | derived from the matched employee's date of birth at creation time (via the existing birthDate-only `identifyingData` scope — see [[project_paycor_identifying_data_scope]]); `enabled` cannot be set true while this is true |
| enabled | boolean, default true | per-person opt-out toggle |
| created_by | text | IT/exec user who created the account |
| created_at | timestamptz | |

**`crew_punches`** — first-party log, source of truth for the employee's own "today"
view and for IT/exec's pay-period review, independent of Paycor entirely until sent.
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| crew_account_id | uuid fk | |
| punch_type | text | `clock_in` \| `meal_start` \| `meal_end` \| `clock_out` |
| captured_at | timestamptz | server-captured real time of the tap (or admin-entered time for a manual edit) |
| pay_period_end | date | the Saturday closing this punch's pay period, computed at capture time |
| source | text | `live` \| `manual_edit` |
| edited_by | text, nullable | admin username, when `source = manual_edit` |
| paycor_status | text | `unsent` \| `pending` \| `confirmed` \| `failed` — `unsent` until that period's batch send runs |
| paycor_tracking_id | text, nullable | from the batch `CreatePunches` call covering this punch's period |
| paycor_punch_id | text, nullable | once confirmed |
| note | text, nullable | sent as Paycor's `Note` field for any `manual_edit` row |

**`crew_pay_period_locks`** — one row per store per pay period.
| column | type | notes |
|---|---|---|
| store_pc | int | |
| pay_period_end | date | |
| locked_at | timestamptz, nullable | set at the Tuesday-night deadline; null while still editable |
| sent_at | timestamptz, nullable | when IT/exec clicked Send (may be before or after edits; may never happen before lock) |
| sent_by | text, nullable | |

**`crew_activity_types`** — cached per legal entity, fetched once when a store is
first enabled (not re-fetched per punch, not re-fetched per employee).
| column | type | notes |
|---|---|---|
| legal_entity_id | text pk | |
| work_activity_type_id | text | |
| meal_activity_type_id | text | |
| fetched_at | timestamptz | |

### `paycor.mjs` additions

New named, server-validated actions (never routed through the GET-only `raw` proxy,
matching the existing security posture that keeps `raw` exploration-only):

- `activityTypes` — GET `/legalentities/{legalEntityId}/activityTypes` (read-only,
  used once per store at enable-time to populate `crew_activity_types`)
- `createPunches` — POST `/legalentities/{legalEntityId}/CreatePunches`, body is the
  full array of that store's punches for the closing pay period; auth-gated exec/it
  only, matching `createSchedulingShifts`'s pattern
- `punchErrorLog` — GET `/legalentities/{legalEntityId}/punchErrorLog/{trackingId}`,
  polled by the batch-send background function

## Punch Mapping

| Button | `PunchStatusType` | `ActivityTypeId` |
|---|---|---|
| Clock In | `In` | Work |
| Meal Start | `Out` | Meal |
| Meal End | `In` | Work |
| Clock Out | `Out` | Work |

`PunchDateTime` is the server's real timestamp at the moment of the tap (or the
admin-entered time for a manual edit) — never a client-supplied or client-device time.

## Live Capture (no Paycor call at punch time)

Crew member taps a button → the function captures the server timestamp, resolves
which pay period it falls in, and writes one `crew_punches` row with
`paycor_status = 'unsent'`. That's it — nothing is sent to Paycor yet. This is what
makes the daily flow simple and removes any need for per-punch retry/confirmation
logic; all of that complexity is concentrated in one place (the batch send) instead of
running under time pressure on every tap.

## Pay Period Review & Send (IT/exec only)

- Once a pay period closes (Saturday night), a review screen per store lists that
  period's `crew_punches`, flags obviously incomplete days (an open clock-in with no
  clock-out; a scheduled shift — cross-referenced against existing Paycor schedule
  data already in the app — with zero punches).
- IT/exec can add or edit any punch's date/time inline (`source = manual_edit`,
  `edited_by` recorded).
- A **"Send to Paycor"** button (available any time before that store's Tuesday-night
  lock, with or without edits) triggers a background function
  (`crew-clock-send-background.mjs`, matching this codebase's established
  fire-and-forget-then-poll-a-result-blob pattern for anything past the 26s manual
  timeout):
  1. Builds one `createPunches` array for that store covering every `unsent` punch in
     the period.
  2. Posts it, gets a tracking ID, writes it onto every punch in that batch.
  3. Polls `punchErrorLog` with the correct 2xx/404/other semantics until resolved.
  4. Updates each punch's `paycor_status` individually from the per-record results,
     surfacing exactly which punches succeeded and which failed back on the review
     screen — not just a single pass/fail for the whole store.
- **Hard lock:** at the Tuesday-night deadline, `crew_pay_period_locks.locked_at` is
  set for that store/period. After that, the review screen for that period becomes
  fully read-only — no edits, no re-send, no override — matching payroll's own lock.
  A period can still be sent multiple times before the lock (e.g., send early, catch
  one more missing punch, send again) — later punches simply carry `unsent` status
  until their own send.

## Accounts & Permissions

- New `crew` userType: single-purpose UI — the four punch buttons and today's own
  punch history, nothing else of the Portal.
- Created centrally by IT/exec only; no self-registration or manager creation in v1.
- Login: phone number (identifier) + PIN. Chosen over SMS-one-time-code (real
  per-punch cost at 45-store scale, delivery-delay risk right at shift start) and over
  the standard email/password policy (most crew have no company email; a 12-char
  password is a poor fit for something done several times a day).
- Per-account `enabled` toggle — the individual opt-out. **Cannot be enabled for a
  minor** (see Non-Goals) — the setup screen blocks this with a clear message pointing
  at the physical clock instead.
- Every other existing role (manager, dm, it, executive, office_staff, kiosk_pulse,
  kiosk_upload, construction, maintenance, vendor) is excluded automatically, simply
  by not being `crew` — no separate role-exclusion switch is needed.

## One-Time Setup

**Per store (automatic, on first enable):** fetch and cache that legal entity's real
Activity Type GUIDs into `crew_activity_types` — verified per store as each one goes
live, never assumed identical across stores.

**Per crew member (IT/exec, one-time):**
1. IT opens that store's crew setup screen and sees a live dropdown of the store's
   *active* Paycor employees (reusing the existing employees fetch, filtered on
   `statusData.status === 'Active'`, same as every other Paycor consumer in this
   codebase).
2. Picks the matching name — `paycor_employee_id`, `paycor_department_id`, and
   `is_minor` (from birthDate) are captured automatically from that record. No GUID is
   ever typed.
3. Enters phone (optional at creation) and sets an initial PIN.
4. Toggles enabled — blocked if `is_minor` is true.

## Store Cutover

- Parallel-run: both the physical Paycor clock and this app stay active for a trial
  period (default: one full work week) once a store is turned on.
- A comparison view (IT/exec) lines up this app's punches against Paycor's own
  read-side punches for the same store/period, surfacing any mapping mistakes before
  the physical clock is retired — naturally available once at least one pay period's
  batch has actually been sent.
- Retiring the physical clock for a store is a manual, explicit IT/exec decision —
  never automatic.

## Open Questions

1. **Exact `CreatePunches` required/optional field list** — to be confirmed by the
   Controlled Test's real response.
2. **Whether PCG's OAuth client has write scope for `CreatePunches`** at all — also
   surfaces via the Controlled Test; a 401/403 there means it doesn't, the same wall
   shape as the tips-import block.
3. **Phone number is optional at account creation** — but a crew member needs *some*
   identifier to log in. Needs a small decision during implementation: require phone
   before `enabled` can be set true, or support a temporary internal identifier until
   a phone is added later.
4. Whether to eventually feed this app's first-party `crew_punches` data into Minor
   Timecard Compliance's detection logic, and lift the minors restriction — explicitly
   parked, not required for v1.

## Testing

- Pure logic (punch-status/activity-type mapping, error-log resolution semantics,
  incomplete-day detection, pay-period/lock-boundary math) as unit-testable pure
  functions, following this codebase's established pure-function + I/O-wrapper
  pattern (see `src/minor-timecard-detect.mjs` for precedent).
- The Controlled Test itself is the integration-level verification of the real
  Paycor contract — not a substitute for unit tests, but the only way to verify facts
  no documentation excerpt could confirm.
