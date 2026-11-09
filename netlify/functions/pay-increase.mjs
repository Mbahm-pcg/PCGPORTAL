// pay-increase.mjs — data for Tools · Pay Increase (v22.55). The DM fills HR's Pay Increase
// Form; the Store Manager, the DM and the Director of Operations sign on the DM's screen; it is
// sent to the office (who make the change in Paycor).
//
//   GET                       → { stores, employees: [{ id, name, jobTitle, pc }] } in the caller's scope
//   GET ?pc=&employeeId=      → { employee: { id, name, jobTitle, payRate, payType } } live from Paycor
//   POST { values, employeeId, pdf } → checks the form against Paycor, files the signed PDF in the
//                               "Pay Changes" Shared Drive (PAY_DRIVE_FOLDER_ID, folder per store) and
//                               alerts Admin · Notifications · Pay Increase (email with the PDF, text,
//                               push, bell). One row per signed form in pay_increases — sending the
//                               same signed form twice never files or alerts twice.
//
// Who: DMs / Directors (their districts) and exec / IT (every store). Scope is decided here.
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts } from './_shared/store-status.mjs';
import { loadRoster, liveEmployee, saveToDrive, emailWithPdf } from './transfer-notice.mjs';
import { sendSms, sendPush } from './_shared/channels.mjs';
import { rateProblem, missingPayFields, payFingerprint, payFileName, payAlertText, payEmailHtml } from '../../src/pay-increase.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const NOTIFY_KEY = 'pcg_pay_increase_notify_v1';
const storeOf = (pc) => STORES.find(s => String(s.pc) === String(pc));
const isSig = (s) => typeof s === 'string' && /^data:image\/png;base64,/.test(s) && s.length > 200 && s.length < 600000;

async function sendAlerts(v, storeName, submittedBy, driveLink, fileName, pdf, clientId) {
  const b = blobs();
  const raw = await b.get(NOTIFY_KEY, { type: 'json' }).catch(() => null);
  const list = raw?.data ?? raw ?? {};
  const emails = (list.emails || []).filter(Boolean);
  const phones = (list.phones || []).filter(Boolean);
  const userIds = [...new Set([...(list.emailOwners || []), ...(list.phoneOwners || [])].filter(id => id != null).map(String))];
  const t = payAlertText(v, storeName, submittedBy);
  const [emailed, sms, push] = await Promise.all([
    emails.length ? emailWithPdf(emails, t.title, payEmailHtml(v, storeName, submittedBy, driveLink, clientId), fileName, pdf) : false,
    phones.length ? sendSms(phones, t.sms) : { sent: 0 },
    userIds.length ? sendPush(b, userIds, t.title, t.line, 'pay-increase') : { sent: 0 },
  ]);
  if (userIds.length) {
    try {
      const cur = await b.get('pcg_notifications_v1', { type: 'json' });
      const arr = Array.isArray(cur) ? cur : (cur?.data || []);
      const entry = { id: `payinc_${Date.now()}`, type: 'pay_increase', message: t.line, onlyFor: userIds, read: false, createdAt: new Date().toISOString() };
      await b.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...arr].slice(0, 500) });
    } catch (e) { console.warn('[pay-increase] bell write failed', e.message); }
  }
  return { recipients: emails.length + phones.length + userIds.length, emailed: !!emailed, texted: sms.sent || 0, pushed: push.sent || 0 };
}

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const realType = authed.realUserType || authed.userType;
  let allowed; // Set of store pcs, or null = every store
  if (realType === 'executive' || realType === 'it') allowed = null;
  else if (realType === 'dm' || realType === 'director') {
    await syncDistricts(STORES, ALL_STORES);
    const ds = claimDistricts(authed);
    allowed = new Set(STORES.filter(s => ds.includes(String(s.district))).map(s => String(s.pc)));
  } else return json(403, { error: 'Pay increases are started by the District Manager.' });
  const inScope = (pc) => !!storeOf(pc) && (!allowed || allowed.has(String(pc)));

  try {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const employeeId = url.searchParams.get('employeeId');
      if (employeeId) {
        const pc = url.searchParams.get('pc');
        if (!inScope(pc)) return json(403, { error: 'forbidden' });
        const employee = await liveEmployee(storeOf(pc), employeeId);
        if (!employee) return json(404, { error: 'This employee is no longer active at that store in Paycor.' });
        return json(200, { employee });
      }
      const roster = await loadRoster();
      const stores = STORES.filter(s => inScope(s.pc)).map(s => ({ pc: String(s.pc), name: s.name }));
      const employees = [];
      for (const s of stores) for (const e of roster.stores[s.pc] || []) employees.push({ ...e, pc: s.pc });
      employees.sort((a, b) => a.name.localeCompare(b.name));
      return json(200, { stores, employees });
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });

    const body = await request.json().catch(() => ({}));
    const v = body.values || {};
    const missing = missingPayFields(v);
    if (missing.length) return json(400, { error: `Still needed: ${missing.join(', ')}` });
    if (!inScope(v.pc)) return json(403, { error: 'You can only send pay increases for stores in your district.' });
    // Store Manager + one of DM / Director; any signature that IS there must be a real drawing.
    const sigsGiven = [v.smSignature, v.dmSignature, v.directorSignature].filter(Boolean);
    if (!isSig(v.smSignature) || !(isSig(v.dmSignature) || isSig(v.directorSignature)) || !sigsGiven.every(isSig)) return json(400, { error: 'The Store Manager and the District Manager or Director need to sign.' });
    const store = storeOf(v.pc);
    // The locked fields must be what Paycor says right now — never what the browser says.
    const emp = await liveEmployee(store, String(body.employeeId || ''));
    if (!emp) return json(404, { error: 'This employee is no longer active at that store in Paycor.' });
    if (emp.name !== v.employeeName || Math.abs(Number(emp.payRate) - Number(v.currentRate)) > 0.004 || (emp.jobTitle && emp.jobTitle !== v.position)) {
      return json(409, { error: "Paycor's details for this employee changed while the form was open — pick the employee again and re-sign." });
    }
    const problem = rateProblem(emp.payRate, v.newRate);
    if (problem) return json(400, { error: problem });
    const pdf = Buffer.from(String(body.pdf || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (pdf.length < 1000 || pdf.length > 8e6 || pdf.subarray(0, 5).toString() !== '%PDF-') return json(400, { error: 'The PDF did not come through — try again.' });

    await db`CREATE TABLE IF NOT EXISTS pay_increases (
      id serial PRIMARY KEY, form_key text UNIQUE NOT NULL, pc text, employee_id text, employee_name text, position text,
      current_rate numeric, new_rate numeric, reason text, form_date text, submitted_by integer, submitted_by_name text,
      created_at timestamptz DEFAULT now(), drive_file_id text, drive_link text, drive_error text, alerted_at timestamptz, alert_summary jsonb)`;
    const key = createHash('sha256').update(payFingerprint(v) + '|' + v.smSignature + '|' + v.dmSignature + '|' + v.directorSignature).digest('hex').slice(0, 32);
    const me = (await db`SELECT name FROM users WHERE id = ${authed.sub}`)[0];
    const submittedBy = me?.name || authed.name || authed.username || '';
    await db`INSERT INTO pay_increases (form_key, pc, employee_id, employee_name, position, current_rate, new_rate, reason, form_date, submitted_by, submitted_by_name)
      VALUES (${key}, ${String(store.pc)}, ${emp.id}, ${emp.name}, ${v.position}, ${emp.payRate}, ${Number(Number(v.newRate).toFixed(2))}, ${String(v.reason).slice(0, 600)}, ${v.date}, ${Number(authed.sub) || null}, ${submittedBy})
      ON CONFLICT (form_key) DO NOTHING`;
    const row = (await db`SELECT * FROM pay_increases WHERE form_key = ${key}`)[0];

    const fileName = payFileName(v, store.name);
    let drive = { saved: !!row.drive_file_id, link: row.drive_link || '', error: null };
    if (!drive.saved) {
      try {
        const f = await saveToDrive(pdf, store.name, fileName, `payinc:${key}`, process.env.PAY_DRIVE_FOLDER_ID || '');
        drive = { saved: true, link: f.webViewLink || '', error: null };
        await db`UPDATE pay_increases SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${row.id}`;
      } catch (e) {
        drive = { saved: false, link: '', error: e.message };
        console.error('[pay-increase] drive', e.message);
        await db`UPDATE pay_increases SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${row.id}`;
      }
    }
    let alert = row.alert_summary || null;
    if (!row.alerted_at) {
      const claimed = await db`UPDATE pay_increases SET alerted_at = now() WHERE id = ${row.id} AND alerted_at IS NULL RETURNING id`;
      if (claimed.length) {
        try {
          alert = await sendAlerts(v, store.name, submittedBy, drive.link, fileName, pdf, store.paycor);
          await db`UPDATE pay_increases SET alert_summary = ${JSON.stringify(alert)} WHERE id = ${row.id}`;
        } catch (e) {
          console.error('[pay-increase] alert', e.message);
          await db`UPDATE pay_increases SET alerted_at = NULL WHERE id = ${row.id}`;
          alert = { error: e.message };
        }
      }
    }
    return json(200, { ok: drive.saved && !alert?.error, id: row.id, drive, alert });
  } catch (e) {
    console.error('[pay-increase]', e.message);
    return json(502, { error: /Paycor/.test(e.message) ? 'Paycor is not responding — try again in a minute.' : 'Something went wrong — try again.' });
  }
};
