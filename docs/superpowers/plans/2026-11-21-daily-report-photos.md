# Daily Report Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the practical photo limit on Daily Reports by uploading each photo on its own, shrink the PDF, and always email a link.

**Architecture:** Report photos become rows in the existing `project_photos` table with two blobs each (1600px full, 800px medium); the report blob stores only references. Pure split/merge logic lives in `src/report-photos.mjs` and is shared by the app and the nightly backup. Old inline-base64 reports are read unchanged.

**Tech Stack:** React 18 (CDN globals) in `app.jsx` bundled by esbuild, Netlify Functions v2 (`.mjs`, `Request`/`Response`), Netlify Blobs (`pcg-portal` store), Neon Postgres, jsPDF (CDN global), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-21-daily-report-photos-design.md`

## Global Constraints

- Branch `feature/daily-report-photos`; never commit to `main`; no prod deploy from this plan.
- Every commit that changes `app.jsx` or `src/*` also bumps `APP_VERSION` and includes a rebuilt `app.js` (`npm run build`).
- Sync `npm install` side effect: `package-lock.json` name must stay `"Portal"` — never commit a lockfile whose only change is the name.
- Renditions: full = 1600px wide, JPEG q0.75; medium = 800px wide, JPEG q0.7.
- Report-photo roles: `executive`, `it`, `office_staff`, `construction` (same as `canEditProjects`).
- Soft-deleted photos are purged after 30 days.
- PDF chunks ≤ 3 MB of base64 per request.
- Legacy photos (`{data,name,timestamp}`) must keep loading, saving, backing up and restoring exactly as before; legacy-first ordering inside a work log.
- All git commands in this repo are slow (iCloud); use long timeouts, never run two at once.

---

### Task 1: Pure report-photo logic

**Files:**
- Create: `src/report-photos.mjs`
- Test: `src/report-photos.test.mjs`

**Interfaces — Produces:**
- `isRefPhoto(p): boolean` — `p.photoId` is a non-empty string.
- `isRealReportPhoto(p): boolean` — legacy photo with `typeof p.data === 'string' && p.data.length > 32` and **not** a ref.
- `isPendingPhoto(p): boolean` — `p._status === 'uploading' || p._status === 'failed'`.
- `cleanRef(p)` → `{ photoId, fullKey, medKey, name, timestamp }`.
- `splitReportForSave(report)` → `{ slimReport, photoMap, hasReal }` (drops `_photosLoaded`; pending photos dropped).
- `mergeLoadedReport(report, photoMap)` → report (legacy from `photoMap[i]` first, then refs already on the log; with a null map the log's own photos are kept).
- `stripReportPhotosForLocal(report)`.
- `countReportPhotos(report)` → `{ total, refs, legacy, pending }`.
- `REPORT_PHOTO_ROLES`, `canUploadReportPhotos(userType)`.

- [ ] **Step 1: Write failing tests** covering: split of a legacy-only log (photos → map, slim `[]`, `hasReal` true); ref-only log (refs kept in slim without `data`/`_status`, map empty, `hasReal` false); mixed log; pending photo dropped; `_photosLoaded` not persisted; merge legacy-first; merge with `null` map keeps refs; split→merge round trip equals the cleaned input; strip-for-local keeps ref keys and removes `data`; counts; role helper (`office_staff` true, `manager` false).
- [ ] **Step 2:** `node --test src/report-photos.test.mjs` → FAIL (module missing).
- [ ] **Step 3:** Implement the module.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(daily-reports): pure report-photo split/merge logic`.

### Task 2: Server — report photo actions

**Files:**
- Modify: `netlify/functions/project-photos.mjs`

**Interfaces — Consumes:** `canUploadReportPhotos` from `src/report-photos.mjs`.
**Produces (POST JSON):**
- `createForReport { projectId, projectNickname, reportId, fileName, imageBase64, mediumBase64 }` → `{ ok, photo }` where `photo` has `id, imageKey, medKey, reportId, fileName, createdAt`.
- `removeFromReport { ids: string[] }` → `{ ok, removed }`.
- `list` excludes soft-deleted rows.

- [ ] **Step 1:** `ensureTables`: `ALTER TABLE project_photos ADD COLUMN IF NOT EXISTS` for `med_key text`, `report_id text`, `file_name text`, `deleted_at timestamptz`; index on `report_id`.
- [ ] **Step 2:** Move the role gate: report actions check `canUploadReportPhotos`, all other actions keep `canAccessProjectGallery`.
- [ ] **Step 3:** Implement both actions; `saveBlob(id, dataUrl, addedBy, suffix = '')`; reject data URLs that are not `data:image/` or exceed 4 MB; `rowToPhoto` returns the new fields.
- [ ] **Step 4:** `node --check netlify/functions/project-photos.mjs`; existing `shapes.test.mjs` still passes.
- [ ] **Step 5:** Commit.

### Task 3: Server — emailed PDF link

**Files:**
- Create: `netlify/functions/report-pdf.mjs`, `netlify/functions/report-pdf-lib/chunks.mjs`
- Test: `netlify/functions/report-pdf-lib/chunks.test.mjs` (add its glob to `npm test` if the existing globs don't cover it)

**Interfaces — Produces:**
- `chunks.mjs`: `isValidToken(t)` (64 hex chars), `chunkKey(token, i)`, `metaKey(token)`, `safeFileName(name)` (strips to `[A-Za-z0-9._-]`, forces `.pdf`), `MAX_CHUNK = 3 * 1024 * 1024`, `MAX_CHUNKS = 12`.
- `POST { action:'put', token?, index, total, chunk, fileName }` (signed in, report roles) → `{ ok, token, done }`.
- `GET ?t=<token>` → `application/pdf` stream, `Content-Disposition: inline`; 404 otherwise.

- [ ] Steps: failing tests for the helpers → implement helpers → implement function → `node --check` → commit.

### Task 4: Client helpers

**Files:**
- Create: `src/report-photo-upload.mjs`

**Interfaces — Consumes:** `authHeader` from `src/portal-auth.mjs`. **Produces:**
- `scaleImageDataUrl(src, maxWidth, quality)` → data URL (never upscales).
- `makeRenditions(file)` → `{ full, med }`.
- `uploadReportPhoto({ projectId, projectNickname, reportId, fileName, full, med })` → ref `{ photoId, fullKey, medKey, name, timestamp }`-shaped fields (`timestamp` supplied by caller); 2 retries on network/5xx.
- `removeReportPhotos(ids)` (best effort).
- `runLimited(items, limit, worker)` — concurrency pool (pure; unit-tested in `src/report-photo-upload.test.mjs`).
- `uploadReportPdf(blob, fileName)` → absolute URL of the link.

- [ ] Steps: test `runLimited` (order-independent completion, never more than `limit` in flight, one rejection doesn't stop the rest) → implement → commit.

### Task 5: app.jsx — storage layer

**Files:** Modify `app.jsx` — `cloudSaveReport`/`cloudLoadReport`/`isRealReportPhoto`/`stripDailyReportPhotos` (≈ lines 8732–8830), gallery auto-sync `pgalSyncDailyReportPhotos` (≈ 16869).

- [ ] `cloudSaveReport` uses `splitReportForSave`; `cloudLoadReport` uses `mergeLoadedReport`; `stripDailyReportPhotos` delegates to `stripReportPhotosForLocal`; gallery sync skips `isRefPhoto` entries (keeping the original index for `sourceRef`).
- [ ] Add module-level `ReportPhotoImg` component + `loadReportPhotoData(photo, size)` with an in-memory `Map` cache, and `resolveReportPhotosForPdf(report)`.
- [ ] `buildReportPdf` starts with `report = await resolveReportPhotosForPdf(report)`; fix `%%`; signature only breaks the page when it doesn't fit.
- [ ] Build, bump version, commit.

### Task 6: app.jsx — desktop report screen (`DailyReportSection`)

- [ ] Report id fixed at form open (`pendingIdRef`); `handlePhotoUpload` → tiles with `_status`, pool of 3, Retry; `removePhoto` queues ref ids; `saveReport` blocks on pending, strips nothing itself (split does), then fires `removeReportPhotos`; Cancel soft-deletes session uploads.
- [ ] Form tiles, preview grid and lightbox render through `ReportPhotoImg`.
- [ ] `sendEmailWithPdf` → `uploadReportPdf` + link email (summary kept, no attachment branch).
- [ ] Build, bump, commit.

### Task 7: app.jsx — phone field app (`ConstructionMobileView`)

- [ ] Same upload flow in `addLogPhoto`/`removeLogPhoto`; id fixed at form open; `saveReport` surfaces failures and stays on the form; detail-view photo count via `countReportPhotos`; thumbnails/lightbox via `ReportPhotoImg`; `mobileSendEmail` → link.
- [ ] Build, bump, commit.

### Task 8: Nightly backup + purge

**Files:** Modify `netlify/functions/reports-backup.mjs`

- [ ] Merge with `mergeLoadedReport`; `realPhotos` counts refs too; after the backup, purge rows + both blobs where `deleted_at < now() - interval '30 days'` (wrapped in try/catch so a DB problem never fails the backup).
- [ ] `node --check`, commit.

### Task 9: Verify + docs

- [ ] `npm test` (full suite) and `npm run build` clean.
- [ ] Update `CLAUDE.md`: version, Daily Reports storage note, new function, new columns.
- [ ] Preview deploy for hands-on testing **only after Mike says where to test** (a preview deploy shares production data).
