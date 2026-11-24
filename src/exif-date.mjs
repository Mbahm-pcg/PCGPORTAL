// When was this photo taken? Reads the capture time a camera writes into a JPEG (EXIF
// DateTimeOriginal). Pure — give it the first bytes of the file. Used by Daily Report photo
// uploads BEFORE the photo is compressed: drawing a photo on a canvas throws its EXIF away.
//   → 'YYYY-MM-DDTHH:MM:SS' (the camera's local wall-clock time, no timezone) or null.
const TAG_EXIF_IFD = 0x8769, TAG_DATETIME = 0x0132, TAG_ORIGINAL = 0x9003, TAG_DIGITIZED = 0x9004;

function parseExifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

export function exifTakenAt(bytes) {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null; // not a JPEG
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 2;
    while (p + 4 <= b.length) {
      if (b[p] !== 0xFF) return null;
      const marker = b[p + 1];
      if (marker === 0xDA || marker === 0xD9) return null; // image data starts — no EXIF found
      const size = view.getUint16(p + 2);
      if (size < 2) return null;
      if (marker === 0xE1 && size >= 8 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
        return readTiff(view, p + 10, Math.min(b.length, p + 2 + size));
      }
      p += 2 + size;
    }
    return null;
  } catch { return null; }
}

function readTiff(view, tiff, end) {
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4D4D) return null;
  const le = order === 0x4949;
  const u16 = (o) => view.getUint16(o, le), u32 = (o) => view.getUint32(o, le);
  const ascii = (entry) => {
    const count = u32(entry + 4);
    const at = count <= 4 ? entry + 8 : tiff + u32(entry + 8);
    if (count < 19 || at + 19 > end) return null;
    let s = '';
    for (let i = 0; i < 19; i++) s += String.fromCharCode(view.getUint8(at + i));
    return parseExifDate(s);
  };
  const scan = (ifd, wanted) => {
    const found = {};
    if (ifd + 2 > end) return found;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > end) break;
      const tag = u16(entry);
      if (wanted.includes(tag)) found[tag] = entry;
    }
    return found;
  };
  const ifd0 = scan(tiff + u32(tiff + 4), [TAG_EXIF_IFD, TAG_DATETIME]);
  if (ifd0[TAG_EXIF_IFD] != null) {
    const sub = scan(tiff + u32(ifd0[TAG_EXIF_IFD] + 8), [TAG_ORIGINAL, TAG_DIGITIZED]);
    for (const tag of [TAG_ORIGINAL, TAG_DIGITIZED]) {
      const v = sub[tag] != null ? ascii(sub[tag]) : null;
      if (v) return v;
    }
  }
  return ifd0[TAG_DATETIME] != null ? ascii(ifd0[TAG_DATETIME]) : null;
}
