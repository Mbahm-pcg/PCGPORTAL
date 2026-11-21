# Daily Report Photos — per-photo storage, lighter PDFs, emailed link

**Status:** Approved by Mike in chat 2026-11-21 (design summary + "no-login link is fine for now").
**Branch:** `feature/daily-report-photos`

## Problem

A Daily Report's photos are compressed on the device (1280px, q0.65) and saved **together**
as base64 in one blob (`pcg_dr_{id}_photos`) through one POST to `storage.mjs`. Netlify caps a
function request/response at ~6 MB, so a report tops out around 12–15 photos; crews work to a
"safe" 8. Over the cap the phone field app fails silently (`cloudSaveReport(report).catch(()=>{})`),
and an over-cap photo blob cannot be downloaded again either (the cause of the Oct 2026 photo-loss
incident and the restore tool). The PDF embeds the same full-size images, and email drops the
attachment above 4.5 MB.

## Goals

1. No practical per-report photo limit (50+).
2. One photo failing never loses the report or the other photos; failures are visible and retryable.
3. Sharper stored photos, lighter PDFs.
4. Emailed reports always arrive as a working link, whatever the size.
5. Existing reports keep working unchanged.

## Non-goals (this round)

- Per-photo captions, real time-taken stamps, converting old reports to the new format —
  **queued as the next round, right after this ships** (Mike, 2026-11-21).
- Server-side PDF generation (would mean re-writing ~400 lines of working jsPDF layout).
- Locking down `storage.mjs` (unauthenticated today; separate piece of work).
- Link expiry / sign-in for the emailed PDF link.

## Design

### 1. Photo storage — one upload per photo

Reuse the Project Gallery store (`project_photos` table + one blob per image).

`project_photos` gains (all `ADD COLUMN IF NOT EXISTS`, inside `ensureTables`):

| column | type | meaning |
|---|---|---|
| `med_key` | text | blob key of the 800px rendition |
| `report_id` | text | Daily Report id this photo belongs to (null for gallery captures) |
| `file_name` | text | original file name |
| `deleted_at` | timestamptz | soft delete; null = live |

New `project-photos.mjs` actions:

- `createForReport { projectId, projectNickname, reportId, fileName, imageBase64, mediumBase64 }`
  → `{ ok, photo }`. Writes `pcg_project_photo_<id>` (full) and `pcg_project_photo_<id>_med`,
  inserts a row with `source = 'daily_report'`. Allowed roles: everyone who can edit projects —
  `executive`, `it`, `office_staff`, `construction` (wider than the gallery's own gate, which
  excludes `office_staff`).
- `removeFromReport { ids: [] }` → sets `deleted_at = now()` (same roles). Blob kept.
- `list` excludes rows with `deleted_at`.
- `purgeDeleted` is not an HTTP action: the nightly `reports-backup.mjs` run deletes rows + both
  blobs where `deleted_at < now() - 30 days`.

### 2. Report data shape

A work log's `photos` array may now hold two kinds of entries:

- **Legacy** — `{ data, name, timestamp }` (base64 inline). Still stored in `pcg_dr_{id}_photos`.
- **Ref** — `{ photoId, fullKey, medKey, name, timestamp }`. Stored **inside the report blob**
  (`pcg_dr_{id}`); no image data.

Rules, implemented once in `src/report-photos.mjs` (pure, unit-tested) and used by `app.jsx`,
`reports-backup.mjs`:

- `isRefPhoto(p)` — has a `photoId`.
- `splitReportForSave(report)` → `{ slimReport, photoMap, hasReal }`: refs stay in
  `slimReport.workLogs[i].photos` with transient fields (`data`, `_status`, `_localId`, `_error`)
  removed; legacy photos with real data go to `photoMap[i]`; photos still uploading/failed are dropped.
- `mergeLoadedReport(report, photoMap)` → work log photos = `[...legacy from photoMap[i], ...refs]`
  (legacy first, so the positional gallery `source_ref` of old photos never shifts).
- `stripReportPhotosForLocal(report)` — legacy → `{ name, timestamp, _photoStripped }` as today;
  refs keep their keys, lose `data`.
- `countReportPhotos(report)`.

`cloudSaveReport` / `cloudLoadReport` keep their signatures and their v22.26 "only write the
photo map when this copy really has the photos" guard.

### 3. Upload flow (both report screens)

Shared client helper `src/report-photo-upload.mjs`:

- `makeRenditions(file)` → `{ full, med }` data URLs: 1600px/q0.75 and 800px/q0.7 (canvas).
- `uploadReportPhoto({ projectId, projectNickname, reportId, fileName, full, med })` → ref.
  Retries twice on network/5xx with backoff; throws with a readable message otherwise.

Screen behaviour:

- Picking files adds a tile per photo immediately with a local preview (`data` = med) and
  `_status: 'uploading'`; uploads run 3 at a time. On success the tile becomes a ref
  (`_status` cleared); on failure `_status: 'failed'` with a Retry button.
- **Save Draft / Submit are blocked while any photo is uploading or failed** (alert says how many).
- The report id is fixed when the form opens (new reports get their id up front) so uploads can
  carry `reportId`.
- Removing a ref tile only queues its id; `removeFromReport` is called after the report is saved.
  Cancelling a form soft-deletes the photos uploaded during that form session.
- Phone field app: `saveReport` no longer swallows a failed save — it shows an error and stays on
  the form.

### 4. Displaying photos

`<ReportPhotoImg photo size="med|full">`: uses `photo.data` when present (legacy, or a fresh local
preview), otherwise lazy-loads `medKey`/`fullKey` via `cloudLoad` with an in-memory cache.
Used by: desktop form tiles, desktop preview, lightbox (full), phone form tiles, phone detail view.

### 5. PDF

Both jsPDF builders stay as they are. Before either runs, `resolveReportPhotosForPdf(report)`
returns a copy where every photo has `data` at ≤800px: refs load their `medKey`; legacy photos
are down-scaled on the fly. Also: signature block no longer forced onto its own page when it
fits; `%%` humidity typo fixed.

### 6. Emailed link

New function `report-pdf.mjs`:

- `POST` (signed-in, project-edit roles) `{ action: 'put', token?, index, total, chunk, fileName }`
  — base64 chunks ≤ 3 MB each, stored as `pcg_report_pdf_<token>_c<i>`; first call mints the token
  (32 random bytes, hex); last chunk writes `pcg_report_pdf_<token>_meta`.
- `GET ?t=<token>` — no sign-in; streams the PDF (`application/pdf`, inline filename). 404 on a
  bad token.

Both email senders (desktop + phone) always: build PDF → upload → send `notify` with a
"View report (PDF)" button plus the existing text summary. No attachment path, no size branch.

### 7. Existing tooling

- `reports-backup.mjs`: merge with `mergeLoadedReport` (today's `photoMap[i] || w.photos` would
  drop refs on a mixed log); "real photo" count includes refs; nightly purge of soft-deleted photos.
- Gallery auto-sync (`pgalSyncDailyReportPhotos`): skips ref photos (already gallery rows).
- Photo-restore tool: untouched (works on legacy photo maps only).
- Force Sync: untouched (goes through `cloudSaveReport`).

## Error handling

| Failure | Behaviour |
|---|---|
| Photo upload fails | Tile shows Failed + Retry; report cannot be saved until resolved or removed |
| Report save fails | Error alert; form/draft stays (desktop already marks sync failed) |
| Ref image fails to load | Grey placeholder tile; PDF prints `[photo]` as today |
| PDF upload for email fails | Error alert, email not sent |

## Testing

- `node --test`: `src/report-photos.test.mjs` (split/merge round-trip for legacy, ref and mixed
  logs; transient-field stripping; strip-for-local; counts), `project-photos-lib` role helper,
  `report-pdf` chunk/token helpers.
- `npm run build` clean.
- Manual, on a preview deploy with a test project: 30-photo report from a phone (camera + library),
  airplane-mode a mid-upload to see Retry, edit an old legacy report and add new photos (mixed),
  PDF download, email link opened signed-out, photo appears in Project Gallery, remove + re-open.

## Rollout

Feature branch → preview deploy → Mike/crew test → merge to `main` → prod deploy under the
existing deploy rule (clean tree, not behind `origin/main`). `APP_VERSION` bump + `app.js` rebuilt
in the same commit as each `app.jsx` change.

## Addendum — changes after code review (2026-11-21)

An independent review found that photo refs, unlike legacy photos, had no protection against a
stale copy saving over them (two people in the same report, Force Sync, the legacy-fallback
paths, a browser on old code). Changes made in response:

- **Server-side reconcile on every report save** (`storage.mjs` → `reconcileReportRefs` in
  `src/report-photos.mjs`). Refs the incoming copy lacks are carried over from the stored copy.
  A ref leaves a report only via the report's `removedPhotoIds` list (tombstones, capped at 1000),
  which each form appends to when the user removes a photo. A tombstone wins over a stale copy
  that still carries the ref. This replaces the narrower "old client" guard (`_pv` is still
  stamped but nothing depends on it).
- **Purge is reference-aware.** The nightly run restores (`deleted_at = NULL`) any soft-deleted
  photo that a report still references, and purges nothing if it could not read every report.
  This also covers the desktop screen soft-deleting before its cloud save has completed.
- **Idempotent uploads.** `createForReport` takes a `clientRef` (unique per uploader) and returns
  the existing photo on a retry; the PDF link token is generated in the browser and a repeated
  final chunk returns `done` instead of 409.
- **One upload queue per form** (3 at a time overall, not per pick); removing a tile in the same
  instant its upload finishes is recorded as a removal.
- **PDF metadata** keeps photo name + date only — no photo ids or storage keys in a file that is
  sent outside the company.

Known and accepted: `removeFromReport` is not scoped to a report (any project-edit role can
soft-delete a report photo; it is restored nightly if a report still uses it). Two people editing
the same report still overwrite each other's *text* — pre-existing, not addressed here.
`storage.mjs` remains unauthenticated — pre-existing, separate work.
