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
