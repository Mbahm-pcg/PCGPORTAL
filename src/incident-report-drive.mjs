// src/incident-report-drive.mjs
// Pure logic for the Incident Report → Google Drive backup — no I/O. Builds
// the Drive API v3 request shapes; the caller (incident-report-drive.mjs,
// the Netlify function) supplies the actual Drive client and file bytes.
//
// Target is a regular "My Drive" folder owned by a real Google account
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
