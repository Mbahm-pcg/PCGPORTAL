// src/report-photo-restore.mjs — put daily-report photos back from the nightly backups (v22.26).
// Pure, no I/O (netlify/functions/reports-photo-restore-background.mjs does the reading/writing).
//
// Each report's photos live in their own blob as a photo map { [workLogIndex]: [photo] }.
// A photo is "real" only if it carries image data — Force Sync (before v22.26) could
// overwrite a report's photo map with an empty map or with data-less placeholders
// ({ name, timestamp, _photoStripped }), which is what this undoes.

export const isRealPhoto = (p) => !!(p && typeof p.data === 'string' && p.data.length > 32);

// { [i]: photos[] } -> { [i]: count of real photos }
export function realCounts(photoMap) {
  const out = {};
  for (const [i, photos] of Object.entries(photoMap && typeof photoMap === 'object' ? photoMap : {})) {
    out[i] = (Array.isArray(photos) ? photos : []).filter(isRealPhoto).length;
  }
  return out;
}
export const totalReal = (photoMap) => Object.values(realCounts(photoMap)).reduce((a, b) => a + b, 0);

// A backed-up report (photos merged into workLogs) -> its photo map.
export function photoMapFromReport(report) {
  const out = {};
  (report && Array.isArray(report.workLogs) ? report.workLogs : []).forEach((w, i) => {
    if (Array.isArray(w.photos) && w.photos.length) out[i] = w.photos;
  });
  return out;
}

// Merge, per work log: take the backup's photos for a log only when the backup has MORE
// real photos for it than the current map (so photos added after the backup are kept).
// Returns { map, restored } — restored = real photos gained.
export function mergePhotoMaps(current, backup) {
  const cur = current && typeof current === 'object' ? current : {};
  const cc = realCounts(cur), bc = realCounts(backup);
  const map = {};
  for (const [i, photos] of Object.entries(cur)) map[i] = photos;
  let restored = 0;
  for (const [i, n] of Object.entries(bc)) {
    const have = cc[i] || 0;
    if (n > have) { map[i] = backup[i].filter(isRealPhoto); restored += n - have; }
  }
  return { map, restored };
}

// Track the best backup per report. Feed backups NEWEST FIRST: a report keeps the first
// (newest) backup that restores the most photos for it.
//   best: Map(reportId -> { backupKey, savedAt, map, restored })
export function considerBackup(best, current, backupKey, savedAt, reports) {
  for (const r of Array.isArray(reports) ? reports : []) {
    if (!r || r.id == null) continue;
    const id = String(r.id);
    const { restored } = mergePhotoMaps(current[id], photoMapFromReport(r));
    if (restored <= 0) continue;
    const prev = best.get(id);
    if (!prev || restored > prev.restored) {
      best.set(id, { backupKey, savedAt, map: photoMapFromReport(r), restored, date: r.date || '', projectId: r.projectId ?? null, preparedBy: r.preparedBy || '' });
    }
  }
  return best;
}

// Summary for the screen (no photo data).
export function summarizePlan(best) {
  const items = [...best.entries()].map(([id, b]) => ({ id, date: b.date, projectId: b.projectId, preparedBy: b.preparedBy, restore: b.restored, from: b.backupKey, savedAt: b.savedAt }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { reports: items.length, photos: items.reduce((s, x) => s + x.restore, 0), items };
}
