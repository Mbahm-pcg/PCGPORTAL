# Walk-In Cooler/Freezer Temp Alerts — Design Spec

## Purpose

A walk-in cooler/freezer that goes over 5°C is a food-safety and inventory-loss problem.
This feature monitors Shelly Cloud temperature sensors with a two-tier response — a quiet
heads-up while it's borderline, a full escalation once it's clearly serious — automatically
opening a HIGH-priority Maintenance ticket and notifying the right people, without anyone
needing to be watching a dashboard.

This grew out of a simpler ask (show the current reading on the Dashboard, built and shipped
same day — see `netlify/functions/shelly.mjs` and the Dashboard temp cards) once the real
goal came out: automated detection, not just display. The display widget stays as-is; this
spec covers the new automation layered on top of the same data source.

## Delivery-day suppression (added during design review, 2026-09-23)

Dunkin's DCP process has the cooler propped open for a stretch during a real delivery — a
genuine, expected temp spike that must not create a false ticket. The Portal already has
usable data for this: `ndcp_orders` (Postgres, populated from parsed National DCP
order-confirmation emails — see `netlify/functions/ndcp-lib/`) carries a `date_shipped` per
order, and `account == store pc` directly (verified 45/45 stores, `ndcp-lib/store-map.js`) —
no fuzzy name-matching needed to join an order to a store.

**Rule**: on any day a store has an `ndcp_orders` row with `date_shipped` matching today,
that store's sensors are skipped entirely for the whole day — no breach-counter movement
either direction, same as an `unknown`/failed reading. Monitoring resumes normally the next
day regardless of where the counter was before the delivery day.

**Known limitation, accepted**: `date_shipped` is date-only (no time-of-day in what NDCP's
order emails expose), so this suppresses the *whole day*, not a tight arrival window — a
real failure that happens to fall on a delivery day won't be caught until the following day's
checks. Given delivery days are a small fraction of a month, this trade favors avoiding false
tickets over slightly slower detection on those specific days.

## Rules (revised 2026-09-23 — two-tier escalation)

Two thresholds, not one — added after review because a single hard line either creates a
ticket for a borderline reading or misses a slow, quiet failure, and neither is right.

| Tier | Condition | Action |
|------|-----------|--------|
| **Warning** | Temp **> 5°C**, sustained 2 consecutive checks (~30 min) | Notify the **manager only** (SMS/email/push) — heads up, keep an eye on it. **No ticket yet.** Fires once per episode, not on every check while still borderline. |
| **Red-flag** | Temp **> 7°C**, on the very first reading that crosses it — no separate sustain requirement (crossing 7°C already means it's clearly gotten worse, no need to wait another 30 min to confirm) | Create the HIGH ticket immediately, notify **manager + DM** (SMS/email/push) |
| **Prolonged warning** | Still between 5-7°C (never dropped to ≤5°C, never crossed 7°C) for **2 straight hours** | Escalate to the same HIGH ticket + manager+DM notification as Red-flag — a cooler stuck borderline all day is a real problem even if it never spikes higher |

Worked example: 5.5°C at 2:00, 5.8°C at 2:15 (30 min sustained → Warning notification to the
manager only, no ticket). Stays in the 5-7°C band without change until 4:00 (2 hours since it
first went over 5°C) → escalates to a HIGH ticket, manager+DM notified. If instead it had
jumped to 7.5°C at 2:30, that alone creates the ticket immediately, regardless of the 2-hour
window or whether the Warning had even fired yet.

**exec/IT are never separately texted/emailed for either tier** — they see every notification
in the bell automatically regardless of type (existing behavior, `filterNotifsByRole`), the
same way they were never separately SMS'd for `no-clockin-cron`'s alerts either. If that's
wrong, flag it before implementation — texting exec/IT directly on every ticket is easy to
add but wasn't asked for.

- **One ticket per breach episode**, however it was reached (Red-flag or Prolonged warning).
  The open ticket itself is the dedup lock: while a ticket tagged to that exact sensor is
  still open (any status other than `Closed`), nothing creates a second one, no matter how
  many more over-threshold checks happen. Once a human closes it, the next sustained breach
  opens a fresh one. No separate "has it recovered" state is tracked.
- A reading **≤5°C** fully resets that sensor: clears the elapsed-time clock and the
  "already warned this episode" flag. The next crossing above 5°C starts a brand new episode
  from zero — a fresh Warning can fire again, a fresh 2-hour clock starts, etc.
- **A failed/unreachable reading is `unknown`, never treated as over-threshold or as a reset**
  — same principle `no-clockin-cron`'s Paycor calls already use (`fetchPunches` returns `null`
  on error, "unknown, never missing"). A Shelly API outage must never itself create a false
  ticket or warning, and must never silently clear a real in-progress episode either — an
  unknown check simply doesn't move anything, in either direction, and doesn't advance the
  2-hour clock either (an unknown check is time that didn't count, not time that passed safely).
- Every physical probe is monitored independently — this device (`70af09e522d0`, Bustleton)
  has two (`temperature:200`, `temperature:201`), confirmed real 2026-09-23 via
  `/device/all_status`; both get their own episode/state.
- Ticket fields: `priority: 'High'` **always**, hardcoded — never Medium/Low, no override path,
  regardless of whether it arrived via Red-flag or Prolonged warning. `status: 'Open'`,
  `ticketOwner: 'Unassigned'` (general Maintenance queue, same as an unassigned
  manager-reported ticket), `category: 'Equipment Repair / Maintenance'`.

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
- `src/shelly-temp.mjs` — pure decision logic (episode/elapsed-time tracking, tier decisions),
  no I/O, unit-testable the same way `src/no-clockin.mjs` is.

Constants (`src/shelly-temp.mjs`): `WARNING_THRESHOLD_C = 5`, `WARNING_SUSTAIN_MS = 30 *
60000`, `RED_FLAG_THRESHOLD_C = 7`, `PROLONGED_WARNING_ESCALATE_MS = 2 * 3600000`.

Pure function `advanceTempState({ tempC, prevState, nowMs })` → `{ state, shouldWarn,
shouldTicket, reason }` (`reason` is `'red-flag'` | `'prolonged-warning'` | `null`, kept for
the ticket/notification text and for tests, not a control-flow value):

- `tempC == null` (unknown/failed reading) → return `prevState` completely unchanged,
  `shouldWarn: false`, `shouldTicket: false`. Doesn't advance the elapsed-time clock either —
  an unknown check is time that didn't count, not time that passed safely.
- `tempC <= 5` → full reset: `{ overSince: null, warningNotified: false }`, nothing fires.
- `tempC > 5`:
  - `overSince` becomes `prevState.overSince || nowMs` (starts the clock on first crossing).
  - `elapsedMs = nowMs - overSince`.
  - `tempC > 7` → `shouldTicket: true, reason: 'red-flag'` immediately, no elapsed-time
    requirement.
  - else if `elapsedMs >= PROLONGED_WARNING_ESCALATE_MS` → `shouldTicket: true, reason:
    'prolonged-warning'`.
  - else if `elapsedMs >= WARNING_SUSTAIN_MS && !prevState.warningNotified` →
    `shouldWarn: true` (only once per episode — `warningNotified` flips to `true` and stays
    that way until the next full reset).
  - **Whenever `shouldTicket` is true (either reason), `warningNotified` is also set `true`**
    in the returned state, even on a straight jump to red-flag that skipped the Warning stage
    entirely. Otherwise a later dip back to, say, 6.5°C (still >5, so not a full reset) would
    fire a redundant "Warning" notification after the manager+DM have already been alerted
    about the serious ticket — once an episode has escalated, it's escalated for good.

Each run, in `shelly-temp-lib/run.mjs`:
1. Call Shelly's `/device/all_status` once (all devices/probes in one call, same as `shelly.mjs`).
2. Query `ndcp_orders` once for any row where `account` matches a mapped store's pc and
   `date_shipped` is today — build a small set of "suppressed today" store pcs from the result.
3. For each `(deviceId, sensorId)` pair with a `SHELLY_DEVICE_STORE` entry: if that device's
   store is in today's suppressed set, skip it entirely (state untouched, same as an unknown
   reading). Otherwise run `advanceTempState` against the saved state for that key.
4. `shouldWarn` → send the Warning notification (manager only), but only if this hasn't
   already been sent for this episode (the pure function's `warningNotified` flag already
   guarantees this — `run.mjs` doesn't need its own separate check here).
5. `shouldTicket` → check whether a ticket is already open for this exact sensor (`meta` tag
   match, status ≠ `Closed`) in `maint_tickets`. If not, create it (direct `INSERT INTO
   maint_tickets`, matching `tickets.mjs`'s exact column shape so the frontend's existing
   `list` reconstruction picks it up with no changes there) and send the Red-flag notification
   (manager + DM).
6. Either notification also writes one entry into the shared `pcg_notifications_v1` blob
   (`type: 'temp_warning'` or `'temp_alert'`), tagged with the store's `storePC`/`district`,
   so it shows up in the bell too — see Notification routing below.
7. Save the updated per-sensor state back to the blob.

## Notification routing

**Bell visibility (both tiers, free/no new code):** `filterNotifsByRole` (`app.jsx`) already
scopes bell notifications by `storePC` (manager) and `district` (DM), and shows *everything*
to exec/IT/office_staff regardless of type — this is the exact mechanism
`manager_change_pending` already uses, and neither tier needs any change to that function.
Tagging both `temp_warning` and `temp_alert` notifications with the breach store's
`storePC`/`district` means Bustleton's manager and district 7's DM see both tiers in their
bell, and exec/IT see everything, automatically.

**Active channels (SMS/email/push) differ by tier** — this is the actual behavioral
difference between "quiet" and "escalated", not bell visibility:
- Warning → recipients = manager only.
- Red-flag (however reached — instant 7°C+ or the 2-hour prolonged-warning escalation) →
  recipients = manager + DM.
- exec/IT are never in the active-channel recipient list for either tier — same as
  `no-clockin-cron`, which never separately SMS'd/emailed exec/IT either; they're covered by
  bell visibility only. **Confirm before implementation if this is wrong** — easy to add a
  direct channel to exec/IT, just wasn't asked for.

Recipients resolved the same way `no-clockin-lib/run.mjs`'s `contactsFor`-style lookup
already does (by `store_pc`/`district` against the `users` table), via the same
`sendSms`/`sendEmail`/`sendPush` helpers (`_shared/channels.mjs`) — so this automatically
picks up whoever the *current* correct manager is, including once the in-progress
manager-sync work (separately, not yet deployed) resolves Bustleton's own manager transition.

## State — blob `pcg_shelly_temp_state_v1`

Keyed by `deviceId|sensorId`:

```json
{ "70af09e522d0|200": { "overSince": "2026-09-23T18:00:00Z", "warningNotified": true } }
```

- `overSince: null` means currently at or below 5°C (no active episode).
- No ticket id stored here — "is there an open ticket for this sensor" is checked live
  against `maint_tickets` (via a `meta` tag: `{ source: 'shelly-temp-auto', deviceId,
  sensorId }`), not cached, so a manually-edited/reopened ticket is always the source of truth.
- Stored with the standard `{ savedAt, data }` wrapper.

## Testing

Pure logic in `src/shelly-temp.mjs`: `advanceTempState({ tempC, prevState, nowMs })`. Unit
tests cover: at/under 5°C fully resets; one over-5°C reading alone doesn't warn (needs the
30-min sustain); 30+ min sustained between 5-7°C warns exactly once, not again on the next
check; a reading over 7°C tickets immediately even with no prior warning at all (straight
jump); once ticketed, further over-threshold checks don't re-fire `shouldTicket`; still
between 5-7°C for 2+ hours tickets via `reason: 'prolonged-warning'` even though it never
crossed 7°C; a straight jump to red-flag that skipped the Warning stage entirely still sets
`warningNotified: true`, so a later dip back into the 5-7°C band (still no full reset) never
fires a redundant Warning after the ticket's already out; an `unknown` (null) reading leaves
`overSince`/`warningNotified` completely
unchanged AND does not count toward either the 30-min or 2-hour elapsed clocks; and a full
reset (drop to ≤5°C) then a fresh climb re-triggers both a new Warning and, if it goes far
enough, a new ticket — a second full episode, not suppressed by the first one's history.
Delivery-day suppression is tested separately (it's a skip decision made before
`advanceTempState` is even called, not a parameter of it): a store with a matching
`date_shipped` today leaves its state completely untouched across a run, whatever it was
going in.

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
