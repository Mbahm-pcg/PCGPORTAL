// reports-photo-restore-background.mjs — put daily-report photos back from the nightly
// backups (v22.26). Exec/IT only. Background (15-min budget): reads blobs directly, so the
// ~6 MB request/response limit that the browser's storage calls hit doesn't apply.
//
// Why it exists: before v22.26, Daily Reports "Force Sync" re-uploaded each report from the
// device. For reports whose photos weren't on the device — often because a report's photo
// blob was too big (>6 MB) to download — it saved an EMPTY photo map (or data-less
// placeholders) over the real one. reports-backup.mjs keeps ~8 nightly copies of every
// report WITH photos; this puts the photos back from them.
//
// POST { mode: 'scan' }    → dry run: what each report would get back, from which backup.
// POST { mode: 'restore' } → saves the current photo maps of the affected reports to an
//                            undo blob first, then writes the merged maps (per work log,
//                            only where the backup has MORE real photos — never removes any).
// POST { mode: 'undo', undoKey } → writes the saved photo maps back.
// Result → blob pcg_reports_photo_restore_status (read by reports-photo-restore.mjs).
//
// Sources, newest first: every nightly backup, then the Project Gallery — which keeps its
// own copy of each Daily Report photo (project_photos rows, source_ref
// "dr_<reportId>_<workLog>_<photo#>", image in a blob { base64 }). The scan also reports
// photo totals (now / per backup / gallery) so "nothing to restore" can be explained.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { considerBackup, summarizePlan, mergePhotoMaps, totalReal, photoMapFromReport, realCounts } from '../../src/report-photo-restore.mjs';

const DR_KEY_PREFIX = 'pcg_dr_';
const DR_PHOTOS_SUFFIX = '_photos';
const DR_INDEX_KEY = 'pcg_daily_reports_index_v1';
const BACKUP_PREFIX = 'pcg_daily_reports_backup_';
export const STATUS_KEY = 'pcg_reports_photo_restore_status';

const store = () => getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const unwrap = (raw) => (raw && typeof raw === 'object' && 'data' in raw && 'savedAt' in raw ? raw.data : raw);
const photosKey = (id) => `${DR_KEY_PREFIX}${id}${DR_PHOTOS_SUFFIX}`;

async function setStatus(s, data) {
  await s.setJSON(STATUS_KEY, { savedAt: new Date().toISOString(), data });
}

async function buildPlan(s) {
  const index = unwrap(await s.get(DR_INDEX_KEY, { type: 'json' })) || [];
  const ids = (Array.isArray(index) ? index : []).map(m => String(m.id));
  const current = {};
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map(async (id) => {
      try { current[id] = unwrap(await s.get(photosKey(id), { type: 'json' })) || {}; } catch { current[id] = {}; }
    }));
  }
  const currentPhotos = Object.values(current).reduce((t, m) => t + totalReal(m), 0);
  const { blobs } = await s.list({ prefix: BACKUP_PREFIX });
  const keys = blobs.map(b => b.key).sort().reverse(); // newest first (keys end in YYYYMMDD)
  const best = new Map();
  const backups = [];
  for (const key of keys) {
    try {
      const raw = await s.get(key, { type: 'json' });
      const reports = unwrap(raw);
      considerBackup(best, current, key, raw?.savedAt || null, reports);
      const photos = (Array.isArray(reports) ? reports : []).reduce((t, r) => t + totalReal(photoMapFromReport(r)), 0);
      backups.push({ key, savedAt: raw?.savedAt || null, reports: Array.isArray(reports) ? reports.length : 0, photos });
    } catch (e) { backups.push({ key, error: String(e.message || e).slice(0, 160) }); }
  }
  const gallery = await considerGallery(s, best, current, new Set(ids));
  return { current, best, backups, indexed: ids.length, currentPhotos, gallery };
}

// Project Gallery copies → per-report photo maps. Rows first (cheap); images are only
// loaded for reports where the gallery has more photos than the cloud copy, per log.
async function considerGallery(s, best, current, idSet) {
  let rows = [];
  try {
    rows = await sql()`SELECT source_ref, image_key, created_at FROM project_photos WHERE source_ref LIKE 'dr\\_%' ESCAPE '\\'`;
  } catch (e) { return { error: String(e.message || e).slice(0, 160), photos: 0 }; }
  const byReport = new Map(); // id -> { wi -> [{pi, image_key, created_at}] }
  for (const r of rows) {
    const m = /^dr_(.+)_(\d+)_(\d+)$/.exec(String(r.source_ref || ''));
    if (!m || !idSet.has(m[1])) continue;
    const id = m[1], wi = Number(m[2]), pi = Number(m[3]);
    if (!byReport.has(id)) byReport.set(id, {});
    const logs = byReport.get(id);
    (logs[wi] ||= []).push({ pi, image_key: r.image_key, created_at: r.created_at });
  }
  let photos = 0;
  for (const logs of byReport.values()) for (const l of Object.values(logs)) photos += l.length;
  for (const [id, logs] of byReport.entries()) {
    const have = realCounts(current[id] || {});
    if (!Object.entries(logs).some(([wi, l]) => l.length > (have[wi] || 0))) continue;
    const workLogs = [];
    for (const [wi, l] of Object.entries(logs)) {
      l.sort((a, b) => a.pi - b.pi);
      const loaded = [];
      for (const p of l) {
        try {
          const raw = await s.get(p.image_key, { type: 'json' });
          const data = (raw?.data || raw)?.base64;
          if (typeof data === 'string' && data.length > 32) loaded.push({ data, name: `photo_${p.pi + 1}.jpg`, timestamp: p.created_at ? new Date(p.created_at).toISOString().slice(0, 19) : '' });
        } catch {}
      }
      workLogs[Number(wi)] = { photos: loaded };
    }
    for (let i = 0; i < workLogs.length; i++) if (!workLogs[i]) workLogs[i] = { photos: [] };
    considerBackup(best, current, 'project_gallery', null, [{ id, workLogs }]);
  }
  return { photos, reports: byReport.size };
}

export default async (request) => {
  const s = store();
  let caller = null;
  try { caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql()); } catch {}
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) return new Response('', { status: 403 });
  const body = await request.json().catch(() => ({}));
  const mode = ['scan', 'restore', 'undo'].includes(body.mode) ? body.mode : 'scan';
  const by = caller.username || String(caller.sub);
  const startedAt = new Date().toISOString();
  await setStatus(s, { state: 'running', mode, by, startedAt });

  try {
    if (mode === 'undo') {
      const undo = unwrap(await s.get(String(body.undoKey || ''), { type: 'json' }));
      if (!undo || typeof undo !== 'object') throw new Error('Undo snapshot not found.');
      let n = 0;
      for (const [id, map] of Object.entries(undo)) { await s.setJSON(photosKey(id), { savedAt: new Date().toISOString(), data: map || {} }); n++; }
      await setStatus(s, { state: 'done', mode, by, startedAt, finishedAt: new Date().toISOString(), undone: n });
      return new Response('', { status: 202 });
    }

    const { current, best, backups, indexed, currentPhotos, gallery } = await buildPlan(s);
    const plan = summarizePlan(best);
    if (mode === 'scan') {
      await setStatus(s, { state: 'done', mode, by, startedAt, finishedAt: new Date().toISOString(), indexed, backups, plan, currentPhotos, gallery });
      return new Response('', { status: 202 });
    }

    // restore: snapshot first, then write
    const undoKey = `pcg_reports_photo_restore_undo_${Date.now()}`;
    const snapshot = {};
    for (const id of best.keys()) snapshot[id] = current[id] || {};
    await s.setJSON(undoKey, { savedAt: new Date().toISOString(), data: snapshot });
    let restoredPhotos = 0, restoredReports = 0;
    const failed = [];
    for (const [id, b] of best.entries()) {
      try {
        const { map, restored } = mergePhotoMaps(current[id], b.map);
        if (restored <= 0) continue;
        await s.setJSON(photosKey(id), { savedAt: new Date().toISOString(), data: map });
        restoredPhotos += restored; restoredReports++;
      } catch (e) { failed.push({ id, error: String(e.message || e).slice(0, 120) }); }
    }
    console.log(`[photo-restore] ${by}: restored ${restoredPhotos} photos on ${restoredReports} reports (undo ${undoKey})`);
    await setStatus(s, { state: 'done', mode, by, startedAt, finishedAt: new Date().toISOString(), indexed, backups, plan, currentPhotos, gallery, restoredPhotos, restoredReports, failed, undoKey });
  } catch (e) {
    console.error('[photo-restore] failed:', e);
    await setStatus(s, { state: 'error', mode, by, startedAt, finishedAt: new Date().toISOString(), error: String(e.message || e) });
  }
  return new Response('', { status: 202 });
};
