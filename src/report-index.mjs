// Daily Report list merging — pure. Used by netlify/functions/storage.mjs every time a device
// saves the shared report list (pcg_daily_reports_index_v1) or the legacy all-reports backup
// (pcg_daily_reports_v1).
//
// Each device used to overwrite the whole list with its own copy. A device whose copy was a
// few seconds old (it hadn't yet seen a report someone else just created) knocked that report
// off the list, and it stayed gone until somebody pressed Force Sync. Now the server merges:
//   - a report on the stored list that the incoming list lacks is KEPT, unless it was deleted
//     (`deleted` — ids the user deleted, plus ids whose report blob no longer exists);
//   - for a report on both, the copy with the newer updatedAt wins (incoming on a tie);
//   - with `preferContent`, a copy that has its work logs beats a bare list entry (the phone
//     app writes bare entries to the legacy backup).
export const REPORT_INDEX_KEY = 'pcg_daily_reports_index_v1';
export const REPORT_LEGACY_KEY = 'pcg_daily_reports_v1';
export const REPORT_DELETED_KEY = 'pcg_daily_reports_deleted_v1';
export const MAX_DELETED = 5000;

const idOf = (r) => (r && r.id != null ? String(r.id) : null);
const stamp = (r) => String(r?.updatedAt || r?.createdAt || '');
const hasContent = (r) => Array.isArray(r?.workLogs);

export function mergeReportList(existing, incoming, { deleted = new Set(), preferContent = false } = {}) {
  if (!Array.isArray(incoming)) return incoming;
  const gone = (id) => deleted.has(id);
  const stored = new Map();
  for (const r of (Array.isArray(existing) ? existing : [])) { const id = idOf(r); if (id && !stored.has(id)) stored.set(id, r); }
  const out = [], seen = new Set();
  for (const r of incoming) {
    const id = idOf(r);
    if (!id) { out.push(r); continue; }
    if (seen.has(id) || gone(id)) continue;
    seen.add(id);
    const old = stored.get(id);
    let pick = r;
    if (old) {
      if (stamp(old) > stamp(r)) pick = old;
      else if (preferContent && hasContent(old) && !hasContent(r)) pick = old;
    }
    out.push(pick);
  }
  for (const [id, r] of stored) if (!seen.has(id) && !gone(id)) out.push(r);
  return out;
}

// Ids on the stored list that the incoming list lacks — the ones whose report blob the
// server checks before keeping them.
export function missingFromIncoming(existing, incoming) {
  const have = new Set((Array.isArray(incoming) ? incoming : []).map(idOf).filter(Boolean));
  return (Array.isArray(existing) ? existing : []).map(idOf).filter(id => id && !have.has(id));
}

// The deleted-reports record: { [id]: ISO time deleted }. → a new record with `id` added.
export function addDeleted(record, id, at) {
  const next = { ...(record && typeof record === 'object' && !Array.isArray(record) ? record : {}) };
  next[String(id)] = at;
  const keys = Object.keys(next);
  if (keys.length > MAX_DELETED) {
    keys.sort((a, b) => String(next[a]).localeCompare(String(next[b])));
    for (const k of keys.slice(0, keys.length - MAX_DELETED)) delete next[k];
  }
  return next;
}
export const deletedIds = (record) => new Set(record && typeof record === 'object' && !Array.isArray(record) ? Object.keys(record) : []);
