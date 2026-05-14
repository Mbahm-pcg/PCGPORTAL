// reports-backup.js — Daily snapshot of all daily reports (with photos) to a dated backup blob.
// Scheduled: 11:59 PM ET daily (4:59 AM UTC). Keeps 7 days of rolling backups.

const { getStore } = require('@netlify/blobs');

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

exports.handler = async () => {
  console.log('[reports-backup] Starting daily backup');
  const store = getStore_();

  try {
    // 1. Load the report index
    const indexRaw = await store.get(DR_INDEX_KEY, { type: 'json' });
    const index = indexRaw?.data || indexRaw || [];

    if (!Array.isArray(index) || index.length === 0) {
      console.log('[reports-backup] No reports in index — nothing to back up');
      return { statusCode: 200, body: JSON.stringify({ ok: true, backed: 0 }) };
    }

    // 2. Hydrate each report: load metadata blob + photos blob in parallel
    const reports = await Promise.all(index.map(async (meta) => {
      try {
        const id = meta.id;
        const [reportRaw, photosRaw] = await Promise.all([
          store.get(`${DR_KEY_PREFIX}${id}`, { type: 'json' }).catch(() => null),
          store.get(`${DR_KEY_PREFIX}${id}${DR_PHOTOS_SUFFIX}`, { type: 'json' }).catch(() => null),
        ]);
        const report = reportRaw?.data || reportRaw;
        const photoMap = photosRaw?.data || photosRaw;
        if (!report) return null;
        // Merge photos back into workLogs
        if (photoMap && typeof photoMap === 'object') {
          report.workLogs = (report.workLogs || []).map((w, i) => ({
            ...w,
            photos: photoMap[i] || w.photos || [],
          }));
        }
        return report;
      } catch (e) {
        console.warn(`[reports-backup] Failed to load report ${meta.id}:`, e.message);
        return null;
      }
    }));

    const valid = reports.filter(Boolean);
    console.log(`[reports-backup] Hydrated ${valid.length}/${index.length} reports`);

    // 3. Save backup blob for today
    const today = dateStr();
    const backupKey = `${BACKUP_PREFIX}${today}`;
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

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, backed: valid.length, key: backupKey }),
    };
  } catch (e) {
    console.error('[reports-backup] Fatal error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
