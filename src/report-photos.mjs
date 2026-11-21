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
