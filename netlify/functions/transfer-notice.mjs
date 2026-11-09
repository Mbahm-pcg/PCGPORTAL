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
//   DM / Director → stores in their districts;  manager / store_tablet → their own store;
//   kiosks → 403;  everyone else → every store.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts } from './_shared/store-status.mjs';
import { callPaycor } from './paycor.mjs';
import { pickCurrentPayRate, readEmploymentType, missingTransferFields, letterFingerprint, transferFileName, transferAlertText, transferEmailHtml } from '../../src/transfer-notice.mjs';
import { buildFolderFindQuery, buildFolderCreateParams, buildTaggedUploadParams, buildTaggedFileQuery } from '../../src/incident-report-drive.mjs';
import { sendSms, sendPush } from './_shared/channels.mjs';
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import https from 'node:https';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const ROSTER_KEY = 'pcg_transfer_roster_v1';
const ROSTER_TTL = 4 * 3600 * 1000;

async function storeRoster(legalEntityId) {
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

const fullName = (e) => [e.firstName, e.lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

// { savedAt, stores: { [pc]: [{ id, name, jobTitle }] } } — rebuilt when stale. A store whose
// read fails keeps its previous list rather than vanishing from the search.
async function loadRoster() {
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

async function saveToDrive(pdf, folderName, fileName, pcgKey) {
  const root = DRIVE_FOLDER_ID();
  if (!root) throw new Error('Transfer Notices Drive folder is not set up yet (TRANSFER_DRIVE_FOLDER_ID).');
  const drive = driveClient();
  const found = await drive.files.list(buildFolderFindQuery(folderName, root));
  const folderId = found.data.files?.[0]?.id || (await drive.files.create(buildFolderCreateParams(folderName, root))).data.id;
  const existing = await drive.files.list({ ...buildTaggedFileQuery(pcgKey, folderId), fields: 'files(id, webViewLink)' });
  if (existing.data.files?.length) return existing.data.files[0];
  const params = buildTaggedUploadParams({ name: fileName, mimeType: 'application/pdf', parentFolderId: folderId, pcgKey });
  params.media.body = Readable.from(pdf);
  params.fields = 'id, webViewLink';
  return (await drive.files.create(params)).data;
}

function emailWithPdf(to, subject, html, fileName, pdf) {
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

async function sendAlerts(v, fromName, toName, submittedBy, driveLink, fileName, pdf) {
  const b = blobs();
  const raw = await b.get(NOTIFY_KEY, { type: 'json' }).catch(() => null);
  const list = raw?.data ?? raw ?? {};
  const emails = (list.emails || []).filter(Boolean);
  const phones = (list.phones || []).filter(Boolean);
  const userIds = [...new Set([...(list.emailOwners || []), ...(list.phoneOwners || [])].filter(id => id != null).map(String))];
  const t = transferAlertText(v, fromName, toName, submittedBy);
  const [emailed, sms, push] = await Promise.all([
    emails.length ? emailWithPdf(emails, t.title, transferEmailHtml(v, fromName, toName, submittedBy, driveLink), fileName, pdf) : false,
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

async function submitNotice(request, db, authed, allowed) {
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'Invalid request' }); }
  const v = body?.values || {};
  if (missingTransferFields(v).length) return json(400, { error: `Still needed: ${missingTransferFields(v).join(', ')}` });
  const from = STORES.find(s => String(s.pc) === String(v.fromPC));
  const to = STORES.find(s => String(s.pc) === String(v.toPC));
  if (!from || !to) return json(400, { error: 'Unknown store' });
  if (allowed && !allowed.has(String(from.pc))) return json(403, { error: 'forbidden' });
  const pdf = Buffer.from(String(body.pdf || '').replace(/^data:[^,]*,/, ''), 'base64');
  if (pdf.length < 1000 || pdf.length > 8e6 || pdf.subarray(0, 5).toString() !== '%PDF-') return json(400, { error: 'The PDF did not come through — try again.' });

  await db`CREATE TABLE IF NOT EXISTS transfer_notices (
    id serial PRIMARY KEY, notice_key text UNIQUE NOT NULL, employee_name text, employee_id text,
    from_pc text, to_pc text, from_title text, to_title text, employment_type text, effective_date text,
    hourly_wage numeric, dm_name text, submitted_by integer, submitted_by_name text, created_at timestamptz DEFAULT now(),
    drive_file_id text, drive_link text, drive_error text, alerted_at timestamptz, alert_summary jsonb)`;
  const key = createHash('sha256').update(letterFingerprint(v) + '|' + v.employeeSignature + '|' + v.dmSignature).digest('hex').slice(0, 32);
  const me = (await db`SELECT name FROM users WHERE id = ${authed.sub}`)[0];
  const submittedBy = me?.name || authed.name || authed.username || '';
  await db`INSERT INTO transfer_notices (notice_key, employee_name, employee_id, from_pc, to_pc, from_title, to_title, employment_type, effective_date, hourly_wage, dm_name, submitted_by, submitted_by_name)
    VALUES (${key}, ${v.employeeName}, ${body.employeeId || null}, ${String(from.pc)}, ${String(to.pc)}, ${v.fromTitle}, ${v.toTitle}, ${v.employmentType}, ${v.effectiveDate}, ${Number(v.hourlyWage) || null}, ${v.dmName}, ${Number(authed.sub) || null}, ${submittedBy})
    ON CONFLICT (notice_key) DO NOTHING`;
  const row = (await db`SELECT * FROM transfer_notices WHERE notice_key = ${key}`)[0];

  const fileName = transferFileName(v, from.name, to.name);
  let drive = { saved: !!row.drive_file_id, link: row.drive_link || '', error: null };
  if (!drive.saved) {
    try {
      const f = await saveToDrive(pdf, to.name, fileName, `transfer:${key}`);
      drive = { saved: true, link: f.webViewLink || '', error: null };
      await db`UPDATE transfer_notices SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${row.id}`;
    } catch (e) {
      drive = { saved: false, link: '', error: e.message };
      console.error('[transfer-notice] drive', e.message);
      await db`UPDATE transfer_notices SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${row.id}`;
    }
  }

  let alert = row.alert_summary || null;
  if (!row.alerted_at) {
    // Claim the send first so two quick clicks can't both alert.
    const claimed = await db`UPDATE transfer_notices SET alerted_at = now() WHERE id = ${row.id} AND alerted_at IS NULL RETURNING id`;
    if (claimed.length) {
      try {
        alert = await sendAlerts(v, from.name, to.name, submittedBy, drive.link, fileName, pdf);
        await db`UPDATE transfer_notices SET alert_summary = ${JSON.stringify(alert)} WHERE id = ${row.id}`;
      } catch (e) {
        console.error('[transfer-notice] alert', e.message);
        await db`UPDATE transfer_notices SET alerted_at = NULL WHERE id = ${row.id}`;
        alert = { error: e.message };
      }
    }
  }
  return json(200, { ok: drive.saved && !alert?.error, id: row.id, drive, alert });
}

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const ut = authed.userType;
  if (ut === 'kiosk_pulse' || ut === 'kiosk_upload') return json(403, { error: 'forbidden' });
  await syncDistricts(STORES, ALL_STORES);

  let allowed = null; // null = every store
  if (ut === 'dm' || ut === 'director') {
    const ds = claimDistricts(authed);
    allowed = new Set(STORES.filter(s => ds.includes(String(s.district))).map(s => String(s.pc)));
  } else if (ut === 'manager' || ut === 'store_tablet') {
    const me = (await db`SELECT store_pc FROM users WHERE id = ${authed.sub}`)[0];
    allowed = new Set(me?.store_pc ? [String(me.store_pc)] : []);
  }

  if (request.method === 'POST') return submitNotice(request, db, authed, allowed);

  const url = new URL(request.url);
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
      return json(200, { stores, employees, rosterAt: roster.savedAt });
    }

    // One employee, live — only from the caller's own scope and only someone on that
    // store's active Paycor roster, never an arbitrary Paycor id.
    const store = STORES.find(s => String(s.pc) === String(pc));
    if (!store) return json(404, { error: 'unknown store' });
    if (allowed && !allowed.has(String(store.pc))) return json(403, { error: 'forbidden' });
    const emp = (await storeRoster(store.paycor)).find(e => e.id === employeeId);
    if (!emp) return json(404, { error: 'This employee is no longer active at that store in Paycor.' });
    const rateRes = await callPaycor(`/employees/${emp.id}/payrates`);
    if (rateRes.status !== 200) throw new Error(`Paycor payrates ${rateRes.status}`);
    const rate = pickCurrentPayRate(rateRes.data?.records || rateRes.data || []);
    return json(200, {
      store: { pc: String(store.pc), name: store.name },
      employee: {
        id: emp.id,
        name: fullName(emp),
        jobTitle: emp.positionData?.jobTitle || '',
        employmentType: readEmploymentType(emp),
        payRate: rate ? Number(rate.payRate ?? rate.rate ?? 0) || null : null,
        payType: rate ? (rate.payType || rate.type || null) : null,
      },
    });
  } catch (e) {
    console.error('[transfer-notice]', e.message);
    return json(502, { error: 'Paycor is not responding — try again in a minute.' });
  }
};
