// src/paradox-hires.mjs — pure helpers for the Paradox API hire alerts (v22.43).
// No network, no DB: the every-minute job (netlify/functions/paradox-hires-lib/run.mjs)
// does the I/O and uses these to decide what's new and how to read a Paradox row.

export const HIRED_STATUS = 'Hire: Hired';

// One row of GET /candidates → the fields the alert needs. Paradox leaves hired_date empty
// (confirmed 2026-11-03), so the hire time is the candidate's updated_at — the moment the
// status flipped to Hired — falling back to "now" (when we first saw it).
export function readHiredRow(row, nowIso = new Date().toISOString()) {
  const c = (row && row.candidate) || {};
  const oid = c.OID != null ? String(c.OID) : null;
  if (!oid) return null;
  const t = Date.parse(c.hired_date || c.updated_at || '');
  return {
    oid,
    name: String(c.name || '').trim() || 'Unknown candidate',
    email: c.email ? String(c.email).trim() : null,
    jobReqId: c.job_req_id ? String(c.job_req_id) : null,
    status: String(c.candidate_journey_status || ''),
    hiredAt: Number.isFinite(t) ? new Date(t).toISOString() : nowIso,
  };
}

// Hired rows we haven't recorded yet (by Paradox OID). Only rows whose status really is
// "Hire: Hired" count — the API filter is trusted, but checked again here.
export function newHires(rows, seenOids) {
  const seen = seenOids instanceof Set ? seenOids : new Set(seenOids || []);
  const out = [];
  const dupe = new Set();
  for (const r of rows || []) {
    if (!r || !r.oid || seen.has(r.oid) || dupe.has(r.oid)) continue;
    if (!/^hire:\s*hired$/i.test(r.status)) continue;
    dupe.add(r.oid);
    out.push(r);
  }
  return out;
}

// Where hire alerts come from (Admin → New Hires): 'email' = the store-mailbox scan
// (original, every 5 min) sends them; 'paradox' = this API job sends them and the mailbox
// scan only records. Anything else reads as 'email' so a missing setting never goes quiet.
export function hireSource(cfg) {
  return cfg && cfg.source === 'paradox' ? 'paradox' : 'email';
}
