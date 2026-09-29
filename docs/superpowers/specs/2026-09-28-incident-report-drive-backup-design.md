# Incident Report — Google Drive Backup — Design Spec

**Date:** 2026-09-28
**Status:** Approved for planning

## Problem

Incident Report PDFs and their photo/video evidence currently live only in
Netlify Blobs + Neon Postgres. The user wants a second, independent copy in
Google Drive as a data-safety backup — "make sure we keep our data."

## Confirmed setup

- **Shared Drive ID:** `1A2aYyLns90Qv1LqgxZ8HQhxUW9epiP5r`
- **Service account:** `pcg-googledrive@portal-project-495514.iam.gserviceaccount.com`
  (the same one KB sync already uses, via `GOOGLE_SERVICE_ACCOUNT_KEY`), added
  as a Content Manager member of that Shared Drive on 2026-09-28.
- Using a Shared Drive (not a personal-account folder) sidesteps the
  standard "bare service account has no Drive storage quota of its own"
  gotcha — storage belongs to the Shared Drive, not any one account.

## Goals

- Every filed incident report's PDF and all its photo/video evidence get
  uploaded to Drive automatically, immediately when the report is filed —
  no manual step, no separate batch job.
- Organized as one subfolder per store under the Shared Drive, auto-created
  the first time that store has a report.
- Never blocks or fails the actual report submission — Drive is a backup,
  not the primary store. The report is already safely in Postgres the
  moment `incident-reports.mjs`'s `create` action returns; Drive upload is
  a best-effort secondary step layered on top.
- IT gets a bell notification if a Drive backup ever fails, so a silent,
  ongoing failure doesn't go unnoticed for months (defeating the point of
  having a backup at all).

## Non-goals

- Not a general-purpose Drive integration for anything else in the app —
  scoped to Incident Report backup only.
- Not a two-way sync — Drive is write-only from the Portal's side, never
  read back into it (mirrors KB sync being read-only in the other
  direction).
- No retry queue for failed uploads in v1 — a failure logs + notifies IT;
  a human decides whether to manually re-run it. (Automatic retry is a
  reasonable future enhancement, not required now.)

## Architecture

### A new, separate Drive client — not reusing KB sync's

KB sync's existing `getDriveClient()` (`kb-sync.mjs`) requests
`drive.readonly` scope. This feature needs write access, so it gets its own
`GoogleAuth` instance requesting `https://www.googleapis.com/auth/drive.file`
(the narrowest write scope — lets the app manage files/folders it creates
itself, not arbitrary Drive content) — same `GOOGLE_SERVICE_ACCOUNT_KEY`
credential, different scope, different client instance. KB sync's code is
untouched.

Every Drive API call against a Shared Drive needs `supportsAllDrives: true`,
and list/query calls additionally need `includeItemsFromAllDrives: true`,
`corpora: 'drive'`, and `driveId: <the Shared Drive ID>` — a well-known Drive
API v3 requirement for Shared Drives specifically (regular "My Drive"
content doesn't need these).

### Folder-per-store, find-or-create

On each backup, look up a subfolder named after the store under the Shared
Drive root (`drive.files.list` with the Shared Drive params above, query
`name = '<storeName>' and mimeType = 'application/vnd.google-apps.folder'
and trashed = false and '<sharedDriveId>' in parents`). If not found,
create it (`drive.files.create`, `mimeType:
'application/vnd.google-apps.folder'`, `parents: [sharedDriveId]`,
`supportsAllDrives: true`).

### Getting the PDF and evidence files to the backend without hitting size limits

PDF generation happens entirely client-side (`html2pdf`/`html2canvas` —
browser-only APIs, can't run server-side). Sending a PDF with several
embedded photos as one big base64 POST body risks the same ~6MB Netlify
Function request-body ceiling that motivated this app's existing chunked
file upload for photos/videos.

The fix: treat the PDF exactly like an attachment. Right after a report is
successfully created, the client also generates the PDF as a Blob (a small
change to `exportIncidentReportPdf` — `html2pdf().outputPdf('blob')` instead
of `.save()`) and chunk-saves it into Netlify Blobs via the SAME existing
`cloudSaveFile`/`cloudSaveDataUrl` helper every photo/video already uses,
under a key like `incident_pdf_{reportId}`.

The client then calls the new backend endpoint with only small metadata —
`{reportId, storeName, pdfKey, attachments: [{fileKey, name, mimeType}, …]}`
— never the file bytes themselves. The backend reads each file back out of
Netlify Blobs itself (server-side chunk reassembly — `deal-docs.mjs` already
does exactly this for its own chunked files, same `{key}_meta` +
`{key}_c{i}` shape, reusable pattern) and uploads the reassembled bytes to
Drive directly, server-to-Google — no client-to-backend size constraint in
this path at all.

### New backend function: `incident-report-drive.mjs`

Action `backup`, any active session (matches "everyone can file a report" —
this isn't exec/IT-restricted, it's the automatic side-effect of a normal
user's own successful submission):

1. Read PDF + each attachment from Netlify Blobs (chunk reassembly).
2. Find-or-create the store's Drive subfolder.
3. Upload each file (`drive.files.create`, `media: {mimeType, body}`,
   `parents: [storeFolderId]`, `supportsAllDrives: true`).
4. On any failure: `console.error` (visible in Netlify function logs) AND
   write a bell notification to exec/IT ("Drive backup failed for Incident
   Report #<id> — <store>") using this app's existing notification
   mechanism, so it's visible without anyone needing to check logs
   proactively.
5. Returns `{ok, uploaded: [...], failed: [...]}` — informational only, the
   client doesn't act on the result (see below).

### Client: fire-and-forget, never blocks the filer's UX

After `incident-reports.mjs`'s `create` call succeeds (the point at which
the report is already safely and durably stored), the client:

1. Shows "Incident report filed" and resets the form immediately —
   unchanged from today. The filer's experience doesn't change at all.
2. Separately, without awaiting or blocking the above, generates the PDF
   blob, chunk-saves it, and calls the new backup endpoint. Any error here
   is caught and swallowed client-side (logged to console only) — the
   backend's own failure notification (above) is the real signal path, not
   a UI error for the person filing the report, who has already succeeded
   at their actual task.

## Testing

- Folder find-or-create query construction and the Shared-Drive-specific
  request parameters are the one piece of this worth a pure-logic unit test
  (a small function that builds the Drive API query/params object, testable
  without hitting a real API) — goes in `src/incident-report-drive.mjs` +
  `.test.mjs`, following the established pure-module pattern.
- The actual Drive upload I/O isn't unit-tested (consistent with how this
  codebase treats every other external-API-calling function) — verified
  manually: file a real test report with a photo attached, confirm the
  store's subfolder appears in the Shared Drive with the PDF and photo
  inside, then delete that test data from Drive afterward.
