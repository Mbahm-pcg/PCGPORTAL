// time-off-request.mjs — Tools · Time Off Request (v22.80). Replaces HR's Google Form.
// A Store Manager, DM, Director or exec / IT requests their OWN time off (user, 2026-11-11).
//
//   GET  → { me: { name, email, phone, role, position, location, locations }, balances, linked }
//          prefill from the caller's own account + their Paycor time-off balances (time_off_people,
//          synced daily — the same copy "My time off" reads; never calls Paycor here).
//   POST { values, pdf, documents: [{ name, type, data }] } → the signed PDF and any supporting
//          documents are filed in the "Time Off Requests" Shared Drive (TIMEOFF_DRIVE_FOLDER_ID,
//          folder per location) and Admin · Notifications · Time Off Request is alerted (email
//          with the PDF + documents, text, push, bell). Straight to HR — no approval step.
//          One row per signed request in time_off_requests; sending it twice never files twice.
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import https from 'node:https';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts } from './_shared/store-status.mjs';
import { saveToDrive } from './transfer-notice.mjs';
import { sendSms, sendPush } from './_shared/channels.mjs';
import { CORPORATE, defaultPosition, missingTimeOffFields, timeOffProblem, timeOffFingerprint, timeOffFileName, timeOffAlertText, timeOffEmailHtml } from '../../src/time-off-request.mjs';
import { buildTaggedUploadParams, buildTaggedFileQuery, buildFolderFindQuery, buildFolderCreateParams } from '../../src/incident-report-drive.mjs';
import { google } from 'googleapis';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const NOTIFY_KEY = 'pcg_time_off_notify_v1';
const ROLES = new Set(['manager', 'dm', 'director', 'executive', 'it']);
const isSig = (s) => typeof s === 'string' && /^data:image\/png;base64,/.test(s) && s.length > 200 && s.length < 600000;
const DOC_TYPES = /^(application\/pdf|image\/(jpeg|png|heic|heif|webp|gif)|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/plain)$/;
const MAX_DOCS = 5, MAX_DOC_BYTES = 3.6 * 1024 * 1024; // all documents together (the screen caps at 3.5 MB; a request body tops out near 6 MB)

const storeLabel = (s) => `${s.name} (PC ${s.pc})`;

function emailWithFiles(to, subject, html, files) {
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
async function saveDocToDrive(buf, name, mimeType, folderName, pcgKey, root) {
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY), scopes: ['https://www.googleapis.com/auth/drive.file'] });
  const drive = google.drive({ version: 'v3', auth });
  const found = await drive.files.list(buildFolderFindQuery(folderName, root));
  const folderId = found.data.files?.[0]?.id || (await drive.files.create(buildFolderCreateParams(folderName, root))).data.id;
  const existing = await drive.files.list({ ...buildTaggedFileQuery(pcgKey, folderId), fields: 'files(id, webViewLink)' });
  if (existing.data.files?.length) return existing.data.files[0];
  const params = buildTaggedUploadParams({ name, mimeType, parentFolderId: folderId, pcgKey });
  params.media.body = Readable.from(buf);
  params.fields = 'id, webViewLink';
  return (await drive.files.create(params)).data;
}

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const role = authed.realUserType || authed.userType;
  if (!ROLES.has(role)) return json(403, { error: 'Time off requests are for managers, DMs, Directors and executives.' });
  await syncDistricts(STORES, ALL_STORES);
  const me = (await db`SELECT id, name, email, phone, store_pc, paycor_employee_id FROM users WHERE id = ${authed.sub}`)[0] || {};
  const myStore = role === 'manager' ? STORES.find(s => String(s.pc) === String(me.store_pc || '')) : null;
  const locations = [...STORES.map(storeLabel).sort(), CORPORATE];

  try {
    if (request.method === 'GET') {
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

    await db`CREATE TABLE IF NOT EXISTS time_off_requests (
      id serial PRIMARY KEY, form_key text UNIQUE NOT NULL, user_id integer, employee_name text, location text, position text,
      start_date text, start_time text, return_date text, return_time text, total_hours numeric, leave_type text, leave_other text,
      last_worked text, documents integer, created_at timestamptz DEFAULT now(), drive_file_id text, drive_link text, drive_error text,
      alerted_at timestamptz, alert_summary jsonb)`;
    const key = createHash('sha256').update(timeOffFingerprint(v) + '|' + v.signature).digest('hex').slice(0, 32);
    await db`INSERT INTO time_off_requests (form_key, user_id, employee_name, location, position, start_date, start_time, return_date, return_time, total_hours, leave_type, leave_other, last_worked, documents)
      VALUES (${key}, ${Number(authed.sub) || null}, ${me.name}, ${v.location}, ${v.position}, ${v.startDate}, ${v.startTime}, ${v.returnDate}, ${v.returnTime},
        ${Number(v.totalHours)}, ${v.leaveType}, ${v.leaveOther || null}, ${v.lastWorked}, ${docs.length}) ON CONFLICT (form_key) DO NOTHING`;
    const row = (await db`SELECT * FROM time_off_requests WHERE form_key = ${key}`)[0];

    const root = process.env.TIMEOFF_DRIVE_FOLDER_ID || '';
    const folder = String(v.location).replace(/ \(PC \d+\)$/, '').replace(/^Other: /, '') || CORPORATE;
    const fileName = timeOffFileName(v);
    let drive = { saved: !!row.drive_file_id, link: row.drive_link || '', error: null };
    const docLinks = docs.map(d => ({ name: d.name, link: '' }));
    if (!drive.saved) {
      try {
        const f = await saveToDrive(pdf, folder, fileName, `timeoff:${key}`, root);
        drive = { saved: true, link: f.webViewLink || '', error: null };
        for (let i = 0; i < docs.length; i++) {
          const d = await saveDocToDrive(docs[i].buf, `${fileName.replace(/\.pdf$/, '')} - ${docs[i].name}`, docs[i].type, folder, `timeoff:${key}:doc${i}`, root);
          docLinks[i].link = d.webViewLink || '';
        }
        await db`UPDATE time_off_requests SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${row.id}`;
      } catch (e) {
        drive = { saved: false, link: '', error: e.message };
        console.error('[time-off-request] drive', e.message);
        await db`UPDATE time_off_requests SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${row.id}`;
      }
    }

    let alert = row.alert_summary || null;
    if (!row.alerted_at) {
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
    }
    return json(200, { ok: drive.saved && !alert?.error, id: row.id, drive, alert });
  } catch (e) {
    console.error('[time-off-request]', e.message);
    return json(502, { error: 'Something went wrong — try again.' });
  }
};
