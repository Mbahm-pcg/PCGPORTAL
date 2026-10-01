# Office Hourly Time Clock — Design Spec

> Supersedes `2026-09-30-crew-time-clock-design.md` (removed), which was built on a
> mistaken population — Dunkin' store hourly "crew." The actual target population is
> **hourly office staff**, who already have normal Portal accounts. See "What changed
> from the first draft" below.

## Overview

Office staff are a mix of salaried and hourly employees. This feature gives
**hourly office staff** — a new tab in their *existing* Portal login — a clock-in /
meal-start / meal-end / clock-out screen that captures punches in real time in our
own database, then lets IT/exec review each closed biweekly pay period and push it to
Paycor's `CreatePunches` API with one button, mirroring the existing tips biweekly
flow's shape and sharing its real payroll-lock deadline.

This is the write-side companion to [[project_minor_timecard_compliance]] only in the
sense that both write/read Paycor punches — there is **no population overlap and no
minor-labor-law relevance here at all**. It is architecturally distinct from the
earlier [[project_paycor_payroll_auto_import]] effort — that work targets Paycor's
**payroll dollar-amount staging** (`payrollhours`), permanently blocked by a
Trackforce/Integration Payroll Time Partner account-tier requirement. Punches are a
different Paycor product surface (**Perform Time**), gated differently, and PCG's
account already demonstrably has *read* access under that same gate (`punches` /
`employeePunches` already work in production for stores). Write access is not yet
confirmed — see "Controlled Test" below.

## What changed from the first draft

The first draft of this spec was built around "crew members" — understood (wrongly)
to mean Dunkin' store hourly crew — pulling in an entire new account type, phone+PIN
login, and a minors-exclusion guardrail tied to [[project_minor_timecard_compliance]].
None of that applies here:

- **Population:** hourly office staff only, a subset of the existing `office_staff`
  userType — not a new population needing new accounts.
- **Accounts & login:** office staff already have ordinary Portal logins. This
  feature adds a flag to an *existing* user's record and a new tab they already see
  inside their *existing* Portal shell — no new userType, no PIN, no new login
  screen.
- **No minors concern at all** — office staff are adults; this guardrail is removed
  entirely, not just deferred.
- **Paycor legal entity:** office staff sit under their own dedicated
  corporate/office legal entity in Paycor, not one of the 45 store entities.
- **Access control:** gated through the existing per-role Access Matrix
  (`accessOverrides`/`HUB_SUBITEMS`), the same mechanism Minor Timecard Compliance
  already uses — not a bespoke `clock_enabled` column. See
  [[feedback_role_based_feature_access]]. Per-person enablement is simply whether
  that user has been linked to a Paycor employee record at all.
- Everything about *how Paycor itself works* (the write endpoint, the async
  tracking-ID/error-log model, the punch mapping, the biweekly batch cadence and its
  real Tuesday-night lock) is unchanged — that was never wrong, only who it's for.

## Background — what's actually true about Paycor's punch API

Confirmed via Paycor's own documentation and corroborated by a real third-party
integration's (alexrelintex/timeclock) public PR history — not guessed:

- **Write endpoint exists:** `POST /v1/legalentities/{legalEntityId}/CreatePunches`,
  body is an array of punch objects.
- **Gate:** "Employee Time Card Punches APIs will only work with Perform Time-enabled
  clients... will not work for Time on Demand or Attendance on Demand clients." This
  is the same gate that already covers punches *reads* for stores, which PCG's
  account passes today. Whether the office/corporate legal entity is on the same
  Paycor product tier, and whether PCG's OAuth client has write scope granted at all,
  are both unconfirmed — see Controlled Test.
- **No native "Break" punch type.** `PunchStatusType` only accepts `Auto`, `In`,
  `Out`, `Transfer`. A meal break is represented as an `Out`/`In` pair tagged with a
  break-specific `ActivityTypeId`, not a distinct punch status.
- **Confirmed against PCG's real Bustleton store data** (legal entity 193884, via the
  existing read-only `raw` GET proxy) that Activity Types for a legal entity include
  distinct **Work** (Productive) and **Meal** (NonProductive) GUIDs, and that
  Departments are job-classification-based with their own GUIDs, already present on
  an employee's own Paycor record (`department.id`) — never needing to be typed or
  looked up separately. **The office/corporate legal entity's own Activity Type and
  Department GUIDs are a separate, not-yet-confirmed fetch** — fetched and cached the
  same way, once, the first time this feature is turned on.
- **Async, not synchronous.** `CreatePunches` returns a tracking ID immediately: the
  real outcome is only knowable via `GET punchErrorLog/{trackingId}`. A real bug found
  in the third-party integration's history: treating any non-404 response as "clean
  success" silently recorded permission/server errors (401/403/500) as successful
  punches. Correct semantics: only a 2xx response is resolved (and may still contain
  per-record errors inside); 404 means still processing, keep polling; anything else
  is unresolved — never treat it as success.
- **No delete/void-punch API exists.** If a test or a sent batch is wrong, the only
  fix is a manual correction inside Paycor's own UI.
- Exact required-vs-optional field list for `CreatePunches` could not be retrieved
  from Paycor's JS-rendered developer portal via automated tooling. Best-known fields:
  `EmployeeId`, `DepartmentId`, `PunchDateTime`, `PunchStatusType`, `ActivityTypeId`
  (believed required); `IsTransfer`, `Note`, `LaborCodes` (believed optional). **This
  will be confirmed for real by the Controlled Test** — a real 400/validation
  response names exactly which field is wrong.

## Pay Period Cadence (reused, not reinvented)

Unchanged from the first draft — this codebase already has a confirmed,
Paycor-verified biweekly boundary in `tips-report-cron-background.mjs`:

- Pay weeks run **Sunday–Saturday**.
- Biweekly periods are anchored to `BIWEEKLY_ANCHOR_END = '2026-08-15'`, recurring
  every 14 days (`isBiweekBoundary`, `dateRangeEndingAt`).
- **Payroll hard-locks the Tuesday night 3 days after the period's Saturday close** —
  confirmed as the same real Paycor lock for both tips/earnings and worked-time
  hours.

**Lock behavior:** from period close (Saturday night) until that Tuesday-night lock,
IT/exec can freely view, edit, and send that period's punches to Paycor, any number
of times, with no requirement to edit before sending. At the lock, the period becomes
fully read-only: no further edits, no further sends, no override.

## Goals

1. Give hourly office staff a clock-in / meal-break / clock-out tab, inside their
   existing Portal login, that captures every punch the instant it happens.
2. Give IT/exec control over who can even see this tab, through the **existing
   per-role Access Matrix** (`accessOverrides`/`accessSubOn`/`HUB_SUBITEMS` —
   see [[feedback_role_based_feature_access]]), the same mechanism Minor Timecard
   Compliance already uses — not a bespoke new permission flag. That way, if the
   company later decides a different role should get this too, it's a toggle in
   that existing admin screen, not new code. Within an eligible role, whether a
   specific person can actually *use* it still depends on whether they've been
   linked to a real Paycor employee record (see One-Time Setup) — most office
   staff are salaried and will simply never be linked.
3. Once each biweekly pay period closes, give IT/exec a single review screen to edit
   any gaps and push the whole period to Paycor with one button.

## Non-Goals

- Not available to any role other than `office_staff`, and not to every
  `office_staff` account either — gated per-person by a new flag, off by default.
- Not a new account type, not a new login mechanism.
- No minor-labor-law relevance, no interaction with Minor Timecard Compliance.
- Not a real-time write to Paycor — punches are captured live in our own system,
  reaching Paycor only via the biweekly reviewed batch send.
- Not a second Paycor-side staging/approval step — once IT clicks Send, it's a real,
  live set of punches in Paycor immediately (no equivalent exists for punches, unlike
  the tips `payrollhours` paygrid).

## Controlled Test (required before any UI work — Task 1 of the implementation plan)

A single real test punch (Clock In) will be posted to Ahmed's own record — at
Bustleton, since that's the legal entity already confirmed to have working Paycor
read access and known real data, standing in for the technical validation of the
`CreatePunches`/`punchErrorLog` mechanism itself (the office/corporate legal entity's
own write-access and Activity Type/Department GUIDs get verified separately, during
Task 4, before any real office-staff punch is ever sent there) — then confirmed via
the `punchErrorLog` poll using the correct 2xx/404/other semantics above.

Because there is no delete-punch API, this requires an **explicit go-ahead at the
moment it is about to run**, separate from approval of this design — if it succeeds,
cleanup means manually correcting/removing it in Paycor's own UI afterward.

## Data Model

### `users` table additions (not a new table — see "What changed")

| column | type | notes |
|---|---|---|
| `paycor_department_id` | text, nullable | from the matched Paycor employee record, sibling to the existing `paycor_employee_id` |

No separate enable/disable flag. **A user can actually punch once both
`paycor_employee_id` and `paycor_department_id` are set** — that link's existence
*is* the enablement, set once by IT during One-Time Setup. Tab *visibility* is a
completely separate concern, handled by the Access Matrix (see Goals #2) — someone
could in principle see an empty/not-set-up Time Clock tab if their role is eligible
but they haven't been linked yet; the tab shows a plain "not set up — contact IT"
state in that case rather than punch buttons.

`is_hourly` is **not stored** — it's derived live from the matched Paycor employee's
`statusData.flsa` field (`HourlyNonExempt` vs anything else) at link time and shown
to IT as a suggestion, not persisted as a separate source of truth that could drift
from Paycor's own record.

### New Postgres tables (self-created, matching `audits.mjs`/`safe-audits.mjs`
convention — documented in `db/schema.ts` for reference only, never migrated from
there)

**`office_clock_punches`** — first-party log, source of truth for the "today" view
and the pay-period review, independent of Paycor until sent.
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | integer fk → users.id | |
| punch_type | text | `clock_in` \| `meal_start` \| `meal_end` \| `clock_out` |
| captured_at | timestamptz | server time at the tap, or admin-entered time for a manual edit |
| pay_period_end | date | the Saturday closing this punch's pay period |
| source | text | `live` \| `manual_edit` |
| edited_by | text, nullable | admin username, when `source = manual_edit` |
| paycor_status | text | `unsent` \| `pending` \| `confirmed` \| `failed` |
| paycor_tracking_id | text, nullable | |
| paycor_punch_id | text, nullable | once confirmed |
| note | text, nullable | sent as Paycor's `Note` field for a `manual_edit` row |

**`office_clock_activity_types`** — cached once for the office/corporate legal
entity (one row, not one per store).
| column | type | notes |
|---|---|---|
| legal_entity_id | text pk | |
| work_activity_type_id | text | |
| meal_activity_type_id | text | |
| fetched_at | timestamptz | |

**`office_clock_pay_period_sends`** — audit trail of who sent a period and when (a
period can be sent more than once before it locks).
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| pay_period_end | date | |
| sent_at | timestamptz | |
| sent_by | text | |

## Punch Mapping

| Button | `PunchStatusType` | `ActivityTypeId` |
|---|---|---|
| Clock In | `In` | Work |
| Meal Start | `Out` | Meal |
| Meal End | `In` | Work |
| Clock Out | `Out` | Work |

`PunchDateTime` is the server's real timestamp at the moment of the tap (or the
admin-entered time for a manual edit) — never a client-supplied or client-device
time.

## Live Capture (no Paycor call at punch time)

An enabled user taps a button in their new Time Clock tab → the function captures
the server timestamp, resolves the pay period, and writes one
`office_clock_punches` row with `paycor_status = 'unsent'`. Nothing is sent to Paycor
yet — that's what keeps the daily flow simple and removes any need for per-punch
retry/confirmation logic.

## One-Time Setup (linking an *existing* account — not creating one)

1. IT opens an "Hourly Time Clock" admin screen, sees the office/corporate legal
   entity's active Paycor employees (same active-employee fetch pattern used
   elsewhere in this codebase), cross-referenced against existing `office_staff`
   `users` rows.
2. Picks the matching existing office_staff account — `paycor_employee_id` and
   `paycor_department_id` auto-fill from that Paycor record, and the employee's FLSA
   status is shown ("Hourly" / "Salaried — clock-in not applicable") as a plain
   signal, not an enforced gate (IT makes the final call on whether to link them at
   all).
3. Saving the link is the entire "enable" action — no separate toggle. The user
   immediately sees working punch buttons next time they load the Time Clock tab
   (which they may already be able to see, if their role is eligible via the Access
   Matrix) — no new login, no password change, nothing else different about their
   account.

## Pay Period Review & Send (IT/exec only)

- Once a pay period closes (Saturday night), a review screen lists that period's
  `office_clock_punches` across every linked user (`paycor_employee_id` and
  `paycor_department_id` both set), flagging obviously incomplete days (an open
  clock-in with no clock-out; a meal started with no meal ended).
- IT/exec can add or edit any punch's date/time inline (`source = manual_edit`,
  `edited_by` recorded).
- A **"Send to Paycor"** button (available any time before the Tuesday-night lock,
  with or without edits) triggers a background function that batches every `unsent`
  punch into one `createPunches` call, polls `punchErrorLog` with the correct
  semantics, and updates each punch's status individually from the real per-record
  result.
- **Hard lock** at the Tuesday-night deadline: the review screen becomes fully
  read-only — no edits, no re-send, no override.

## Open Questions

1. **Exact `CreatePunches` required/optional field list** — confirmed by the
   Controlled Test's real response.
2. **Whether PCG's OAuth client has write scope for `CreatePunches`** at all, and
   whether the office/corporate legal entity is itself Perform-Time-enabled — both
   surface via the Controlled Test and Task 4's first real fetch against that legal
   entity.
3. **The office/corporate legal entity ID itself** — needed before Task 4 can be
   built against real data; to be supplied once known.

## Testing

- Pure logic (punch-status/activity-type mapping, error-log resolution semantics,
  pay-period/lock-boundary math, incomplete-day detection) as unit-testable pure
  functions, following this codebase's established pure-function + I/O-wrapper
  pattern.
- The Controlled Test is the integration-level verification of the real Paycor
  contract — not a substitute for unit tests, but the only way to verify facts no
  documentation excerpt could confirm.
