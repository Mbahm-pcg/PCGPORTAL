// transfer-notice.mjs — data for Tools · Transfer Notice (v22.49; POST save+alert v22.54). Any signed-in user
// (the Tools tile is switched on/off per role in Admin · Access).
//
//   GET                         → { stores, employees: [{ id, name, jobTitle, pc }] } — every
//                                 active employee the caller may transfer, for the search box.
//                                 Names/titles only, from a roster cache (blob, refreshed when
//                                 older than ROSTER_TTL); never pay rates.
//   GET ?pc=&employeeId=        → { employee: { id, name, jobTitle, employmentType, payRate,
//                                 payType }, store } — read live from Paycor
//   GET ?dest=                  → { manager, dm }  destination store's manager + district DM
//   POST { values, pdf }        → files the signed PDF in the Transfer Notices Shared Drive
//                                 (folder per NEW store) and alerts Admin · Notifications ·
//                                 Transfer Notice (email w/ PDF, text, push, bell). v22.54
//
// Scope is decided here, server-side, never by the client (pay rates are sensitive):
//   DM / Director → EVERY store (v23.23, user 2026-11-24: a DM can transfer someone from another
//   district; Mike approves every transfer and checks the PC to PC);  manager / store_tablet → their own store;
//   kiosks → 403;  everyone else → every store.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts, refreshStoreList } from './_shared/store-status.mjs';
import { callPaycor } from './paycor.mjs';
import { pickCurrentPayRate, readEmploymentType, missingTransferFields, letterFingerprint, transferFileName, transferAlertText, transferEmailHtml } from '../../src/transfer-notice.mjs';
import { buildFolderFindQuery, buildFolderCreateParams, buildTaggedUploadParams, buildTaggedFileQuery } from '../../src/incident-report-drive.mjs';
import { sendSms, sendPush } from './_shared/channels.mjs';
import { PORTAL, formApprovers, approversFor, mayDecide, approverNames, notifyFormApprovers, tellPerson, stampApproval, approverTitle, etNow, usDay } from './_shared/form-approval.mjs';
import { auditForm } from './_shared/audit.mjs';
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import https from 'node:https';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const ROSTER_KEY = 'pcg_transfer_roster_v1';
const ROSTER_TTL = 4 * 3600 * 1000;

export async function storeRoster(legalEntityId) {
  const out = [];
  let token = null, pages = 0;
  do {
    const res = await callPaycor(`/legalentities/${legalEntityId}/employees?include=All${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}`);
    if (res.status !== 200) throw new Error(`Paycor employees ${res.status}`);
    out.push(...(res.data?.records || []));
    token = res.data?.continuationToken || null;
  } while (token && ++pages < 20);
  return out.filter(e => (e.statusData?.status || e.status) === 'Active');
}

export const fullName = (e) => [e.firstName, e.lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

// { savedAt, stores: { [pc]: [{ id, name, jobTitle }] } } — rebuilt when stale. A store whose
// read fails keeps its previous list rather than vanishing from the search.
export async function loadRoster() {
  const b = blobs();
  const cached = await b.get(ROSTER_KEY, { type: 'json' }).catch(() => null);
  if (cached?.savedAt && Date.now() - Date.parse(cached.savedAt) < ROSTER_TTL) return cached;
  const stores = { ...(cached?.stores || {}) };
  let failed = 0;
  const queue = [...STORES];
  await Promise.all(Array.from({ length: 10 }, async () => {
    for (let s; (s = queue.shift());) {
      try {
        stores[String(s.pc)] = (await storeRoster(s.paycor))
          .map(e => ({ id: e.id, name: fullName(e), jobTitle: e.positionData?.jobTitle || '' }))
          .filter(e => e.id && e.name);
      } catch (e) { failed++; console.error('[transfer-notice] roster', s.pc, e.message); }
    }
  }));
  if (failed === STORES.length && cached) return cached; // Paycor down — serve the old copy
  if (failed === STORES.length) throw new Error('Paycor roster unavailable');
  const fresh = { savedAt: new Date().toISOString(), stores };
  await b.setJSON(ROSTER_KEY, fresh).catch(e => console.error('[transfer-notice] cache save', e.message));
  return fresh;
}

// One active employee of a store, read live from Paycor with today's pay rate; null when
// they're not on that store's active roster. Shared with pay-increase.mjs.
export async function liveEmployee(store, employeeId) {
  const emp = (await storeRoster(store.paycor)).find(e => e.id === employeeId);
  if (!emp) return null;
  const rateRes = await callPaycor(`/employees/${emp.id}/payrates`);
  if (rateRes.status !== 200) throw new Error(`Paycor payrates ${rateRes.status}`);
  const rate = pickCurrentPayRate(rateRes.data?.records || rateRes.data || []);
  return {
    id: emp.id,
    name: fullName(emp),
    jobTitle: emp.positionData?.jobTitle || '',
    employmentType: readEmploymentType(emp),
    payRate: rate ? Number(rate.payRate ?? rate.rate ?? 0) || null : null,
    payType: rate ? (rate.payType || rate.type || null) : null,
    // v22.74: salaried people (e.g. Store Managers) — Paycor's payRate is then per paycheck;
    // annualPayRate is the yearly salary.
    annualPayRate: rate ? Number(rate.annualPayRate ?? 0) || null : null,
  };
}

// ── v22.54: POST = a signed notice → Google Drive + alert ─────────────────────
// The client builds the PDF (fonts/seal live there) and sends it with the letter's values.
// One row per signed letter in transfer_notices (key = letter text + both signatures), so
// pressing Download twice never files or alerts twice; a failed Drive save or alert is
// retried the next time the same signed letter is sent.
const NOTIFY_KEY = 'pcg_transfer_notice_notify_v1';
const DRIVE_FOLDER_ID = () => process.env.TRANSFER_DRIVE_FOLDER_ID || '';

function driveClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(keyJson), scopes: ['https://www.googleapis.com/auth/drive.file'] });
  return google.drive({ version: 'v3', auth });
}

export async function saveToDrive(pdf, folderName, fileName, pcgKey, rootId = DRIVE_FOLDER_ID()) {
  const root = rootId;
  if (!root) throw new Error('The Google Drive folder for this form is not set up yet.');
  const drive = driveClient();
  // v22.85: folderName may be a path (['Bustleton', 'Jane Doe']) — each level is found or created
  // inside the one before it, so a form can be filed store → employee.
  let folderId = root;
  for (const name of (Array.isArray(folderName) ? folderName : [folderName]).map(n => String(n || '').trim()).filter(Boolean)) {
    const found = await drive.files.list(buildFolderFindQuery(name, folderId));
    folderId = found.data.files?.[0]?.id || (await drive.files.create(buildFolderCreateParams(name, folderId))).data.id;
  }
  const existing = await drive.files.list({ ...buildTaggedFileQuery(pcgKey, folderId), fields: 'files(id, webViewLink)' });
  if (existing.data.files?.length) return existing.data.files[0];
  const params = buildTaggedUploadParams({ name: fileName, mimeType: 'application/pdf', parentFolderId: folderId, pcgKey });
  params.media.body = Readable.from(pdf);
  params.fields = 'id, webViewLink';
  return (await drive.files.create(params)).data;
}

export function emailWithPdf(to, subject, html, fileName, pdf) {
  return new Promise((resolve) => {
    const key = process.env.RESEND_API_KEY;
    if (!key || !to.length) return resolve(false);
    const body = JSON.stringify({ from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>', to, subject, html, attachments: [{ filename: fileName, content: pdf.toString('base64') }] });
    const req = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('error', () => resolve(false)); req.write(body); req.end();
  });
}

async function sendAlerts(v, fromName, toName, submittedBy, driveLink, fileName, pdf, clients = {}) {
  const b = blobs();
  const raw = await b.get(NOTIFY_KEY, { type: 'json' }).catch(() => null);
  const list = raw?.data ?? raw ?? {};
  const emails = (list.emails || []).filter(Boolean);
  const phones = (list.phones || []).filter(Boolean);
  const userIds = [...new Set([...(list.emailOwners || []), ...(list.phoneOwners || [])].filter(id => id != null).map(String))];
  const t = transferAlertText(v, fromName, toName, submittedBy);
  const [emailed, sms, push] = await Promise.all([
    emails.length ? emailWithPdf(emails, t.title, transferEmailHtml(v, fromName, toName, submittedBy, driveLink, clients), fileName, pdf) : false,
    phones.length ? sendSms(phones, t.sms) : { sent: 0 },
    userIds.length ? sendPush(b, userIds, t.title, t.line, 'transfer-notice') : { sent: 0 },
  ]);
  if (userIds.length) {
    try {
      const cur = await b.get('pcg_notifications_v1', { type: 'json' });
      const arr = Array.isArray(cur) ? cur : (cur?.data || []);
      const entry = { id: `transfer_${Date.now()}`, type: 'transfer_notice', message: `${t.line} ${t.by}`.trim(), onlyFor: userIds, read: false, createdAt: new Date().toISOString() };
      await b.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...arr].slice(0, 500) });
    } catch (e) { console.warn('[transfer-notice] bell write failed', e.message); }
  }
  return { recipients: emails.length + phones.length + userIds.length, emailed: !!emailed, texted: sms.sent || 0, pushed: push.sent || 0 };
}

// v23.22 (user, 2026-11-24): DM / manager → Mike approves → Drive. Sending saves it as 'pending'
// and the approver (Admin · Notifications · Transfer Notice approval; nobody named → the Pay Rate
// Change approver) is told. Approving stamps the PDF, files it in Drive and alerts the Transfer
// Notice list exactly as before. status NULL = filed before the approval step existed.
const APPROVERS_KEY = 'pcg_transfer_approvers_v1';
// v23.26 (review): once per function instance, not on every request (each employee search paid for 9 DDL statements).
let tableReady = null;
function ensureTable(db) {
  return (tableReady ||= createTable(db).catch(e => { tableReady = null; throw e; }));
}
async function createTable(db) {
  await db`CREATE TABLE IF NOT EXISTS transfer_notices (
    id serial PRIMARY KEY, notice_key text UNIQUE NOT NULL, employee_name text, employee_id text,
    from_pc text, to_pc text, from_title text, to_title text, employment_type text, effective_date text,
    hourly_wage numeric, dm_name text, submitted_by integer, submitted_by_name text, created_at timestamptz DEFAULT now(),
    drive_file_id text, drive_link text, drive_error text, alerted_at timestamptz, alert_summary jsonb)`;
  await db`ALTER TABLE transfer_notices ADD COLUMN IF NOT EXISTS status text`;
  await db`ALTER TABLE transfer_notices ADD COLUMN IF NOT EXISTS pdf bytea`;
  await db`ALTER TABLE transfer_notices ADD COLUMN IF NOT EXISTS form_values jsonb`;
  await db`ALTER TABLE transfer_notices ADD COLUMN IF NOT EXISTS decided_by integer`;
  await db`ALTER TABLE transfer_notices ADD COLUMN IF NOT EXISTS decided_by_name text`;
  await db`ALTER TABLE transfer_notices ADD COLUMN IF NOT EXISTS decided_at timestamptz`;
  await db`ALTER TABLE transfer_notices ADD COLUMN IF NOT EXISTS decision_note text`;
  await db`ALTER TABLE transfer_notices ADD COLUMN IF NOT EXISTS reminded_at timestamptz`;
}
const storeName = (pc) => STORES.find(s => String(s.pc) === String(pc))?.name || `PC ${pc}`;
const summary = (r) => `${r.employee_name}: ${storeName(r.from_pc)} to ${storeName(r.to_pc)}${r.to_title ? ` as ${r.to_title}` : ''}, effective ${usDay(r.effective_date)}`;

export async function notifyTransferApprovers(db, row, { reminder = false } = {}) {
  const waited = Math.max(1, Math.round((Date.now() - Date.parse(row.created_at)) / 3600e3));
  const n = await notifyFormApprovers(db, APPROVERS_KEY, {
    submitterId: row.submitted_by,
    title: `Transfer notice to approve: ${row.employee_name}`,
    line: `${row.submitted_by_name || 'A manager'} sent a transfer notice for approval. ${summary(row)}.`,
    link: `${PORTAL}/?transfer=${row.id}`, pushTag: `transfer-${row.id}`, type: 'transfer_notice', where: 'Tools > Transfer Notice', reminder, waitedHours: waited,
  });
  await db`UPDATE transfer_notices SET reminded_at = now() WHERE id = ${row.id}`;
  return n;
}

async function submitNotice(body, db, authed, allowed) {
  const v = body?.values || {};
  if (missingTransferFields(v).length) return json(400, { error: `Still needed: ${missingTransferFields(v).join(', ')}` });
  const from = STORES.find(s => String(s.pc) === String(v.fromPC));
  const to = STORES.find(s => String(s.pc) === String(v.toPC));
  if (!from || !to) return json(400, { error: 'Unknown store' });
  if (allowed && !allowed.has(String(from.pc))) return json(403, { error: 'forbidden' });
  const pdf = Buffer.from(String(body.pdf || '').replace(/^data:[^,]*,/, ''), 'base64');
  if (pdf.length < 1000 || pdf.length > 8e6 || pdf.subarray(0, 5).toString() !== '%PDF-') return json(400, { error: 'The PDF did not come through — try again.' });

  await ensureTable(db);
  const key = createHash('sha256').update(letterFingerprint(v) + '|' + v.employeeSignature + '|' + v.dmSignature).digest('hex').slice(0, 32);
  const me = (await db`SELECT name FROM users WHERE id = ${authed.sub}`)[0];
  const submittedBy = me?.name || authed.name || authed.username || '';
  const inserted = await db`INSERT INTO transfer_notices (notice_key, status, pdf, form_values, employee_name, employee_id, from_pc, to_pc, from_title, to_title, employment_type, effective_date, hourly_wage, dm_name, submitted_by, submitted_by_name)
    VALUES (${key}, 'pending', ${pdf}, ${JSON.stringify(v)}, ${v.employeeName}, ${body.employeeId || null}, ${String(from.pc)}, ${String(to.pc)}, ${v.fromTitle}, ${v.toTitle}, ${v.employmentType}, ${v.effectiveDate}, ${Number(v.hourlyWage) || null}, ${v.dmName}, ${Number(authed.sub) || null}, ${submittedBy})
    ON CONFLICT (notice_key) DO NOTHING RETURNING id`;
  const row = (await db`SELECT * FROM transfer_notices WHERE notice_key = ${key}`)[0];
  const names = await approverNames(db, await approversFor(db, APPROVERS_KEY, authed.sub));
  // The same signed letter sent twice never asks twice; one sent back can be sent again.
  const resent = row.status === 'rejected' && (await db`UPDATE transfer_notices SET status = 'pending', decided_by = NULL, decided_by_name = NULL, decided_at = NULL, decision_note = NULL, created_at = now()
    WHERE id = ${row.id} AND status = 'rejected' RETURNING id`).length > 0;
  if (!inserted.length && !resent) return json(200, { ok: true, id: row.id, status: row.status || 'approved', already: true, approvers: names, drive: { saved: !!row.drive_file_id, link: row.drive_link || '' } });
  const full = (await db`SELECT * FROM transfer_notices WHERE id = ${row.id}`)[0];
  await auditForm(db, 'transfer', resent ? 'resent' : 'sent', full, { id: authed.sub, role: authed.realUserType || authed.userType, name: submittedBy });
  const notified = await notifyTransferApprovers(db, full);
  return json(200, { ok: true, id: row.id, status: 'pending', notified, approvers: names });
}

// Approve → stamp, Drive, the Transfer Notice alert list, the maker told. Reject → the maker told why.
async function decideNotice(body, db, authed, me, appr) {
  const real = authed.realUserType || authed.userType;
  const r = (await db`SELECT * FROM transfer_notices WHERE id = ${Number(body.id)}`)[0];
  if (!r) return json(404, { error: 'Not found' });
  if (!(await mayDecide(db, appr, r.submitted_by, authed.sub))) return json(403, { error: String(r.submitted_by) === String(authed.sub) ? 'You sent this one, so someone else has to approve it.' : 'Only the transfer notice approver can do this.' });
  const myName = me.name || authed.name || authed.username || '';
  if (body.action === 'reject') {
    const note = String(body.note || '').trim().slice(0, 400);
    if (note.length < 3) return json(400, { error: 'Say why it is being sent back.' });
    const upd = (await db`UPDATE transfer_notices SET status = 'rejected', decided_by = ${Number(authed.sub)}, decided_by_name = ${myName}, decided_at = now(), decision_note = ${note}
      WHERE id = ${r.id} AND status = 'pending' RETURNING *`)[0];
    if (!upd) return json(409, { error: 'This one was already decided — reload.' });
    await auditForm(db, 'transfer', 'sent_back', upd, { id: authed.sub, role: real, name: myName }, { note: note.slice(0, 120) });
    await tellPerson(db, upd.submitted_by, { title: `Transfer notice sent back: ${upd.employee_name}`, line: `${myName} sent back the transfer notice for ${summary(upd)}. Why: ${note}. Fix it and send it again in Tools > Transfer Notice.`, pushTag: `transfer-${upd.id}`, type: 'transfer_notice', path: `/?transfer=${upd.id}` });
    return json(200, { ok: true });
  }
  // v23.26 (review): an approved notice whose Drive save / office alert failed can be filed again.
  const refile = r.status === 'approved' && (!r.drive_file_id || !r.alerted_at);
  const upd = refile ? r : (await db`UPDATE transfer_notices SET status = 'approved', decided_by = ${Number(authed.sub)}, decided_by_name = ${myName}, decided_at = now()
    WHERE id = ${r.id} AND status = 'pending' RETURNING *`)[0];
  if (!upd) return json(409, { error: 'This one was already decided — reload.' });
  await auditForm(db, 'transfer', refile ? 'filed_again' : 'approved', upd, { id: authed.sub, role: real, name: myName });
  let pdf = Buffer.from(upd.pdf);
  if (!refile) {
    const title = approverTitle(real, me.username || authed.username);
    try {
      pdf = await stampApproval(pdf, `Approved by ${myName}${title ? `, ${title}` : ''}, on ${etNow()} in the PCG Portal.`);
      await db`UPDATE transfer_notices SET pdf = ${pdf} WHERE id = ${upd.id}`;
    } catch (e) { console.error('[transfer-notice] stamp', e.message); }
  }
  const v = upd.form_values || {};
  const from = STORES.find(s => String(s.pc) === String(upd.from_pc)) || { name: storeName(upd.from_pc) };
  const to = STORES.find(s => String(s.pc) === String(upd.to_pc)) || { name: storeName(upd.to_pc) };
  const fileName = transferFileName(v, from.name, to.name);
  let drive = { saved: !!upd.drive_file_id, link: upd.drive_link || '', error: null };
  if (!drive.saved) try {
    const f = await saveToDrive(pdf, [to.name, upd.employee_name], fileName, `transfer:${upd.notice_key}`);
    drive = { saved: true, link: f.webViewLink || '', error: null };
    await db`UPDATE transfer_notices SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${upd.id}`;
  } catch (e) {
    drive = { saved: false, link: '', error: e.message };
    console.error('[transfer-notice] drive', e.message);
    await db`UPDATE transfer_notices SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${upd.id}`;
  }
  let alert = null;
  const claimed = await db`UPDATE transfer_notices SET alerted_at = now() WHERE id = ${upd.id} AND alerted_at IS NULL RETURNING id`;
  if (claimed.length) {
    try {
      alert = await sendAlerts(v, from.name, to.name, upd.submitted_by_name, drive.link, fileName, pdf, { from: from.paycor, to: to.paycor });
      await db`UPDATE transfer_notices SET alert_summary = ${JSON.stringify(alert)} WHERE id = ${upd.id}`;
    } catch (e) {
      console.error('[transfer-notice] alert', e.message);
      await db`UPDATE transfer_notices SET alerted_at = NULL WHERE id = ${upd.id}`;
      alert = { error: e.message };
    }
  }
  const filedOk = drive.saved && !alert?.error;
  if (!refile || filedOk) await tellPerson(db, upd.submitted_by, { title: `Transfer notice approved: ${upd.employee_name}`,
    line: `${upd.decided_by_name || myName} approved the transfer notice for ${summary(upd)}. ${filedOk ? "It's filed in Google Drive and the office has it." : "Filing it didn't fully go through yet (Google Drive or the office alert); the approver was shown the error and can file it again."}`, pushTag: `transfer-${upd.id}`, type: 'transfer_notice', link: drive.link || '', linkLabel: 'Open it in Google Drive', path: `/?transfer=${upd.id}` });
  return json(200, { ok: drive.saved && !alert?.error, drive, alert });
}

// The approver's lists, and the maker's own recent ones.
async function queue(db, authed, canView) {
  const mine = Number(authed.sub) || -1;
  const item = (r) => ({ id: r.id, title: r.employee_name, sub: `${storeName(r.from_pc)} to ${storeName(r.to_pc)}${r.to_title ? ` as ${r.to_title}` : ''}, effective ${usDay(r.effective_date)}`,
    by: r.submitted_by_name, at: r.created_at, status: r.status || 'approved', note: r.decision_note || null, decidedBy: r.decided_by_name || null, decidedAt: r.decided_at || null,
    driveLink: r.drive_link || null, hasPdf: !!r.has_pdf, submittedById: r.submitted_by, mine: String(r.submitted_by) === String(authed.sub), filed: !!r.drive_link && !!r.alerted_at });
  const out = { canView, mine: (await db`SELECT id, employee_name, from_pc, to_pc, to_title, effective_date, submitted_by_name, created_at, status, decision_note, decided_by_name, decided_at, drive_link, (pdf IS NOT NULL) AS has_pdf, submitted_by, alerted_at FROM transfer_notices WHERE submitted_by = ${mine} AND status IS NOT NULL ORDER BY created_at DESC LIMIT 8`).map(item) };
  if (canView) {
    out.pending = (await db`SELECT id, employee_name, from_pc, to_pc, to_title, effective_date, submitted_by_name, created_at, status, decision_note, decided_by_name, decided_at, drive_link, (pdf IS NOT NULL) AS has_pdf, submitted_by, alerted_at FROM transfer_notices WHERE status = 'pending' ORDER BY created_at`).map(item);
    out.done = (await db`SELECT id, employee_name, from_pc, to_pc, to_title, effective_date, submitted_by_name, created_at, status, decision_note, decided_by_name, decided_at, drive_link, (pdf IS NOT NULL) AS has_pdf, submitted_by, alerted_at FROM transfer_notices WHERE status IN ('approved', 'rejected') ORDER BY decided_at DESC LIMIT 60`).map(item);
  }
  return out;
}

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const ut = authed.userType;
  if (ut === 'kiosk_pulse' || ut === 'kiosk_upload') return json(403, { error: 'forbidden' });
  await refreshStoreList(STORES, ALL_STORES); // v23.3: skips permanently closed stores (Locations) and syncs districts

  let allowed = null; // null = every store — exec / IT / office, and (v23.23) DMs and Directors too
  if (ut === 'manager' || ut === 'store_tablet') {
    const me = (await db`SELECT store_pc FROM users WHERE id = ${authed.sub}`)[0];
    allowed = new Set(me?.store_pc ? [String(me.store_pc)] : []);
  }

  // v23.22 the approval step.
  await ensureTable(db);
  const real = authed.realUserType || authed.userType;
  const meFull = (await db`SELECT id, name, username FROM users WHERE id = ${authed.sub}`)[0] || {};
  // v23.26 (review): the approver list is only read when it matters (not on every employee search).
  let apprP = null;
  const getAppr = () => (apprP ||= formApprovers(db, APPROVERS_KEY));
  const isStaff = real === 'executive' || real === 'it';
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json(400, { error: 'Invalid request' }); }
    if (body?.action === 'approve' || body?.action === 'reject') return decideNotice(body, db, authed, meFull, await getAppr());
    return submitNotice(body, db, authed, allowed);
  }

  const url = new URL(request.url);
  if (url.searchParams.get('queue')) {
    const appr = await getAppr();
    const canApprove = appr.ids.includes(String(authed.sub));
    const out = await queue(db, authed, canApprove || isStaff);
    for (const x of out.pending || []) x.canDecide = await mayDecide(db, appr, x.submittedById, authed.sub);
    for (const x of out.done || []) x.canRefile = x.status === 'approved' && !x.filed && await mayDecide(db, appr, x.submittedById, authed.sub);
    return json(200, { ...out, canApprove: canApprove || (out.pending || []).some(x => x.canDecide) });
  }
  const pdfId = url.searchParams.get('pdf');
  const canView = isStaff || (pdfId ? (await getAppr()).ids.includes(String(authed.sub)) : false);
  if (pdfId) {
    const r = (await db`SELECT pdf, submitted_by FROM transfer_notices WHERE id = ${Number(pdfId)}`)[0];
    if (!r?.pdf || !(canView || String(r.submitted_by) === String(authed.sub))) return json(404, { error: 'Not found' });
    return new Response(r.pdf, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="transfer-notice.pdf"', 'Cache-Control': 'no-store' } });
  }
  const pc = url.searchParams.get('pc');
  const employeeId = url.searchParams.get('employeeId');
  const dest = url.searchParams.get('dest');

  try {
    if (dest) {
      const store = STORES.find(s => String(s.pc) === String(dest));
      if (!store) return json(404, { error: 'unknown store' });
      const users = await db`SELECT name, user_type, district, store_pc FROM users WHERE active IS NOT FALSE AND user_type IN ('manager', 'dm')`;
      const manager = users.find(u => u.user_type === 'manager' && String(u.store_pc) === String(store.pc));
      const dm = users.find(u => u.user_type === 'dm' && String(u.district) === String(store.district));
      return json(200, { manager: manager?.name || '', dm: dm?.name || '' });
    }

    if (!employeeId) {
      const roster = await loadRoster();
      const stores = STORES.map(s => ({ pc: String(s.pc), name: s.name, district: s.district }));
      const employees = [];
      for (const s of STORES) {
        if (allowed && !allowed.has(String(s.pc))) continue;
        for (const e of roster.stores[String(s.pc)] || []) employees.push({ ...e, pc: String(s.pc) });
      }
      employees.sort((a, b) => a.name.localeCompare(b.name));
      // v22.96: who's filling it in. Anyone but a Store Manager approves it themselves, so the
      // approval line shows their own name and title (a Store Manager's goes to the store's DM).
      const real = authed.realUserType || authed.userType;
      const meRow = (await db`SELECT name, username FROM users WHERE id = ${authed.sub}`)[0] || {};
      const approverTitle = real === 'manager' ? null : real === 'dm' ? 'District Manager' : real === 'director' ? 'Director of Operations'
        : real === 'executive' ? (String(meRow.username || authed.username || '').toLowerCase() === 'mike.bahm' ? 'Vice President' : 'Executive')
        : real === 'it' ? 'HR / IT Administrator' : real === 'office_staff' ? 'Office / HR' : null;
      return json(200, { stores, employees, rosterAt: roster.savedAt, me: { name: meRow.name || authed.name || '', approverTitle } });
    }

    // One employee, live — only from the caller's own scope and only someone on that
    // store's active Paycor roster, never an arbitrary Paycor id.
    const store = STORES.find(s => String(s.pc) === String(pc));
    if (!store) return json(404, { error: 'unknown store' });
    if (allowed && !allowed.has(String(store.pc))) return json(403, { error: 'forbidden' });
    const employee = await liveEmployee(store, employeeId);
    if (!employee) return json(404, { error: 'This employee is no longer active at that store in Paycor.' });
    return json(200, { store: { pc: String(store.pc), name: store.name }, employee });
  } catch (e) {
    console.error('[transfer-notice]', e.message);
    return json(502, { error: 'Paycor is not responding — try again in a minute.' });
  }
};
