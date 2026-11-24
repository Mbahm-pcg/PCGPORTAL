import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exifTakenAt } from './exif-date.mjs';

// Build a minimal JPEG: SOI + APP1(Exif) with IFD0 → [DateTime?, ExifIFD → DateTimeOriginal?]
function jpeg({ le = true, original, dateTime, pad = 0 } = {}) {
  const tiff = [];
  const w16 = (v) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const w32 = (v) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const str = (s) => [...Buffer.from(s + '\0', 'latin1')];
  const ifd0Count = (dateTime ? 1 : 0) + (original ? 1 : 0);
  const ifd0At = 8, ifd0Len = 2 + ifd0Count * 12 + 4;
  let dataAt = ifd0At + ifd0Len;
  const dtAt = dataAt; if (dateTime) dataAt += 20;
  const subAt = dataAt; if (original) dataAt += 2 + 12 + 4;
  const origAt = dataAt;
  tiff.push(...(le ? [0x49, 0x49] : [0x4D, 0x4D]), ...w16(42), ...w32(ifd0At));
  tiff.push(...w16(ifd0Count));
  if (dateTime) tiff.push(...w16(0x0132), ...w16(2), ...w32(20), ...w32(dtAt));
  if (original) tiff.push(...w16(0x8769), ...w16(4), ...w32(1), ...w32(subAt));
  tiff.push(...w32(0));
  if (dateTime) tiff.push(...str(dateTime));
  if (original) tiff.push(...w16(1), ...w16(0x9003), ...w16(2), ...w32(20), ...w32(origAt), ...w32(0), ...str(original));
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const seg = (marker, body) => [0xFF, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  return new Uint8Array([0xFF, 0xD8, ...(pad ? seg(0xE0, new Array(pad).fill(0)) : []), ...seg(0xE1, app1), 0xFF, 0xDA, 0, 2, 0xFF, 0xD9]);
}

test('reads DateTimeOriginal, either byte order, after other segments', () => {
  assert.equal(exifTakenAt(jpeg({ original: '2026:11:24 09:15:02' })), '2026-11-24T09:15:02');
  assert.equal(exifTakenAt(jpeg({ le: false, original: '2026:11:24 09:15:02', pad: 14 })), '2026-11-24T09:15:02');
});
test('prefers the original capture time over the file-changed time; falls back to it', () => {
  assert.equal(exifTakenAt(jpeg({ original: '2026:11:20 08:00:00', dateTime: '2026:11:23 17:30:00' })), '2026-11-20T08:00:00');
  assert.equal(exifTakenAt(jpeg({ dateTime: '2026:11:23 17:30:00' })), '2026-11-23T17:30:00');
});
test('no usable date → null, never throws', () => {
  assert.equal(exifTakenAt(jpeg({ original: '0000:00:00 00:00:00' })), null);
  assert.equal(exifTakenAt(jpeg({})), null);
  assert.equal(exifTakenAt(new Uint8Array([0x89, 0x50, 0x4E, 0x47])), null); // PNG
  assert.equal(exifTakenAt(new Uint8Array(0)), null);
  assert.equal(exifTakenAt(jpeg({ original: '2026:11:24 09:15:02' }).slice(0, 30)), null); // cut off
  assert.equal(exifTakenAt(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF, 0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2])), null);
});
