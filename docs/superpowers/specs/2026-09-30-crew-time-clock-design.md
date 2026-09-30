# Crew Time Clock — Design Spec

## Overview

Hourly crew members currently have no Portal accounts and punch in/out via Paycor's
physical time clock (or some other unintegrated scanning app). This feature gives
enabled crew a phone-based clock-in / break-start / break-end / clock-out screen that
writes **real punches directly into Paycor** via its `CreatePunches` API — with IT/exec
controlling rollout, an audit-friendly correction tool for missed punches, and a safe
parallel-run cutover per store before any physical clock is retired.

This is the write-side companion to [[project_minor_timecard_compliance]] (which only
reads Paycor's punches today) and is architecturally distinct from the earlier
[[project_paycor_payroll_auto_import]] effort — that work targets Paycor's **payroll
dollar-amount staging** (`payrollhours`), which is permanently blocked by a
Trackforce/Integration Payroll Time Partner account-tier requirement. Punches are a
different Paycor product surface (**Perform Time**), gated differently, and PCG's
account already demonstrably has *read* access under that same gate (`punches` /
`employeePunches` already work in production). Write access is not yet confirmed —
see "Controlled Test" below.

## Background — what's actually true about Paycor's punch API

Confirmed via Paycor's own documentation and corroborated by a real third-party
integration's (alexrelintex/timeclock) public PR history — not guessed:

- **Write endpoint exists:** `POST /v1/legalentities/{legalEntityId}/CreatePunches`,
  body is an array of punch objects.
- **Gate:** "Employee Time Card Punches APIs will only work with Perform Time-enabled
  clients... will not work for Time on Demand or Attendance on Demand clients." This is
  the same gate that already covers punches *reads*, which PCG's account passes today.
  Write-scope grant on our specific OAuth client/subscription is a separate, unconfirmed
  variable — Paycor's schedule-write feature ([[project_paycor_schedule_write]]) needed
  its own explicit activation before it worked, and this may too.
- **No native "Break" punch type.** `PunchStatusType` only accepts `Auto`, `In`, `Out`,
  `Transfer`. A break is represented as an `Out`/`In` pair tagged with a break-specific
  `ActivityTypeId`, not a distinct punch status.
- **Confirmed against PCG's real Bustleton data** (legal entity 193884, via the
  existing read-only `raw` GET proxy):
  - Activity Types: **Work** (`95c8fb2d-955f-47ce-bc32-8d4d534f536f`, Productive),
    **Meal** (`fc95b5ca-db28-4089-b08f-babd3cfb2f7d`, NonProductive), **Break**
    (`0e3b5971-2d14-4086-b393-0788e279a051`, NonProductive).
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
  unresolved — never treat it as success.
- **No delete/void-punch API exists.** If a test or real punch is wrong, the only fix
  is a manual correction inside Paycor's own UI.
- Exact required-vs-optional field list for `CreatePunches` could not be retrieved from
  Paycor's JS-rendered developer portal via automated tooling. Best-known fields from
  documentation excerpts: `EmployeeId`, `DepartmentId`, `PunchDateTime`,
  `PunchStatusType`, `ActivityTypeId` (believed required); `IsTransfer`, `Note`,
  `LaborCodes` (believed optional). **This will be confirmed for real by the Controlled
  Test below** — a real 400/validation response names exactly which field is wrong,
  which is more reliable than a secondhand doc excerpt.

## Goals

1. Give enabled hourly crew a personal-phone clock-in / break / clock-out screen that
   writes real Paycor punches, timestamped at the moment of the tap.
2. Give IT/exec full control: which stores are live, which individual crew are
   enabled/disabled, independent of role (managers/DM/IT/kiosk never see this at all).
3. Give IT/exec a weekly tool to fix missed punches and explicitly push corrections to
   Paycor, mirroring the review-then-send shape of the existing tips staging flow.
4. Let a store safely cut over from its physical Paycor clock via a parallel-run
   period with a punch-comparison view, rather than a blind hard switch.

## Non-Goals (v1)

- Not available to any existing role (manager, dm, it, executive, office_staff,
  construction, maintenance, vendor, kiosk_pulse, kiosk_upload) — scoped to a
  brand-new `crew` userType only.
- Not wiring this app's first-party punch log into Minor Timecard Compliance's
  detection cron yet, even though it would sidestep the known raw-punch-vs-corrected-
  timecard limitation there. Parked as a future enhancement.
- Not building a second Paycor-side staging/approval step for corrections — no such
  mechanism exists for punches (unlike the tips `payrollhours` paygrid). A correction
  that's sent becomes a real live punch immediately, tagged in `Note` for audit.
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
| enabled | boolean, default true | per-person opt-out toggle |
| created_by | text | IT/exec user who created the account |
| created_at | timestamptz | |

**`crew_punches`** — first-party log, source of truth for the employee's own "today"
view and for IT/manager audit, independent of Paycor's read-side lag.
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| crew_account_id | uuid fk | |
| punch_type | text | `clock_in` \| `break_start` \| `break_end` \| `clock_out` |
| captured_at | timestamptz | server-captured real time of the tap (or admin-entered time for corrections) |
| paycor_tracking_id | text, nullable | from `CreatePunches`' response |
| paycor_status | text | `pending` \| `confirmed` \| `failed` |
| paycor_punch_id | text, nullable | once confirmed |
| source | text | `live` \| `manual_correction` |
| note | text, nullable | sent as Paycor's `Note` field; manual corrections always get one |
| created_by | text, nullable | admin username, for manual corrections |
| resolved_at | timestamptz, nullable | |

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
- `createPunches` — POST `/legalentities/{legalEntityId}/CreatePunches`, auth-gated
  like `createSchedulingShifts` (exec/it, or the live tap's own crew-session check)
- `punchErrorLog` — GET `/legalentities/{legalEntityId}/punchErrorLog/{trackingId}`,
  used by both the synchronous poll and the background reconciliation cron

## Punch Mapping

| Button | `PunchStatusType` | `ActivityTypeId` |
|---|---|---|
| Clock In | `In` | Work |
| Break Start | `Out` | Meal |
| Break End | `In` | Work |
| Clock Out | `Out` | Work |

`PunchDateTime` is the server's real timestamp at the moment of the tap — never a
client-supplied or client-device time — so Paycor's record of "when" is exactly when
the button was actually pressed, not something typed or spoofable.

## Write Pipeline & Reliability

1. Crew member taps a button → function captures the server timestamp, loads their
   stored `paycor_employee_id` / `paycor_department_id` / the store's cached
   `crew_activity_types`, and calls `createPunches` with one punch record.
2. Response gives a tracking ID immediately; a `crew_punches` row is written as
   `pending`.
3. The function synchronously polls `punchErrorLog/{trackingId}` for up to ~15s
   (inside the 26s function budget) with the correct semantics: only a 2xx response
   resolves it (checking for per-record errors inside the body too); 404 means still
   processing; anything else (401/403/500) stays unresolved and is never read as
   success.
4. Resolved within the window → `crew_punches` updated to `confirmed`/`failed`,
   employee sees the real result immediately.
5. Still unresolved after the window → responds to the employee optimistically
   ("Clocked in — confirming...") and a background cron
   (`crew-punch-reconcile-cron.mjs`, same shape as `minor-timecard-followup-cron.mjs`)
   keeps polling until it resolves.
6. On a confirmed real failure (either path): the employee is told plainly next time
   they open the app ("your last clock-in didn't go through, tell your manager"), and
   the manager is alerted (push/email) so payroll doesn't silently lose the punch.

## Accounts & Permissions

- New `crew` userType: single-purpose UI — the four punch buttons and today's own
  punch history, nothing else of the Portal.
- Created centrally by IT/exec only; no self-registration or manager creation in v1.
- Login: phone number (identifier) + PIN. Chosen over SMS-one-time-code (real
  per-punch cost at 45-store scale, delivery-delay risk right at shift start) and over
  the standard email/password policy (most crew have no company email; a 12-char
  password is a poor fit for something done several times a day).
- Per-account `enabled` toggle — the individual opt-out.
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
2. Picks the matching name — `paycor_employee_id` and `paycor_department_id` are
   captured automatically from that record. No GUID is ever typed.
3. Enters phone (optional at creation) and sets an initial PIN.
4. Toggles enabled.

## Missed-Punch Corrections (weekly, IT/exec only)

- A screen listing that week's `crew_punches` per store/employee, flagging obviously
  incomplete days (an open clock-in with no clock-out; a scheduled shift — cross-
  referenced against existing Paycor schedule data already in the app — with zero
  punches).
- IT/exec can manually add or edit a punch's date and time.
- A "Send to Paycor" action (per correction or as a batch) runs the same write
  pipeline as a live punch, with `source = manual_correction` and a `Note` recording
  who made the correction and when.
- Mirrors the tips-staging flow's review-then-explicit-send shape, but — unlike the
  tips paygrid — there is no second Paycor-side approval waiting for it: a sent
  correction is a real, live punch immediately.

## Store Cutover

- Parallel-run: both the physical Paycor clock and this app stay active for a trial
  period (default: one full work week) once a store is turned on.
- A comparison view (IT/manager) lines up this app's punches against Paycor's own
  read-side punches for the same store/period, surfacing any mapping mistakes before
  the physical clock is retired.
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
   Timecard Compliance's detection logic — parked, not required for v1.

## Testing

- Pure logic (punch-status/activity-type mapping, error-log resolution semantics,
  incomplete-day detection for corrections) as unit-testable pure functions, following
  this codebase's established pure-function + I/O-wrapper pattern (see
  `src/minor-timecard-detect.mjs` for precedent).
- The Controlled Test itself is the integration-level verification of the real
  Paycor contract — not a substitute for unit tests, but the only way to verify facts
  no documentation excerpt could confirm.
