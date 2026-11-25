// time-off-request.mjs — Tools · Time Off Request (v22.80). Replaces HR's Google Form.
// A Store Manager, DM, Director or exec / IT requests their OWN time off (user, 2026-11-11).
//
//   GET  → { me: { name, email, phone, role, position, location, locations }, balances, linked }
//          prefill from the caller's own account + their Paycor time-off balances (time_off_people,
//          synced daily — the same copy "My time off" reads; never calls Paycor here).
//   POST { values, pdf, documents: [{ name, type, data }] } → the signed PDF and any supporting
//          documents are filed in the "Time Off Requests" Shared Drive (TIMEOFF_DRIVE_FOLDER_ID,
//          folder per location) and Admin · Notifications · Time Off Request is alerted (email
//          with the PDF + documents, text, push, bell).
//          v23.22 (user, 2026-11-24): NOT straight to HR any more — it waits for approval (Mike:
//          Admin · Notifications · Time Off approval, or the Pay Rate Change approver while nobody is
//          named there). Approving stamps the PDF and does the filing + alert above.
//   GET ?queue=1 → the approver's Pending / Done lists + your own recent ones; GET ?pdf=<id>
//   POST { action: 'approve' | 'reject', id, note }
//          One row per signed request in time_off_requests; sending it twice never files twice.
import { getStore } from '@netlify/blobs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import https from 'node:https';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts, refreshStoreList } from './_shared/store-status.mjs';
import { saveToDrive } from './transfer-notice.mjs';
import { sendSms, sendPush } from './_shared/channels.mjs';
import { PORTAL, formApprovers, approversFor, mayDecide, approverNames, notifyFormApprovers, tellPerson, stampApproval, approverTitle, etNow, usDay } from './_shared/form-approval.mjs';
import { CORPORATE, defaultPosition, missingTimeOffFields, timeOffProblem, timeOffFingerprint, timeOffFileName, timeOffAlertText, timeOffEmailHtml } from '../../src/time-off-request.mjs';
import { buildTaggedUploadParams, buildTaggedFileQuery, buildFolderFindQuery, buildFolderCreateParams } from '../../src/incident-report-drive.mjs';
import { google } from 'googleapis';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const NOTIFY_KEY = 'pcg_time_off_notify_v1';
const APPROVERS_KEY = 'pcg_time_off_approvers_v1'; // v23.22
const ROLES = new Set(['manager', 'dm', 'director', 'executive', 'it']);
const isSig = (s) => typeof s === 'string' && /^data:image\/png;base64,/.test(s) && s.length > 200 && s.length < 600000;
const DOC_TYPES = /^(application\/pdf|image\/(jpeg|png|heic|heif|webp|gif)|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/plain)$/;
const MAX_DOCS = 5, MAX_DOC_BYTES = 3.6 * 1024 * 1024; // all documents together (the screen caps at 3.5 MB; a request body tops out near 6 MB)

const storeLabel = (s) => `${s.name} (PC ${s.pc})`;

export function emailWithFiles(to, subject, html, files) { // v23.30: also used by crew-time-off
  return new Promise((resolve) => {
    const key = process.env.RESEND_API_KEY;
    if (!key || !to.length) return resolve(false);
    const body = JSON.stringify({ from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>', to, subject, html,
      attachments: files.map(f => ({ filename: f.name, content: f.buf.toString('base64') })) });
    const req = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('error', () => resolve(false)); req.write(body); req.end();
  });
}

// Supporting documents go in the same location folder as the PDF, tagged so a resend never doubles them.
export async function saveDocToDrive(buf, name, mimeType, folderName, pcgKey, root) {
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY), scopes: ['https://www.googleapis.com/auth/drive.file'] });
  const drive = google.drive({ version: 'v3', auth });
  let folderId = root; // v22.86: folderName may be a path (location → employee), like saveToDrive
  for (const n of (Array.isArray(folderName) ? folderName : [folderName]).map(x => String(x || '').trim()).filter(Boolean)) {
    const found = await drive.files.list(buildFolderFindQuery(n, folderId));
    folderId = found.data.files?.[0]?.id || (await drive.files.create(buildFolderCreateParams(n, folderId))).data.id;
  }
  const existing = await drive.files.list({ ...buildTaggedFileQuery(pcgKey, folderId), fields: 'files(id, webViewLink)' });
  if (existing.data.files?.length) return existing.data.files[0];
  const params = buildTaggedUploadParams({ name, mimeType, parentFolderId: folderId, pcgKey });
  params.media.body = Readable.from(buf);
  params.fields = 'id, webViewLink';
  return (await drive.files.create(params)).data;
}

// v23.26 (review): once per function instance, not on every request.
let tableReady = null;
function ensureTable(db) {
  return (tableReady ||= createTable(db).catch(e => { tableReady = null; throw e; }));
}
async function createTable(db) {
  await db`CREATE TABLE IF NOT EXISTS time_off_requests (
    id serial PRIMARY KEY, form_key text UNIQUE NOT NULL, user_id integer, employee_name text, location text, position text,
    start_date text, start_time text, return_date text, return_time text, total_hours numeric, leave_type text, leave_other text,
    last_worked text, documents integer, created_at timestamptz DEFAULT now(), drive_file_id text, drive_link text, drive_error text,
    alerted_at timestamptz, alert_summary jsonb)`;
  await db`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS status text`;
  await db`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS pdf bytea`;
  await db`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS form_values jsonb`;
  await db`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS documents_data jsonb`;
  await db`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS decided_by integer`;
  await db`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS decided_by_name text`;
  await db`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS decided_at timestamptz`;
  await db`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS decision_note text`;
  await db`ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS reminded_at timestamptz`;
}
const leaveOf = (r) => (r.leave_type === 'Other' && r.leave_other ? r.leave_other : r.leave_type) || 'time off';
const summary = (r) => `${r.employee_name} (${String(r.location || '').replace(/ \(PC \d+\)$/, '')}): ${usDay(r.start_date)} to ${usDay(r.return_date)}, ${Number(r.total_hours)} h, ${leaveOf(r)}`;

export async function notifyTimeOffApprovers(db, row, { reminder = false } = {}) {
  const waited = Math.max(1, Math.round((Date.now() - Date.parse(row.created_at)) / 3600e3));
  const n = await notifyFormApprovers(db, APPROVERS_KEY, {
    submitterId: row.user_id,
    title: `Time off to approve: ${row.employee_name}`,
    line: `${row.employee_name} requested time off. ${summary(row)}.`,
    link: `${PORTAL}/?timeOff=${row.id}`, pushTag: `timeoff-${row.id}`, type: 'time_off_request', where: 'Tools > Time Off Request', reminder, waitedHours: waited,
  });
  await db`UPDATE time_off_requests SET reminded_at = now() WHERE id = ${row.id}`;
  return n;
}

// After approval: the PDF + documents into Drive, then the Time Off Request list (unchanged from v22.80).
async function fileAndAlert(db, row, v, pdf, docs) {
  const root = process.env.TIMEOFF_DRIVE_FOLDER_ID || '';
  const folder = [String(v.location).replace(/ \(PC \d+\)$/, '').replace(/^Other: /, '') || CORPORATE, row.employee_name]; // v22.86: location → employee
  const fileName = timeOffFileName(v);
  let drive = { saved: false, link: '', error: null };
  const docLinks = docs.map(d => ({ name: d.name, link: '' }));
  try {
    const f = await saveToDrive(pdf, folder, fileName, `timeoff:${row.form_key}`, root);
    drive = { saved: true, link: f.webViewLink || '', error: null };
    for (let i = 0; i < docs.length; i++) {
      const d = await saveDocToDrive(docs[i].buf, `${fileName.replace(/\.pdf$/, '')} - ${docs[i].name}`, docs[i].type, folder, `timeoff:${row.form_key}:doc${i}`, root);
      docLinks[i].link = d.webViewLink || '';
    }
    await db`UPDATE time_off_requests SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${row.id}`;
  } catch (e) {
    drive = { saved: false, link: '', error: e.message };
    console.error('[time-off-request] drive', e.message);
    await db`UPDATE time_off_requests SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${row.id}`;
  }
  let alert = null;
  const claimed = await db`UPDATE time_off_requests SET alerted_at = now() WHERE id = ${row.id} AND alerted_at IS NULL RETURNING id`;
  if (claimed.length) {
    try {
      const b = blobs();
      const raw = await b.get(NOTIFY_KEY, { type: 'json' }).catch(() => null);
      const list = raw?.data ?? raw ?? {};
      const emails = (list.emails || []).filter(Boolean), phones = (list.phones || []).filter(Boolean);
      const ids = [...new Set([...(list.emailOwners || []), ...(list.phoneOwners || [])].filter(id => id != null).map(String))];
      const t = timeOffAlertText(v);
      const [emailed, sms, push] = await Promise.all([
        emails.length ? emailWithFiles(emails, t.title, timeOffEmailHtml(v, drive.link, docLinks), [{ name: fileName, buf: pdf }, ...docs]) : false,
        phones.length ? sendSms(phones, t.sms) : { sent: 0 },
        ids.length ? sendPush(b, ids, t.title, t.line, 'time-off-request') : { sent: 0 },
      ]);
      if (ids.length) {
        const cur = await b.get('pcg_notifications_v1', { type: 'json' });
        const arr = Array.isArray(cur) ? cur : (cur?.data || []);
        await b.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [{ id: `timeoff_${Date.now()}`, type: 'time_off_request', message: t.line, onlyFor: ids, read: false, createdAt: new Date().toISOString() }, ...arr].slice(0, 500) });
      }
      alert = { recipients: emails.length + phones.length + ids.length, emailed: !!emailed, texted: sms.sent || 0, pushed: push.sent || 0 };
      await db`UPDATE time_off_requests SET alert_summary = ${JSON.stringify(alert)} WHERE id = ${row.id}`;
    } catch (e) {
      console.error('[time-off-request] alert', e.message);
      await db`UPDATE time_off_requests SET alerted_at = NULL WHERE id = ${row.id}`;
      alert = { error: e.message };
    }
  }
  return { drive, alert };
}

// v23.22: the approver opens each attached document on its own page (a new tab — on an iPhone the
// installed app hands links to Safari, which isn't signed in). So each link carries its own pass: an
// HMAC of (request id, document #, expiry) with the portal's session secret, good for 2 hours, handed
// out only in the queue to people who may see that request. Nothing else is reachable with it.
const DOC_LINK_MS = 2 * 3600 * 1000;
const docSig = (id, i, exp) => createHmac('sha256', process.env.DEAL_SESSION_SECRET || 'missing').update(`timeoff-doc|${id}|${i}|${exp}`).digest('base64url');
const docUrl = (id, i) => { const exp = Date.now() + DOC_LINK_MS; return `/.netlify/functions/time-off-request?doc=${id}&i=${i}&exp=${exp}&sig=${docSig(id, i, exp)}`; };
async function serveDoc(db, url) {
  const id = Number(url.searchParams.get('doc')), i = Number(url.searchParams.get('i')), exp = Number(url.searchParams.get('exp'));
  const sig = String(url.searchParams.get('sig') || '');
  const want = docSig(id, i, exp);
  const ok = sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  if (!ok || !(exp > Date.now()) || !process.env.DEAL_SESSION_SECRET) return new Response('This link has expired. Open the request in the portal again to get a fresh one.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const r = (await db`SELECT documents_data FROM time_off_requests WHERE id = ${id}`)[0];
  const d = Array.isArray(r?.documents_data) ? r.documents_data[i] : null;
  if (!d) return new Response('This document is no longer here — once a request is approved its documents are in Google Drive.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const name = String(d.name || 'document').replace(/[\r\n"]/g, '');
  return new Response(Buffer.from(String(d.data || ''), 'base64'), { status: 200, headers: {
    'Content-Type': String(d.type || 'application/octet-stream'), 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" } });
}

export default async (request) => {
  const db = sql();
  if (request.method === 'GET') {
    const u = new URL(request.url);
    if (u.searchParams.get('doc')) return serveDoc(db, u).catch(e => { console.error('[time-off-request] doc', e.message); return new Response('Could not load the document.', { status: 502 }); });
  }
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const role = authed.realUserType || authed.userType;
  await ensureTable(db);
  // v23.26 (review): the approver list is read only when it matters.
  let apprP = null;
  const getAppr = () => (apprP ||= formApprovers(db, APPROVERS_KEY));
  const isStaff = role === 'executive' || role === 'it';
  const listed = async () => (await getAppr()).ids.includes(String(authed.sub));
  if (!ROLES.has(role) && !(await listed())) return json(403, { error: 'Time off requests are for managers, DMs, Directors and executives.' });
  await refreshStoreList(STORES, ALL_STORES); // v23.3: skips permanently closed stores (Locations) and syncs districts
  const me = (await db`SELECT id, name, email, phone, store_pc, paycor_employee_id FROM users WHERE id = ${authed.sub}`)[0] || {};
  const myStore = role === 'manager' ? STORES.find(s => String(s.pc) === String(me.store_pc || '')) : null;
  const locations = [...STORES.map(storeLabel).sort(), CORPORATE];

  try {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      if (url.searchParams.get('queue')) {
        const appr = await getAppr();
        const canApprove = appr.ids.includes(String(authed.sub));
        const canView = canApprove || isStaff;
        const item = (r) => ({ id: r.id, title: r.employee_name, sub: `${String(r.location || '').replace(/ \(PC \d+\)$/, '')}: ${usDay(r.start_date)} to ${usDay(r.return_date)}, ${Number(r.total_hours)} h, ${leaveOf(r)}${r.documents ? `, ${r.documents} document${r.documents === 1 ? '' : 's'}` : ''}`,
          by: r.employee_name, at: r.created_at, status: r.status || 'approved', note: r.decision_note || null, decidedBy: r.decided_by_name || null, decidedAt: r.decided_at || null,
          driveLink: r.drive_link || null, hasPdf: !!r.has_pdf, submittedById: r.user_id, mine: String(r.user_id) === String(authed.sub), filed: !!r.drive_link && !!r.alerted_at,
          docs: (r.doc_meta || []).map((d, i) => ({ name: d.name, type: d.type, url: docUrl(r.id, i) })) });
        const out = { canView, canApprove, mine: (await db`SELECT id, employee_name, location, start_date, return_date, total_hours, leave_type, leave_other, documents, created_at, status, decision_note, decided_by_name, decided_at, drive_link, (pdf IS NOT NULL) AS has_pdf, user_id, alerted_at, (SELECT json_agg(json_build_object('name', d->>'name', 'type', d->>'type')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(documents_data) = 'array' THEN documents_data ELSE '[]'::jsonb END) d) AS doc_meta
          FROM time_off_requests WHERE user_id = ${Number(authed.sub) || -1} AND status IS NOT NULL ORDER BY created_at DESC LIMIT 8`).map(item) };
        if (canView) {
          out.pending = (await db`SELECT id, employee_name, location, start_date, return_date, total_hours, leave_type, leave_other, documents, created_at, status, decision_note, decided_by_name, decided_at, drive_link, (pdf IS NOT NULL) AS has_pdf, user_id, alerted_at, (SELECT json_agg(json_build_object('name', d->>'name', 'type', d->>'type')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(documents_data) = 'array' THEN documents_data ELSE '[]'::jsonb END) d) AS doc_meta
            FROM time_off_requests WHERE status = 'pending' ORDER BY created_at`).map(item);
          out.done = (await db`SELECT id, employee_name, location, start_date, return_date, total_hours, leave_type, leave_other, documents, created_at, status, decision_note, decided_by_name, decided_at, drive_link, (pdf IS NOT NULL) AS has_pdf, user_id, alerted_at, (SELECT json_agg(json_build_object('name', d->>'name', 'type', d->>'type')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(documents_data) = 'array' THEN documents_data ELSE '[]'::jsonb END) d) AS doc_meta
            FROM time_off_requests WHERE status IN ('approved', 'rejected') ORDER BY decided_at DESC LIMIT 60`).map(item);
        }
        for (const x of out.pending || []) x.canDecide = await mayDecide(db, appr, x.submittedById, authed.sub);
        for (const x of out.done || []) x.canRefile = x.status === 'approved' && !x.filed && await mayDecide(db, appr, x.submittedById, authed.sub);
        out.canApprove = canApprove || (out.pending || []).some(x => x.canDecide);
        return json(200, out);
      }
      const pdfId = url.searchParams.get('pdf');
      if (pdfId) {
        const canView = isStaff || await listed();
        const r = (await db`SELECT pdf, user_id FROM time_off_requests WHERE id = ${Number(pdfId)}`)[0];
        if (!r?.pdf || !(canView || String(r.user_id) === String(authed.sub))) return json(404, { error: 'Not found' });
        return new Response(r.pdf, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="time-off-request.pdf"', 'Cache-Control': 'no-store' } });
      }
      let balances = [];
      if (me.paycor_employee_id) {
        const rows = await db`SELECT balances FROM time_off_people WHERE paycor_employee_id = ${me.paycor_employee_id}`.catch(() => []);
        balances = rows.flatMap(r => (Array.isArray(r.balances) ? r.balances : [])).map(b => ({ type: b.type, current: b.current, used: b.used, scheduled: b.scheduled }));
      }
      return json(200, {
        me: { name: me.name || '', email: me.email || '', phone: me.phone || '', role, position: defaultPosition(role), location: myStore ? storeLabel(myStore) : CORPORATE, locations },
        linked: !!me.paycor_employee_id, balances,
      });
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });

    const body = await request.json().catch(() => ({}));
    if (body.action === 'approve' || body.action === 'reject') {
      const r0 = (await db`SELECT id, user_id, status, drive_file_id, alerted_at FROM time_off_requests WHERE id = ${Number(body.id)}`)[0];
      if (!r0) return json(404, { error: 'Not found' });
      if (!(await mayDecide(db, await getAppr(), r0.user_id, authed.sub))) return json(403, { error: String(r0.user_id) === String(authed.sub) ? 'This is your own request, so someone else has to approve it.' : 'Only the time off approver can do this.' });
      const myName = me.name || authed.name || authed.username || '';
      if (body.action === 'reject') {
        const note = String(body.note || '').trim().slice(0, 400);
        if (note.length < 3) return json(400, { error: 'Say why it is being sent back.' });
        const upd = (await db`UPDATE time_off_requests SET status = 'rejected', decided_by = ${Number(authed.sub)}, decided_by_name = ${myName}, decided_at = now(), decision_note = ${note}
          WHERE id = ${Number(body.id)} AND status = 'pending' RETURNING *`)[0];
        if (!upd) return json(409, { error: 'This one was already decided — reload.' });
        await tellPerson(db, upd.user_id, { title: 'Time off request sent back', line: `${myName} sent back your time off request (${usDay(upd.start_date)} to ${usDay(upd.return_date)}). Why: ${note}. Fix it and send it again in Tools > Time Off Request.`, pushTag: `timeoff-${upd.id}`, type: 'time_off_request', path: `/?timeOff=${upd.id}` });
        return json(200, { ok: true });
      }
      // v23.26 (review): an approved request whose Drive save / HR alert failed can be filed again.
      const refile = r0.status === 'approved' && (!r0.drive_file_id || !r0.alerted_at);
      const upd = refile ? (await db`SELECT * FROM time_off_requests WHERE id = ${r0.id}`)[0]
        : (await db`UPDATE time_off_requests SET status = 'approved', decided_by = ${Number(authed.sub)}, decided_by_name = ${myName}, decided_at = now()
          WHERE id = ${Number(body.id)} AND status = 'pending' RETURNING *`)[0];
      if (!upd) return json(409, { error: 'This one was already decided — reload.' });
      let pdf = Buffer.from(upd.pdf);
      if (!refile) {
        const title = approverTitle(role, authed.username);
        try {
          pdf = await stampApproval(pdf, `Approved by ${myName}${title ? `, ${title}` : ''}, on ${etNow()} in the PCG Portal.`);
          await db`UPDATE time_off_requests SET pdf = ${pdf} WHERE id = ${upd.id}`;
        } catch (e) { console.error('[time-off-request] stamp', e.message); }
      }
      const docs = (Array.isArray(upd.documents_data) ? upd.documents_data : []).map(d => ({ name: d.name, type: d.type, buf: Buffer.from(String(d.data || ''), 'base64') }));
      const res = await fileAndAlert(db, upd, upd.form_values || {}, pdf, docs);
      if (res.drive.saved) await db`UPDATE time_off_requests SET documents_data = NULL WHERE id = ${upd.id}`; // filed; no need to keep a second copy
      const filedOk = res.drive.saved && !res.alert?.error;
      if (!refile || filedOk) await tellPerson(db, upd.user_id, { title: 'Time off approved', line: `${upd.decided_by_name || myName} approved your time off request (${usDay(upd.start_date)} to ${usDay(upd.return_date)}, ${Number(upd.total_hours)} h). ${filedOk ? "It's with HR now." : "Sending it to HR didn't fully go through yet; the approver was shown the error and can send it again."}`, pushTag: `timeoff-${upd.id}`, type: 'time_off_request', path: `/?timeOff=${upd.id}` });
      return json(200, { ok: res.drive.saved && !res.alert?.error, ...res });
    }
    const v = body.values || {};
    // The request is always for the signed-in person — never someone else's name.
    if (String(v.employeeName || '').trim().toLowerCase() !== String(me.name || '').trim().toLowerCase()) return json(400, { error: 'A time off request is for your own time off — your name is filled in from your account.' });
    const missing = missingTimeOffFields(v);
    if (missing.length) return json(400, { error: `Still needed: ${missing.join(', ')}` });
    const problem = timeOffProblem(v);
    if (problem) return json(400, { error: problem });
    if (!isSig(v.signature)) return json(400, { error: 'Sign again — the signature did not come through.' });
    if (!locations.includes(v.location) && !String(v.location).startsWith('Other: ')) return json(400, { error: 'Pick your location again.' });
    const pdf = Buffer.from(String(body.pdf || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (pdf.length < 1000 || pdf.length > 3e6 || pdf.subarray(0, 5).toString() !== '%PDF-') return json(400, { error: 'The PDF did not come through — try again.' });
    const docs = (Array.isArray(body.documents) ? body.documents : []).slice(0, MAX_DOCS).map(d => ({
      name: String(d.name || 'document').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120), type: String(d.type || ''), buf: Buffer.from(String(d.data || '').replace(/^data:[^,]*,/, ''), 'base64'),
    }));
    if (docs.some(d => !DOC_TYPES.test(d.type) || !d.buf.length)) return json(400, { error: 'Documents can be PDFs, photos, Word files or text files.' });
    if (docs.reduce((n, d) => n + d.buf.length, 0) > MAX_DOC_BYTES) return json(400, { error: 'The documents are too large together (3.5 MB max). Take smaller photos or send fewer files.' });

    const key = createHash('sha256').update(timeOffFingerprint(v) + '|' + v.signature).digest('hex').slice(0, 32);
    const inserted = await db`INSERT INTO time_off_requests (form_key, status, pdf, form_values, documents_data, user_id, employee_name, location, position, start_date, start_time, return_date, return_time, total_hours, leave_type, leave_other, last_worked, documents)
      VALUES (${key}, 'pending', ${pdf}, ${JSON.stringify(v)}, ${JSON.stringify(docs.map(d => ({ name: d.name, type: d.type, data: d.buf.toString('base64') })))}, ${Number(authed.sub) || null}, ${me.name}, ${v.location}, ${v.position}, ${v.startDate}, ${v.startTime}, ${v.returnDate}, ${v.returnTime},
        ${Number(v.totalHours)}, ${v.leaveType}, ${v.leaveOther || null}, ${v.lastWorked}, ${docs.length}) ON CONFLICT (form_key) DO NOTHING RETURNING id`;
    const row = (await db`SELECT * FROM time_off_requests WHERE form_key = ${key}`)[0];
    const names = await approverNames(db, await approversFor(db, APPROVERS_KEY, authed.sub));
    // The same signed request sent twice never asks twice; one sent back can be sent again.
    const resent = row.status === 'rejected' && (await db`UPDATE time_off_requests SET status = 'pending', decided_by = NULL, decided_by_name = NULL, decided_at = NULL, decision_note = NULL, created_at = now()
      WHERE id = ${row.id} AND status = 'rejected' RETURNING id`).length > 0;
    if (!inserted.length && !resent) return json(200, { ok: true, id: row.id, status: row.status || 'approved', already: true, approvers: names });
    const full = (await db`SELECT * FROM time_off_requests WHERE id = ${row.id}`)[0];
    const notified = await notifyTimeOffApprovers(db, full);
    return json(200, { ok: true, id: row.id, status: 'pending', notified, approvers: names });
  } catch (e) {
    console.error('[time-off-request]', e.message);
    return json(502, { error: 'Something went wrong — try again.' });
  }
};
