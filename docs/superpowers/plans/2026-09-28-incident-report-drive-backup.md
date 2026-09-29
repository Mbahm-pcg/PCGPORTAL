# Incident Report — Google Drive Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every filed Incident Report's PDF and evidence photos/videos get automatically backed up to a Google Shared Drive, organized one folder per store — without ever blocking or risking the report's own successful submission.

**Architecture:** A pure-logic module builds the Drive API request shapes (folder find/create, file upload params — testable without a real API call). The client generates the PDF as a Blob right after a successful submit, chunk-saves it into Netlify Blobs exactly like photos/videos already are, then fires a small metadata-only call to a new backend function, which reassembles the bytes server-side and pushes them to Drive using a new write-scoped `googleapis` client (separate from the existing read-only one KB sync uses).

**Tech Stack:** `googleapis` (already a dependency), Netlify Functions (ESM), Netlify Blobs, React (inline in `app.jsx`), Node's `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-28-incident-report-drive-backup-design.md`

## Global Constraints

- Filing a report must never fail or feel slower because of Drive — the backup call is fire-and-forget from the client's perspective, after the report is already confirmed saved.
- Never send raw file bytes to the new backend endpoint — only blob keys/metadata. The backend reads bytes from Netlify Blobs itself.
- Shared Drive ID: `1A2aYyLns90Qv1LqgxZ8HQhxUW9epiP5r`. Every Drive API call touching it needs `supportsAllDrives: true`; list/query calls also need `includeItemsFromAllDrives: true`, `corpora: 'drive'`, `driveId`.
- KB sync's existing Drive client/scope (`drive.readonly`) is untouched — this feature gets its own `GoogleAuth` instance with `drive.file` scope, same `GOOGLE_SERVICE_ACCOUNT_KEY` credential.
- On any backup failure: log server-side AND write a bell notification (type `incident_report_drive_backup_failed`, added to `ADMIN_ONLY_NOTIF_TYPES` so only exec/IT see it) — never surface an error to the person who filed the report.
- Single commit, single push at the end — ask before pushing to prod.

---

### Task 1: Pure logic module

**Files:**
- Create: `src/incident-report-drive.mjs`
- Test: `src/incident-report-drive.test.mjs`

**Interfaces:**
- Produces: `buildFolderFindQuery(storeName, sharedDriveId)`, `buildFolderCreateParams(storeName, sharedDriveId)`, `buildFileUploadParams({name, mimeType, parentFolderId})` — consumed by Task 2's backend function.

- [ ] **Step 1: Write the failing tests**

Create `src/incident-report-drive.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderFindQuery, buildFolderCreateParams, buildFileUploadParams } from './incident-report-drive.mjs';

const DRIVE_ID = '1A2aYyLns90Qv1LqgxZ8HQhxUW9epiP5r';

test('buildFolderFindQuery: includes Shared Drive params and a name+mimeType+parent query', () => {
  const q = buildFolderFindQuery('Bustleton', DRIVE_ID);
  assert.equal(q.supportsAllDrives, true);
  assert.equal(q.includeItemsFromAllDrives, true);
  assert.equal(q.corpora, 'drive');
  assert.equal(q.driveId, DRIVE_ID);
  assert.match(q.q, /name = 'Bustleton'/);
  assert.match(q.q, /mimeType = 'application\/vnd\.google-apps\.folder'/);
  assert.match(q.q, new RegExp(`'${DRIVE_ID}' in parents`));
});

test('buildFolderFindQuery: escapes a single quote in the store name (e.g. an apostrophe)', () => {
  const q = buildFolderFindQuery("O'Malley's", DRIVE_ID);
  assert.match(q.q, /name = 'O\\'Malley\\'s'/);
});

test('buildFolderCreateParams: creates a folder under the Shared Drive root', () => {
  const p = buildFolderCreateParams('Bustleton', DRIVE_ID);
  assert.deepEqual(p.requestBody, { name: 'Bustleton', mimeType: 'application/vnd.google-apps.folder', parents: [DRIVE_ID] });
  assert.equal(p.supportsAllDrives, true);
});

test('buildFileUploadParams: parents the file under the given folder, no media.body (caller supplies bytes)', () => {
  const p = buildFileUploadParams({ name: 'report.pdf', mimeType: 'application/pdf', parentFolderId: 'folder-123' });
  assert.deepEqual(p.requestBody, { name: 'report.pdf', parents: ['folder-123'] });
  assert.equal(p.media.mimeType, 'application/pdf');
  assert.equal(p.media.body, undefined);
  assert.equal(p.supportsAllDrives, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/incident-report-drive.test.mjs`
Expected: FAIL — `Cannot find module './incident-report-drive.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/incident-report-drive.mjs`:

```js
// src/incident-report-drive.mjs
// Pure logic for the Incident Report → Google Drive backup — no I/O. Builds
// the Drive API v3 request shapes; the caller (incident-report-drive.mjs,
// the Netlify function) supplies the actual Drive client and file bytes.
// Every Shared Drive call needs supportsAllDrives:true; list/query calls
// also need includeItemsFromAllDrives/corpora/driveId — see Google's own
// Shared Drive API docs, not optional for a Shared Drive target.

function escapeForDriveQuery(name) {
  return String(name).replace(/'/g, "\\'");
}

export function buildFolderFindQuery(storeName, sharedDriveId) {
  const escaped = escapeForDriveQuery(storeName);
  return {
    q: `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${sharedDriveId}' in parents`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'drive',
    driveId: sharedDriveId,
    fields: 'files(id, name)',
  };
}

export function buildFolderCreateParams(storeName, sharedDriveId) {
  return {
    requestBody: { name: storeName, mimeType: 'application/vnd.google-apps.folder', parents: [sharedDriveId] },
    supportsAllDrives: true,
    fields: 'id',
  };
}

export function buildFileUploadParams({ name, mimeType, parentFolderId }) {
  return {
    requestBody: { name, parents: [parentFolderId] },
    media: { mimeType }, // caller adds `.body` (the actual bytes/stream) at call time
    supportsAllDrives: true,
    fields: 'id',
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/incident-report-drive.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Do not commit yet** (single commit at the end)

---

### Task 2: Backend function

**Files:**
- Create: `netlify/functions/incident-report-drive.mjs`

**Interfaces:**
- Consumes: `buildFolderFindQuery`/`buildFolderCreateParams`/`buildFileUploadParams` (Task 1), `requireActiveUser` (`./auth-lib/require-user.js`).
- Produces: POST `/.netlify/functions/incident-report-drive` `{action:'backup', reportId, storeName, pdfKey, attachments:[{fileKey,name,mimeType}]}` → `{ok, uploaded, failed}`.

- [ ] **Step 1: Write the function**

Create `netlify/functions/incident-report-drive.mjs`:

```js
// incident-report-drive.mjs — backs up an Incident Report's PDF + evidence
// to a Google Shared Drive, one subfolder per store. Fire-and-forget from
// the client's side (called right after a successful report create) —
// never blocks or reflects back onto the report's own success/failure.
// Failures here log server-side AND write a bell notification to exec/IT
// (type: incident_report_drive_backup_failed) so a silent, ongoing failure
// doesn't go unnoticed.
import { google } from 'googleapis';
import { getStore } from '@netlify/blobs';
import { neon } from '@neondatabase/serverless';
import { Readable } from 'node:stream';
import { requireActiveUser } from './auth-lib/require-user.js';
import { buildFolderFindQuery, buildFolderCreateParams, buildFileUploadParams } from '../../src/incident-report-drive.mjs';

const SHARED_DRIVE_ID = '1A2aYyLns90Qv1LqgxZ8HQhxUW9epiP5r';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

function getBlobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

// Separate GoogleAuth instance from kb-sync.mjs's read-only one — same
// credential (GOOGLE_SERVICE_ACCOUNT_KEY), different scope (write, not
// read), different client instance. kb-sync.mjs is untouched by this.
function getDriveClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var not set');
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return google.drive({ version: 'v3', auth });
}

// Reassembles a chunked file (same {key}_meta + {key}_c{i} shape this app
// already uses for ticket photos/videos and deal docs) into a Buffer.
async function readChunkedFile(store, key) {
  const meta = await store.get(`${key}_meta`, { type: 'json' });
  if (!meta) throw new Error(`blob missing: ${key}_meta`);
  const parts = [];
  for (let i = 0; i < (meta.chunks || 1); i++) {
    const c = await store.get(`${key}_c${i}`);
    if (c == null) throw new Error(`chunk ${i} missing for ${key}`);
    parts.push(c);
  }
  return { buffer: Buffer.from(parts.join(''), 'base64'), name: meta.name, type: meta.type };
}

async function findOrCreateStoreFolder(drive, storeName) {
  const findRes = await drive.files.list(buildFolderFindQuery(storeName, SHARED_DRIVE_ID));
  const existing = findRes.data.files && findRes.data.files[0];
  if (existing) return existing.id;
  const createRes = await drive.files.create(buildFolderCreateParams(storeName, SHARED_DRIVE_ID));
  return createRes.data.id;
}

async function uploadFile(drive, store, { fileKey, name, mimeType, parentFolderId }) {
  const { buffer } = await readChunkedFile(store, fileKey);
  const params = buildFileUploadParams({ name, mimeType, parentFolderId });
  params.media.body = Readable.from(buffer);
  const res = await drive.files.create(params);
  return res.data.id;
}

async function notifyDriveBackupFailed(store, { reportId, storeName, error }) {
  try {
    const existing = await store.get('pcg_notifications_v1', { type: 'json' });
    const list = Array.isArray(existing) ? existing : (existing?.data || []);
    const entry = {
      id: `incidentdrive_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      type: 'incident_report_drive_backup_failed',
      message: `Drive backup failed for Incident Report #${reportId} (${storeName}): ${error}`,
      read: false, createdAt: new Date().toISOString(),
    };
    await store.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...list].slice(0, 500) });
  } catch (e) { console.warn('[incident-report-drive] failure-notification write failed:', e.message); }
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};
  if (action !== 'backup') return json(400, { error: `Unknown action: ${action}` });

  const sql = db();
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql);
  if (!caller) return json(401, { error: 'Sign in required.' });

  const { reportId, storeName, pdfKey, attachments } = payload;
  if (!reportId || !storeName || !pdfKey) return json(400, { error: 'Missing reportId, storeName, or pdfKey' });

  const blobStore = getBlobStore();
  const uploaded = [];
  const failed = [];

  try {
    const drive = getDriveClient();
    const folderId = await findOrCreateStoreFolder(drive, storeName);

    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      await uploadFile(drive, blobStore, { fileKey: pdfKey, name: `Incident-Report-${reportId}-${dateStr}.pdf`, mimeType: 'application/pdf', parentFolderId: folderId });
      uploaded.push(pdfKey);
    } catch (e) { failed.push({ key: pdfKey, error: e.message }); }

    for (const a of (attachments || [])) {
      try {
        await uploadFile(drive, blobStore, { fileKey: a.fileKey, name: a.name, mimeType: a.mimeType, parentFolderId: folderId });
        uploaded.push(a.fileKey);
      } catch (e) { failed.push({ key: a.fileKey, error: e.message }); }
    }
  } catch (e) {
    // Couldn't even get a Drive client or find/create the folder — everything failed.
    console.error('[incident-report-drive] backup failed entirely:', e.message);
    await notifyDriveBackupFailed(blobStore, { reportId, storeName, error: e.message });
    return json(200, { ok: false, uploaded, failed: [{ key: 'all', error: e.message }] });
  }

  if (failed.length) {
    console.error('[incident-report-drive] partial failure:', JSON.stringify(failed));
    await notifyDriveBackupFailed(blobStore, { reportId, storeName, error: failed.map(f => `${f.key}: ${f.error}`).join('; ') });
  }

  return json(200, { ok: failed.length === 0, uploaded, failed });
};
```

- [ ] **Step 2: Syntax-check**

Run: `node --check netlify/functions/incident-report-drive.mjs`
Expected: no output (success).

- [ ] **Step 3: Do not commit yet**

---

### Task 3: Frontend wiring

**Files:**
- Modify: `app.jsx`

**Interfaces:**
- Consumes: `cloudSaveFile` (existing, ~line 8112), `authHeader()`, `IncidentReportsTab`'s `submit` function (built earlier this session).

- [ ] **Step 1: Add `incident_report_drive_backup_failed` to the admin-only notification types**

Find `ADMIN_ONLY_NOTIF_TYPES` in `app.jsx` and add the new type:

```
old_string:
const ADMIN_ONLY_NOTIF_TYPES = new Set(['manager_change_pending']);
new_string:
const ADMIN_ONLY_NOTIF_TYPES = new Set(['manager_change_pending', 'incident_report_drive_backup_failed']);
```

- [ ] **Step 2: Add a fire-and-forget Drive backup call after a successful submit**

In `IncidentReportsTab`'s `submit` function, after the existing success path (right after `showAlert('success', 'Incident report filed.'); loadReports();` and BEFORE any early return), add a call that does NOT block or get awaited by the rest of the function:

```
old_string:
      setLastFiledId(j.id);
      resetForm();
      setShowForm(false);
      showAlert && showAlert('success', 'Incident report filed.');
      loadReports();
new_string:
      setLastFiledId(j.id);
      // Fire-and-forget Drive backup — never awaited, never blocks the success
      // path above, and any failure here is invisible to the filer (the
      // report is already safely saved; backend logs + notifies exec/IT
      // instead — see incident-report-drive.mjs).
      backupToDrive(j.id, report, form.attachments).catch(() => {});
      resetForm();
      setShowForm(false);
      showAlert && showAlert('success', 'Incident report filed.');
      loadReports();
```

- [ ] **Step 3: Write `backupToDrive`**

Add this function near `exportIncidentReportPdf` (built earlier this session) in `app.jsx` — it builds the same PDF content, but as a chunk-saved blob instead of a browser download, then hands off blob keys (never raw bytes) to the backend:

```jsx
async function backupToDrive(reportId, report, attachmentsBeforeUpload) {
  // Build the exact same PDF the Download button produces, but as a Blob
  // (outputPdf('blob') — same html2pdf API this codebase already uses
  // elsewhere for blob output, e.g. the KB article PDF share feature)
  // instead of triggering a save-to-disk.
  const employeeParty = buildSubjectEmployeeParty(report);
  const { parties } = splitPeopleForPdf(employeeParty ? [employeeParty, ...(report.people || [])] : (report.people || []));
  const rowsHtml = (rows) => rows.map(r => `<tr><td style="padding:4px 8px;border:1px solid #ddd;">${r[0]}</td><td style="padding:4px 8px;border:1px solid #ddd;">${r[1]}</td></tr>`).join('');
  const el = document.createElement('div');
  el.style.cssText = 'width:800px;background:#fff;color:#111;font-family:Arial,sans-serif;padding:24px;font-size:11px;line-height:1.4;';
  el.innerHTML = `
    <div style="text-align:center;border-bottom:2px solid #FF671F;padding-bottom:8px;margin-bottom:14px;">
      <div style="font-weight:700;font-size:13px;">PEOPLE CAPITAL GROUP</div>
      <div style="font-size:9px;font-style:italic;color:#555;">CONFIDENTIAL — INTERNAL USE ONLY</div>
      <div style="font-size:15px;font-weight:800;margin-top:6px;">WORKPLACE INCIDENT REPORT</div>
    </div>
    <h3 style="font-size:12px;margin:10px 0 6px;">Case Information</h3>
    <table style="width:100%;border-collapse:collapse;border:1px solid #ddd;margin-bottom:14px;font-size:11px;">${rowsHtml([
      ['Report Date', report.reportDate || ''], ['Report Prepared By', report.preparedByName || ''],
      ['Incident Date', report.incidentDate || ''], ['Incident Location', `PC#${report.storePC || ''} ${report.address || ''}`],
      ['Incident Type', report.incidentType || ''], ['W/C Claim', report.wcClaim || ''],
      ['Reported Injury', report.reportedInjury || ''],
    ])}</table>
    <h3 style="font-size:12px;margin:10px 0 6px;">Incident Summary</h3>
    <p style="white-space:pre-wrap;">${(report.incidentSummary || '').replace(/</g, '&lt;')}</p>
    <h3 style="font-size:12px;margin:10px 0 6px;">Name / Role of Parties Involved / Witnesses</h3>
    <ol style="margin:0;padding-left:18px;">${parties.map(p => `<li>${p.name} / ${p.role}</li>`).join('')}</ol>
  `;
  let pdfBlob;
  try {
    pdfBlob = await html2pdf().set({
      margin: 0.4, image: { type: 'jpeg', quality: 0.95 }, html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
    }).from(el).outputPdf('blob');
  } catch { return; } // PDF generation failing here just means no Drive backup this time — never surfaced

  const pdfKey = `incident_pdf_${reportId}`;
  await cloudSaveFile(pdfKey, new File([pdfBlob], `incident-${reportId}.pdf`, { type: 'application/pdf' }), report.preparedByName || '');

  const attachmentMeta = (report.attachments || []).map((a, i) => ({ fileKey: a.fileKey, name: a.name, mimeType: a.mimeType }));

  await fetch('/.netlify/functions/incident-report-drive', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ action: 'backup', reportId, storeName: report.storeName || 'Unknown', pdfKey, attachments: attachmentMeta }),
  });
}
```

**Note on the PDF content difference:** this backup PDF intentionally uses a
shorter subset of the full report (skipping the Subject Employee table,
Evidence Preserved, Preparer Certification, and Contact List sections that
the real Download PDF includes) to keep this task's diff focused — if the
implementer judges the backup PDF should be byte-identical to the real
download, factor `exportIncidentReportPdf`'s HTML-building logic out into a
shared function both it and `backupToDrive` call, rather than duplicating
and drifting. Flag this choice in the task report either way.

- [ ] **Step 4: Bump `APP_VERSION`**

Search `const APP_VERSION =` in `app.jsx`, increment the last digit.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 6: Do not commit yet**

---

### Task 4: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all passing, including the 4 new `incident-report-drive.test.mjs` tests.

- [ ] **Step 2: Preview deploy, then production**

Paycor/Google credentials are Production-only (established earlier this session) — a preview deploy can verify the UI doesn't break, but the actual Drive upload can only be tested once pushed to production.

- [ ] **Step 3: File a real test report**

On production, file a test incident report with one photo attached. Confirm:
- The report still files successfully and instantly, with no visible delay from the Drive backup work happening in the background.
- Within a few seconds, a "Bustleton" (or whichever test store) subfolder appears under the Shared Drive (`1A2aYyLns90Qv1LqgxZ8HQhxUW9epiP5r`) containing the PDF and the photo.
- Delete that test folder/files from Drive afterward — this was test data, not a real report.

- [ ] **Step 4: Verify the failure path (optional but recommended)**

Temporarily break something (e.g. pass an invalid `pdfKey`) to confirm a failure produces the exec/IT bell notification and a `console.error` log entry, without affecting the report's own success. Revert the temporary break before committing.

- [ ] **Step 5: Single commit**

```bash
git add src/incident-report-drive.mjs src/incident-report-drive.test.mjs netlify/functions/incident-report-drive.mjs app.jsx app.js docs/superpowers/specs/2026-09-28-incident-report-drive-backup-design.md docs/superpowers/plans/2026-09-28-incident-report-drive-backup.md
git commit -m "feat(incident-reports): back up PDF + evidence to Google Drive on file"
```

Also remove the temporary `google-service-account-email.mjs` diagnostic
(its job — getting the service account's email to share the Shared Drive
with — is done) as part of this same commit:

```bash
git rm netlify/functions/google-service-account-email.mjs
```

Do NOT push — ask the user first, per the standing "never deploy without asking" rule.
