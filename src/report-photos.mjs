// Daily Report photos — pure storage-shape logic, shared by app.jsx and the nightly
// backup (netlify/functions/reports-backup.mjs). No DOM, no network.
// Spec: docs/superpowers/specs/2026-11-21-daily-report-photos-design.md
//
// A work log's `photos` array can hold two kinds of entries:
//   legacy — { data, name, timestamp }                     image inline as a base64 data URL;
//            persisted together in the pcg_dr_{id}_photos blob (the "photo map").
//   ref    — { photoId, fullKey, medKey, name, timestamp }  image lives in its own blobs
//            (project_photos row); persisted inside the report blob itself.
// While a form is open a photo may also carry transient fields (_status, _localId, _error,
// and for refs a local `data` preview). Those never reach storage.

export const PHOTO_FORMAT_VERSION = 2; // stamped on every report blob saved by v23.00+ code
export const REPORT_PHOTO_ROLES = ['executive', 'it', 'office_staff', 'construction'];
export const canUploadReportPhotos = (userType) => REPORT_PHOTO_ROLES.includes(userType);

export const isRefPhoto = (p) => !!(p && typeof p.photoId === 'string' && p.photoId.length > 0);

export const isPendingPhoto = (p) => !!(p && (p._status === 'uploading' || p._status === 'failed'));

// A legacy photo with real image data (not a `_photoStripped` placeholder / empty entry).
export const isRealReportPhoto = (p) =>
  !!(p && !isRefPhoto(p) && !isPendingPhoto(p) && typeof p.data === 'string' && p.data.length > 32);

export function cleanRef(p) {
  return { photoId: p.photoId, fullKey: p.fullKey, medKey: p.medKey, name: p.name, timestamp: p.timestamp };
}

// → { slimReport, photoMap, hasReal }
//   slimReport — what goes in pcg_dr_{id}: everything except legacy image data.
//   photoMap   — { [workLogIndex]: legacyPhoto[] } for pcg_dr_{id}_photos.
//   hasReal    — this copy carries at least one legacy photo with real data.
export function splitReportForSave(report) {
  const photoMap = {};
  let hasReal = false;
  const { _photosLoaded, ...rest } = report || {};
  const slimReport = {
    ...rest,
    _pv: PHOTO_FORMAT_VERSION,
    workLogs: (rest.workLogs || []).map((w, i) => {
      const photos = w.photos || [];
      const real = photos.filter(isRealReportPhoto);
      if (real.length > 0) { photoMap[i] = real; hasReal = true; }
      return { ...w, photos: photos.filter(p => isRefPhoto(p) && !isPendingPhoto(p)).map(cleanRef) };
    }),
  };
  return { slimReport, photoMap, hasReal };
}

// Recombine a loaded report blob with its photo map. Legacy photos come first so their
// position (used by the Project Gallery's "dr_<report>_<log>_<n>" source_ref) never shifts.
export function mergeLoadedReport(report, photoMap) {
  if (!report) return report;
  if (!photoMap || typeof photoMap !== 'object') return report;
  return {
    ...report,
    workLogs: (report.workLogs || []).map((w, i) => {
      const fromMap = photoMap[i];
      if (!Array.isArray(fromMap)) return { ...w, photos: w.photos || [] };
      return { ...w, photos: [...fromMap, ...(w.photos || []).filter(isRefPhoto)] };
    }),
  };
}

// Guard against a browser still running a pre-v23.00 copy of the app. That code knows
// nothing about photo refs: it saves every report with `photos: []` (or data-less
// placeholders), which would silently drop the refs from the report blob. A save from
// current code is stamped `_pv: 2`; anything else that arrives for a report whose stored
// copy has refs gets those refs carried over (same work-log position; refs of a work log
// that no longer exists move to the last one).
//   → the report to store (the `incoming` object itself when nothing needs carrying)
export function preserveRefsFromOldClient(incoming, existing) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  if (incoming._pv === PHOTO_FORMAT_VERSION) return incoming;
  const oldLogs = Array.isArray(existing?.workLogs) ? existing.workLogs : [];
  const refsByLog = oldLogs.map(w => (w?.photos || []).filter(isRefPhoto).map(cleanRef));
  if (!refsByLog.some(r => r.length)) return incoming;
  const logs = Array.isArray(incoming.workLogs) ? incoming.workLogs.map(w => ({ ...w })) : [];
  if (!logs.length) logs.push({ name: '', description: '', quantity: '', totalHours: '', hoursToDate: '', photos: [] });
  refsByLog.forEach((refs, i) => {
    if (!refs.length) return;
    const target = logs[Math.min(i, logs.length - 1)];
    const have = new Set((target.photos || []).filter(isRefPhoto).map(p => p.photoId));
    target.photos = [...(target.photos || []).filter(isRefPhoto), ...refs.filter(r => !have.has(r.photoId))];
  });
  return { ...incoming, workLogs: logs, _pv: PHOTO_FORMAT_VERSION };
}

// For localStorage: no image data at all. Refs keep their keys (they are tiny).
export function stripReportPhotosForLocal(report) {
  if (!report) return report;
  return {
    ...report,
    workLogs: (report.workLogs || []).map(w => ({
      ...w,
      photos: (w.photos || []).filter(p => !isPendingPhoto(p)).map(p =>
        isRefPhoto(p) ? cleanRef(p) : { name: p.name, timestamp: p.timestamp, _photoStripped: true }),
    })),
  };
}

// total = photos that belong to the report (refs + legacy, incl. stripped placeholders);
// pending = still uploading / failed in an open form (not part of total).
export function countReportPhotos(report) {
  const out = { total: 0, refs: 0, legacy: 0, pending: 0 };
  for (const w of (report?.workLogs || [])) {
    for (const p of (w.photos || [])) {
      if (!p) continue;
      if (isPendingPhoto(p)) out.pending++;
      else if (isRefPhoto(p)) { out.refs++; out.total++; }
      else { out.legacy++; out.total++; }
    }
  }
  return out;
}
