# Notification System Revamp — Design

## Problem

Today "who gets notified about X" is handled two incompatible ways:

1. **Per-feature email lists** — Admin · Notifications is a row of pill-tabs (Project, Ticket, Car, Food License, System Health, Minor Timecard, Weekly Hours + Schedule, …), each backed by its own `ManualNotifyListPanel` + its own blob key. Every new notification category adds another pill. This doesn't scale — it was already the stated trigger for this project ("we are going to keep adding more notifications... more tabs are going to be added in the future").
2. **The in-app feed** — a bell icon / dropdown backed by a single shared Netlify Blob (`pcg_notifications_v1`), written by 4 crons (`pos-negative-cron.mjs`, `labor-cron.mjs`'s manager-sync, `incident-report-drive.mjs`, `shelly-temp-lib/run.mjs`) plus 3 client-side call sites (Projects deadlines/overdue, chat mentions). It has **no real per-user read state** — `read` is a flat boolean on a shared, role-filtered list capped at 500 entries. Two people looking at the same notification affect each other's read state.

A Postgres `notifications` table already exists in `db/schema.ts` but has **zero real usage** — no inserts anywhere except a delete-cascade `NULL`-out in `users.mjs`, no reads anywhere. It's dead weight, not a working foundation.

External, non-Portal-user recipients (vendors/consultants like `Bill@Raogroupinc.com`, `Sam@rgi.life`) are mixed into the per-feature email lists today, with no account to attach a preference to.

## Goals

- Stop the pill-tab row from growing forever — new notification types should never require new UI chrome.
- Give every Portal user real, individual control over what they receive (per-type toggle, with a "use my role's defaults" option), surfaced from their own Edit User page.
- Give the in-app feed real per-user read/unread state and remove the 500-entry/shared-list limitation.
- Keep a clear home for non-Portal-user (external) recipients, separate from internal per-user preferences.
- Redesign the in-app feed's own UI to be cleaner: short plain-language item copy, zero-count filters hidden on the compact view, the full category filter row moved to a separate "View All" page.
- Rename the current Admin · Notifications area to **Notification Preferences**, repurposed to host the new Notification Types registry + External Recipients screen (not just relabeled — see Scope below).

## Non-Goals

- Not migrating every existing per-feature list in one shot. Each of Project/Ticket/Car/Food License/System Health/Minor Timecard/Weekly Hours + Schedule moves onto the new model incrementally (own task, own review) — this spec defines the target shape, not a big-bang cutover.
- Not changing how Web Push (`push.mjs`, `pcg_push_subscriptions_v1`) works — it's already independent of the in-app feed/notifications table and stays that way.
- Not reconciling "did this get read" against external recipients — externals are email-only, by definition they have no feed to mark read.

## Data Model (Neon Postgres — same database every other table already lives in)

### `notification_types` (new) — the registry
| column | type | notes |
|---|---|---|
| `key` | text PK | stable slug, e.g. `weekly_hours_schedule` |
| `label` | text | "Weekly Hours + Schedule" |
| `category` | text | groups rows in the registry UI + feed filter pills (Projects/Operations/System/Reports/…) |
| `description` | text | plain-language, shown in the registry AND as the per-user toggle's helper text |
| `icon` | text | maps to an existing `ICONS.xxx` key — no new emoji |
| `default_enabled` | boolean | whether a role gets this by default before any override |
| `eligible_roles` | text[] | which `userType`s can ever receive this (mirrors today's per-feature role gating) |
| `active` | boolean | soft-disable a type without deleting history |

### `notifications` (repurpose the existing dead table)
One row per **event**, not per recipient.
| column | type | notes |
|---|---|---|
| `id` | serial PK | existing |
| `type` → rename conceptually to `type_key` | text | FK to `notification_types.key` |
| `title` | text | existing column, reused |
| `body` | text | existing column, reused |
| `metadata` | jsonb | existing column, reused — link/action target, store/district scope used at fan-out time |
| `created_at` | timestamp | existing |
- Drop: `recipient_id`, `channel`, `status` (superseded by `notification_recipients` below).

### `notification_recipients` (new) — per-user delivery + read state
| column | type | notes |
|---|---|---|
| `id` | serial PK | |
| `notification_id` | integer FK → `notifications.id` | |
| `user_id` | integer FK → `users.id` | |
| `read` | boolean default false | **real per-user state**, fixes today's shared-boolean bug |
| `read_at` | timestamp nullable | |
- Index on `(user_id, read, created_at)` for the feed query and unread badge count.

### `user_notification_preferences` (new) — overrides only
| column | type | notes |
|---|---|---|
| `user_id` | integer FK | |
| `type_key` | text FK → `notification_types.key` | |
| `enabled` | boolean | explicit override; absence of a row = inherit role/type default |
| `use_role_profile` | boolean | mockup's toggle — when true, ignore any override rows for this user entirely |
- PK `(user_id, type_key)`. Table stays small — most users never touch most types.

### `notification_external_recipients` (new) — non-Portal-user emails
| column | type | notes |
|---|---|---|
| `id` | serial PK | |
| `type_key` | text FK → `notification_types.key` | |
| `email` | text | |
| `added_by` | text | username, audit trail |
| `created_at` | timestamp | |
- Email-only delivery. Never produces a `notification_recipients` row (no account to attach one to).

## Write Path (replaces today's blob-append pattern)

A new shared helper, `createNotification({ typeKey, title, body, metadata, audienceFilter })`:
1. Inserts one `notifications` row.
2. Resolves the real audience **at write time** (not deferred to client-side filtering like today): queries `users` for everyone whose `userType` is in the type's `eligible_roles`, applies `audienceFilter` (e.g. "only this store's manager + DM" — the same scoping logic `filterNotifsByRole`/per-feature cron code already does today, ported into this one place), then applies `user_notification_preferences` (explicit override, else type `default_enabled`).
3. Inserts one `notification_recipients` row per resolved user.
4. If `notification_external_recipients` has rows for this type, sends them email (reuses existing `sendReportEmail`/`notify.js`/`email-send.mjs` infra — no new email-sending code).

Existing writers to migrate onto this helper (own task each, not this spec's job to do all at once):
`pos-negative-cron.mjs`, `labor-cron.mjs` (manager-sync), `incident-report-drive.mjs`, `shelly-temp-lib/run.mjs`, plus the 3 client-side `cloudSave('pcg_notifications_v1', …)` call sites in `app.jsx` (Projects deadline/overdue, chat mentions).

## Read Path (frontend)

- Bell badge / dropdown: `SELECT notifications.*, notification_recipients.read FROM notification_recipients JOIN notifications ... WHERE notification_recipients.user_id = :me ORDER BY created_at DESC`. Real per-user unread count — no more client-side `filterNotifsByRole` reconstruction of "is this mine."
- Mark read: `UPDATE notification_recipients SET read = true, read_at = now() WHERE notification_id = :id AND user_id = :me`.
- No 500-entry cap needed (indexed, per-user query, not a flat capped array) — paginate instead.

## UI

### 1. In-app feed (bell icon) — compact view
Keep the existing visual language (banner-style featured item, "Recent Notifications" list, `New` badge, overflow menu) — confirmed this is preferred over a plainer redesign. One change from today: item body copy is short/plain-language ("08/02–08/08 report sent — one Timecard file and one Schedule file per store"), not a technical rule description. No category filter row here.

### 2. "View All" — full list page
New page. Category filter pills live here (`All / Tasks / Projects / Access / Orion / Vendors / Sensors / System & Logs / …`), sourced from `notification_types.category`, zero-count categories still shown here (this is the "browse everything" view, unlike the compact one).

### 3. Admin · **Notification Preferences** (renamed from "Notifications")
Two sub-areas:
- **Notification Types** — the registry (second mockup): list + "+ Add Notification Type", each row's category/description/active toggle editable.
- **External Recipients** — master/detail replacement for today's pill-tab row: notification types listed down the left (grouped by category, scrolls indefinitely), selected type's external email list + add/remove on the right.

Existing per-feature lists (Project, Ticket, Car, Food License, System Health, Minor Timecard, Weekly Hours + Schedule) migrate into this screen one at a time; until migrated, a given list keeps using its current `ManualNotifyListPanel` + blob key unchanged.

### 4. Edit User → Notifications tab (per-user preferences)
Per the mockup: categories (Projects/Operations/Reports/System) each with a toggle + expandable per-type checklist, and a top-level "Use Role Profile" switch. Writes to `user_notification_preferences`.

## Rollout Phasing (for the implementation plan, not solved here)

1. Postgres migration: create the 3 new tables, repurpose `notifications`, write `createNotification()` helper + the per-user read query. No UI changes yet — prove the data layer with one real writer (pick the lowest-risk existing one).
2. Notification Types registry UI (Admin), seeded with today's known types.
3. Per-user Notification Preferences UI (Edit User tab) + enforcement in `createNotification()`.
4. External Recipients screen + migrate one existing pill-tab list onto it as a pilot.
5. Feed UI redesign (compact view copy/layout cleanup + new "View All" page).
6. Migrate remaining writers (`pos-negative-cron.mjs`, `labor-cron.mjs` manager-sync, `incident-report-drive.mjs`, `shelly-temp-lib/run.mjs`, the 3 client-side sites) one at a time, retiring `pcg_notifications_v1` once all are moved.

## Open Questions / Risks (flagged, not blockers)

- Audience scoping logic (`filterNotifsByRole` and whatever each cron does today for store/district targeting) needs to be read carefully per writer during migration — this spec assumes it can be ported into `audienceFilter`, not that it's trivial for every existing writer.
- `notification_recipients` grows one row per (notification × audience size) — fine at this org's scale (45 stores, dozens of staff), but worth a retention/cleanup policy (e.g. prune read notifications after N days) so the table doesn't grow unbounded forever.
