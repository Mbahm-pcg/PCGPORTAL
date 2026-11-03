// paradox-probe.mjs — exec/IT-only, read-only check of the Paradox API credentials (v22.43).
// The Paradox_ID / Paradox_API env vars are Netlify secrets, so only code running on Netlify
// can read their real values (the CLI shows a masked copy). This logs in to Paradox and makes
// one GET per endpoint, returning ONLY status codes, record counts and FIELD NAMES — never
// values — so it's safe to open in a browser and share the result. No writes of any kind.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';

const BASE = 'https://api.paradox.ai/api/v1/public';
const ENDPOINTS = ['users', 'locations', 'candidates', 'jobs', 'interviews', 'requisitions', 'groups', 'conversations'];

const json = (status, body) => new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

// Shape only: field names (nested one level), never values.
function shapeOf(rec) {
  if (!rec || typeof rec !== 'object') return typeof rec;
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (Array.isArray(v)) out[k] = v.length && typeof v[0] === 'object' ? ['…', ...Object.keys(v[0] || {})] : 'array';
    else if (v && typeof v === 'object') out[k] = Object.keys(v);
    else out[k] = v === null ? 'null' : typeof v;
  }
  return out;
}

// ?deep=1 — what "Hired" looks like and how a candidate ties to a store. Reports only
// status/stage NAMES with counts, key names, and HTTP codes for candidate paths — no
// names, phones, emails or free text.
async function deepProbe(token) {
  const get = async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const tally = (m, k) => { const key = k == null ? '(none)' : String(k).slice(0, 60); m[key] = (m[key] || 0) + 1; };
  const out = { stageStatus: {}, journeyStatus: {}, interviewStage: {}, journeyShape: null, groupIds: {}, jobReqIdPresent: 0, sampled: 0 };
  let first = null;
  for (let offset = 0; offset < 600; offset += 100) {
    const { status, body } = await get(`/candidates?limit=100&offset=${offset}`);
    if (status !== 200 || !Array.isArray(body?.candidates)) { out.pageError = { offset, status }; break; }
    for (const row of body.candidates) {
      const c = row.candidate || {}, s = row.stage || {};
      first = first || row;
      out.sampled++;
      tally(out.stageStatus, s.status);
      tally(out.journeyStatus, c.candidate_journey_status);
      tally(out.interviewStage, s.interview_stage);
      tally(out.groupIds, c.group_id);
      if (c.job_req_id) out.jobReqIdPresent++;
      if (!out.journeyShape && c.candidate_journey) out.journeyShape = shapeOf(Array.isArray(c.candidate_journey) ? c.candidate_journey[0] : c.candidate_journey);
    }
    if (body.candidates.length < 100) break;
  }
  out.distinctGroups = Object.keys(out.groupIds).length;
  out.groupIds = Object.fromEntries(Object.entries(out.groupIds).slice(0, 15));
  // Where do detail / interviews / locations live? Status codes + key names only.
  const oid = first?.candidate?.OID;
  const paths = oid ? [`/candidates/${oid}`, `/candidates/${oid}/interviews`, `/candidates/${oid}/attributes`, `/interviews?candidate_id=${oid}`, `/candidates/${oid}/journey`,
    // offer letter / application attachments — does the API expose candidate files at all?
    `/candidates/${oid}/documents`, `/candidates/${oid}/attachments`, `/candidates/${oid}/files`, `/candidates/${oid}/resume`,
    `/candidates/${oid}/offer_letter`, `/candidates/${oid}/offers`, `/candidates/${oid}/application`, `/candidates/${oid}/forms`, `/documents?candidate_id=${oid}`,
    // Paradox UI names: "Hire Details" → Offers (Offer Letter) + Candidate Forms (Application)
    `/candidates/${oid}/hire_details`, `/candidates/${oid}/offer_letters`, `/candidates/${oid}/candidate_forms`, `/candidates/${oid}/form_submissions`,
    `/candidates/${oid}/onboarding`, `/offer_letters?candidate_id=${oid}`, `/candidate_forms?candidate_id=${oid}`] : [];
  paths.push('/locations?limit=1', '/location?limit=1', '/companies', '/company', '/jobs?limit=1', '/job?limit=1', '/job_requisitions?limit=1', '/groups?limit=1', '/group?limit=1', '/webhooks', '/events');
  out.paths = {};
  for (const p of paths) {
    const { status, body } = await get(p);
    const label = oid ? p.replace(oid, ':oid') : p;
    out.paths[label] = { status, keys: body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).slice(0, 25) : (Array.isArray(body) ? 'array' : null), error: body?.errors?.[0]?.message || null };
  }
  // Does the list accept an "updated since" filter? (needed to poll cheaply every minute)
  const since = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  out.filters = {};
  for (const q of [`updated_at_from=${since}`, `updated_since=${since}`, `start_date=${since}`, `modified_since=${since}`, 'status=Hired', 'sort=-updated_at']) {
    const { status, body } = await get(`/candidates?limit=1&${q}`);
    out.filters[q] = { status, count: body?.count ?? null };
  }
  return out;
}

// ?deep=2 — how a candidate ties to a store, and what start_date filters on. Patterns only:
// letters → "a", digits → "9", so an ID's SHAPE shows without its value.
const maskPattern = (v) => String(v).replace(/[A-Za-z]/g, 'a').replace(/[0-9]/g, '9').slice(0, 60);
async function deepProbe2(token) {
  const get = async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const out = {};
  const list = await get('/candidates?limit=100&offset=0');
  const rows = Array.isArray(list.body?.candidates) ? list.body.candidates : [];
  const pats = {};
  rows.forEach(r => { const p = maskPattern(r.candidate?.job_req_id ?? '(none)'); pats[p] = (pats[p] || 0) + 1; });
  out.jobReqIdPatterns = pats;
  const reqIds = [...new Set(rows.map(r => r.candidate?.job_req_id).filter(Boolean))];
  out.distinctJobReqIdsIn100 = reqIds.length;
  // A hired candidate's full record: every field name, plus value TYPES only.
  const hired = rows.find(r => /hired/i.test(r.candidate?.candidate_journey_status || '')) || rows[0];
  if (hired?.candidate?.OID) {
    const d = await get(`/candidates/${hired.candidate.OID}`);
    out.detail = { status: d.status, candidate: shapeOf(d.body?.candidate), stage: shapeOf(d.body?.stage) };
  }
  // Can a job req ID unlock a location / job record?
  const rid = reqIds[0];
  out.byJobReq = {};
  if (rid) {
    for (const p of [`/locations?job_loc_code=${encodeURIComponent(rid)}`, `/job?job_req_id=${encodeURIComponent(rid)}`, `/job/${encodeURIComponent(rid)}`, `/jobs/${encodeURIComponent(rid)}`, `/candidates?job_req_id=${encodeURIComponent(rid)}&limit=1`]) {
      const r = await get(p);
      out.byJobReq[p.replace(encodeURIComponent(rid), ':req')] = { status: r.status, keys: r.body && typeof r.body === 'object' ? Object.keys(r.body).slice(0, 20) : null, error: r.body?.errors?.[0]?.message || null, count: r.body?.count ?? null };
    }
  }
  // start_date: does it match on created_at or updated_at? Compare against a date 3 days back.
  const since = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const f = await get(`/candidates?limit=100&start_date=${since}`);
  const fr = Array.isArray(f.body?.candidates) ? f.body.candidates : [];
  out.startDate = {
    since, status: f.status, count: f.body?.count ?? null, sampled: fr.length,
    createdBeforeSince: fr.filter(r => String(r.candidate?.created_at || '') < since).length,
    updatedBeforeSince: fr.filter(r => String(r.candidate?.updated_at || '') < since).length,
    dateShape: fr[0] ? { created_at: maskPattern(fr[0].candidate?.created_at), updated_at: maskPattern(fr[0].candidate?.updated_at) } : null,
  };
  for (const q of [`end_date=${since}`, `date_type=updated&start_date=${since}`, `updated_start_date=${since}`]) {
    const r = await get(`/candidates?limit=1&${q}`);
    out.startDate[q] = { status: r.status, count: r.body?.count ?? null };
  }
  return out;
}

// ?deep=3 — after Paradox granted jobs/locations permission: can we read them now, and
// what fields tie a job to a store? Field names, counts and masked ID shapes only.
async function deepProbe3(token) {
  const get = async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const firstRecord = (body) => {
    if (!body || typeof body !== 'object') return null;
    if (Array.isArray(body)) return body[0] || null;
    const arr = Object.values(body).find(Array.isArray);
    return arr ? arr[0] || null : null;
  };
  const describe = (r) => ({
    status: r.status,
    error: r.body?.errors?.[0]?.message || null,
    topLevelKeys: r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? Object.keys(r.body).slice(0, 20) : null,
    count: r.body?.count ?? r.body?.total ?? null,
    fields: firstRecord(r.body) ? shapeOf(firstRecord(r.body)) : null,
  });
  const out = { paths: {} };
  for (const p of ['/job?limit=1', '/jobs?limit=1', '/job_requisitions?limit=1', '/requisitions?limit=1', '/locations?limit=1', '/location?limit=1', '/locations']) {
    out.paths[p] = describe(await get(p));
  }
  // Try the job/location lookups with a real job_req_id from a candidate (value never returned).
  const c = await get('/candidates?limit=50');
  const rid = (c.body?.candidates || []).map(r => r.candidate?.job_req_id).find(Boolean);
  out.jobReqIdShape = rid ? maskPattern(rid) : null;
  if (rid) {
    const e = encodeURIComponent(rid);
    for (const p of [`/job?job_req_id=${e}`, `/job/${e}`, `/jobs/${e}`, `/job?job_id=${e}`, `/locations?job_loc_code=${e}`]) {
      out.paths[p.replace(e, ':req')] = describe(await get(p));
    }
  }
  return out;
}

// ?deep=5 — per readme.paradox.ai: GET /company/locations lists every location, and
// GET /candidates filters by job_loc_code (store) and candidate_journey_status. Confirms
// (a) which of OUR PC#s are Paradox location codes, (b) the "Hired" filter, (c) store-
// filtered hires. Returns PC numbers, counts and field names only — no candidate data.
async function deepProbe5(token) {
  const get = async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const out = {};
  // Our store list (PC#s) from the same blob the hire alerts use.
  let ours = [];
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
    const raw = await store.get('pcg_stores_v1', { type: 'json' });
    ours = (Array.isArray(raw) ? raw : raw?.data || []).filter(s => s && s.pc != null && !/closed/i.test(s.status || '')).map(s => ({ pc: String(s.pc), name: s.name }));
  } catch (e) { out.storeListError = e.message; }

  const locs = await get('/company/locations');
  const list = Array.isArray(locs.body?.locations) ? locs.body.locations : [];
  out.companyLocations = { status: locs.status, count: list.length, fields: list[0] ? Object.keys(list[0]) : null, statusCounts: list.reduce((m, l) => (m[l.status] = (m[l.status] || 0) + 1, m), {}) };
  const codes = new Set(list.flatMap(l => [l.job_loc_code, l.location_id].filter(Boolean).map(String)));
  out.ourStores = ours.length;
  out.matchedInList = ours.filter(s => codes.has(s.pc)).map(s => `${s.pc} ${s.name}`);
  out.notInList = ours.filter(s => !codes.has(s.pc)).map(s => `${s.pc} ${s.name}`);

  const hired = await get(`/candidates?limit=50&candidate_journey_status=${encodeURIComponent('Hire: Hired')}`);
  const hr = Array.isArray(hired.body?.candidates) ? hired.body.candidates : [];
  out.hiredFilter = {
    status: hired.status, count: hired.body?.count ?? null, returned: hr.length,
    allHired: hr.every(r => /hired/i.test(r.candidate?.candidate_journey_status || '')),
    withHiredDate: hr.filter(r => r.candidate?.hired_date).length,
    hiredDateShape: hr.find(r => r.candidate?.hired_date) ? maskPattern(hr.find(r => r.candidate?.hired_date).candidate.hired_date) : null,
    candidateFields: hr[0] ? Object.keys(hr[0].candidate || {}) : null,
  };
  // Hires per store via the job_loc_code filter (first 10 of our stores, counts only).
  out.hiredByStore = {};
  for (const s of ours.slice(0, 10)) {
    const r = await get(`/candidates?limit=1&job_loc_code=${encodeURIComponent(s.pc)}&candidate_journey_status=${encodeURIComponent('Hire: Hired')}`);
    out.hiredByStore[`${s.pc} ${s.name}`] = { status: r.status, count: r.body?.count ?? null, error: r.body?.errors?.[0]?.message || null };
  }

  // Interviews: (a) inline on the candidate list with interviews=1, (b) the per-candidate
  // history endpoint. Field names + interview status counts only.
  const sched = await get(`/candidates?limit=25&interviews=1&candidate_journey_status=${encodeURIComponent('Interview: Interview Scheduled')}`);
  const sr = Array.isArray(sched.body?.candidates) ? sched.body.candidates : [];
  const withItv = sr.find(r => r.interview || r.interviews || r.candidate?.interview);
  const itvObj = withItv ? (withItv.interview || withItv.interviews || withItv.candidate?.interview) : null;
  out.interviewsInline = { status: sched.status, count: sched.body?.count ?? null, rowKeys: sr[0] ? Object.keys(sr[0]) : null, interviewFields: itvObj ? shapeOf(Array.isArray(itvObj) ? itvObj[0] : itvObj) : null };
  const oid = sr[0]?.candidate?.OID;
  if (oid) {
    const h = await get(`/interview/interview_history?OID=${encodeURIComponent(oid)}&limit=3`);
    const hist = h.body?.interview_history || (Array.isArray(h.body) ? h.body : null);
    const first = Array.isArray(hist) ? hist[0] : null;
    out.interviewHistory = { status: h.status, error: h.body?.errors?.[0]?.message || null, topLevelKeys: h.body && typeof h.body === 'object' && !Array.isArray(h.body) ? Object.keys(h.body) : null, entryFields: first ? shapeOf(first) : null, entries: Array.isArray(hist) ? hist.length : null };
  }

  // The other read-only endpoints in the docs: what each returns (keys, counts, field names).
  out.other = {};
  for (const p of ['/company/conversations', '/company/groups', '/reporting/reports', '/areas', '/users/roles']) {
    const r = await get(p);
    const arr = r.body && typeof r.body === 'object' ? (Array.isArray(r.body) ? r.body : Object.values(r.body).find(Array.isArray)) : null;
    out.other[p] = { status: r.status, error: r.body?.errors?.[0]?.message || null, topLevelKeys: r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? Object.keys(r.body).slice(0, 15) : null, items: Array.isArray(arr) ? arr.length : null, itemFields: Array.isArray(arr) && arr[0] && typeof arr[0] === 'object' ? Object.keys(arr[0]).slice(0, 25) : null };
  }
  // Report names are labels, not personal data — list them.
  const rep = await get('/reporting/reports');
  const repArr = rep.body && typeof rep.body === 'object' ? (Array.isArray(rep.body) ? rep.body : Object.values(rep.body).find(Array.isArray)) : null;
  out.reportNames = Array.isArray(repArr) ? repArr.map(x => x?.name || x?.report_name || x?.type || null).filter(Boolean).slice(0, 30) : null;
  return out;
}

export default async (request) => {
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql());
  if (!authed || (authed.userType !== 'executive' && authed.userType !== 'it')) return json(403, { error: 'forbidden' });

  const id = (process.env.Paradox_ID || '').trim();
  const secret = (process.env.Paradox_API || '').trim();
  const creds = { idLength: id.length, secretLength: secret.length };
  if (!id || !secret) return json(200, { ok: false, creds, error: 'Paradox_ID / Paradox_API not set for this deploy' });

  const authRes = await fetch(`${BASE}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
  });
  const auth = await authRes.json().catch(() => ({}));
  if (!auth.access_token) return json(200, { ok: false, creds, auth: { status: authRes.status, errors: auth.errors || auth } });

  const url = new URL(request.url);
  if (url.searchParams.get('deep') === '1') return json(200, { ok: true, creds, deep: await deepProbe(auth.access_token) });
  if (url.searchParams.get('deep') === '2') return json(200, { ok: true, creds, deep2: await deepProbe2(auth.access_token) });
  if (url.searchParams.get('deep') === '3') return json(200, { ok: true, creds, deep3: await deepProbe3(auth.access_token) });
  if (url.searchParams.get('deep') === '5') return json(200, { ok: true, creds, deep5: await deepProbe5(auth.access_token) });
  if (url.searchParams.get('deep') === '4') {
    // Is a Paradox location code one of our own store numbers? Try PC#, Paycor legal #, and
    // padded/prefixed variants for a few stores. Field names only on a hit.
    const tries = ['343352', '200540', '339616', '345986', '341350', 'PC343352', '0343352', '343352-1', 'Hatboro'];
    const res = {};
    for (const code of tries) {
      const r = await fetch(`${BASE}/locations?job_loc_code=${encodeURIComponent(code)}`, { headers: { Authorization: `Bearer ${auth.access_token}` } });
      const body = await r.json().catch(() => null);
      const rec = body && !Array.isArray(body) ? (Object.values(body).find(Array.isArray)?.[0] || body.location || null) : null;
      res[code] = { status: r.status, error: body?.errors?.[0]?.message || null, topLevelKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 20) : null, fields: rec ? shapeOf(rec) : null };
    }
    return json(200, { ok: true, creds, deep4: res });
  }

  const endpoints = {};
  for (const ep of ENDPOINTS) {
    try {
      const r = await fetch(`${BASE}/${ep}?limit=1`, { headers: { Authorization: `Bearer ${auth.access_token}` } });
      const body = await r.json().catch(() => null);
      if (!r.ok) { endpoints[ep] = { status: r.status, errors: body?.errors || null }; continue; }
      const list = Array.isArray(body) ? body : (Object.values(body || {}).find(Array.isArray) || []);
      const meta = body && !Array.isArray(body) ? Object.fromEntries(Object.entries(body).filter(([, v]) => !Array.isArray(v) && typeof v !== 'object')) : {};
      endpoints[ep] = { status: r.status, topLevelKeys: body && !Array.isArray(body) ? Object.keys(body) : 'array', meta, fields: list[0] ? shapeOf(list[0]) : '(no records)' };
    } catch (err) {
      endpoints[ep] = { error: err.message };
    }
  }
  return json(200, { ok: true, creds, auth: { status: authRes.status, expiresIn: auth.expires_in ?? null, scope: auth.scope ?? null }, endpoints });
};
