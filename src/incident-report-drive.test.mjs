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
