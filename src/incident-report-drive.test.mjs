import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderFindQuery, buildFolderCreateParams, buildFileUploadParams } from './incident-report-drive.mjs';

const DRIVE_ID = '1A2aYyLns90Qv1LqgxZ8HQhxUW9epiP5r';

test('buildFolderFindQuery: searches all drives (target is a Shared Drive folder since v21.97) without pinning a driveId', () => {
  const q = buildFolderFindQuery('Bustleton', DRIVE_ID);
  assert.equal(q.supportsAllDrives, true);
  // Without includeItemsFromAllDrives + corpora:allDrives, files.list silently skips
  // Shared Drive items, the store folder is never found, and a duplicate is created
  // on every backup. driveId stays unset: it errors unless the ID is a Shared Drive
  // ROOT, and the target here is a folder inside one.
  assert.equal(q.includeItemsFromAllDrives, true);
  assert.equal(q.corpora, 'allDrives');
  assert.equal(q.driveId, undefined);
  assert.match(q.q, /name = 'Bustleton'/);
  assert.ok(q.q.includes("mimeType = 'application/vnd.google-apps.folder'"));
  assert.match(q.q, new RegExp(`'${DRIVE_ID}' in parents`));
});

test('buildFolderFindQuery: escapes a single quote in the store name (e.g. an apostrophe)', () => {
  const q = buildFolderFindQuery("O'Malley's", DRIVE_ID);
  assert.match(q.q, /name = 'O\\'Malley\\'s'/);
});

test('buildFolderCreateParams: creates a folder under the target folder', () => {
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

// ── v22.3: correct decoding + no duplicate uploads ───────────────────────────
import { unwrapStoredValue, decodeChunkedFile, buildTaggedUploadParams, buildTaggedFileQuery, buildSameNameUntaggedQuery } from './incident-report-drive.mjs';

test('unwrapStoredValue: unwraps the {savedAt, data} blob wrapper, passes plain values through', () => {
  assert.deepEqual(unwrapStoredValue({ savedAt: 'x', data: { chunks: 2 } }), { chunks: 2 });
  assert.equal(unwrapStoredValue({ savedAt: 'x', data: 'QUJD' }), 'QUJD');
  assert.equal(unwrapStoredValue('QUJD'), 'QUJD');
  assert.equal(unwrapStoredValue(null), null);
});

test('decodeChunkedFile: joins the base64 inside each wrapped chunk — never the wrapper JSON', () => {
  const pdf = Buffer.from('%PDF-1.3 hello world');
  const b64 = pdf.toString('base64');
  const chunks = [{ savedAt: 't', data: b64.slice(0, 10) }, { savedAt: 't', data: b64.slice(10) }];
  const out = decodeChunkedFile(chunks);
  assert.equal(out.toString(), '%PDF-1.3 hello world');
});

test('buildTaggedUploadParams: tags the file with appProperties.pcgKey', () => {
  const p = buildTaggedUploadParams({ name: 'r.pdf', mimeType: 'application/pdf', parentFolderId: 'f1', pcgKey: 'pdf:123:original' });
  assert.deepEqual(p.requestBody, { name: 'r.pdf', parents: ['f1'], appProperties: { pcgKey: 'pdf:123:original' } });
  assert.equal(p.supportsAllDrives, true);
});

test('buildTaggedFileQuery: finds an already-uploaded copy by tag inside the folder', () => {
  const q = buildTaggedFileQuery('att:incident_media_1_0', 'f1');
  assert.ok(q.q.includes("appProperties has { key='pcgKey' and value='att:incident_media_1_0' }"));
  assert.ok(q.q.includes("'f1' in parents"));
  assert.equal(q.includeItemsFromAllDrives, true);
});

test('buildSameNameUntaggedQuery: same-name files (escaped) in the folder, not trashed', () => {
  const q = buildSameNameUntaggedQuery("O'Neil.png", 'f1');
  assert.ok(q.q.includes("name = 'O\\'Neil.png'"));
  assert.ok(q.q.includes('trashed = false'));
  assert.ok(q.fields.includes('appProperties'));
});

import { buildNamePrefixQuery } from './incident-report-drive.mjs';
test('buildNamePrefixQuery: matches a report PDF from any date', () => {
  const q = buildNamePrefixQuery('Incident-Report-123-', 'f1');
  assert.ok(q.q.startsWith("name contains 'Incident-Report-123-'"));
  assert.ok(q.q.includes("'f1' in parents"));
});
