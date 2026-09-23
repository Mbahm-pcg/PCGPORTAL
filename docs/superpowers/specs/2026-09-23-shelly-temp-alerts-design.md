# Walk-In Cooler/Freezer Temp Alerts — Design Spec

## Purpose

A walk-in cooler/freezer that goes over 5°C is a food-safety and inventory-loss problem.
This feature monitors Shelly Cloud temperature sensors, and when a reading stays over 5°C
for a sustained period, automatically opens a HIGH-priority Maintenance ticket and notifies
the store's manager, its DM, and exec/IT — without anyone needing to be watching a dashboard.

This grew out of a simpler ask (show the current reading on the Dashboard, built and shipped
same day — see `netlify/functions/shelly.mjs` and the Dashboard temp cards) once the real
goal came out: automated detection, not just display. The display widget stays as-is; this
spec covers the new automation layered on top of the same data source.

## Rules (as agreed 2026-09-23)

- Threshold: **> 5°C** on any monitored probe.
- Trigger: **2 consecutive checks over threshold** (~30 min at the 15-min check interval) —
  not an instant single-reading trigger, to avoid a false ticket from one noisy reading.
- **One ticket per breach episode.** The open ticket itself is the dedup lock: while a ticket
  tagged to that exact sensor is still open (any status other than `Closed`), no second ticket
  gets created regardless of how many more over-threshold checks happen. Once a human closes
  that ticket, the next sustained breach opens a fresh one. No separate "has it recovered"
  state is tracked — simpler, and the ticket lifecycle is already human-managed.
- A normal (≤5°C) reading resets that sensor's consecutive-over counter to 0.
- **A failed/unreachable reading is `unknown`, never treated as over-threshold or as a reset**
  — same principle `no-clockin-cron`'s Paycor calls already use (`fetchPunches` returns `null`
  on error, "unknown, never missing"). A Shelly API outage must never itself create a false
  ticket, and must never silently clear a real in-progress breach streak either — an unknown
  check simply doesn't move the counter in either direction.
- Every physical probe is monitored independently — this device (`70af09e522d0`, Bustleton)
  has two (`temperature:200`, `temperature:201`), confirmed real 2026-09-23 via
  `/device/all_status`; both get their own counter/episode.
- Ticket fields: `priority: 'High'` **always**, hardcoded — never Medium/Low, no override path.
  `status: 'Open'`, `ticketOwner: 'Unassigned'` (general Maintenance queue, same as an
  unassigned manager-reported ticket), `category: 'Equipment Repair / Maintenance'`.

## Device → store mapping

Shelly's Cloud API (`/device/status`, `/device/all_status`) carries no usable "which store"
field — confirmed against the real response, not assumed. A small hardcoded map is the only
way to route a ticket/notification to the right store:

```js
// netlify/functions/shelly-temp-lib/device-map.mjs
export const SHELLY_DEVICE_STORE = {
  '70af09e522d0': '332941', // Bustleton
};
```

**Known limitation, accepted for now:** adding a sensor at a new store needs this one line
added (+ redeploy) — everything else (the sensor showing up on the Dashboard, being read by
this automation) needs zero code change, since `shelly.mjs` already auto-discovers every
device/probe on the account. A device with no entry in this map is monitored for nothing —
skipped by the automation (logged as a warning) rather than guessing a store, since routing a
food-safety alert to the wrong store is worse than not routing it. An in-app admin screen for
this mapping was considered and explicitly deferred (see Out of Scope).

`SHELLY_SENSOR_LABELS` (already shipped, in `app.jsx`, cosmetic-only display labels) is a
separate, unrelated map — it affects only what a sensor is *called* on the Dashboard, not
whether this automation runs or where a ticket routes.

## Detection — `netlify/functions/shelly-temp-cron.mjs`

Scheduled `*/15 * * * *`, mirroring `no-clockin-cron.mjs`'s exact 3-layer split:

- `shelly-temp-cron.mjs` — thin scheduled entry, calls the shared engine.
- `shelly-temp-lib/run.mjs` — I/O: calls Shelly (`/device/all_status`, same call `shelly.mjs`
  already makes), loads/saves state, creates tickets, sends notifications.
- `src/shelly-temp.mjs` — pure decision logic (counter increment/reset, breach-trigger check),
  no I/O, unit-testable the same way `src/no-clockin.mjs` is.

Each run:
1. Call Shelly's `/device/all_status` once (all devices/probes in one call, same as `shelly.mjs`).
2. For each `(deviceId, sensorId)` pair with a `SHELLY_DEVICE_STORE` entry: run the pure
   `advanceBreachStreak` logic against the saved counter for that key.
3. Where the logic says "should ticket" (counter just reached 2 and no open ticket exists for
   this sensor): create the ticket (direct `INSERT INTO maint_tickets`, same table
   `tickets.mjs` owns, matching its exact column shape so the frontend's existing `list`
   reconstruction picks it up with no changes there) and write one entry into the shared
   `pcg_notifications_v1` blob, `type: 'temp_alert'`, tagged with that store's `storePC` and
   `district`.
4. Save the updated per-sensor counters back to state.

## Notification routing — reuses existing role filtering, no new code there

`filterNotifsByRole` (`app.jsx`) already scopes bell notifications by `storePC` (manager) and
`district` (DM), and shows everything to exec/IT/office_staff — this is the exact mechanism
`manager_change_pending` notifications already use. Tagging the new `temp_alert` notification
with the breach store's `storePC`/`district` means Bustleton's manager and district 7's DM see
it, everyone else doesn't, with zero changes to the filtering function itself.

Channels: SMS + email + push, same `sendSms`/`sendEmail`/`sendPush` helpers
(`_shared/channels.mjs`) `no-clockin-lib/run.mjs` already uses, recipients resolved the same
way (`contactsFor`-style lookup by `store_pc`/`district` against the `users` table) — so this
automatically picks up whoever the *current* correct manager is, including once the
in-progress manager-sync work (separately, not yet deployed) resolves Bustleton's own
manager transition.

## State — blob `pcg_shelly_temp_state_v1`

Keyed by `deviceId|sensorId`:

```json
{ "70af09e522d0|200": { "consecutiveOverCount": 1, "lastCheckedAt": "2026-09-23T18:00:00Z" } }
```

- No ticket id stored here — "is there an open ticket for this sensor" is checked live
  against `maint_tickets` (via a `meta` tag: `{ source: 'shelly-temp-auto', deviceId,
  sensorId }`), not cached, so a manually-edited/reopened ticket is always the source of truth.
- Stored with the standard `{ savedAt, data }` wrapper.

## Testing

Pure logic in `src/shelly-temp.mjs`: `advanceBreachStreak({ tempC, prevCount })` returns
`{ count, shouldTicket }`. Unit tests cover: under threshold resets to 0, one over-reading
doesn't trigger, two consecutive over-readings triggers, a third over-reading while already
triggered doesn't re-trigger, `unknown` (null reading) leaves the count unchanged in both
directions, and recovery-then-rebreach (count drops to 0, then climbs back to trigger again)
producing a second `shouldTicket`.

## Out of scope (explicitly deferred, not silently dropped)

- **Sensor-offline alerting** (device unreachable vs. over-temp) — not asked for; today's
  scope is the temperature threshold only. A dead sensor currently just produces `unknown`
  checks (no ticket, no alert) until it reports again.
- **In-app admin screen for the device→store mapping** — considered during design, deferred
  in favor of the small hardcoded map given the low device count (cap of 5 on the current
  plan) and to ship the actual safety automation sooner. Worth revisiting if the sensor count
  grows meaningfully past a handful.
- **Auto-detecting which store a device belongs to** (e.g. parsing a Shelly device name) —
  Shelly's `/device/status`/`/device/all_status` responses carry no name field to parse
  (confirmed against the real response); the name shown in the Shelly *app* comes from a
  different part of Shelly's API that hasn't been explored, and mis-detecting a store for a
  food-safety alert is worse than requiring the one manual mapping line.
