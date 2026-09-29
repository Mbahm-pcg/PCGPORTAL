import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderFindQuery, buildFolderCreateParams, buildFileUploadParams } from './incident-report-drive.mjs';

const DRIVE_ID = '1A2aYyLns90Qv1LqgxZ8HQhxUW9epiP5r';

test('buildFolderFindQuery: a name+mimeType+parent query, supportsAllDrives but no Shared-Drive-only params', () => {
  const q = buildFolderFindQuery('Bustleton', DRIVE_ID);
  assert.equal(q.supportsAllDrives, true);
  // corpora/driveId/includeItemsFromAllDrives are Shared-Drive-only params —
  // the actual target is a regular "My Drive" folder shared as Editor, and
  // Google's API errors out if driveId doesn't resolve to a real Shared Drive.
  assert.equal(q.includeItemsFromAllDrives, undefined);
  assert.equal(q.corpora, undefined);
  assert.equal(q.driveId, undefined);
  assert.match(q.q, /name = 'Bustleton'/);
  assert.match(q.q, /mimeType = 'application\/vnd\.google-apps\.folder'/);
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
