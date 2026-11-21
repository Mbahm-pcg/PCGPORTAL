import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_CHARS, MAX_CHUNKS, isValidToken, chunkKey, metaKey, safeFileName, splitBase64, chunkProblem } from './report-pdf-chunks.mjs';

test('token must be 64 lowercase hex chars', () => {
  assert.equal(isValidToken('a'.repeat(64)), true);
  assert.equal(isValidToken('A'.repeat(64)), false);
  assert.equal(isValidToken('a'.repeat(63)), false);
  assert.equal(isValidToken('../' + 'a'.repeat(61)), false);
  assert.equal(isValidToken(undefined), false);
});

test('keys', () => {
  assert.equal(chunkKey('ab', 2), 'pcg_report_pdf_ab_c2');
  assert.equal(metaKey('ab'), 'pcg_report_pdf_ab_meta');
});

test('safeFileName strips anything unsafe and forces .pdf', () => {
  assert.equal(safeFileName('Daily_Report_2026-11-20_Rybas.pdf'), 'Daily_Report_2026-11-20_Rybas.pdf');
  assert.equal(safeFileName('../../etc/passwd'), 'etc_passwd.pdf');
  assert.equal(safeFileName('a"b\r\nc.PDF'), 'a_b_c.pdf');
  assert.equal(safeFileName(''), 'Daily_Report.pdf');
});

test('splitBase64 chunks decode independently and re-join to the original bytes', () => {
  assert.equal(CHUNK_CHARS % 4, 0);
  const bytes = Buffer.alloc(CHUNK_CHARS * 3 / 4 * 2 + 1234, 7); // just over two chunks
  bytes[5] = 200; bytes[bytes.length - 1] = 99;
  const parts = splitBase64(bytes.toString('base64'));
  assert.equal(parts.length, 3);
  const back = Buffer.concat(parts.map(p => Buffer.from(p, 'base64')));
  assert.equal(back.equals(bytes), true);
  assert.deepEqual(splitBase64(''), ['']);
});

test('chunkProblem', () => {
  const ok = { index: 0, total: 1, chunk: 'QUJD' };
  assert.equal(chunkProblem(ok), null);
  assert.equal(chunkProblem({ index: 0, total: 1, chunk: 'QUI=' }), null);
  assert.match(chunkProblem({ ...ok, total: MAX_CHUNKS + 1 }), /total/);
  assert.match(chunkProblem({ ...ok, index: 1 }), /index/);
  assert.match(chunkProblem({ ...ok, chunk: '' }), /chunk/);
  assert.match(chunkProblem({ ...ok, chunk: 'x'.repeat(CHUNK_CHARS + 4) }), /too large/);
  assert.match(chunkProblem({ index: 0, total: 2, chunk: 'QUJDR' }), /aligned/);
  assert.match(chunkProblem({ ...ok, chunk: '<script>' }), /base64/);
});
