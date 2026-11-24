// Daily Report photos — browser-side upload helpers, shared by the desktop report screen
// (DailyReportSection) and the phone field app (ConstructionMobileView) in app.jsx.
// Spec: docs/superpowers/specs/2026-11-21-daily-report-photos-design.md
//
// Each photo is uploaded on its own (two sizes), so a report is no longer limited by how
// many photos fit in one ~6 MB request.
import { authHeader } from './portal-auth.mjs';
import { splitBase64, MAX_CHUNKS } from './report-pdf-chunks.mjs';
import { exifTakenAt } from './exif-date.mjs';

export const FULL_WIDTH = 1600, FULL_QUALITY = 0.75;  // tap-to-zoom, Project Gallery
export const MED_WIDTH = 800, MED_QUALITY = 0.7;      // report screen + PDF tile (2" wide)
export const UPLOAD_CONCURRENCY = 3;

const PHOTOS_URL = '/.netlify/functions/project-photos';
const PDF_URL = '/.netlify/functions/report-pdf';
const PHOTO_LINK_URL = '/.netlify/functions/report-photo';

// Run `worker(item, index)` over items, at most `limit` at a time. Never rejects: one
// failure must not stop the other photos. → [{ ok, value } | { ok:false, error }] in input order.
export async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { ok: true, value: await worker(items[i], i) }; }
      catch (error) { results[i] = { ok: false, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}

// Retry `fn` on thrown errors flagged retryable (network failures, 5xx).
export async function withRetry(fn, { retries = 2, delayMs = 800, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(attempt); }
    catch (e) {
      if (attempt >= retries || e?.retryable === false) throw e;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('This file could not be read as a photo'));
  img.src = src;
});

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('This file could not be read'));
  r.readAsDataURL(file);
});

function drawScaled(img, maxWidth, quality) {
  const scale = Math.min(1, maxWidth / img.width); // never upscale
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

// Re-encode an image data URL at ≤ maxWidth. Returns the source untouched if it's already
// small enough to gain nothing (used to shrink old inline photos for the PDF).
export async function scaleImageDataUrl(src, maxWidth = MED_WIDTH, quality = MED_QUALITY) {
  const img = await loadImage(src);
  if (img.width <= maxWidth) return src;
  return drawScaled(img, maxWidth, quality);
}

// When the camera says the photo was taken ('YYYY-MM-DDTHH:MM:SS') or null. Must be read
// from the ORIGINAL file — the resized copies below no longer carry it.
export async function readTakenAt(file) {
  try { return exifTakenAt(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())); }
  catch { return null; }
}

// → { full, med } JPEG data URLs.
export async function makeRenditions(file) {
  const img = await loadImage(await readAsDataUrl(file));
  return { full: drawScaled(img, FULL_WIDTH, FULL_QUALITY), med: drawScaled(img, MED_WIDTH, MED_QUALITY) };
}

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    });
  } catch { throw Object.assign(new Error('No connection'), { retryable: true }); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j?.ok) {
    const msg = j?.error || (res.status === 401 ? 'Please sign in again' : `Upload failed (${res.status})`);
    throw Object.assign(new Error(msg), { retryable: res.status >= 500, status: res.status });
  }
  return j;
}

// Upload one photo (both sizes). → the fields a report stores for it.
// `clientRef` is a one-off id for this photo: if the request succeeded but the reply was lost,
// the retry gets the same photo back instead of creating a second copy.
// Optional: takenAt, caption; sourceRef + createdAt when converting an old report's photo.
export async function uploadReportPhoto({ projectId, projectNickname, reportId, fileName, full, med, clientRef, takenAt, caption, sourceRef, createdAt, contentHash }) {
  const j = await withRetry(() => postJson(PHOTOS_URL, {
    action: 'createForReport', projectId, projectNickname, reportId, fileName, clientRef, takenAt, caption, sourceRef, createdAt, contentHash,
    imageBase64: full, mediumBase64: med,
  }));
  return { photoId: j.photo.id, fullKey: j.photo.imageKey, medKey: j.photo.medKey };
}

// Full-size links for a report PDF's photos — open without signing in, like the PDF link
// itself. → Map photoId → absolute URL. Never throws: a PDF without links is still a PDF.
export async function fetchPhotoLinks(photoIds) {
  const out = new Map();
  const ids = [...new Set((photoIds || []).filter(Boolean))];
  if (!ids.length) return out;
  try {
    const j = await postJson(PHOTOS_URL, { action: 'shareLinks', ids });
    for (const [id, token] of Object.entries(j.tokens || {})) out.set(id, `${window.location.origin}${PHOTO_LINK_URL}?t=${token}`);
  } catch { /* no links this time */ }
  return out;
}

// sha-256 (hex) of a string — identifies an old inline photo by its content.
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

// Copy the captions typed in a report onto its photos' gallery records. Best effort.
export async function saveReportCaptions(reportId, items) {
  if (reportId == null || !items?.length) return;
  try { await postJson(PHOTOS_URL, { action: 'setCaptions', reportId, items }); } catch { /* the report itself holds the caption */ }
}

// Soft-delete photos that were removed from a report. Best effort — never throws.
export async function removeReportPhotos(ids, reportId) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return;
  try { await postJson(PHOTOS_URL, { action: 'removeFromReport', ids: list, reportId }); } catch { /* purge is not user-facing */ }
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the PDF'));
  r.readAsDataURL(blob);
});

// Upload a finished PDF for emailing. → absolute link (works without signing in).
export async function uploadReportPdf(blob, fileName) {
  const parts = splitBase64(await blobToBase64(blob));
  if (parts.length > MAX_CHUNKS) throw new Error('This report is too large to email (over 18 MB).');
  // The link's secret is made here (not by the server) so a retried request lands on the
  // same upload instead of starting a second one.
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  for (let index = 0; index < parts.length; index++) {
    await withRetry(() => postJson(PDF_URL, { action: 'put', token, index, total: parts.length, chunk: parts[index], fileName }));
  }
  return `${window.location.origin}${PDF_URL}?t=${token}`;
}
