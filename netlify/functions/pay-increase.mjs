// pay-increase.mjs — data for Tools · Pay Increase (v22.55; approval step v22.60).
//
// Flow (user, 2026-11-10): a Store Manager or DM fills HR's Pay Increase Form and signs their own
// line → it waits for approval and the approver (Mike) gets an email + text + push → once
// approved, the signed PDF is filed in the "Pay Changes" Shared Drive and the office list (Ella,
// Roxy) is alerted, exactly as before. Sent back → the person who made it is told why.
//
//   GET                       → { stores, employees, canApprove, listView, pending?, complete? }
//                               (pending / complete only for exec, IT and approvers — their list screen)
//   GET ?pc=&employeeId=      → { employee } live from Paycor
//   GET ?pdf=<id>             → the signed PDF (approvers, and the person who made it)
//   POST { values, employeeId, pdf }          submit for approval
//   POST { action:'approve', id }             approver: file in Drive + alert the office
//   POST { action:'reject', id, note }        approver: send back to the person who made it
//
// Approvers: the people added BY NAME to Admin · Notifications · Pay Increase approval
// (pcg_pay_increase_approvers_v1); the emails / numbers on that list get the request. While no one
// is named there, every executive can approve and gets the request.
// Makers: Store Managers (their store), DMs / Directors (their districts), exec / IT (all stores).
// Signatures (v22.64): a Store Manager makes it → Store Manager + their DM sign on the same screen.
// Anyone else → Store Manager line N/A, and they sign the second line, titled District Manager /
// Director of Operations / Vice President (Mike) / Executive by who they are (secondLineLabel).
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts } from './_shared/store-status.mjs';
import { loadRoster, liveEmployee, saveToDrive, emailWithPdf } from './transfer-notice.mjs';
import { sendSms, sendPush, sendHtmlEmail } from './_shared/channels.mjs';
import { payBasisOf, currentPayOf, rateProblem, missingPayFields, signatureProblem, secondLineLabel, storeManagerNa, signerCode, payFingerprint, payFileName, payAlertText, payEmailHtml, approvalAlertText, approvalEmailHtml } from '../../src/pay-increase.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const OFFICE_KEY = 'pcg_pay_increase_notify_v1';
const APPROVERS_KEY = 'pcg_pay_increase_approvers_v1';
const PORTAL = 'https://uop.peoplecapitalgroup.com';
const storeOf = (pc) => STORES.find(s => String(s.pc) === String(pc));
const isSig = (s) => typeof s === 'string' && /^data:image\/png;base64,/.test(s) && s.length > 200 && s.length < 600000;

async function readList(key) {
  const raw = await blobs().get(key, { type: 'json' }).catch(() => null);
  const l = raw?.data ?? raw ?? {};
  return {
    saved: !!l.updatedAt,
    emails: (l.emails || []).filter(Boolean), phones: (l.phones || []).filter(Boolean),
    ids: [...new Set([...(l.emailOwners || []), ...(l.phoneOwners || [])].filter(id => id != null).map(String))],
  };
}

// Who approves: named people on the approver list; nobody named yet → every executive.
async function approvers(db) {
  const l = await readList(APPROVERS_KEY);
  if (l.ids.length) return { ids: l.ids, emails: l.emails, phones: l.phones };
  const execs = await db`SELECT id, email, phone FROM users WHERE active IS NOT FALSE AND user_type = 'executive'`;
  return { ids: execs.map(e => String(e.id)), emails: [...new Set([...l.emails, ...execs.map(e => e.email).filter(Boolean)])], phones: [...new Set([...l.phones, ...execs.map(e => e.phone).filter(Boolean)])] };
}

async function bell(b, ids, message, tag) {
  if (!ids.length) return;
  try {
    const cur = await b.get('pcg_notifications_v1', { type: 'json' });
    const arr = Array.isArray(cur) ? cur : (cur?.data || []);
    const entry = { id: `payinc_${tag}_${Date.now()}`, type: 'pay_increase', message, onlyFor: ids.map(String), read: false, createdAt: new Date().toISOString() };
    await b.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...arr].slice(0, 500) });
  } catch (e) { console.warn('[pay-increase] bell write failed', e.message); }
}

// The office list (after approval): email with the PDF, text, push, bell — unchanged from v22.55.
async function alertOffice(v, storeName, submittedBy, driveLink, fileName, pdf, clientId, approvedBy) {
  const b = blobs();
  const l = await readList(OFFICE_KEY);
  const t = payAlertText(v, storeName, submittedBy);
  const [emailed, sms, push] = await Promise.all([
    l.emails.length ? emailWithPdf(l.emails, t.title, payEmailHtml(v, storeName, submittedBy, driveLink, clientId, approvedBy), fileName, pdf) : false,
    l.phones.length ? sendSms(l.phones, t.sms) : { sent: 0 },
    l.ids.length ? sendPush(b, l.ids, t.title, t.line, 'pay-increase') : { sent: 0 },
  ]);
  await bell(b, l.ids, t.line, 'office');
  return { recipients: l.emails.length + l.phones.length + l.ids.length, emailed: !!emailed, texted: sms.sent || 0, pushed: push.sent || 0 };
}

// One person (the maker): push + bell + email. Never throws.
async function tellMaker(db, row, kind, extra) {
  try {
    const u = (await db`SELECT id, email FROM users WHERE id = ${row.submitted_by}`)[0];
    if (!u) return;
    const t = approvalAlertText(kind, row, storeOf(row.pc)?.name, extra);
    const b = blobs();
    await Promise.all([sendPush(b, [String(u.id)], t.title, t.line, `pay-increase-${row.id}`), u.email ? sendHtmlEmail([u.email], t.title, `<p style="font-family:Arial,sans-serif;font-size:14px">${t.line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`) : null]);
    await bell(b, [u.id], t.line, kind);
  } catch (e) { console.error('[pay-increase] tell maker', e.message); }
}

// Email + text + push + bell to the approvers about one pending form (a stored row). Used when a
// form is sent and, every 3 hours while it is still pending, by pay-increase-reminder-cron.mjs.
export async function notifyApprovers(db, row, { reminder = false } = {}) {
  const appr = await approvers(db);
  const store = storeOf(row.pc);
  const v = rowValues(row);
  const link = `${PORTAL}/?payIncrease=${row.id}`;
  const t = approvalAlertText('request', row, store?.name);
  const waited = reminder ? Math.max(1, Math.round((Date.now() - Date.parse(row.created_at)) / 3600e3)) : 0;
  const title = reminder ? `Reminder: ${t.title.toLowerCase()} (waiting ${waited} h)` : t.title;
  const sms = reminder ? `PCG reminder: a pay increase for ${row.employee_name} (${store?.name || 'PC ' + row.pc}) from ${row.submitted_by_name || 'a manager'} is still waiting for your approval (${waited} h). Open it:` : t.sms;
  const b = blobs();
  await Promise.all([
    appr.emails.length ? sendHtmlEmail(appr.emails, title, approvalEmailHtml(v, store?.name, row.submitted_by_name, link, store?.paycor, waited)) : null,
    appr.phones.length ? sendSms(appr.phones, `${sms}\n${link}`) : null,
    !reminder && appr.ids.length ? sendPush(b, appr.ids, t.title, t.line, `pay-increase-${row.id}`) : null,
  ]);
  if (!reminder) await bell(b, appr.ids, t.line, 'request');
  await db`UPDATE pay_increase_forms SET reminded_at = now(), reminder_count = reminder_count + ${reminder ? 1 : 0} WHERE id = ${row.id}`;
  return new Set([...appr.ids, ...appr.emails, ...appr.phones]).size;
}

const rowValues = (r) => ({ payBasis: r.pay_basis || 'hour', employeeName: r.employee_name, position: r.position, pc: r.pc, currentRate: Number(r.current_rate), newRate: Number(r.new_rate), reason: r.reason, date: r.form_date, signer: r.signer,
  smName: r.sm_name || '', dmName: r.dm_name || '', secondLabel: r.second_label || '' });

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const realType = authed.realUserType || authed.userType;
  const me = (await db`SELECT id, name, username, store_pc FROM users WHERE id = ${authed.sub}`)[0] || {};
  const myName = me.name || authed.name || authed.username || '';

  // Stores this person may make a form for (null = all).
  let allowed;
  if (realType === 'executive' || realType === 'it') allowed = null;
  else if (realType === 'dm' || realType === 'director') {
    await syncDistricts(STORES, ALL_STORES);
    const ds = claimDistricts(authed);
    allowed = new Set(STORES.filter(s => ds.includes(String(s.district))).map(s => String(s.pc)));
  } else if (realType === 'manager') allowed = new Set(me.store_pc ? [String(me.store_pc)] : []);
  else allowed = new Set();
  const inScope = (pc) => !!storeOf(pc) && (!allowed || allowed.has(String(pc)));

  await db`CREATE TABLE IF NOT EXISTS pay_increase_forms (
    id serial PRIMARY KEY, form_key text UNIQUE NOT NULL, pc text, employee_id text, employee_name text, position text,
    current_rate numeric, new_rate numeric, reason text, form_date text, submitted_by integer, submitted_by_name text,
    created_at timestamptz DEFAULT now(), drive_file_id text, drive_link text, drive_error text, alerted_at timestamptz, alert_summary jsonb)`;
  // v22.60 approval step. Rows from before it have status NULL = already sent to the office.
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS status text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS signer text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS pdf bytea`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS decided_by integer`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS decided_by_name text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS decided_at timestamptz`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS decision_note text`;
  // v22.65: when the approver was last emailed / texted about a pending form (3-hour reminders).
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS reminded_at timestamptz`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0`;
  // v22.66: printed names next to the signatures, and the second line's title.
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS sm_name text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS dm_name text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS second_label text`;
  // v22.74: 'hour' or 'year' (salaried) — what current_rate / new_rate are per.
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS pay_basis text`;

  const appr = await approvers(db);
  const canApprove = appr.ids.includes(String(authed.sub));
  // v22.63: executives / IT (and approvers) get the list screen — Pending + Complete.
  const listView = canApprove || realType === 'executive' || realType === 'it';

  try {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const pdfId = url.searchParams.get('pdf');
      if (pdfId) {
        const r = (await db`SELECT pdf, submitted_by, employee_name FROM pay_increase_forms WHERE id = ${Number(pdfId)}`)[0];
        if (!r?.pdf || !(listView || String(r.submitted_by) === String(authed.sub))) return json(404, { error: 'Not found' });
        return new Response(r.pdf, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="pay-increase.pdf"', 'Cache-Control': 'no-store' } });
      }
      const employeeId = url.searchParams.get('employeeId');
      if (employeeId) {
        const pc = url.searchParams.get('pc');
        if (!inScope(pc)) return json(403, { error: 'forbidden' });
        const employee = await liveEmployee(storeOf(pc), employeeId);
        if (!employee) return json(404, { error: 'This employee is no longer active at that store in Paycor.' });
        return json(200, { employee });
      }
      const out = { canApprove, listView, role: realType, secondLabel: secondLineLabel(realType, me.username), smNa: storeManagerNa(realType), myName, stores: [], employees: [] };
      if (realType === 'manager' && me.store_pc) {
        const st = storeOf(me.store_pc);
        const dm = st && (await db`SELECT name FROM users WHERE active IS NOT FALSE AND user_type = 'dm' AND district::text = ${String(st.district)} LIMIT 1`)[0];
        out.dmNameGuess = dm?.name || '';
      }
      if (listView) {
        const item = (r) => ({ id: r.id, pc: r.pc, storeName: storeOf(r.pc)?.name || '', employeeName: r.employee_name, position: r.position,
          payBasis: r.pay_basis || 'hour', currentRate: Number(r.current_rate), newRate: Number(r.new_rate), reason: r.reason, formDate: r.form_date, submittedBy: r.submitted_by_name, createdAt: r.created_at,
          approvedBy: r.decided_by_name || null, approvedAt: r.decided_at || null, driveLink: r.drive_link || null, hasPdf: !!r.has_pdf });
        out.pending = (await db`SELECT id, pc, employee_name, position, current_rate, new_rate, pay_basis, reason, form_date, submitted_by_name, created_at, decided_by_name, decided_at, drive_link, (pdf IS NOT NULL) AS has_pdf
          FROM pay_increase_forms WHERE status = 'pending' ORDER BY created_at`).map(item);
        // Complete = approved, plus forms sent before the approval step existed (status NULL).
        out.complete = (await db`SELECT id, pc, employee_name, position, current_rate, new_rate, pay_basis, reason, form_date, submitted_by_name, created_at, decided_by_name, decided_at, drive_link, (pdf IS NOT NULL) AS has_pdf
          FROM pay_increase_forms WHERE status = 'approved' OR status IS NULL ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 300`).map(item);
      }
      if (allowed === null || allowed.size) {
        out.stores = STORES.filter(s => inScope(s.pc)).map(s => ({ pc: String(s.pc), name: s.name }));
        // Paycor being slow must not hide the Pending / Complete lists — only the search waits on it.
        const roster = await loadRoster().catch(e => { console.error('[pay-increase] roster', e.message); out.rosterError = 'Paycor is not responding, so employee search is unavailable. Try again in a minute.'; return { stores: {} }; });
        for (const s of out.stores) for (const e of roster.stores[s.pc] || []) out.employees.push({ ...e, pc: s.pc });
        out.employees.sort((a, b) => a.name.localeCompare(b.name));
      }
      return json(200, out);
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = await request.json().catch(() => ({}));

    // ── approver decisions ──
    if (body.action === 'approve' || body.action === 'reject') {
      if (!canApprove) return json(403, { error: 'Only the pay increase approver can do this.' });
      const r = (await db`SELECT * FROM pay_increase_forms WHERE id = ${Number(body.id)}`)[0];
      if (!r) return json(404, { error: 'Not found' });
      if (body.action === 'reject') {
        const note = String(body.note || '').trim().slice(0, 400);
        if (note.length < 3) return json(400, { error: 'Say why it is being sent back.' });
        const upd = (await db`UPDATE pay_increase_forms SET status = 'rejected', decided_by = ${Number(authed.sub)}, decided_by_name = ${myName}, decided_at = now(), decision_note = ${note}
          WHERE id = ${r.id} AND status = 'pending' RETURNING *`)[0];
        if (!upd) return json(409, { error: 'This one was already decided — reload.' });
        await tellMaker(db, upd, 'rejected', { by: myName, note });
        return json(200, { ok: true });
      }
      // approve: claim it first so two quick clicks can't both send.
      const upd = (await db`UPDATE pay_increase_forms SET status = 'approved', decided_by = ${Number(authed.sub)}, decided_by_name = ${myName}, decided_at = now()
        WHERE id = ${r.id} AND status = 'pending' RETURNING *`)[0];
      if (!upd) return json(409, { error: 'This one was already decided — reload.' });
      const store = storeOf(upd.pc);
      const v = rowValues(upd);
      const pdf = Buffer.from(upd.pdf);
      const fileName = payFileName(v, store?.name);
      let drive = { saved: false, link: '', error: null };
      try {
        const f = await saveToDrive(pdf, store?.name || upd.pc, fileName, `payinc:${upd.form_key}`, process.env.PAY_DRIVE_FOLDER_ID || '');
        drive = { saved: true, link: f.webViewLink || '' };
        await db`UPDATE pay_increase_forms SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${upd.id}`;
      } catch (e) {
        drive.error = e.message;
        console.error('[pay-increase] drive', e.message);
        await db`UPDATE pay_increase_forms SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${upd.id}`;
      }
      let alert;
      try {
        alert = await alertOffice(v, store?.name, upd.submitted_by_name, drive.link, fileName, pdf, store?.paycor, myName);
        await db`UPDATE pay_increase_forms SET alerted_at = now(), alert_summary = ${JSON.stringify(alert)} WHERE id = ${upd.id}`;
      } catch (e) { console.error('[pay-increase] office alert', e.message); alert = { error: e.message }; }
      await tellMaker(db, upd, 'approved', { by: myName });
      return json(200, { ok: drive.saved && !alert?.error, drive, alert });
    }

    // ── submit for approval ──
    const v = body.values || {};
    const missing = missingPayFields(v, realType);
    if (missing.length) return json(400, { error: `Still needed: ${missing.join(', ')}` });
    if (!inScope(v.pc)) return json(403, { error: 'You can only send pay increases for your own stores.' });
    const sigProblem = signatureProblem(realType, v);
    if (sigProblem) return json(400, { error: sigProblem });
    // The second line's title is decided by who is signed in, never by the browser.
    if ((v.secondLabel || 'District Manager') !== secondLineLabel(realType, me.username)) return json(400, { error: 'Reload the page and sign again.' });
    if (![v.smSignature, v.dmSignature].filter(Boolean).every(isSig)) return json(400, { error: 'Sign again — the signature did not come through.' });
    const store = storeOf(v.pc);
    // The locked fields must be what Paycor says right now — never what the browser says.
    const emp = await liveEmployee(store, String(body.employeeId || ''));
    if (!emp) return json(404, { error: 'This employee is no longer active at that store in Paycor.' });
    const basis = payBasisOf(emp), currentPay = Number(currentPayOf(emp));
    if (basis !== (v.payBasis || 'hour')) return json(409, { error: "Paycor's pay type for this employee changed — pick the employee again." });
    if (emp.name !== v.employeeName || Math.abs(currentPay - Number(v.currentRate)) > 0.004 || (emp.jobTitle && emp.jobTitle !== v.position)) {
      return json(409, { error: "Paycor's details for this employee changed while the form was open — pick the employee again and re-sign." });
    }
    const problem = rateProblem(currentPay, v.newRate, basis);
    if (problem) return json(400, { error: problem });
    const pdf = Buffer.from(String(body.pdf || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (pdf.length < 1000 || pdf.length > 8e6 || pdf.subarray(0, 5).toString() !== '%PDF-') return json(400, { error: 'The PDF did not come through — try again.' });

    const signer = signerCode(realType, me.username); // who signed, for the office email
    const key = createHash('sha256').update(payFingerprint(v) + '|' + (v.smSignature || '') + '|' + (v.dmSignature || '')).digest('hex').slice(0, 32);
    const inserted = await db`INSERT INTO pay_increase_forms (form_key, status, signer, sm_name, dm_name, second_label, pay_basis, pdf, pc, employee_id, employee_name, position, current_rate, new_rate, reason, form_date, submitted_by, submitted_by_name)
      VALUES (${key}, 'pending', ${signer}, ${String(v.smName || '').slice(0, 80) || null}, ${String(v.dmName || '').slice(0, 80)}, ${secondLineLabel(realType, me.username)}, ${basis}, ${pdf}, ${String(store.pc)}, ${emp.id}, ${emp.name}, ${v.position}, ${currentPay}, ${Number(Number(v.newRate).toFixed(2))}, ${String(v.reason).slice(0, 600)}, ${v.date}, ${Number(authed.sub) || null}, ${myName})
      ON CONFLICT (form_key) DO NOTHING RETURNING id`;
    const row = (await db`SELECT id, status FROM pay_increase_forms WHERE form_key = ${key}`)[0];
    // Sending the same signed form again never asks twice; a sent-back form can be sent again.
    const resent = row.status === 'rejected' && (await db`UPDATE pay_increase_forms SET status = 'pending', decided_by = NULL, decided_by_name = NULL, decided_at = NULL, decision_note = NULL
      WHERE id = ${row.id} AND status = 'rejected' RETURNING id`).length > 0;
    if (!inserted.length && !resent) return json(200, { ok: true, id: row.id, status: row.status === 'rejected' ? 'pending' : (row.status || 'approved'), notified: 0, already: true });
    const full = (await db`SELECT * FROM pay_increase_forms WHERE id = ${row.id}`)[0];
    const notified = await notifyApprovers(db, full);
    return json(200, { ok: true, id: row.id, status: 'pending', notified });
  } catch (e) {
    console.error('[pay-increase]', e.message);
    return json(502, { error: /Paycor/.test(e.message) ? 'Paycor is not responding — try again in a minute.' : 'Something went wrong — try again.' });
  }
};
