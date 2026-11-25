// reports-backup.mjs — Daily snapshot of all daily reports (with photos) to a dated backup blob.
// Scheduled: 11:59 PM ET daily (4:59 AM UTC). Keeps 7 days of rolling backups.

import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { mergeLoadedReport, isRefPhoto, referencedPhotoIds } from '../../src/report-photos.mjs';

const PURGE_AFTER_DAYS = 30;

// v23.11 — Daily Report photos removed from a report are only soft-deleted
// (project_photos.deleted_at). Really delete them (row + both image blobs) 30 days later —
// but never one a report still points at: that happens when a removal was recorded but the
// report save behind it never reached the cloud, and such a photo is restored instead.
// `referenced` = every photo id in tonight's hydrated reports; `complete` = every report in
// the index was read. With an incomplete read nothing is purged (an unread report might
// reference the photo). Never throws: a database problem must not fail the backup.
async function purgeDeletedPhotos(store, referenced, complete) {
  try {
    const db = sql();
    const rows = await db`SELECT id, image_key, med_key, deleted_at FROM project_photos WHERE deleted_at IS NOT NULL LIMIT 2000`;
    const cutoff = Date.now() - PURGE_AFTER_DAYS * 86400000;
    let purged = 0, restored = 0;
    for (const r of rows) {
      if (referenced.has(r.id)) {
        await db`UPDATE project_photos SET deleted_at = NULL WHERE id = ${r.id}`;
        restored++;
        continue;
      }
      if (!complete || new Date(r.deleted_at).getTime() > cutoff) continue;
      await store.delete(r.image_key).catch(() => {});
      if (r.med_key) await store.delete(r.med_key).catch(() => {});
      await db`DELETE FROM project_photos WHERE id = ${r.id} AND deleted_at IS NOT NULL`;
      purged++;
    }
    if (purged || restored) console.log(`[reports-backup] photos: purged ${purged} (removed over ${PURGE_AFTER_DAYS} days ago), restored ${restored} still used by a report`);
    return { purged, restored };
  } catch (e) {
    // e.g. the deleted_at column doesn't exist until project-photos.mjs has run once
    console.warn('[reports-backup] photo purge skipped:', e.message);
    return { purged: 0, restored: 0 };
  }
}
const DR_KEY_PREFIX    = 'pcg_dr_';
const DR_PHOTOS_SUFFIX = '_photos';
const DR_INDEX_KEY     = 'pcg_daily_reports_index_v1';
const BACKUP_PREFIX    = 'pcg_daily_reports_backup_';
const KEEP_DAYS        = 7;

function getStore_() {
  return getStore({
    name: 'pcg-portal',
    consistency: 'strong',
    siteID: process.env.PCG_SITE_ID,
    token: process.env.PCG_AUTH_TOKEN,
  });
}

function dateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  console.log('[reports-backup] Starting backup');
  const store = getStore_();

  try {
    // 1. Load the report index
    const indexRaw = await store.get(DR_INDEX_KEY, { type: 'json' });
    const index = indexRaw?.data || indexRaw || [];

    if (!Array.isArray(index) || index.length === 0) {
      console.log('[reports-backup] No reports in index — nothing to back up');
      return new Response(JSON.stringify({ ok: true, backed: 0 }), { status: 200, headers });
    }

    // 2. Hydrate each report: load metadata blob + photos blob in parallel
    // v23.26 (review): a report whose blob is simply GONE uses no photos, so it must not stop the
    // photo purge; only a read that FAILED (unknown contents) does. Before, either one switched the
    // purge off for good, silently.
    let readErrors = 0;
    const failedRead = () => { readErrors++; return null; };
    const reports = await Promise.all(index.map(async (meta) => {
      try {
        const id = meta.id;
        const [reportRaw, photosRaw] = await Promise.all([
          store.get(`${DR_KEY_PREFIX}${id}`, { type: 'json' }).catch(failedRead),
          store.get(`${DR_KEY_PREFIX}${id}${DR_PHOTOS_SUFFIX}`, { type: 'json' }).catch(failedRead),
        ]);
        const report = reportRaw?.data || reportRaw;
        const photoMap = photosRaw?.data || photosRaw;
        if (!report) return null;
        // Merge legacy photos back into workLogs. v23.11: photo refs already live in the
        // report blob and are kept alongside them (same rules as the app — src/report-photos.mjs).
        return mergeLoadedReport(report, photoMap);
      } catch (e) {
        console.warn(`[reports-backup] Failed to load report ${meta.id}:`, e.message);
        readErrors++;
        return null;
      }
    }));

    const valid = reports.filter(Boolean);
    console.log(`[reports-backup] Hydrated ${valid.length}/${index.length} reports`);

    // 3. Save backup blob for today
    const today = dateStr();
    let backupKey = `${BACKUP_PREFIX}${today}`;
    // v22.26: never replace a same-day backup that holds MORE real photos (a run after
    // photos were wiped would otherwise overwrite the copy needed to restore them) —
    // save alongside it instead.
    const realPhotos = (list) => (Array.isArray(list) ? list : []).reduce((s, r) =>
      s + (r?.workLogs || []).reduce((t, w) => t + (w?.photos || []).filter(p => isRefPhoto(p) || (typeof p?.data === 'string' && p.data.length > 32)).length, 0), 0);
    try {
      const existing = await store.get(backupKey, { type: 'json' });
      const had = realPhotos(existing?.data || existing);
      if (had > realPhotos(valid)) {
        backupKey = `${backupKey}_${Date.now()}`;
        console.warn(`[reports-backup] today's backup has more photos (${had}) — keeping it, saving this run as ${backupKey}`);
      }
    } catch {}
    await store.setJSON(backupKey, {
      savedAt: new Date().toISOString(),
      data: valid,
    });
    console.log(`[reports-backup] Saved backup → ${backupKey} (${valid.length} reports)`);

    // 4. Delete backups older than KEEP_DAYS
    for (let i = KEEP_DAYS + 1; i <= KEEP_DAYS + 3; i++) {
      const oldKey = `${BACKUP_PREFIX}${dateStr(-i)}`;
      try {
        await store.delete(oldKey);
        console.log(`[reports-backup] Deleted old backup: ${oldKey}`);
      } catch {}
    }

    // v23.13 — a converted report's old inline photos are kept as pcg_drbak_<id>_photos for
    // 30 days, then dropped (tried nightly for two weeks after that, then left alone).
    for (const r of valid) {
      const age = r.legacyConvertedAt ? (Date.now() - Date.parse(r.legacyConvertedAt)) / 86400000 : 0;
      if (age > PURGE_AFTER_DAYS && age < PURGE_AFTER_DAYS + 14) await store.delete(`pcg_drbak_${r.id}_photos`).catch(() => {});
    }

    if (readErrors) console.warn(`[reports-backup] photo purge held tonight: ${readErrors} report read(s) failed, so not every photo reference is known`);
    else if (valid.length < index.length) console.log(`[reports-backup] ${index.length - valid.length} listed report(s) no longer exist; purge goes ahead`);
    const photos = await purgeDeletedPhotos(store, referencedPhotoIds(valid), readErrors === 0);

    return new Response(
      JSON.stringify({ ok: true, backed: valid.length, key: backupKey, photos, savedAt: new Date().toISOString() }),
      { status: 200, headers },
    );
  } catch (e) {
    console.error('[reports-backup] Fatal error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
};
