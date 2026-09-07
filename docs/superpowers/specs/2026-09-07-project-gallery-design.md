# Project Photo Gallery — Design Spec

**Status:** Approved by user (verbal, in-chat) 2026-09-07, after a Q&A round settling camera approach, location-prompt meaning, annotation depth, and migration scope.

## Goal

A new "Project Gallery" tab (construction/executive/IT only) where a user documents a
construction/remodel site visit: pick a project, optionally share GPS location, take a
series of photos with the phone's own camera (capped per visit), then draw persistent,
re-editable line/circle annotations on any photo (measurements, flagged issues). Existing
Daily Report photos for one test project (Hatboro) get pulled into this new system as a
reusable, idempotent import action — not a one-off script — so any other project can get
the same treatment later.

## Explicit non-goals (for today's build)

- **No custom in-browser camera preview** (no `getUserMedia`/live video/custom shutter).
  Every capture uses the OS's native camera app via a plain
  `<input type="file" accept="image/*" capture="environment">`, exactly like every other
  photo feature in this codebase (maintenance tickets, expense receipts, daily reports).
  The "built-in" requirement is satisfied by our own session-count enforcement around
  that native flow, not by replacing it.
- **No burned-in annotations.** Marks are structured shape data (`annotations` JSONB on
  the photo row), rendered as an SVG overlay, always re-editable. The underlying photo
  pixels never change after upload.
- **No click-to-select-on-image editing.** Deleting a specific shape happens via a small
  listed row under the photo (e.g. "Line #1 (red) ✕"), not by tapping the shape on the
  image itself. This avoids building hit-testing/selection math for a same-day build;
  drag-to-draw + a delete list still makes every shape genuinely removable/re-addable.
- **No per-user project scoping.** Every construction/exec/IT user sees every project's
  gallery — matches how the existing Projects/Construction module already works (no
  per-user project restriction there either).
- Migration today targets Hatboro only (the test case); the action itself works for any
  project, so a future request to migrate another one is a one-line trigger, not new code.

## Data model

New Postgres table, self-created via `CREATE TABLE IF NOT EXISTS` inside a new
`netlify/functions/project-photos.mjs` (exact same pattern as `business_expenses` in
`expenses.mjs` and `maint_tickets` in `tickets.mjs` — no drizzle migration step required,
though a documentation-only block gets added to `db/schema.ts` for consistency).

```sql
CREATE TABLE IF NOT EXISTS project_photos (
  id                text PRIMARY KEY,        -- 'pphoto_<ts>_<rand>', server-generated
  project_id        integer NOT NULL,        -- matches the existing project record's numeric id
  project_nickname  text,                    -- denormalized at insert time (display only —
                                              -- project records live client-side/blob, not
                                              -- Postgres, so the backend has no table to join)
  lat               double precision,        -- nullable — GPS is opt-in/skippable
  lng               double precision,
  taken_by_user_id  integer NOT NULL,
  taken_by_name     text NOT NULL,
  user_type         text NOT NULL,
  image_key         text NOT NULL,           -- Netlify Blob key holding the photo itself
  annotations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  source            text NOT NULL DEFAULT 'capture',  -- 'capture' | 'migrated'
  source_ref        text,                    -- migrated rows only — stable dedupe key,
                                              -- e.g. 'dr_<reportId>_<workLogIdx>_<photoIdx>'
  created_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pphoto_project ON project_photos(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pphoto_source_ref ON project_photos(source_ref)
  WHERE source_ref IS NOT NULL;             -- makes migration idempotent: a re-run's
                                              -- INSERT ... ON CONFLICT DO NOTHING on this
                                              -- index is what skips already-imported photos
```

The photo itself is one Netlify Blob per photo (not chunked — a 1600px/quality-0.75 JPEG
stays comfortably under a few hundred KB to ~1MB, the same order of magnitude as the
existing Daily Report photos this feature migrates from, which already use exactly this
compression level uncontested), keyed `pcg_project_photo_{id}`, shape
`{ savedAt, data: { base64, addedBy, addedAt } }` — the same wrapper every other blob in
this app uses.

## Coordinate system for annotations (locks in a real technical risk)

Both shapes are stored as **fractions of the image's natural width/height**, not raw
pixels and not a single 0–1 square — this is deliberate: a circle stored with equal
width-fraction and height-fraction radii would render as a visible ellipse on any photo
whose aspect ratio isn't square, since a naive single `viewBox="0 0 1 1"` SVG scales X and
Y by different factors to fill a non-square image. Storing separate X/Y fractions and
rendering the SVG overlay with `viewBox="0 0 W H"` (W/H = the image's actual displayed
pixel dimensions, read from the `<img>` element after load) makes both shapes render
correctly at any zoom/screen size:

```js
// Line: { id, type:'line', x1, y1, x2, y2, color }   — all fractions (0–1) of width/height
// Circle tool draws an ellipse under the hood (drag a bounding box, like any drawing app's
// oval tool) — visually indistinguishable from a circle for flagging an issue, and immune
// to the aspect-ratio bug a true circle radius would have:
// Circle: { id, type:'circle', cx, cy, rx, ry, color }  — cx/rx fractions of width,
//                                                          cy/ry fractions of height
```

At render time: `pixelX = fractionX * displayedWidth`, `pixelY = fractionY * displayedHeight`.

## Backend: `netlify/functions/project-photos.mjs`

New file, same shape as `expenses.mjs` (fetch-style handler, `cors`/`json` helpers,
`ensureTables`, `requireActiveUser` + the `eventShim` adapter for its event-shaped API).

**Auth + role gate:** every action requires `requireActiveUser`, AND
`claims.userType` must be one of `construction`/`executive`/`it` (403 otherwise) — unlike
`expenses.mjs` (deliberately open to every role), this feature's backend enforces the
same narrower access the tab itself is gated to, since nothing here is meant to be
reachable by other roles even via a direct API call.

**Actions (POST `{ action, ... }`):**

- `create { projectId, projectNickname, lat, lng, imageBase64 }` → generates `id`, saves
  the blob, inserts a row (`source:'capture'`), returns the row.
- `list { projectId }` → all rows for that project, `ORDER BY created_at DESC`.
- `saveAnnotations { id, annotations }` → validates every array entry has a known `type`
  (`line`|`circle`) and only its expected numeric fields, then
  `UPDATE ... SET annotations = ${JSON.stringify(annotations)}::jsonb WHERE id = ${id}`.
- `delete { id }` → deletes the blob (best-effort) + the row.
- `migrateFromDailyReports { projectId, projectNickname, photos: [{ sourceRef, dataUrl,
  name, timestamp, addedBy }] }` — additionally requires `executive`/`it` (construction
  may capture/annotate but not trigger a migration). The **client** does the extraction
  (flattening `dailyReports.filter(r => r.projectId === X)` → `workLogs[].photos[]`,
  computing `sourceRef = 'dr_' + report.id + '_' + workLogIdx + '_' + photoIdx'`) and
  sends the flat list; the backend, per photo, does
  `INSERT ... (source_ref, ...) VALUES (...) ON CONFLICT (source_ref) DO NOTHING`
  (relying on the unique partial index above) — so re-running the same import a second
  time is a safe no-op for already-migrated photos, and adding a newly-created Daily
  Report photo later just picks it up on the next run.

## Frontend

**Icon:** new `projectGallery` entry in `ICONS` (`src/icons.jsx`) — a simple
camera-shape SVG, following the existing simple-icon shape.

**Tab registration:** add
`{ id: "project-gallery", label: "Project Gallery", icon: (c) => ICONS.projectGallery(c) }`
to the `construction`, `executive`, and `it` branches of `computeRoleTabs` specifically
(NOT `BASE_TABS` — this is deliberately narrower than the Expenses tab's "every role"
reach). Route it in the main `PCGPortal` return:
`{tab === "project-gallery" && <ProjectGalleryTab user={user} th={th} projects={projects} dailyReports={dailyReports} />}`.

**Component: `ProjectGalleryTab`** (new, top-level), a 3-step flow kept in one component
via a `step` state machine (`'setup' | 'capture' | 'gallery'`):

1. **Setup step:** GPS opt-in (a fresh, self-contained implementation of the exact
   pattern already proven in `OpsTasks`, app.jsx:35896-35950 — `pcg_share_location`
   localStorage flag, `navigator.permissions.query`, `enableLocation`/`getLocation`
   resolving `null` on denial/timeout, never throwing) + a project picker (`<select>`
   over the `projects` prop). "Continue" is enabled once a project is chosen; GPS is
   skippable and never blocks progress.
2. **Capture step:** shows a running count (`sessionCount / 20`), a "Take Photo" button
   (`<input type="file" accept="image/*" capture="environment">`) that compresses
   (1600px/quality 0.75, mirroring `DailyReportSection`'s `compressImage`,
   app.jsx:13720-13742) and immediately POSTs a `create` action per photo (not batched —
   a session that's interrupted keeps whatever already uploaded), appending each result
   to a live thumbnail strip. The button disables and shows "Limit reached (20/20)" once
   `sessionCount >= 20`. A "Done" button moves to the gallery step at any point.
3. **Gallery step:** a grid of every photo for the selected project (`list` action),
   each thumbnail with its annotations rendered as a small overlay, a "Migrated" badge
   on rows where `source === 'migrated'`, a delete button per photo, and (executive/it
   only) an "Import from Daily Reports" button that runs the client-side extraction
   described above and calls `migrateFromDailyReports`, showing a running "{n} imported,
   {m} already present" summary as it completes. Clicking a photo opens the annotation
   editor.

**Component: `ProjectPhotoAnnotator`** (new) — given one photo record, renders the image
in a container with an absolutely-positioned SVG overlay
(`viewBox="0 0 W H"`, `preserveAspectRatio="none"`, W/H read from the loaded `<img>`'s
`naturalWidth`/`naturalHeight` — using the image's own natural size, not its on-screen
CSS size, keeps the fraction math correct regardless of how large the photo is displayed):
- Toolbar: two tool buttons (Line, Circle), a small fixed color palette (red/yellow/
  blue/green, red default).
- Pointer events (`onPointerDown`/`onPointerMove`/`onPointerUp` — unifies mouse/touch/pen)
  on the SVG: down records the start fraction, move updates a live preview shape, up
  finalizes it into local `annotations` state.
- A small list below the image: one row per shape ("Line (red)" / "Circle (blue)") each
  with its own ✕ to remove; an "Undo" button removes the most-recently-added shape.
- "Save" POSTs `saveAnnotations` with the full current array. Closing without saving
  discards in-memory changes (no draft-persistence for today's build).

## Access

Tab (and every backend action) restricted to `construction`, `executive`, `it` — no
other role, including `office_staff`/`dm`/`manager`, gets any part of this feature.

## Global Constraints

- Bump `APP_VERSION` in `app.jsx` after each task, not just once at the end.
- No PowerShell edits to `app.jsx` — Edit tool only.
- Run `npm run build` before any preview deploy; commit `app.jsx` + `app.js` together.
- New tab icon must be a real `ICONS` SVG entry, never emoji.
- Every `project-photos.mjs` action requires `requireActiveUser` AND a
  construction/executive/it role check (403 otherwise) — stricter than `expenses.mjs`,
  which is deliberately open to every role for a different feature.
- Annotation coordinates are always stored as width/height-relative fractions, never raw
  pixels — see the Coordinate System section; a task that stores raw pixel coordinates
  instead is a spec violation, not a stylistic choice.
- `migrateFromDailyReports` must be idempotent via the `source_ref` unique partial index
  — never insert a duplicate row for the same Daily Report photo on a re-run.

## Testing

No React UI test harness exists in this repo (`npm test` only covers pure `*-lib`
helpers). Verification is: unit tests for the pure fraction-math/shape-validation/
source-ref helpers extracted into a new `project-photos-lib`, a clean `npm run build`, a
manual curl check of the auth+role gate against a live preview deploy, and — same
honest caveat as the Expenses feature — actual camera capture and GPS behavior on a real
phone can only be confirmed by the user on their own device, not claimed as verified here.
