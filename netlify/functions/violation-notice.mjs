// violation-notice.mjs — data for Tools · Violation Notice (v22.72).
//
//   GET   → { stores, employees: [{ id, name, jobTitle, pc }], myName } in the caller's scope
//           (roster cache shared with Transfer Notice — names / titles only, never pay)
//   POST { values, employeeId, pdf } → checks the form, files the signed PDF in the "Violation
//           Notices" Shared Drive (VIOLATION_DRIVE_FOLDER_ID, folder per store) and alerts Admin ·
//           Notifications · Violation Notice (email with the PDF, text, push, bell). One row per
//           signed form in violation_notices — sending the same signed form twice never files or
//           alerts twice.
//
// Everyone can open it (user, 2026-11-10); who they can pick is scoped here, server-side:
//   DM / Director → their districts;  manager / store_tablet → their store;  exec / IT / office → all.
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts } from './_shared/store-status.mjs';
import { loadRoster, saveToDrive, emailWithPdf } from './transfer-notice.mjs';
import { sendSms, sendPush } from './_shared/channels.mjs';
import { missingViolationFields, violationFingerprint, violationFileName, violationAlertText, violationEmailHtml } from '../../src/violation-notice.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const NOTIFY_KEY = 'pcg_violation_notice_notify_v1';
const storeOf = (pc) => STORES.find(s => String(s.pc) === String(pc));
const isSig = (s) => typeof s === 'string' && /^data:image\/png;base64,/.test(s) && s.length > 200 && s.length < 600000;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

async function sendAlerts(v, storeName, submittedBy, driveLink, fileName, pdf, clientId) {
  const b = blobs();
  const raw = await b.get(NOTIFY_KEY, { type: 'json' }).catch(() => null);
  const list = raw?.data ?? raw ?? {};
  const emails = (list.emails || []).filter(Boolean);
  const phones = (list.phones || []).filter(Boolean);
  const userIds = [...new Set([...(list.emailOwners || []), ...(list.phoneOwners || [])].filter(id => id != null).map(String))];
  const t = violationAlertText(v, storeName, submittedBy);
  const [emailed, sms, push] = await Promise.all([
    emails.length ? emailWithPdf(emails, t.title, violationEmailHtml(v, storeName, submittedBy, driveLink, clientId), fileName, pdf) : false,
    phones.length ? sendSms(phones, t.sms) : { sent: 0 },
    userIds.length ? sendPush(b, userIds, t.title, t.line, 'violation-notice') : { sent: 0 },
  ]);
  if (userIds.length) {
    try {
      const cur = await b.get('pcg_notifications_v1', { type: 'json' });
      const arr = Array.isArray(cur) ? cur : (cur?.data || []);
      const entry = { id: `violation_${Date.now()}`, type: 'violation_notice', message: t.line, onlyFor: userIds, read: false, createdAt: new Date().toISOString() };
      await b.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...arr].slice(0, 500) });
    } catch (e) { console.warn('[violation-notice] bell write failed', e.message); }
  }
  return { recipients: emails.length + phones.length + userIds.length, emailed: !!emailed, texted: sms.sent || 0, pushed: push.sent || 0 };
}

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const realType = authed.realUserType || authed.userType;
  if (['kiosk_pulse', 'kiosk_upload', 'vendor'].includes(realType)) return json(403, { error: 'forbidden' });
  await syncDistricts(STORES, ALL_STORES);
  const me = (await db`SELECT name, store_pc FROM users WHERE id = ${authed.sub}`)[0] || {};
  const myName = me.name || authed.name || authed.username || '';

  let allowed = null; // null = every store
  if (realType === 'dm' || realType === 'director' || authed.userType === 'dm') {
    const ds = claimDistricts(authed);
    allowed = new Set(STORES.filter(s => ds.includes(String(s.district))).map(s => String(s.pc)));
  } else if (realType === 'manager' || realType === 'store_tablet') {
    allowed = new Set(me.store_pc ? [String(me.store_pc)] : []);
  } else if (!['executive', 'it', 'office_staff'].includes(realType)) allowed = new Set();
  const inScope = (pc) => !!storeOf(pc) && (!allowed || allowed.has(String(pc)));

  try {
    if (request.method === 'GET') {
      const out = { myName, stores: STORES.filter(s => inScope(s.pc)).map(s => ({ pc: String(s.pc), name: s.name })), employees: [] };
      const roster = await loadRoster().catch(e => { console.error('[violation-notice] roster', e.message); out.rosterError = 'Paycor is not responding, so employee search is unavailable. Try again in a minute.'; return { stores: {} }; });
      for (const s of out.stores) for (const e of roster.stores[s.pc] || []) out.employees.push({ ...e, pc: s.pc });
      out.employees.sort((a, b) => a.name.localeCompare(b.name));
      return json(200, out);
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });

    const body = await request.json().catch(() => ({}));
    const v = body.values || {};
    const missing = missingViolationFields(v);
    if (missing.length) return json(400, { error: `Still needed: ${missing.join(', ')}` });
    if (!inScope(v.pc)) return json(403, { error: 'You can only write up employees at your own stores.' });
    for (const k of ['date', 'violationDate']) if (!isDate(v[k])) return json(400, { error: 'Check the dates.' });
    if (v.action === 'suspension' && !(isDate(v.suspensionStart) && isDate(v.suspensionReturn) && v.suspensionReturn >= v.suspensionStart)) return json(400, { error: 'The return-to-work date has to be on or after the suspension start.' });
    for (const k of ['employeeSignature', 'supervisorSignature', 'witnessSignature']) if (v[k] && !isSig(v[k])) return json(400, { error: 'Sign again — a signature did not come through.' });
    // The employee must be on that store's active roster, and the locked fields must match it.
    const store = storeOf(v.pc);
    const roster = await loadRoster();
    const emp = (roster.stores[String(store.pc)] || []).find(e => e.id === String(body.employeeId || ''));
    if (!emp) return json(404, { error: 'This employee is not on that store\'s active roster in Paycor.' });
    if (emp.name !== v.employeeName || (emp.jobTitle && emp.jobTitle !== v.jobTitle)) return json(409, { error: "Paycor's details for this employee changed — pick the employee again." });
    const pdf = Buffer.from(String(body.pdf || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (pdf.length < 1000 || pdf.length > 8e6 || pdf.subarray(0, 5).toString() !== '%PDF-') return json(400, { error: 'The PDF did not come through — try again.' });

    await db`CREATE TABLE IF NOT EXISTS violation_notices (
      id serial PRIMARY KEY, form_key text UNIQUE NOT NULL, pc text, employee_id text, employee_name text, job_title text,
      notice text, types text, action text, violation_date text, form_date text, supervisor_name text, witness_name text,
      employee_signed boolean, employee_refused boolean, submitted_by integer, submitted_by_name text, created_at timestamptz DEFAULT now(),
      drive_file_id text, drive_link text, drive_error text, alerted_at timestamptz, alert_summary jsonb)`;
    const key = createHash('sha256').update(violationFingerprint(v) + '|' + (v.employeeSignature || '') + '|' + v.supervisorSignature + '|' + (v.witnessSignature || '')).digest('hex').slice(0, 32);
    await db`INSERT INTO violation_notices (form_key, pc, employee_id, employee_name, job_title, notice, types, action, violation_date, form_date, supervisor_name, witness_name, employee_signed, employee_refused, submitted_by, submitted_by_name)
      VALUES (${key}, ${String(store.pc)}, ${emp.id}, ${emp.name}, ${v.jobTitle || ''}, ${v.notice}, ${(v.types || []).join(',')}, ${v.action}, ${v.violationDate}, ${v.date},
        ${v.supervisorName}, ${v.witnessName || null}, ${!!v.employeeSignature}, ${!!v.employeeRefused}, ${Number(authed.sub) || null}, ${myName})
      ON CONFLICT (form_key) DO NOTHING`;
    const row = (await db`SELECT * FROM violation_notices WHERE form_key = ${key}`)[0];

    const fileName = violationFileName(v, store.name);
    let drive = { saved: !!row.drive_file_id, link: row.drive_link || '', error: null };
    if (!drive.saved) {
      try {
        const f = await saveToDrive(pdf, store.name, fileName, `violation:${key}`, process.env.VIOLATION_DRIVE_FOLDER_ID || '');
        drive = { saved: true, link: f.webViewLink || '', error: null };
        await db`UPDATE violation_notices SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${row.id}`;
      } catch (e) {
        drive = { saved: false, link: '', error: e.message };
        console.error('[violation-notice] drive', e.message);
        await db`UPDATE violation_notices SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${row.id}`;
      }
    }
    let alert = row.alert_summary || null;
    if (!row.alerted_at) {
      const claimed = await db`UPDATE violation_notices SET alerted_at = now() WHERE id = ${row.id} AND alerted_at IS NULL RETURNING id`;
      if (claimed.length) {
        try {
          alert = await sendAlerts(v, store.name, myName, drive.link, fileName, pdf, store.paycor);
          await db`UPDATE violation_notices SET alert_summary = ${JSON.stringify(alert)} WHERE id = ${row.id}`;
        } catch (e) {
          console.error('[violation-notice] alert', e.message);
          await db`UPDATE violation_notices SET alerted_at = NULL WHERE id = ${row.id}`;
          alert = { error: e.message };
        }
      }
    }
    return json(200, { ok: drive.saved && !alert?.error, id: row.id, drive, alert });
  } catch (e) {
    console.error('[violation-notice]', e.message);
    return json(502, { error: /Paycor/.test(e.message) ? 'Paycor is not responding — try again in a minute.' : 'Something went wrong — try again.' });
  }
};
