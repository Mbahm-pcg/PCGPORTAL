# Notification System Revamp — Phase 1: Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new Postgres-backed notification data layer (3 new tables + repurposed `notifications` table + a shared `createNotification()`/read helper module) and prove it end-to-end by migrating exactly one existing writer (`shelly-temp-lib/run.mjs`'s bell notifications) onto it, with zero behavior change for end users.

**Architecture:** Per-event rows in `notifications`, fanned out at write time into one `notification_recipients` row per eligible user (real per-user `read` state, replacing today's shared-blob boolean). Audience resolution in this phase exactly replicates today's client-side `filterNotifsByRole` logic (app.jsx:29096) server-side — no preference/registry enforcement yet (that's Phases 2-3, separate plans). `notification_types`, `user_notification_preferences`, and `notification_external_recipients` tables are created now (so later phases don't need another migration) but are not populated or read by this phase's code.

**Tech Stack:** Netlify Functions (`.mjs`), Neon Postgres via `sql()` from `netlify/functions/_shared/db.mjs` (postgres.js tagged-template client), existing `db-migrate.mjs` manual-trigger migration pattern (raw SQL, `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, idempotent).

**Spec:** `docs/superpowers/specs/2026-10-08-notification-system-revamp-design.md`

## Global Constraints

- Migrations go in `netlify/functions/db-migrate.mjs`, appended after the existing statements, using the same idempotent raw-SQL style already used there (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) — never a bare destructive `DROP TABLE`.
- `notifications.type` stays a plain TEXT column with NO foreign key to `notification_types.key` in this phase — enforcing that FK now would block any event whose type isn't pre-registered, and the registry doesn't exist yet functionally until Phase 2. `user_notification_preferences.type_key` and `notification_external_recipients.type_key` DO get a real FK to `notification_types.key` since those are human-curated via an admin UI in later phases (a value must exist in the registry before someone can pick it from a dropdown).
- `createNotification()` in this phase must produce the exact same audience as today's `filterNotifsByRole(notifs, user)` (app.jsx:29096) for the `temp_warning`/`temp_alert` types it's used for — this is an infrastructure swap, not a behavior change. Exec/IT/office_staff always see it; DM sees it only if `district` matches theirs (or the notification has no district); Manager sees it only if `storePC` matches theirs (or no storePC); no other role.
- No frontend changes in this phase. The existing bell/dropdown UI keeps reading `pcg_notifications_v1` exactly as it does today — it will simply stop gaining `temp_warning`/`temp_alert` entries after Task 3 ships (acceptable, flagged in Task 3's step 5; a later phase migrates the frontend reader itself).

---

### Task 1: Postgres migration — 3 new tables + repurpose `notifications`

**Files:**
- Modify: `netlify/functions/db-migrate.mjs` (append at the end, before the final `return`)

**Interfaces:**
- Produces: tables `notification_types(key, label, category, description, icon, default_enabled, eligible_roles, active, created_at)`, `notification_recipients(id, notification_id, user_id, read, read_at)`, `user_notification_preferences(user_id, type_key, enabled, use_role_profile)`, `notification_external_recipients(id, type_key, email, added_by, created_at)`; `notifications` loses `recipient_id`/`channel`/`status`, keeps `id, type, title, body, metadata, created_at`.

- [ ] **Step 1: Add the migration SQL**

Open `netlify/functions/db-migrate.mjs`. Immediately before the final `return new Response(...)` statement, insert:

```js
  // ── Notification system revamp (2026-10-08) ──────────────────────────────
  // `notifications` existed but was never actually used (zero inserts anywhere
  // except a delete-cascade NULL-out in users.mjs) — repurposing it as one row
  // per notification EVENT, fanned out via notification_recipients below for
  // real per-user read state (today's in-app feed has none — it's a shared
  // boolean on a blob-backed list).
  await db`ALTER TABLE notifications DROP COLUMN IF EXISTS recipient_id`;
  await db`ALTER TABLE notifications DROP COLUMN IF EXISTS channel`;
  await db`ALTER TABLE notifications DROP COLUMN IF EXISTS status`;
  await db`CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC)`;

  // The registry (Admin · Notification Preferences · Notification Types, Phase 2).
  // No rows seeded yet — Phase 1's one migrated writer (shelly-temp) doesn't
  // consult this table; it's created now so Phase 2 doesn't need another migration.
  await db`
    CREATE TABLE IF NOT EXISTS notification_types (
      key              TEXT PRIMARY KEY,
      label            TEXT NOT NULL,
      category         TEXT NOT NULL,
      description      TEXT,
      icon             TEXT,
      default_enabled  BOOLEAN NOT NULL DEFAULT true,
      eligible_roles   TEXT[] NOT NULL DEFAULT ARRAY['executive','it']::TEXT[],
      active           BOOLEAN NOT NULL DEFAULT true,
      created_at       TIMESTAMPTZ DEFAULT now()
    )
  `;

  // Per-user delivery + READ STATE — the actual fix for today's shared-boolean bug.
  await db`
    CREATE TABLE IF NOT EXISTS notification_recipients (
      id               SERIAL PRIMARY KEY,
      notification_id  INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read             BOOLEAN NOT NULL DEFAULT false,
      read_at          TIMESTAMPTZ
    )
  `;
  await db`CREATE INDEX IF NOT EXISTS idx_notif_recipients_user ON notification_recipients(user_id, read, notification_id)`;

  // Per-user overrides only (Phase 3) — absence of a row means "inherit the
  // type's default_enabled / role eligibility." Real FK to notification_types
  // since a human must pick an existing type from a dropdown to create a row here.
  await db`
    CREATE TABLE IF NOT EXISTS user_notification_preferences (
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type_key          TEXT NOT NULL REFERENCES notification_types(key) ON DELETE CASCADE,
      enabled           BOOLEAN,
      use_role_profile  BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, type_key)
    )
  `;

  // Non-Portal-user email recipients (Phase 4 — replaces the growing per-feature
  // pill-tab lists). Email-only; never produces a notification_recipients row.
  await db`
    CREATE TABLE IF NOT EXISTS notification_external_recipients (
      id          SERIAL PRIMARY KEY,
      type_key    TEXT NOT NULL REFERENCES notification_types(key) ON DELETE CASCADE,
      email       TEXT NOT NULL,
      added_by    TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    )
  `;
```

- [ ] **Step 2: Deploy and trigger the migration**

```bash
npx netlify deploy --prod
```

Then, from the browser console while logged in (any exec/IT session — `db-migrate.mjs` has no auth check of its own, same as today; do not change that in this task):

```js
fetch('/.netlify/functions/db-migrate', { method: 'POST' }).then(r => r.json()).then(console.log);
```

Expected: `{ ok: true, message: 'Migration complete' }`.

- [ ] **Step 3: Verify the schema directly**

Using the Netlify/Neon dashboard's SQL console (or `psql` against `NEON_DATABASE_URL`), run:

```sql
\d notifications
\d notification_types
\d notification_recipients
\d user_notification_preferences
\d notification_external_recipients
```

Expected: `notifications` has exactly `id, type, title, body, metadata, created_at` (no `recipient_id`/`channel`/`status`); the four new tables exist with the columns listed above.

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/db-migrate.mjs
git commit -m "feat(notifications): add Phase 1 schema — repurpose notifications table, add recipients/types/preferences/external tables"
```

---

### Task 2: Shared `notification-lib.mjs` — write + read helpers

**Files:**
- Create: `netlify/functions/notification-lib.mjs`

**Interfaces:**
- Consumes: a postgres.js `db` instance (from `sql()` in `./_shared/db.mjs`), already instantiated by the caller.
- Produces: `createNotification(db, { typeKey, title, body, metadata, storePC, district })` → `Promise<{ notificationId, recipientCount }>`; `getUnreadCountForUser(db, userId)` → `Promise<number>`; `getFeedForUser(db, userId, limit)` → `Promise<Array<{id, type, title, body, metadata, created_at, read, read_at}>>`; `markNotificationRead(db, userId, notificationId)` → `Promise<void>`. These exact names/signatures are what Task 3 (and every later migration task) imports.

- [ ] **Step 1: Write the module**

```js
// notification-lib.mjs — shared write/read helpers for the Postgres-backed
// notification system (Phase 1 of the notification revamp, see
// docs/superpowers/specs/2026-10-08-notification-system-revamp-design.md).
//
// createNotification()'s audience resolution in this phase is a direct port
// of app.jsx's filterNotifsByRole (line ~29096) — exec/IT/office_staff always
// see everything; DM only if district matches (or none given); manager only
// if storePC matches (or none given); no other role. This is deliberate: a
// 1:1 behavior match for the one writer migrated in this phase (shelly-temp),
// NOT yet the full notification_types/user_notification_preferences-driven
// resolution — that lands in Phase 3 once the registry (Phase 2) and
// per-user preferences UI exist to actually populate those tables.
const ADMIN_ONLY_NOTIF_TYPES = new Set(['manager_change_pending', 'incident_report_drive_backup_failed']);

export async function createNotification(db, { typeKey, title, body, metadata = {}, storePC = null, district = null }) {
  const [row] = await db`
    INSERT INTO notifications (type, title, body, metadata, created_at)
    VALUES (${typeKey}, ${title}, ${body}, ${JSON.stringify({ ...metadata, storePC, district })}::jsonb, now())
    RETURNING id
  `;
  const notificationId = row.id;

  const users = await db`SELECT id, user_type, district, store_pc FROM users WHERE active = true`;
  const audience = users.filter(u => {
    if (u.user_type === 'executive' || u.user_type === 'it' || u.user_type === 'office_staff') return true;
    if (ADMIN_ONLY_NOTIF_TYPES.has(typeKey)) return false;
    if (u.user_type === 'dm') return !district || Number(district) === Number(u.district);
    if (u.user_type === 'manager') return !storePC || String(storePC) === String(u.store_pc);
    return false;
  });

  for (const u of audience) {
    await db`INSERT INTO notification_recipients (notification_id, user_id, read) VALUES (${notificationId}, ${u.id}, false)`;
  }
  return { notificationId, recipientCount: audience.length };
}

export async function getUnreadCountForUser(db, userId) {
  const [row] = await db`
    SELECT COUNT(*)::int AS count FROM notification_recipients WHERE user_id = ${userId} AND read = false
  `;
  return row.count;
}

export async function getFeedForUser(db, userId, limit = 50) {
  return await db`
    SELECT n.id, n.type, n.title, n.body, n.metadata, n.created_at, r.read, r.read_at
    FROM notification_recipients r
    JOIN notifications n ON n.id = r.notification_id
    WHERE r.user_id = ${userId}
    ORDER BY n.created_at DESC
    LIMIT ${limit}
  `;
}

export async function markNotificationRead(db, userId, notificationId) {
  await db`UPDATE notification_recipients SET read = true, read_at = now() WHERE user_id = ${userId} AND notification_id = ${notificationId}`;
}
```

- [ ] **Step 2: Syntax-check**

```bash
node --check netlify/functions/notification-lib.mjs
```

Expected: no output (success).

- [ ] **Step 3: Write a throwaway manual-trigger smoke-test endpoint**

This project has no local `.env`/dotenv convention (`package.json`'s scripts are build-only — `NEON_DATABASE_URL` and friends only resolve inside a deployed/linked Netlify Function, same as every other backend file touched this session). So the smoke test is a tiny temporary Netlify Function, deployed and hit via an authenticated browser fetch — same pattern already used repeatedly for manual-trigger testing in this app (e.g. `weekly-hours-schedule-report-manual-background.mjs`).

Create `netlify/functions/notification-lib-smoke-test.mjs` (temporary — deleted in Step 5, never left in the codebase):

```js
// notification-lib-smoke-test.mjs — TEMPORARY, exec/IT-only. Deleted at the
// end of Task 2 once createNotification/getFeedForUser/markNotificationRead
// are confirmed working against the real database. Do not leave this in the
// codebase past Phase 1.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { createNotification, getUnreadCountForUser, getFeedForUser, markNotificationRead } from './notification-lib.mjs';

export default async (request) => {
  const db = sql();
  const authedUser = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authedUser || (authedUser.userType !== 'executive' && authedUser.userType !== 'it')) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  const [someManager] = await db`SELECT id, store_pc FROM users WHERE user_type = 'manager' AND active = true LIMIT 1`;
  if (!someManager) return new Response(JSON.stringify({ error: 'No active manager in DB to test against' }), { status: 400 });

  const before = await getUnreadCountForUser(db, someManager.id);
  const { notificationId, recipientCount } = await createNotification(db, {
    typeKey: 'test_smoke', title: 'Smoke test', body: 'Phase 1 smoke test — safe to ignore/delete.',
    storePC: someManager.store_pc,
  });
  const after = await getUnreadCountForUser(db, someManager.id);
  const feed = await getFeedForUser(db, someManager.id, 5);
  const feedIncludesIt = feed.some(n => n.id === notificationId);
  await markNotificationRead(db, someManager.id, notificationId);
  const afterRead = await getUnreadCountForUser(db, someManager.id);
  await db`DELETE FROM notifications WHERE id = ${notificationId}`; // cleanup — this was test data, not real

  return new Response(JSON.stringify({
    recipientCount, before, afterCreate: after, feedIncludesIt, afterMarkRead: afterRead,
    expectations: { recipientCountAtLeast1: recipientCount >= 1, afterCreateIsBeforePlus1: after === before + 1, feedIncludesIt: true, afterMarkReadEqualsBefore: afterRead === before },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
```

Deploy (`npx netlify deploy --prod`), then from the browser console while logged in as exec/IT:

```js
const t = sessionStorage.getItem('pcg_portal_token');
fetch('/.netlify/functions/notification-lib-smoke-test', { headers: t ? { Authorization: 'Bearer ' + t } : {} })
  .then(r => r.json()).then(console.log);
```

Expected: every key under `expectations` is `true`.

- [ ] **Step 4: Delete the smoke-test function** (never leave it deployed)

```bash
rm netlify/functions/notification-lib-smoke-test.mjs
npx netlify deploy --prod
```

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/notification-lib.mjs
git commit -m "feat(notifications): add createNotification/getFeedForUser/markNotificationRead helpers"
```

---

### Task 3: Migrate the pilot writer — `shelly-temp-lib/run.mjs`

**Files:**
- Modify: `netlify/functions/shelly-temp-lib/run.mjs:115-122` (the `writeBellNotification` function) and its two call sites at lines 213 and 226.

**Interfaces:**
- Consumes: `createNotification` from `../notification-lib.mjs` (Task 2).

- [ ] **Step 1: Read the current function and call sites**

Current code (for reference — do not skip reading the real file, line numbers may have shifted since this plan was written):

```js
async function writeBellNotification(bs, { type, message, storePC, district }) {
  try {
    const existing = await bs.get('pcg_notifications_v1', { type: 'json' });
    const list = Array.isArray(existing) ? existing : (existing?.data || []);
    const entry = { id: `shellytemp_${Date.now()}_${Math.floor(Math.random() * 1000)}`, type, message, storePC, district, read: false, createdAt: new Date().toISOString() };
    await bs.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...list].slice(0, 500) });
  } catch (e) { console.warn('[shelly-temp] bell notification write failed:', e.message); }
}
```

Call sites:
```js
          await writeBellNotification(bs, { type: 'temp_warning', message: text, storePC: storePc, district: store?.district });
```
```js
          await writeBellNotification(bs, { type: 'temp_alert', message: text, storePC: storePc, district: store?.district });
```

- [ ] **Step 2: Replace the function**

```js
async function writeBellNotification(db, { type, title, message, storePC, district }) {
  try {
    await createNotification(db, { typeKey: type, title, body: message, storePC, district });
  } catch (e) { console.warn('[shelly-temp] bell notification write failed:', e.message); }
}
```

- [ ] **Step 3: Update the import**

Add to the top of the file (near the existing `import { sql } from '../_shared/db.mjs';`):

```js
import { createNotification } from '../notification-lib.mjs';
```

- [ ] **Step 4: Update the two call sites to pass `db` (already in scope) instead of `bs`, and add a `title`**

```js
          await writeBellNotification(db, { type: 'temp_warning', title: `Temp warning — ${storeName}`, message: text, storePC: storePc, district: store?.district });
```
```js
          await writeBellNotification(db, { type: 'temp_alert', title: `HIGH: Temp alert — ${storeName}`, message: text, storePC: storePc, district: store?.district });
```

(`db` is already declared at line ~144 in `runShellyTempCheck` via `const db = sql();`, in scope at both call sites — confirm this is still true in the actual file before editing; if `db`'s declaration moved, use whatever the current local variable name is.)

- [ ] **Step 5: Note the frontend gap (do not fix in this task)**

The bell/dropdown UI (`app.jsx` ~54350-54398) reads `pcg_notifications_v1` and will no longer receive `temp_warning`/`temp_alert` entries after this change ships — those two notification types move to the new Postgres path, which has no frontend reader yet (that's a later phase: give the bell UI a second data source, or migrate it fully once more writers move over). Flag this clearly in the task's completion note so it isn't mistaken for a bug when temp alerts stop appearing in the old bell dropdown — SMS/email delivery for these alerts (the `deliver()` calls) are completely unaffected and keep working exactly as today.

- [ ] **Step 6: Syntax-check**

```bash
node --check netlify/functions/shelly-temp-lib/run.mjs
```

- [ ] **Step 7: Manual verification against a dry run**

```bash
npx netlify deploy --prod
```

Then trigger a dry run (check the file's exports/existing manual-trigger function for the real invocation path — likely a sibling `shelly-temp-cron.mjs` or similar with a `dryRun` flag) and confirm in the logs that `runShellyTempCheck` still completes without throwing, and that for any `shouldWarn`/`shouldTicket` result the new `createNotification` path runs without error (check Netlify function logs for `[shelly-temp] bell notification write failed` — its ABSENCE is the success signal, same as today's error-swallowing pattern).

If no real over-temp condition is active to trigger a true end-to-end test, additionally re-run Task 2's smoke-test pattern but with `typeKey: 'temp_warning'` to confirm the exact types this task introduces insert and resolve audience correctly.

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/shelly-temp-lib/run.mjs
git commit -m "feat(notifications): migrate shelly-temp bell notifications onto the new Postgres data layer (Phase 1 pilot)"
```

---

## Completion

Phase 1 is done when all three tasks are committed, the schema is live in production, and the pilot writer (`shelly-temp-lib/run.mjs`) is confirmed working against the new tables with no errors in function logs. Phases 2-6 (Notification Types registry UI, per-user Preferences UI + real enforcement, External Recipients screen, feed UI redesign, remaining writer migrations) each get their own plan once this one is reviewed and merged — per the spec's phasing, this is deliberately not attempted in one shot.
