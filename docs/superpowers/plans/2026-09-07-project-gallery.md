# Project Photo Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new "Project Gallery" tab (construction/executive/IT only): pick a project, optionally share GPS, take a capped number of site photos with the phone's native camera, draw persistent/editable line+circle annotations on any photo, and (exec/IT) idempotently import Hatboro's existing Daily Report photos into the same system.

**Architecture:** New Postgres table `project_photos` (self-created, same pattern as `business_expenses`) + new Netlify function `netlify/functions/project-photos.mjs` (create/list/saveAnnotations/delete/migrateFromDailyReports, role-gated to construction/executive/it) + a new `ProjectGalleryTab` component in `app.jsx` (3-step flow: setup → capture → gallery) + a new `ProjectPhotoAnnotator` component (SVG-overlay shape editor).

**Tech Stack:** Neon Postgres (`@neondatabase/serverless`), Netlify Blobs (`@netlify/blobs`), `auth-lib/require-user.js`, React 18, Pointer Events (no new deps).

**Spec:** `docs/superpowers/specs/2026-09-07-project-gallery-design.md`

## Global Constraints

- Bump `APP_VERSION` in `app.jsx` (search `const APP_VERSION =`) after each task that touches `app.jsx`.
- Never edit `app.jsx` with PowerShell/regex tools — Edit tool only.
- Run `npm run build` after every `app.jsx`/`src/*.jsx` change; commit `app.jsx` + `app.js` together.
- Every `project-photos.mjs` action requires `requireActiveUser` AND `claims.userType` to be one of `construction`/`executive`/`it` (403 otherwise) — this is stricter than the Expenses feature and must not be relaxed to "any authenticated user".
- `migrateFromDailyReports` additionally requires `executive`/`it` specifically (construction may not trigger it).
- Annotation shapes are ALWAYS stored as width/height-relative fractions (0–1 range), never raw pixel coordinates. A circle is stored/drawn as an ellipse (`cx,cy,rx,ry`, cx/rx as width-fractions, cy/ry as height-fractions) — never a single radius — to avoid an aspect-ratio rendering bug on non-square photos.
- `migrateFromDailyReports` must be idempotent via a `source_ref` unique partial index — re-running it for the same project must never create duplicate rows.
- New tab icon must be a real `ICONS` SVG entry in `src/icons.jsx`, never emoji.
- This tab and its backend are reachable ONLY by `construction`/`executive`/`it` — no other role, including `office_staff`/`dm`/`manager`.

---

### Task 1: Pure project-photos helpers + tests

**Files:**
- Create: `netlify/functions/project-photos-lib/shapes.mjs`
- Create: `netlify/functions/project-photos-lib/shapes.test.mjs`
- Modify: `package.json` (test script glob)

**Interfaces:**
- Produces (consumed by Task 2): `PROJECT_GALLERY_ROLES` (array `['construction','executive','it']`), `canAccessProjectGallery(userType): boolean`, `canMigrate(userType): boolean` (true only for `executive`/`it`), `computeSourceRef(reportId, workLogIdx, photoIdx): string` (format `` `dr_${reportId}_${workLogIdx}_${photoIdx}` ``), `SHAPE_COLORS` (array of 4 hex strings), `isValidShape(shape): boolean`, `sanitizeAnnotations(rawArray): array` (filters to only valid shapes, each rebuilt with only its known fields — drops any extra/tampered keys).

- [ ] **Step 1: Write the failing tests**

Create `netlify/functions/project-photos-lib/shapes.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_GALLERY_ROLES,
  canAccessProjectGallery,
  canMigrate,
  computeSourceRef,
  SHAPE_COLORS,
  isValidShape,
  sanitizeAnnotations,
} from './shapes.mjs';

test('PROJECT_GALLERY_ROLES: exact 3-role list', () => {
  assert.deepEqual(PROJECT_GALLERY_ROLES, ['construction', 'executive', 'it']);
});

test('canAccessProjectGallery: true for construction/executive/it', () => {
  assert.equal(canAccessProjectGallery('construction'), true);
  assert.equal(canAccessProjectGallery('executive'), true);
  assert.equal(canAccessProjectGallery('it'), true);
});

test('canAccessProjectGallery: false for office_staff/dm/manager/vendor/maintenance', () => {
  assert.equal(canAccessProjectGallery('office_staff'), false);
  assert.equal(canAccessProjectGallery('dm'), false);
  assert.equal(canAccessProjectGallery('manager'), false);
  assert.equal(canAccessProjectGallery('vendor'), false);
  assert.equal(canAccessProjectGallery('maintenance'), false);
});

test('canMigrate: true only for executive/it, false for construction', () => {
  assert.equal(canMigrate('executive'), true);
  assert.equal(canMigrate('it'), true);
  assert.equal(canMigrate('construction'), false);
});

test('computeSourceRef: exact stable format', () => {
  assert.equal(computeSourceRef(1725, 0, 2), 'dr_1725_0_2');
  assert.equal(computeSourceRef('abc', 3, 0), 'dr_abc_3_0');
});

test('SHAPE_COLORS: exact fixed 4-color palette', () => {
  assert.deepEqual(SHAPE_COLORS, ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e']);
});

test('isValidShape: a well-formed line is valid', () => {
  assert.equal(isValidShape({ id: 's1', type: 'line', x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9, color: '#ef4444' }), true);
});

test('isValidShape: a well-formed circle (ellipse) is valid', () => {
  assert.equal(isValidShape({ id: 's2', type: 'circle', cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.15, color: '#3b82f6' }), true);
});

test('isValidShape: false for unknown type', () => {
  assert.equal(isValidShape({ id: 's3', type: 'rectangle', x1: 0, y1: 0, x2: 1, y2: 1, color: '#ef4444' }), false);
});

test('isValidShape: false for non-finite coordinates (NaN/Infinity)', () => {
  assert.equal(isValidShape({ id: 's4', type: 'line', x1: NaN, y1: 0.2, x2: 0.8, y2: 0.9, color: '#ef4444' }), false);
  assert.equal(isValidShape({ id: 's5', type: 'line', x1: 0.1, y1: 0.2, x2: Infinity, y2: 0.9, color: '#ef4444' }), false);
});

test('isValidShape: false for a circle with non-positive radius', () => {
  assert.equal(isValidShape({ id: 's6', type: 'circle', cx: 0.5, cy: 0.5, rx: 0, ry: 0.1, color: '#ef4444' }), false);
  assert.equal(isValidShape({ id: 's7', type: 'circle', cx: 0.5, cy: 0.5, rx: 0.1, ry: -0.1, color: '#ef4444' }), false);
});

test('isValidShape: false for a color not in SHAPE_COLORS', () => {
  assert.equal(isValidShape({ id: 's8', type: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#000000' }), false);
});

test('isValidShape: false for missing/non-object input', () => {
  assert.equal(isValidShape(null), false);
  assert.equal(isValidShape(undefined), false);
  assert.equal(isValidShape('not a shape'), false);
});

test('sanitizeAnnotations: drops invalid entries, keeps valid ones', () => {
  const raw = [
    { id: 'a', type: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#ef4444' },
    { id: 'b', type: 'bogus', x1: 0, y1: 0, x2: 1, y2: 1, color: '#ef4444' },
    { id: 'c', type: 'circle', cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1, color: '#22c55e' },
  ];
  const cleaned = sanitizeAnnotations(raw);
  assert.equal(cleaned.length, 2);
  assert.deepEqual(cleaned.map(s => s.id), ['a', 'c']);
});

test('sanitizeAnnotations: strips unknown extra fields from a valid shape', () => {
  const raw = [{ id: 'a', type: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#ef4444', evilPayload: '<script>' }];
  const cleaned = sanitizeAnnotations(raw);
  assert.deepEqual(cleaned, [{ id: 'a', type: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#ef4444' }]);
});

test('sanitizeAnnotations: non-array input returns an empty array', () => {
  assert.deepEqual(sanitizeAnnotations(null), []);
  assert.deepEqual(sanitizeAnnotations('not an array'), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test netlify/functions/project-photos-lib/shapes.test.mjs`
Expected: FAIL — `Cannot find module './shapes.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `netlify/functions/project-photos-lib/shapes.mjs`:

```js
// shapes.mjs — pure helpers for the project-photo-gallery feature. No I/O —
// safe to unit test. Consumed by netlify/functions/project-photos.mjs.

export const PROJECT_GALLERY_ROLES = ['construction', 'executive', 'it'];

export function canAccessProjectGallery(userType) {
  return PROJECT_GALLERY_ROLES.includes(userType);
}

// Migration is exec/IT only — construction can capture/annotate but not
// trigger a bulk import of historical Daily Report photos.
export function canMigrate(userType) {
  return userType === 'executive' || userType === 'it';
}

// Stable, idempotency-key-safe identifier for one Daily Report photo, so
// re-running a migration never creates a duplicate row for the same photo
// (paired with a unique index on source_ref in Postgres).
export function computeSourceRef(reportId, workLogIdx, photoIdx) {
  return `dr_${reportId}_${workLogIdx}_${photoIdx}`;
}

// Fixed annotation palette — red default (measurements/flagged issues want
// high visibility), amber/blue/green as alternates. A color outside this set
// is rejected by isValidShape, not silently allowed through to storage.
export const SHAPE_COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e'];

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Coordinates are fractions of the photo's natural width/height (line) or
// width/height separately (circle's cx/rx vs cy/ry) — see the design spec's
// "Coordinate system" section for why a circle is an ellipse under the hood.
export function isValidShape(shape) {
  if (!shape || typeof shape !== 'object') return false;
  if (!SHAPE_COLORS.includes(shape.color)) return false;
  if (shape.type === 'line') {
    return isFiniteNum(shape.x1) && isFiniteNum(shape.y1) && isFiniteNum(shape.x2) && isFiniteNum(shape.y2);
  }
  if (shape.type === 'circle') {
    return isFiniteNum(shape.cx) && isFiniteNum(shape.cy) && isFiniteNum(shape.rx) && isFiniteNum(shape.ry)
      && shape.rx > 0 && shape.ry > 0;
  }
  return false;
}

// Rebuilds each valid shape from ONLY its known fields (drops anything else
// a tampered/buggy client sent) and drops invalid entries entirely — this is
// what the backend's saveAnnotations action runs before persisting.
export function sanitizeAnnotations(rawArray) {
  if (!Array.isArray(rawArray)) return [];
  return rawArray.filter(isValidShape).map((s) => {
    if (s.type === 'line') return { id: s.id, type: 'line', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, color: s.color };
    return { id: s.id, type: 'circle', cx: s.cx, cy: s.cy, rx: s.rx, ry: s.ry, color: s.color };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test netlify/functions/project-photos-lib/shapes.test.mjs`
Expected: PASS, all 16 tests green.

- [ ] **Step 5: Wire the new test file into `npm test`**

In `package.json`'s `test` script, add `'netlify/functions/project-photos-lib/*.test.mjs'` to the space-separated glob list (same style as the existing entries — one per `-lib` directory, no wildcard `*-lib` pattern exists).

- [ ] **Step 6: Run the full suite to confirm nothing else broke**

Run: `npm test`. On Windows, if it reports 0 tests found (known cmd.exe vs Git-Bash glob-quoting mismatch, not a code issue), expand the globs yourself and pass real paths to `node --test`, e.g. via PowerShell:
```powershell
$files = Get-ChildItem -Recurse -Include *.test.mjs,*.test.js -Path netlify\functions\analyst-lib,src,netlify\functions\deal-lib,netlify\functions\ndcp-lib,netlify\functions\auth-lib,netlify\functions\audit-lib,netlify\functions\tips-lib,netlify\functions\expenses-lib,netlify\functions\project-photos-lib | ForEach-Object { $_.FullName }
node --test $files
```
Expected: all prior tests still pass, plus the new 16, with only the pre-existing unrelated `ndcp-lib/store-map.test.js` failure (46 vs 45 stores) if still present.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/project-photos-lib/shapes.mjs netlify/functions/project-photos-lib/shapes.test.mjs package.json
git commit -m "feat(project-gallery): pure role/shape-validation helpers"
```

---

### Task 2: Backend handler — `netlify/functions/project-photos.mjs`

**Files:**
- Create: `netlify/functions/project-photos.mjs`
- Modify: `db/schema.ts` (documentation-only `pgTable` block, appended after the `businessExpenses` block added for the Expenses feature)

**Interfaces:**
- Consumes: `canAccessProjectGallery, canMigrate, isValidShape, sanitizeAnnotations` from `./project-photos-lib/shapes.mjs` (Task 1). `requireActiveUser(event, db)` from `./auth-lib/require-user.js` (pre-existing — same helper `expenses.mjs`/`system-health.mjs` use, returns `null` or `{ kind:'portal', sub, username, userType, district, name }`).
- Produces (consumed by Task 3/4/5/6 frontend): a single POST endpoint `/.netlify/functions/project-photos` accepting `{ action: 'create'|'list'|'saveAnnotations'|'delete'|'migrateFromDailyReports', ... }`. Every photo object has this exact shape: `{ id, projectId, projectNickname, lat, lng, takenByUserId, takenByName, userType, imageKey, annotations, source, sourceRef, createdAt }`.

- [ ] **Step 1: Write the handler**

Create `netlify/functions/project-photos.mjs`:

```js
// PCG Portal — Project Photo Gallery, backed by Neon Postgres. One row per
// photo; the photo itself is a separate small Netlify Blob referenced by
// image_key (same wrapper shape every other blob in this app uses). See
// docs/superpowers/specs/2026-09-07-project-gallery-design.md.
//
// Access is deliberately narrower than the Expenses feature: every action
// requires construction/executive/it — no other role, even with a valid
// session, may call this endpoint at all.
//
// Actions (POST { action, ... }):
//   create { projectId, projectNickname, lat?, lng?, imageBase64 } → { ok, photo }
//   list   { projectId } → { ok, photos:[…] }
//   saveAnnotations { id, annotations } → { ok, photo }
//   delete { id } → { ok }
//   migrateFromDailyReports { projectId, projectNickname, photos:[{sourceRef,dataUrl,name,timestamp,addedBy}] }
//     → { ok, imported, skipped }  (executive/it only; idempotent per sourceRef)
import { neon } from '@neondatabase/serverless';
import { getStore } from '@netlify/blobs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { canAccessProjectGallery, canMigrate, sanitizeAnnotations } from './project-photos-lib/shapes.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

function blobStore() {
  return getStore({
    name: 'pcg-portal',
    consistency: 'strong',
    siteID: process.env.PCG_SITE_ID,
    token: process.env.PCG_AUTH_TOKEN,
  });
}

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS project_photos (
    id                text PRIMARY KEY,
    project_id        integer NOT NULL,
    project_nickname  text,
    lat               double precision,
    lng               double precision,
    taken_by_user_id  integer NOT NULL,
    taken_by_name     text NOT NULL,
    user_type         text NOT NULL,
    image_key         text NOT NULL,
    annotations       jsonb NOT NULL DEFAULT '[]'::jsonb,
    source            text NOT NULL DEFAULT 'capture',
    source_ref        text,
    created_at        timestamptz DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pphoto_project ON project_photos(project_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_pphoto_source_ref ON project_photos(source_ref) WHERE source_ref IS NOT NULL`;
  _ready = true;
}

function rowToPhoto(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    projectNickname: r.project_nickname,
    lat: r.lat != null ? Number(r.lat) : null,
    lng: r.lng != null ? Number(r.lng) : null,
    takenByUserId: r.taken_by_user_id,
    takenByName: r.taken_by_name,
    userType: r.user_type,
    imageKey: r.image_key,
    annotations: r.annotations || [],
    source: r.source,
    sourceRef: r.source_ref,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

function genId(prefix = 'pphoto') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function saveBlob(id, dataUrl, addedBy) {
  const key = `pcg_project_photo_${id}`;
  await blobStore().setJSON(key, {
    savedAt: new Date().toISOString(),
    data: { base64: dataUrl, addedBy, addedAt: new Date().toISOString() },
  });
  return key;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};
  if (!action) return json(400, { error: 'Missing action' });

  const eventShim = {
    headers: {
      authorization: request.headers.get('authorization') || '',
      cookie: request.headers.get('cookie') || '',
    },
  };

  try {
    const sql = db();
    await ensureTables();

    const claims = await requireActiveUser(eventShim, sql);
    if (!claims) return json(401, { error: 'Sign in required' });
    if (!canAccessProjectGallery(claims.userType)) return json(403, { error: 'Not available for this role' });

    if (action === 'create') {
      const projectId = Number(payload.projectId);
      if (!Number.isFinite(projectId)) return json(400, { error: 'projectId required' });
      if (!payload.imageBase64) return json(400, { error: 'imageBase64 required' });
      const id = genId();
      const submittedByName = claims.name || claims.username;
      const imageKey = await saveBlob(id, payload.imageBase64, submittedByName);
      const lat = Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : null;
      const lng = Number.isFinite(Number(payload.lng)) ? Number(payload.lng) : null;
      const rows = await sql`
        INSERT INTO project_photos (
          id, project_id, project_nickname, lat, lng,
          taken_by_user_id, taken_by_name, user_type, image_key
        ) VALUES (
          ${id}, ${projectId}, ${payload.projectNickname || null}, ${lat}, ${lng},
          ${claims.sub}, ${submittedByName}, ${claims.userType}, ${imageKey}
        ) RETURNING *`;
      return json(200, { ok: true, photo: rowToPhoto(rows[0]) });
    }

    if (action === 'list') {
      const projectId = Number(payload.projectId);
      if (!Number.isFinite(projectId)) return json(400, { error: 'projectId required' });
      const rows = await sql`SELECT * FROM project_photos WHERE project_id = ${projectId} ORDER BY created_at DESC`;
      return json(200, { ok: true, photos: rows.map(rowToPhoto) });
    }

    if (action === 'saveAnnotations') {
      const id = payload.id != null ? String(payload.id) : null;
      if (!id) return json(400, { error: 'id required' });
      const clean = sanitizeAnnotations(payload.annotations);
      const rows = await sql`UPDATE project_photos SET annotations = ${JSON.stringify(clean)}::jsonb WHERE id = ${id} RETURNING *`;
      if (!rows.length) return json(404, { error: 'Not found' });
      return json(200, { ok: true, photo: rowToPhoto(rows[0]) });
    }

    if (action === 'delete') {
      const id = payload.id != null ? String(payload.id) : null;
      if (!id) return json(400, { error: 'id required' });
      const rows = await sql`SELECT * FROM project_photos WHERE id = ${id}`;
      if (!rows.length) return json(404, { error: 'Not found' });
      await blobStore().delete(rows[0].image_key).catch(() => {});
      await sql`DELETE FROM project_photos WHERE id = ${id}`;
      return json(200, { ok: true });
    }

    if (action === 'migrateFromDailyReports') {
      if (!canMigrate(claims.userType)) return json(403, { error: 'Only executive/it can run an import' });
      const projectId = Number(payload.projectId);
      if (!Number.isFinite(projectId)) return json(400, { error: 'projectId required' });
      const photos = Array.isArray(payload.photos) ? payload.photos : [];
      let imported = 0, skipped = 0;
      for (const p of photos) {
        if (!p?.sourceRef || !p?.dataUrl) { skipped++; continue; }
        const existing = await sql`SELECT id FROM project_photos WHERE source_ref = ${p.sourceRef}`;
        if (existing.length) { skipped++; continue; }
        const id = genId();
        const imageKey = await saveBlob(id, p.dataUrl, p.addedBy || 'Daily Report');
        await sql`
          INSERT INTO project_photos (
            id, project_id, project_nickname, taken_by_user_id, taken_by_name,
            user_type, image_key, source, source_ref, created_at
          ) VALUES (
            ${id}, ${projectId}, ${payload.projectNickname || null}, ${claims.sub}, ${p.addedBy || 'Daily Report'},
            ${claims.userType}, ${imageKey}, 'migrated', ${p.sourceRef}, ${p.timestamp || new Date().toISOString()}
          )
          ON CONFLICT (source_ref) DO NOTHING`;
        imported++;
      }
      return json(200, { ok: true, imported, skipped });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('project-photos.mjs error:', err);
    return json(500, { error: err.message });
  }
};
```

- [ ] **Step 2: Add the documentation-only schema block**

In `db/schema.ts`, immediately after the `businessExpenses` block (added by the Expenses feature), add:

```ts
// ── Project Photo Gallery (LIVE) ──────────────────────────────────────────────
// Backs the "Project Gallery" tab (netlify/functions/project-photos.mjs),
// construction/executive/it only. project-photos.mjs self-creates this table
// via CREATE TABLE IF NOT EXISTS; this block documents the schema for
// drizzle/tooling only.
export const projectPhotos = pgTable("project_photos", {
  id: text("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  projectNickname: text("project_nickname"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  takenByUserId: integer("taken_by_user_id").notNull(),
  takenByName: text("taken_by_name").notNull(),
  userType: text("user_type").notNull(),
  imageKey: text("image_key").notNull(),
  annotations: jsonb("annotations").notNull().default([]),
  source: text("source").notNull().default("capture"),
  sourceRef: text("source_ref"),
  createdAt: timestamp("created_at").defaultNow(),
});
```

This introduces `doublePrecision` — check the top of `db/schema.ts` for its existing import line from `drizzle-orm/pg-core` (it currently imports `integer, pgTable, varchar, text, boolean, timestamp, real, jsonb, serial, bigint, primaryKey, numeric`) and add `doublePrecision` to that same import list.

- [ ] **Step 3: Syntax-check the new files**

Run: `node --check netlify/functions/project-photos.mjs` and `node --check netlify/functions/project-photos-lib/shapes.mjs` (if not already checked in Task 1). Expected: no output.

- [ ] **Step 4: Confirm the auth+role gate (deferred live check, documented for later)**

There is no local Netlify dev server in this repo's workflow. After the next preview deploy (happens once the frontend exists enough to exercise, later in this plan), run:
```bash
curl -s -X POST https://<preview-url>/.netlify/functions/project-photos -H 'Content-Type: application/json' -d '{"action":"list","projectId":6}'
```
Expected: `{"error":"Sign in required"}`, HTTP 401 (proves the auth gate). A second, deeper check (role gate) needs a valid session from a non-construction/exec/IT role and can't be done via plain curl without a live token — note in the task report that the role check itself was verified by code review, not by a live 403 test, and that this is an accepted limitation for today's build.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/project-photos.mjs db/schema.ts
git commit -m "feat(project-gallery): backend — create/list/saveAnnotations/delete/migrate, role-gated"
```

---

### Task 3: Icon + tab registration + setup step (GPS + project picker)

**Files:**
- Modify: `src/icons.jsx` (new `projectGallery` icon)
- Modify: `app.jsx` (`computeRoleTabs`'s construction/executive/it branches, main tab-routing block, new `ProjectGalleryTab` component — setup step only)

**Interfaces:**
- Consumes: `ICONS.projectGallery(color)` (this task). `projects` (prop, array of `{id, nickname, address, pc, district, ...}` — already passed into `AdminProjects` at the same call site, app.jsx:49887 as of this plan's writing but grep to confirm) and `dailyReports` (prop, needed later by Task 5/6 but accepted here too so the component signature doesn't change again). `authHeader()` (pre-existing, imported at the top of `app.jsx` from `./src/portal-auth.mjs`).
- Produces (consumed by Task 4/5/6): the `ProjectGalleryTab` component with a `step` state (`'setup' | 'capture' | 'gallery'`, starting at `'setup'`), a `selectedProject` state (the chosen project object or null), and a `getLocation()` function + `shareLoc`/`locDenied` state (the GPS pattern) — later tasks extend this SAME function body in place, they do not create a new component. State prefix `pgal*` is established here (e.g. `pgalStep`, `pgalSelectedProjectId`, `pgalShareLoc`) and must stay consistent in Tasks 4–6.

- [ ] **Step 1: Add the new icon**

In `src/icons.jsx`, inside the `ICONS` object, add a camera-shaped icon:

```js
projectGallery: (c) => <Icon color={c} d={<>
  {React.createElement("path", { d: "M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" })}
  {React.createElement("circle", { cx: "12", cy: "13", r: "4" })}
</>} />,
```

- [ ] **Step 2: Register the tab**

Grep `computeRoleTabs` for the `if (ut === "executive" || ut === "it")` branch and the `if (ut === "construction")` branch (as of this plan's writing, near app.jsx:25347 and app.jsx:25436 respectively — confirm the current lines before editing, since earlier features may have shifted them slightly). Add this entry to BOTH branches' returned arrays (after their existing entries, before the closing `]`):

```js
{ id: "project-gallery", label: "Project Gallery", icon: (c) => ICONS.projectGallery(c) },
```

Do NOT add it to `BASE_TABS`, `office_staff`, `dm`, `manager`, `maintenance`, or `vendor` branches — this tab is deliberately narrower than the Expenses tab.

- [ ] **Step 3: Route the tab**

Grep for the existing `{tab === "projects"  && canViewProjects(user) && <AdminProjects ...>}` line (near app.jsx:49887) and add a new line directly after it:

```jsx
{tab === "project-gallery" && (user?.userType === "construction" || user?.userType === "executive" || user?.userType === "it") && <ProjectGalleryTab user={user} th={th} projects={projects} dailyReports={dailyReports} />}
```

- [ ] **Step 4: Write the `ProjectGalleryTab` component (setup step)**

Add this new top-level function in `app.jsx`, placed near `AdminProjects` (e.g. just before or after it — they're unrelated components, physical proximity is just for readability):

```jsx
function ProjectGalleryTab({ user, th, projects, dailyReports }) {
  const [pgalStep, setPgalStep] = React.useState('setup'); // 'setup' | 'capture' | 'gallery'
  const [pgalSelectedProjectId, setPgalSelectedProjectId] = React.useState('');
  const selectedProject = React.useMemo(
    () => (projects || []).find(p => String(p.id) === String(pgalSelectedProjectId)) || null,
    [projects, pgalSelectedProjectId]
  );

  // Opt-in GPS — a fresh implementation of the exact pattern already proven
  // in OpsTasks (app.jsx, search GEO_OPTS/pcg_share_location): per-device,
  // localStorage-backed, never blocks progress, never throws.
  const pgalGeoRef = React.useRef(null);
  const PGAL_GEO_OPTS = { enableHighAccuracy: false, maximumAge: 60000, timeout: 8000 };
  const [pgalShareLoc, setPgalShareLoc] = React.useState(() => { try { return localStorage.getItem('pcg_share_location') === '1'; } catch { return false; } });
  const [pgalLocDenied, setPgalLocDenied] = React.useState(false);
  const pgalPersistLoc = (on) => { try { localStorage.setItem('pcg_share_location', on ? '1' : '0'); } catch {} };

  React.useEffect(() => {
    if (!navigator.permissions?.query) return;
    let perm;
    navigator.permissions.query({ name: 'geolocation' }).then((p) => {
      perm = p;
      const apply = () => { const denied = p.state === 'denied'; setPgalLocDenied(denied); if (denied) pgalGeoRef.current = null; };
      apply(); p.onchange = apply;
    }).catch(() => {});
    return () => { if (perm) perm.onchange = null; };
  }, []);

  const pgalEnableLocation = () => {
    if (!navigator.geolocation) { setPgalShareLoc(false); pgalPersistLoc(false); return; }
    setPgalShareLoc(true); pgalPersistLoc(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { pgalGeoRef.current = { lat: p.coords.latitude, lng: p.coords.longitude, at: Date.now() }; setPgalLocDenied(false); },
      (err) => { if (err && err.code === 1) { setPgalShareLoc(false); pgalPersistLoc(false); setPgalLocDenied(true); } },
      PGAL_GEO_OPTS
    );
  };
  const pgalDisableLocation = () => { setPgalShareLoc(false); pgalPersistLoc(false); };

  const pgalGetLocation = React.useCallback(() => new Promise((resolve) => {
    if (!pgalShareLoc || !navigator.geolocation) return resolve(null);
    const c = pgalGeoRef.current;
    if (c && Date.now() - c.at < 120000) return resolve({ lat: c.lat, lng: c.lng });
    navigator.geolocation.getCurrentPosition(
      (p) => { pgalGeoRef.current = { lat: p.coords.latitude, lng: p.coords.longitude, at: Date.now() }; resolve({ lat: p.coords.latitude, lng: p.coords.longitude }); },
      () => resolve(null),
      PGAL_GEO_OPTS
    );
  }), [pgalShareLoc]);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {pgalStep === 'setup' && (
        <div style={{ ...card(th), padding: '1.25rem' }}>
          <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '0.95rem', color: th.text, marginBottom: '0.8rem' }}>Start a site visit</div>
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', marginBottom: '0.4rem' }}>Project</div>
            <select value={pgalSelectedProjectId} onChange={e => setPgalSelectedProjectId(e.target.value)} style={{ ...inp(th), width: '100%' }}>
              <option value="">Select a project…</option>
              {(projects || []).map(p => <option key={p.id} value={p.id}>{p.nickname || p.address}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: '1.25rem', padding: '0.75rem', border: `1px solid ${th.cardBorder}`, borderRadius: 8 }}>
            <div style={{ fontSize: '0.82rem', color: th.text, marginBottom: '0.5rem' }}>Share your GPS location with these photos? (optional)</div>
            {pgalLocDenied && <div style={{ fontSize: '0.72rem', color: '#dc2626', marginBottom: '0.4rem' }}>Location is blocked in your browser settings — you can still continue without it.</div>}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={pgalEnableLocation} style={{ ...btn(th, { background: pgalShareLoc ? '#1B8F5C' : th.card2, color: pgalShareLoc ? '#fff' : th.text }), fontSize: '0.78rem' }}>
                {pgalShareLoc ? '✓ Sharing location' : 'Share location'}
              </button>
              {pgalShareLoc && <button onClick={pgalDisableLocation} style={{ ...btn(th, { background: 'transparent', color: th.muted }), fontSize: '0.78rem' }}>Don't share</button>}
            </div>
          </div>
          <button onClick={() => selectedProject && setPgalStep('capture')} disabled={!selectedProject}
            style={{ ...btn(th, { background: '#FF671F' }), opacity: selectedProject ? 1 : 0.5 }}>
            Continue
          </button>
        </div>
      )}
    </div>
  );
}
```

Note: `pgalGetLocation` is unused by this task's own JSX — Task 4 calls it when saving each captured photo. Keep it declared here exactly as shown; do not remove it as "unused."

- [ ] **Step 5: Build and bump version**

Search `const APP_VERSION =` in `app.jsx`, increment it (e.g. `v20.61` → `v20.62` — check the CURRENT value first). Run `npm run build`. Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js src/icons.jsx
git commit -m "feat(project-gallery): tab icon/routing + setup step (project picker + GPS opt-in)"
```

---

### Task 4: Capture step (native camera, session limit, live upload)

**Files:**
- Modify: `app.jsx` (extend `ProjectGalleryTab` in place)

**Interfaces:**
- Consumes: `pgalStep`, `selectedProject`, `pgalGetLocation` (Task 3, same function body). `/.netlify/functions/project-photos` `create` action (Task 2).
- Produces (consumed by Task 5): `pgalPhotos` (array state — every photo for the selected project, refreshed via a `pgalLoadPhotos` function Task 5 also uses), `pgalSessionCount` (this visit's capture count, capped at 20), and the `ProjectPhotoThumb` component (this task defines it once; Task 5 reuses it as-is for the full gallery grid — Task 5 must NOT redefine it).

- [ ] **Step 1: Add a lazy-loading photo thumbnail component**

Add this new top-level function in `app.jsx`, near `ReceiptThumb` (same lazy-load-on-mount pattern, but reads from the new endpoint's blob key instead of the generic key the rest of the app uses):

```jsx
function ProjectPhotoThumb({ imageKey, size = 90, onClick }) {
  const [src, setSrc] = React.useState(null);
  React.useEffect(() => {
    if (!imageKey) return;
    cloudLoad(imageKey).then(data => { if (data?.base64) setSrc(data.base64); }).catch(() => {});
  }, [imageKey]);
  if (!src) return <div style={{ width: size, height: size, borderRadius: 8, background: '#00000011' }} />;
  return <img src={src} alt="" onClick={onClick} style={{ width: size, height: size, objectFit: 'cover', borderRadius: 8, cursor: onClick ? 'pointer' : 'default', border: '1px solid rgba(0,0,0,0.1)' }} />;
}
```

- [ ] **Step 2: Add capture-step state and handlers**

Inside `ProjectGalleryTab` (Task 3's function body), add alongside the setup-step state:

```jsx
  const PGAL_SESSION_LIMIT = 20;
  const [pgalPhotos, setPgalPhotos] = React.useState([]);
  const [pgalPhotosLoading, setPgalPhotosLoading] = React.useState(false);
  const [pgalSessionCount, setPgalSessionCount] = React.useState(0);
  const [pgalCapturing, setPgalCapturing] = React.useState(false);
  const [pgalError, setPgalError] = React.useState('');

  const pgalLoadPhotos = React.useCallback(() => {
    if (!selectedProject) return;
    setPgalPhotosLoading(true);
    fetch('/.netlify/functions/project-photos', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ action: 'list', projectId: selectedProject.id }),
    })
      .then(r => r.json())
      .then(j => { if (j?.ok) setPgalPhotos(j.photos || []); })
      .catch(() => {})
      .finally(() => setPgalPhotosLoading(false));
  }, [selectedProject]);

  React.useEffect(() => { if (pgalStep !== 'setup') pgalLoadPhotos(); }, [pgalStep, pgalLoadPhotos]);

  // Compress to documentation quality (1600px/0.75) — mirrors DailyReportSection's
  // compressImage (app.jsx, search "maxWidth = 1600, quality = 0.7"), not the much
  // lossier compressImageToBase64 used for receipt/ticket thumbnails.
  const pgalCompressPhoto = (file, maxWidth = 1600, quality = 0.75) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale; canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const pgalHandleCapture = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow capturing the same shot again immediately
    if (!file) return;
    setPgalError('');
    setPgalCapturing(true);
    try {
      const dataUrl = await pgalCompressPhoto(file);
      const loc = await pgalGetLocation();
      const res = await fetch('/.netlify/functions/project-photos', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          action: 'create',
          projectId: selectedProject.id,
          projectNickname: selectedProject.nickname || selectedProject.address,
          lat: loc?.lat ?? null,
          lng: loc?.lng ?? null,
          imageBase64: dataUrl,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setPgalError(j?.error || 'Could not save this photo — please try again.'); return; }
      setPgalPhotos(prev => [j.photo, ...prev]);
      setPgalSessionCount(n => n + 1);
    } catch { setPgalError('Network error — please try again.'); }
    setPgalCapturing(false);
  };
```

- [ ] **Step 3: Render the capture step**

Add this block to the returned JSX, alongside the `pgalStep === 'setup'` block (Task 3):

```jsx
      {pgalStep === 'capture' && selectedProject && (
        <div style={{ ...card(th), padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.8rem' }}>
            <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '0.95rem', color: th.text }}>{selectedProject.nickname || selectedProject.address}</div>
            <div style={{ fontSize: '0.8rem', color: th.muted }}>{pgalSessionCount} / {PGAL_SESSION_LIMIT} this visit</div>
          </div>
          {pgalError && <div style={{ fontSize: '0.78rem', color: '#dc2626', marginBottom: '0.6rem' }}>{pgalError}</div>}
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <label style={{ ...btn(th, { background: pgalSessionCount >= PGAL_SESSION_LIMIT ? th.card2 : '#FF671F', color: pgalSessionCount >= PGAL_SESSION_LIMIT ? th.muted : '#fff' }), cursor: pgalSessionCount >= PGAL_SESSION_LIMIT ? 'default' : 'pointer' }}>
              {pgalCapturing ? 'Saving…' : pgalSessionCount >= PGAL_SESSION_LIMIT ? `Limit reached (${PGAL_SESSION_LIMIT}/${PGAL_SESSION_LIMIT})` : '📷 Take Photo'}
              <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} disabled={pgalCapturing || pgalSessionCount >= PGAL_SESSION_LIMIT} onChange={pgalHandleCapture} />
            </label>
            <button onClick={() => setPgalStep('gallery')} style={{ ...btn(th, { background: th.card2, color: th.text }) }}>Done — view gallery</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: '0.5rem' }}>
            {pgalPhotosLoading ? <div style={{ fontSize: '0.8rem', color: th.muted }}>Loading…</div> : pgalPhotos.map(p => (
              <ProjectPhotoThumb key={p.id} imageKey={p.imageKey} size={90} />
            ))}
          </div>
        </div>
      )}
```

- [ ] **Step 4: Build and bump version**

Bump `APP_VERSION` again. Run `npm run build`. Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(project-gallery): capture step — native camera, session limit, live upload"
```

---

### Task 5: Gallery step (thumbnail grid, migrated badge, delete, import-from-Daily-Reports)

**Files:**
- Modify: `app.jsx` (extend `ProjectGalleryTab` in place)

**Interfaces:**
- Consumes: `pgalPhotos`, `pgalLoadPhotos`, `selectedProject`, `dailyReports` prop (Task 3/4, same function body), `ProjectPhotoThumb` (Task 4 — reuse as-is, do NOT redefine it). `/.netlify/functions/project-photos` `delete` and `migrateFromDailyReports` actions (Task 2). `computeSourceRef` logic (re-implemented client-side identically to Task 1's `computeSourceRef` — the frontend bundle does not import server `-lib` files, so this is a small intentional duplication, same pattern as `BIZ_EXPENSE_CATEGORIES` duplicating `expenses-lib`'s `CATEGORIES`).
- Produces (consumed by Task 6): clicking a photo sets `pgalOpenPhotoId` (this task adds the state; Task 6 renders the annotator when it's non-null).

- [ ] **Step 1: Add gallery-step state, the migration handler, and the gallery-step render block**

Add alongside the other `pgal*` state:

```jsx
  const [pgalOpenPhotoId, setPgalOpenPhotoId] = React.useState(null);
  const [pgalMigrating, setPgalMigrating] = React.useState(false);
  const [pgalMigrateResult, setPgalMigrateResult] = React.useState(null);
  const isExecOrIT = user?.userType === 'executive' || user?.userType === 'it';

  const pgalDeletePhoto = async (id) => {
    try {
      await fetch('/.netlify/functions/project-photos', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ action: 'delete', id }),
      });
      pgalLoadPhotos();
    } catch {}
  };

  const pgalRunMigration = async () => {
    if (!selectedProject) return;
    setPgalMigrating(true);
    setPgalMigrateResult(null);
    try {
      const reportsForProject = (dailyReports || []).filter(r => r.projectId === selectedProject.id);
      const photos = [];
      reportsForProject.forEach(r => {
        (r.workLogs || []).forEach((w, wi) => {
          (w.photos || []).forEach((ph, pi) => {
            photos.push({ sourceRef: `dr_${r.id}_${wi}_${pi}`, dataUrl: ph.data, name: ph.name, timestamp: ph.timestamp, addedBy: r.preparedBy || 'Daily Report' });
          });
        });
      });
      const res = await fetch('/.netlify/functions/project-photos', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          action: 'migrateFromDailyReports',
          projectId: selectedProject.id,
          projectNickname: selectedProject.nickname || selectedProject.address,
          photos,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) { setPgalMigrateResult(j); pgalLoadPhotos(); }
      else setPgalError(j?.error || 'Import failed.');
    } catch { setPgalError('Network error during import.'); }
    setPgalMigrating(false);
  };
```

Add the gallery-step render block alongside the `setup`/`capture` blocks:

```jsx
      {pgalStep === 'gallery' && selectedProject && (
        <div style={{ ...card(th), padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.8rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '0.95rem', color: th.text }}>{selectedProject.nickname || selectedProject.address} — Gallery</div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={() => setPgalStep('capture')} style={{ ...btn(th, { background: th.card2, color: th.text }), fontSize: '0.78rem' }}>+ Take more photos</button>
              {isExecOrIT && (
                <button onClick={pgalRunMigration} disabled={pgalMigrating} style={{ ...btn(th, { background: '#7c3aed' }), fontSize: '0.78rem', opacity: pgalMigrating ? 0.6 : 1 }}>
                  {pgalMigrating ? 'Importing…' : 'Import from Daily Reports'}
                </button>
              )}
            </div>
          </div>
          {pgalMigrateResult && <div style={{ fontSize: '0.78rem', color: th.muted, marginBottom: '0.6rem' }}>{pgalMigrateResult.imported} imported, {pgalMigrateResult.skipped} already present.</div>}
          {pgalError && <div style={{ fontSize: '0.78rem', color: '#dc2626', marginBottom: '0.6rem' }}>{pgalError}</div>}
          {pgalPhotosLoading ? (
            <div style={{ fontSize: '0.8rem', color: th.muted }}>Loading…</div>
          ) : pgalPhotos.length === 0 ? (
            <div style={{ fontSize: '0.8rem', color: th.muted }}>No photos yet for this project.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.75rem' }}>
              {pgalPhotos.map(p => (
                <div key={p.id} style={{ position: 'relative' }}>
                  <ProjectPhotoThumb imageKey={p.imageKey} size={120} onClick={() => setPgalOpenPhotoId(p.id)} />
                  {p.source === 'migrated' && <span style={{ position: 'absolute', top: 4, left: 4, fontSize: '0.6rem', fontWeight: 700, background: '#7c3aed', color: '#fff', borderRadius: 4, padding: '1px 5px' }}>Migrated</span>}
                  <button onClick={() => pgalDeletePhoto(p.id)} style={{ position: 'absolute', top: 4, right: 4, background: '#ef4444dd', border: 'none', borderRadius: 4, color: '#fff', fontSize: '0.65rem', padding: '1px 5px', cursor: 'pointer' }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 2: Build and bump version**

Bump `APP_VERSION` again. Run `npm run build`. Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(project-gallery): gallery grid, delete, Daily Reports import"
```

---

### Task 6: Annotation editor (`ProjectPhotoAnnotator`)

**Files:**
- Modify: `app.jsx` (new `ProjectPhotoAnnotator` component; wire it into `ProjectGalleryTab` via `pgalOpenPhotoId`)

**Interfaces:**
- Consumes: `pgalOpenPhotoId`, `pgalPhotos`, `pgalLoadPhotos` (Task 5, same function body). `SHAPE_COLORS` (re-implemented client-side identically to Task 1's constant, same reasoning as Task 5's `computeSourceRef` duplication). `/.netlify/functions/project-photos` `saveAnnotations` action (Task 2).
- Produces: nothing further consumes this — it's the last task before final review.

- [ ] **Step 1: Write the `ProjectPhotoAnnotator` component**

Add this new top-level function in `app.jsx`:

```jsx
const PGAL_SHAPE_COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e'];

function ProjectPhotoAnnotator({ photo, th, onClose, onSaved }) {
  const [src, setSrc] = React.useState(null);
  const [naturalSize, setNaturalSize] = React.useState({ w: 1, h: 1 });
  const [shapes, setShapes] = React.useState(photo.annotations || []);
  const [tool, setTool] = React.useState('line'); // 'line' | 'circle'
  const [color, setColor] = React.useState(PGAL_SHAPE_COLORS[0]);
  const [draft, setDraft] = React.useState(null); // in-progress shape while dragging
  const [saving, setSaving] = React.useState(false);
  const dragStart = React.useRef(null);
  const svgRef = React.useRef(null);

  React.useEffect(() => {
    cloudLoad(photo.imageKey).then(data => { if (data?.base64) setSrc(data.base64); }).catch(() => {});
  }, [photo.imageKey]);

  const fractionFromEvent = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };

  const handlePointerDown = (e) => {
    e.target.setPointerCapture?.(e.pointerId);
    dragStart.current = fractionFromEvent(e);
  };
  const handlePointerMove = (e) => {
    if (!dragStart.current) return;
    const cur = fractionFromEvent(e);
    const s = dragStart.current;
    if (tool === 'line') setDraft({ id: 'draft', type: 'line', x1: s.x, y1: s.y, x2: cur.x, y2: cur.y, color });
    else setDraft({ id: 'draft', type: 'circle', cx: (s.x + cur.x) / 2, cy: (s.y + cur.y) / 2, rx: Math.abs(cur.x - s.x) / 2, ry: Math.abs(cur.y - s.y) / 2, color });
  };
  const handlePointerUp = () => {
    if (draft) {
      // Reject a degenerate shape (a tap with no real drag) rather than saving
      // a zero-size circle/line that would fail isValidShape's rx/ry>0 check
      // server-side and silently vanish on the next load.
      const tooSmall = draft.type === 'circle' ? (draft.rx < 0.01 || draft.ry < 0.01) : (Math.abs(draft.x2 - draft.x1) < 0.01 && Math.abs(draft.y2 - draft.y1) < 0.01);
      if (!tooSmall) setShapes(prev => [...prev, { ...draft, id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }]);
    }
    dragStart.current = null;
    setDraft(null);
  };

  const removeShape = (id) => setShapes(prev => prev.filter(s => s.id !== id));
  const undoLast = () => setShapes(prev => prev.slice(0, -1));

  const save = async () => {
    setSaving(true);
    try {
      await fetch('/.netlify/functions/project-photos', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ action: 'saveAnnotations', id: photo.id, annotations: shapes }),
      });
      onSaved && onSaved();
    } catch {}
    setSaving(false);
  };

  const renderShape = (s, i) => {
    const W = 1000, H = 1000 * (naturalSize.h / naturalSize.w); // any fixed ratio works since viewBox is unitless-consistent
    if (s.type === 'line') return <line key={s.id || i} x1={s.x1 * W} y1={s.y1 * H} x2={s.x2 * W} y2={s.y2 * H} stroke={s.color} strokeWidth={4} strokeLinecap="round" />;
    return <ellipse key={s.id || i} cx={s.cx * W} cy={s.cy * H} rx={s.rx * W} ry={s.ry * H} fill="none" stroke={s.color} strokeWidth={4} />;
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', flexDirection: 'column', padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={() => setTool('line')} style={{ ...btn(th, { background: tool === 'line' ? '#FF671F' : th.card2, color: tool === 'line' ? '#fff' : th.text }) }}>Line</button>
          <button onClick={() => setTool('circle')} style={{ ...btn(th, { background: tool === 'circle' ? '#FF671F' : th.card2, color: tool === 'circle' ? '#fff' : th.text }) }}>Circle</button>
          {PGAL_SHAPE_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)} style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: color === c ? '3px solid #fff' : '1px solid #0003', cursor: 'pointer' }} />
          ))}
        </div>
        <button onClick={onClose} style={{ ...btn(th, { background: th.card2, color: th.text }) }}>Close</button>
      </div>
      <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {src && (
          <div style={{ position: 'relative', maxWidth: '100%', maxHeight: '100%' }}>
            <img src={src} alt="" onLoad={e => setNaturalSize({ w: e.target.naturalWidth, h: e.target.naturalHeight })} style={{ maxWidth: '100%', maxHeight: '80vh', display: 'block' }} />
            <svg ref={svgRef} viewBox={`0 0 1000 ${1000 * (naturalSize.h / naturalSize.w)}`} preserveAspectRatio="none"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none' }}
              onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}>
              {shapes.map(renderShape)}
              {draft && renderShape(draft, 'draft')}
            </svg>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.6rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {shapes.map((s, i) => (
            <span key={s.id || i} style={{ fontSize: '0.72rem', color: '#fff', background: '#ffffff22', borderRadius: 6, padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 4 }}>
              {s.type === 'line' ? 'Line' : 'Circle'} <span style={{ width: 10, height: 10, borderRadius: '50%', background: s.color, display: 'inline-block' }} />
              <button onClick={() => removeShape(s.id)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: 0 }}>✕</button>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={undoLast} disabled={!shapes.length} style={{ ...btn(th, { background: th.card2, color: th.text }) }}>Undo</button>
          <button onClick={save} disabled={saving} style={{ ...btn(th, { background: '#1B8F5C' }), opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `ProjectGalleryTab`**

At the end of `ProjectGalleryTab`'s returned JSX (after the closing of the outer `<div>`'s step blocks, still inside the component's top-level return), add:

```jsx
      {pgalOpenPhotoId && (() => {
        const photo = pgalPhotos.find(p => p.id === pgalOpenPhotoId);
        if (!photo) return null;
        return (
          <ProjectPhotoAnnotator
            photo={photo}
            th={th}
            onClose={() => setPgalOpenPhotoId(null)}
            onSaved={() => { setPgalOpenPhotoId(null); pgalLoadPhotos(); }}
          />
        );
      })()}
```

- [ ] **Step 3: Build and bump version**

Bump `APP_VERSION` again. Run `npm run build`. Expected: clean build.

- [ ] **Step 4: Manual smoke test (the one step that cannot be automated)**

Deploy a preview (`npx netlify deploy`, no `--prod`) and, signed in as construction/executive/it on a real phone: pick a project, optionally share GPS, take a couple of photos, confirm the session counter/limit works, open the gallery, tap a photo, draw a line and a circle, delete one, save, reopen it and confirm the shapes persisted. As executive/it, run "Import from Daily Reports" for Hatboro and confirm previously-existing Daily Report photos appear with a "Migrated" badge, then run it a second time and confirm the imported count is 0 (idempotent). Report back explicitly which of these were actually exercised vs. assumed.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(project-gallery): annotation editor — line/circle tools, editable shapes"
```

---

## After all tasks

Per `superpowers:subagent-driven-development`: dispatch a final whole-branch code review, address any findings with one fix round + scoped re-review, then use `superpowers:finishing-a-development-branch`. Confirm with the user before merging/pushing to `main` — this repo deploys straight to production on any push to `main`.
