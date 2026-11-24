// PCG Portal — Cloud Storage via Netlify Blobs
// Handles save/load of scorecard data so it persists across devices & browsers

import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { reconcileReportRefs, canUploadReportPhotos } from '../../src/report-photos.mjs';
import { REPORT_PDF_PREFIX } from '../../src/report-pdf-chunks.mjs';
import { REPORT_INDEX_KEY, REPORT_LEGACY_KEY, REPORT_DELETED_KEY, mergeReportList, missingFromIncoming, addDeleted, deletedIds } from '../../src/report-index.mjs';

// A Daily Report blob (pcg_dr_<id>) — not its legacy photo map (pcg_dr_<id>_photos).
const isDailyReportKey = (k) => k.startsWith('pcg_dr_') && !k.endsWith('_photos');

async function canTombstone(request) {
  try {
    const shim = { headers: { authorization: request.headers.get('authorization') || '', cookie: request.headers.get('cookie') || '' } };
    const claims = await requireActiveUser(shim, sql());
    return !!claims && canUploadReportPhotos(claims.userType);
  } catch (e) { console.warn('[storage] tombstone auth check failed:', e.message); return false; }
}

export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST')   return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  let payload;
  try { payload = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers }); }

  const { action, key, data } = payload;
  if (!action || !key) return new Response(JSON.stringify({ error: 'Missing action or key' }), { status: 400, headers });

  // Sanitize key — allow alphanumeric, underscore, hyphen, slash, dot (for path-style keys like analyst/briefs/...)
  const safeKey = key.replace(/[^a-zA-Z0-9_\-/.]/g, '_').slice(0, 128);

  // Emailed report PDFs are public links — only report-pdf.mjs (signed in) may write or read them.
  if (safeKey.startsWith(REPORT_PDF_PREFIX)) return new Response(JSON.stringify({ error: 'Not allowed' }), { status: 403, headers });

  // The deleted-reports record decides what can never be saved again — it is only ever
  // changed by the signed-in delete path below, never written or removed directly.
  if (safeKey === REPORT_DELETED_KEY && action !== 'load') return new Response(JSON.stringify({ error: 'Not allowed' }), { status: 403, headers });

  try {
    const store = getStore({
      name: 'pcg-portal',
      consistency: 'strong',
      siteID: process.env.PCG_SITE_ID,
      token: process.env.PCG_AUTH_TOKEN,
    });

    if (action === 'save') {
      if (!data) return new Response(JSON.stringify({ error: 'Missing data' }), { status: 400, headers });
      let toStore = data;
      // v23.13: once a report's old inline photos were converted to separate photos, a copy
      // of it loaded before that must not write the inline photos back (they'd show twice).
      if (safeKey.startsWith('pcg_dr_') && safeKey.endsWith('_photos') && data && typeof data === 'object' && Object.keys(data).length > 0) {
        try {
          const report = await store.get(safeKey.slice(0, -'_photos'.length), { type: 'json' });
          if (report?.data?.legacyConvertedAt) return new Response(JSON.stringify({ ok: true, key: safeKey, skipped: 'converted' }), { status: 200, headers });
        } catch (e) { console.warn('[storage] converted-report check skipped:', e.message); }
      }
      // v23.11: the copy being saved can be out of date (a second person with the report open,
      // Force Sync, a browser on older app code) — photo references someone else added are
      // carried over, and only an explicit removal takes one out (src/report-photos.mjs).
      if (isDailyReportKey(safeKey) && data && typeof data === 'object') {
        try {
          const [existing, delRec] = await Promise.all([store.get(safeKey, { type: 'json' }), store.get(REPORT_DELETED_KEY, { type: 'json' })]);
          // v23.18: a report someone deleted is not brought back by a device that still has it
          if (deletedIds(delRec?.data).has(safeKey.slice('pcg_dr_'.length))) {
            return new Response(JSON.stringify({ ok: true, key: safeKey, skipped: 'deleted' }), { status: 200, headers });
          }
          toStore = reconcileReportRefs(data, existing?.data);
        } catch (e) { console.warn('[storage] photo-ref reconcile skipped:', e.message); }
      }
      // v23.18: the shared report list (and the legacy all-reports backup) is MERGED with
      // what is stored, not replaced — the saving device's copy may be missing a report
      // someone else just created (src/report-index.mjs).
      if ((safeKey === REPORT_INDEX_KEY || safeKey === REPORT_LEGACY_KEY) && Array.isArray(data)) {
        try {
          const [existing, delRec] = await Promise.all([store.get(safeKey, { type: 'json' }), store.get(REPORT_DELETED_KEY, { type: 'json' })]);
          const deleted = deletedIds(delRec?.data);
          if (safeKey === REPORT_INDEX_KEY) {
            // a listed report this copy lacks is kept only while its report blob exists
            const missing = missingFromIncoming(existing?.data, data).filter(id => !deleted.has(id)).slice(0, 40);
            const found = await Promise.all(missing.map(id => store.getMetadata(`pcg_dr_${id}`).then(m => m !== null, () => true)));
            missing.forEach((id, i) => { if (!found[i]) deleted.add(id); });
          }
          toStore = mergeReportList(existing?.data, data, { deleted, preferContent: safeKey === REPORT_LEGACY_KEY });
        } catch (e) { console.warn('[storage] report-list merge skipped:', e.message); }
      }
      await store.setJSON(safeKey, { savedAt: new Date().toISOString(), data: toStore });
      return new Response(JSON.stringify({ ok: true, key: safeKey }), { status: 200, headers });
    }

    if (action === 'load') {
      const result = await store.get(safeKey, { type: 'json' });
      if (!result) return new Response(JSON.stringify({ ok: true, data: null }), { status: 200, headers });
      return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers });
    }

    if (action === 'delete') {
      // v23.18: a user deleting a report records it, so no other device's copy revives it
      // Only for a signed-in user who can edit reports, and only for a report that exists.
      if (payload.tombstone === true && isDailyReportKey(safeKey) && await canTombstone(request) && await store.getMetadata(safeKey).then(m => m !== null, () => false)) {
        const rec = await store.get(REPORT_DELETED_KEY, { type: 'json' }).catch(() => null);
        await store.setJSON(REPORT_DELETED_KEY, { savedAt: new Date().toISOString(), data: addDeleted(rec?.data, safeKey.slice('pcg_dr_'.length), new Date().toISOString()) });
      }
      await store.delete(safeKey);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers });

  } catch (err) {
    console.error('Storage error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
