// src/incident-report-drive.mjs
// Pure logic for the Incident Report → Google Drive backup — no I/O. Builds
// the Drive API v3 request shapes; the caller (incident-report-drive.mjs,
// the Netlify function) supplies the actual Drive client and file bytes.
//
// UPDATE v21.97: the target is now a folder inside a real Shared Drive (service
// accounts have no storage quota of their own, so uploads into a My Drive folder
// always failed). History below kept for context.
//
// Target WAS a regular "My Drive" folder owned by a real Google account
// (Ahmed), shared with Editor access to the service account — NOT a
// genuine Shared Drive (confirmed 2026-09-29: the folder lives under "My
// Drive" in Drive's own UI, not "Shared drives", and the sharing dialog
// grants "Editor," the personal-Drive role — Shared Drives use "Content
// Manager" instead). Google's Shared-Drive-only query parameters
// (corpora:'drive', driveId) specifically validate that the given ID is a
// real Shared Drive and error out otherwise — they must NOT be used here.
// supportsAllDrives:true is still safe to include (a harmless no-op outside
// a Shared Drive context) in case this ever does move to a real Shared
// Drive later.

function escapeForDriveQuery(name) {
  return String(name).replace(/'/g, "\\'");
}

export function buildFolderFindQuery(storeName, driveFolderId) {
  const escaped = escapeForDriveQuery(storeName);
  return {
    q: `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${driveFolderId}' in parents`,
    supportsAllDrives: true,
    // v21.97: target moved to a folder inside a real Shared Drive. Without these two,
    // files.list skips Shared Drive items and every backup would create a duplicate
    // store folder. Still no driveId (only valid for a Shared Drive ROOT id).
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
    fields: 'files(id, name)',
  };
}

export function buildFolderCreateParams(storeName, driveFolderId) {
  return {
    requestBody: { name: storeName, mimeType: 'application/vnd.google-apps.folder', parents: [driveFolderId] },
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

// ── v22.3: correct decoding + no duplicate uploads ───────────────────────────
// Every blob written through storage.mjs is wrapped as { savedAt, data }. The
// Drive backup used to read a file's chunks as raw text and base64-decode the
// WRAPPER JSON, which put garbage bytes at the front of every uploaded PDF/photo
// (Drive showed "error" previews). These unwrap first, then decode.
export function unwrapStoredValue(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'data' in v) return v.data;
  return v;
}

export function decodeChunkedFile(chunks) {
  const b64 = (chunks || []).map(c => {
    const v = unwrapStoredValue(c);
    return typeof v === 'string' ? v : '';
  }).join('');
  return Buffer.from(b64, 'base64');
}

const escQ = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Each uploaded file carries a hidden tag (appProperties.pcgKey) so a second
// run for the same report finds it and skips instead of uploading a duplicate.
export function buildTaggedUploadParams({ name, mimeType, parentFolderId, pcgKey }) {
  return {
    requestBody: { name, parents: [parentFolderId], appProperties: { pcgKey } },
    media: { mimeType },
    supportsAllDrives: true,
    fields: 'id',
  };
}

export function buildTaggedFileQuery(pcgKey, parentFolderId) {
  return {
    q: `appProperties has { key='pcgKey' and value='${escQ(pcgKey)}' } and '${parentFolderId}' in parents and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives',
    fields: 'files(id, name)',
  };
}

// Same-named files in the folder — the caller trashes the untagged ones (copies
// uploaded before v22.3, which are the corrupted ones) before uploading a good copy.
export function buildSameNameUntaggedQuery(name, parentFolderId) {
  return {
    q: `name = '${escQ(name)}' and '${parentFolderId}' in parents and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives',
    fields: 'files(id, name, appProperties)',
  };
}

// Untagged files whose name starts with a prefix (a report's PDFs from any date).
export function buildNamePrefixQuery(prefix, parentFolderId) {
  return {
    q: `name contains '${escQ(prefix)}' and '${parentFolderId}' in parents and trashed = false`,
    supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives',
    fields: 'files(id, name, appProperties)',
  };
}
