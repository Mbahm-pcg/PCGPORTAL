# No Clock-In Alerts — Design Spec

## Purpose

Managers often add hours by hand because employees forget to clock in, which hurts payroll and tips-report accuracy. This feature detects scheduled employees who have not clocked in and alerts the store manager (and, later, the DM) by text and email, so the miss is caught the same morning instead of at payroll.

## Rules (as agreed 2026-09-21)

- The schedule is treated as truth even when a manager never removes a call-off from Paycor: a scheduled shift with no punch triggers the rule regardless.
- **30 minutes after shift start, still no clock-in** -> heads-up to the **store manager only** (text + app notification + email).
- **60 minutes after shift start, still no clock-in** -> employee is **marked absent**; alert goes to the **store manager and the DM** (text + app notification + email).
- Any clock-in before a message goes out cancels it.
- Every alert goes out on all three channels: SMS, in-app (web push) notification, and email.

## Detection — `netlify/functions/no-clockin-cron.mjs`

- Scheduled `*/15 * * * *`. Store list comes from the `pcg_stores_v1` blob, `status === 'Open'` only (same approach as `system-health-cron.mjs`).
- Each run:
  1. Pre-filter using the saved `pcg_schedule_{pc}` blob: shifts that started 30 minutes to 3 hours ago.
  2. For stores with candidates, re-fetch that store's live `schedulingShifts` from Paycor so a shift the manager removed or moved does not alert.
  3. For each remaining candidate, call `employeePunches`. The employee counts as clocked in if any punch exists from 60 minutes before the shift start until now (covers early clockers and split shifts).
- Paycor calls are per employee for punches (the bulk punches endpoint only returns completed shifts), so only people whose shift already started and who have no punch on file are checked.
- **Never guess on failure:** if a Paycor call errors or returns non-200, the employee is `unknown`, never `missing`, and is never marked absent.
- **Feed-problem guard:** if 3 or more employees at one store are missing at once, the message says "clock-in data may be unavailable, please verify" and does not name anyone as absent.
- **Timing:** the 30-minute alert fires on the first run at or after start+30 min (up to 15 minutes late). The 60-minute alert is "60 or more minutes since shift start", not a run counter, so skipped or late Netlify crons cannot mark anyone absent early.
- Dates and shift windows use Eastern time; shifts that cross midnight are handled.

## Messages

- 30 min, manager only: "Jane D. was scheduled 6:00a at Wadsworth and hasn't clocked in."
- 60 min, manager + DM: "Jane D. marked absent (scheduled 6:00a, Wadsworth)."
- Multiple people at one store are combined into one message per store per run. A DM with several affected stores gets one text per store.
- SMS via Textbelt (same provider as `sms.mjs` / `pulse-notify.mjs`), email via Resend, and app notification via web push (VAPID, subscriptions in `pcg_push_subscriptions_v1` keyed by Portal user id) — same helper patterns as `system-health-cron.mjs`. A channel that fails or is unavailable (e.g. no push subscription) never blocks the others.
- Recipients: the store manager's phone/email from the store record; the DM from the Users data for that store's district. Push needs the recipient's Portal user id, so the manager and DM are resolved to their Users records (by store PC / district) for push; a recipient with no Portal account or no subscription still gets SMS and email. This feature reads real store/user data and never writes to it. (District Alignment is a separate draft-only tool and does not affect recipients.)
- Cost note: a no-show is 2 texts to the manager and 1 to the DM.

## State — blob `pcg_noclockin_v1`

Keyed by business date, then `pc|employeeId|shiftStart`:

```json
{ "2026-09-21": { "339616|abc123|2026-09-21T10:00:00Z": { "alerted30At": "...", "absentAt": "..." } } }
```

- Prevents repeat messages; each stage fires once per shift.
- Entries older than 14 days are pruned. The record doubles as absence history for a future report.
- Stored with the standard `{ savedAt, data }` wrapper.

## Testing

- Core logic is a pure function in `src/no-clockin.mjs` (same pattern as `src/system-health.mjs` and `src/pulse-sms.mjs`), taking shifts, punches and `now` and returning the messages to send. Unit tests cover: before 30 min, 30-59 min, 60+ min, punch exists, API error -> unknown, mass-miss guard, overnight shift, and dedupe against saved state.
- A `dryRun` mode, restricted to exec/IT, returns what would be sent without sending anything.

## Out of scope for v1

Reply buttons (Called off / Covered), a Portal page for absence history, approved time-off handling, and the tips/payroll integration.

## Open items for the plan

- Confirm exactly where the DM's phone/email is read from at run time (Users table via `_shared/db.mjs`, as `system-health-cron.mjs` does).
- Confirm the Textbelt key/quota can absorb the added volume.
