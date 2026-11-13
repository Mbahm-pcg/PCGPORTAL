// resignation-letter.mjs — data for Tools · Resignation Letter (v22.87).
//
// Flow (user, 2026-11-11: "same path of violation, but does not need an approval"): the supervisor
// fills in HR's Resignation Letter (employee from Paycor) and signs "Acknowledged by" → the employee
// signs on the same screen, or later from an emailed link when they aren't there (violation-sign.mjs,
// layout 'resignation') → once the employee has signed it is filed ONCE in the "Resignation Letters"
// Shared Drive (RESIGNATION_DRIVE_FOLDER_ID, store → employee folders) and Admin · Notifications ·
// Resignation Letter is alerted. No approval step.
//
//   GET                  → { stores, employees, myName, myTitle, seeAll, waiting, complete }
//   GET ?pdf=<id>        → the latest PDF (its maker, or exec / IT / office)
//   POST { values, employeeId, pdf, remoteSign? }   submit
//   POST { action:'resendLink', id }                new signing link (the old one stops working)
//   POST { action:'refile', id }                    retry a Drive save that failed
//
// Who they can pick is scoped server-side: DM / Director → their districts; manager → their store;
// exec / IT / office → all. exec / IT / office see every letter; everyone else sees their own.
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts } from './_shared/store-status.mjs';
import { loadRoster, saveToDrive, emailWithPdf } from './transfer-notice.mjs';
import { sendSms, sendPush, sendHtmlEmail } from './_shared/channels.mjs';
import { createSignRequest, ensureSignTable, signProgress } from './violation-sign.mjs';
import { missingResignationFields, resignationFingerprint, resignationFileName, resignationAlertText, resignationEmailHtml, titleForRole } from '../../src/resignation-letter.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const NOTIFY_KEY = 'pcg_resignation_notify_v1';
const storeOf = (pc) => STORES.find(s => String(s.pc) === String(pc));
const isSig = (s) => typeof s === 'string' && /^data:image\/png;base64,/.test(s) && s.length > 200 && s.length < 600000;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function ensureResignationTable(db) {
  await db`CREATE TABLE IF NOT EXISTS resignation_letters (
    id serial PRIMARY KEY, form_key text UNIQUE NOT NULL, status text NOT NULL, pdf bytea, form_values jsonb,
    pc text, employee_id text, employee_name text, position text, store_address text, last_day text, form_date text,
    supervisor_name text, supervisor_title text, employee_signed boolean DEFAULT false,
    submitted_by integer, submitted_by_name text, created_at timestamptz DEFAULT now(), signed_at timestamptz, filed_at timestamptz,
    drive_file_id text, drive_link text, drive_error text, alerted_at timestamptz, alert_summary jsonb)`;
}

async function readList() {
  const raw = await blobs().get(NOTIFY_KEY, { type: 'json' }).catch(() => null);
  const l = raw?.data ?? raw ?? {};
  return { emails: (l.emails || []).filter(Boolean), phones: (l.phones || []).filter(Boolean), ids: [...new Set([...(l.emailOwners || []), ...(l.phoneOwners || [])].filter(id => id != null).map(String))] };
}

async function bell(b, ids, message, tag) {
  if (!ids.length) return;
  try {
    const cur = await b.get('pcg_notifications_v1', { type: 'json' });
    const arr = Array.isArray(cur) ? cur : (cur?.data || []);
    const entry = { id: `resignation_${tag}_${Date.now()}`, type: 'resignation_letter', message, onlyFor: ids.map(String), read: false, createdAt: new Date().toISOString() };
    await b.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...arr].slice(0, 500) });
  } catch (e) { console.warn('[resignation-letter] bell write failed', e.message); }
}

async function tellMaker(db, row, title, line) {
  try {
    const u = (await db`SELECT id, email FROM users WHERE id = ${row.submitted_by}`)[0];
    if (!u) return;
    const b = blobs();
    await Promise.all([sendPush(b, [String(u.id)], title, line, `resignation-${row.id}`), u.email ? sendHtmlEmail([u.email], title, `<p style="font-family:Arial,sans-serif;font-size:14px">${esc(line)}</p>`) : null]);
    await bell(b, [u.id], line, 'maker');
  } catch (e) { console.error('[resignation-letter] tell maker', e.message); }
}

// Signed by the employee → Drive (store → employee) + the alert list. Claims the row first so it
// files once. Returns { drive, alert }.
async function fileLetter(db, id) {
  const upd = (await db`UPDATE resignation_letters SET status = 'signed', signed_at = COALESCE(signed_at, now()) WHERE id = ${id} AND status IN ('awaiting_signature', 'signed') AND filed_at IS NULL RETURNING *`)[0];
  if (!upd) return null;
  const store = storeOf(upd.pc);
  const v = upd.form_values || {};
  const pdf = Buffer.from(upd.pdf);
  const fileName = resignationFileName(v, store?.name || upd.pc);
  const drive = { saved: false, link: '', error: null };
  try {
    const f = await saveToDrive(pdf, [store?.name || upd.pc, upd.employee_name], fileName, `resignation:${upd.form_key}`, process.env.RESIGNATION_DRIVE_FOLDER_ID || '');
    drive.saved = true; drive.link = f.webViewLink || '';
    await db`UPDATE resignation_letters SET filed_at = now(), drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${upd.id}`;
  } catch (e) {
    drive.error = e.message;
    console.error('[resignation-letter] drive', e.message);
    await db`UPDATE resignation_letters SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${upd.id}`;
  }
  let alert = upd.alert_summary || null;
  if (!upd.alerted_at) {
    try {
      const l = await readList();
      const b = blobs();
      const t = resignationAlertText(v, store?.name, upd.submitted_by_name);
      const [emailed, sms, push] = await Promise.all([
        l.emails.length ? emailWithPdf(l.emails, t.title, resignationEmailHtml(v, store?.name, upd.submitted_by_name, drive.link), fileName, pdf) : false,
        l.phones.length ? sendSms(l.phones, t.sms) : { sent: 0 },
        l.ids.length ? sendPush(b, l.ids, t.title, t.line, 'resignation-letter') : { sent: 0 },
      ]);
      await bell(b, l.ids, t.line, 'filed');
      alert = { recipients: l.emails.length + l.phones.length + l.ids.length, emailed: !!emailed, texted: sms.sent || 0, pushed: push.sent || 0 };
      await db`UPDATE resignation_letters SET alerted_at = now(), alert_summary = ${JSON.stringify(alert)} WHERE id = ${upd.id}`;
    } catch (e) { console.error('[resignation-letter] alert', e.message); alert = { error: e.message }; }
  }
  return { drive, alert, row: upd };
}

// Called by violation-sign.mjs once the employee signs from their link.
export async function afterResignationSign(db, letterId, signedPdf) {
  await ensureResignationTable(db);
  await db`UPDATE resignation_letters SET pdf = ${signedPdf}, employee_signed = true WHERE id = ${letterId}`;
  const out = await fileLetter(db, letterId);
  if (!out) return;
  const { row, drive } = out;
  await tellMaker(db, row, `Resignation letter signed: ${row.employee_name}`,
    `${row.employee_name} signed their resignation letter. ${drive.saved ? 'It\'s filed in Google Drive.' : `It could NOT be filed in Google Drive (${drive.error}) — open Tools > Resignation Letter to retry.`}`);
}

const rowItem = (r) => ({ id: r.id, pc: r.pc, storeName: storeOf(r.pc)?.name || '', employeeName: r.employee_name, position: r.position, lastDay: r.last_day, formDate: r.form_date,
  submittedBy: r.submitted_by_name, mine: false, createdAt: r.created_at, signedAt: r.signed_at, status: r.status, driveLink: r.drive_link || null, driveError: r.drive_error || null, hasPdf: !!r.has_pdf });

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const realType = authed.realUserType || authed.userType;
  if (!['executive', 'it', 'office_staff', 'dm', 'director', 'manager'].includes(realType)) return json(403, { error: 'forbidden' });
  await syncDistricts(STORES, ALL_STORES);
  const me = (await db`SELECT name, store_pc FROM users WHERE id = ${authed.sub}`)[0] || {};
  const myName = me.name || authed.name || authed.username || '';
  let allowed = null; // null = every store
  if (realType === 'dm' || realType === 'director') {
    const ds = claimDistricts(authed);
    allowed = new Set(STORES.filter(s => ds.includes(String(s.district))).map(s => String(s.pc)));
  } else if (realType === 'manager') allowed = new Set(me.store_pc ? [String(me.store_pc)] : []);
  const inScope = (pc) => !!storeOf(pc) && (!allowed || allowed.has(String(pc)));
  const seeAll = ['executive', 'it', 'office_staff'].includes(realType);
  const mine = Number(authed.sub) || -1;
  const canSee = (r) => seeAll || Number(r.submitted_by) === mine;

  try {
    await ensureResignationTable(db);
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const pdfId = url.searchParams.get('pdf');
      if (pdfId) {
        const r = (await db`SELECT pdf, submitted_by FROM resignation_letters WHERE id = ${Number(pdfId)}`)[0];
        if (!r?.pdf || !canSee(r)) return json(404, { error: 'Not found' });
        return new Response(r.pdf, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="resignation-letter.pdf"', 'Cache-Control': 'no-store' } });
      }
      const rows = seeAll
        ? await db`SELECT *, (pdf IS NOT NULL) AS has_pdf FROM resignation_letters ORDER BY created_at DESC LIMIT 300`
        : await db`SELECT *, (pdf IS NOT NULL) AS has_pdf FROM resignation_letters WHERE submitted_by = ${mine} ORDER BY created_at DESC LIMIT 300`;
      const items = rows.map(r => ({ ...rowItem(r), mine: Number(r.submitted_by) === mine }));
      const out = { myName, myTitle: titleForRole(realType), seeAll, stores: STORES.filter(s => inScope(s.pc)).map(s => ({ pc: String(s.pc), name: s.name })), employees: [],
        waiting: items.filter(i => i.status === 'awaiting_signature'), complete: items.filter(i => i.status === 'signed') };
      const prog = await signProgress(db, 'resignation', out.waiting.map(x => x.id)).catch(e => { console.error('[resignation-letter] progress', e.message); return {}; });
      for (const x of out.waiting) x.signing = prog[x.id] || [];
      const roster = await loadRoster().catch(e => { console.error('[resignation-letter] roster', e.message); out.rosterError = 'Paycor is not responding, so employee search is unavailable. Try again in a minute.'; return { stores: {} }; });
      for (const s of out.stores) for (const e of roster.stores[s.pc] || []) out.employees.push({ ...e, pc: s.pc });
      out.employees.sort((a, b) => a.name.localeCompare(b.name));
      return json(200, out);
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = await request.json().catch(() => ({}));

    if (body.action === 'resendLink') {
      const r = (await db`SELECT * FROM resignation_letters WHERE id = ${Number(body.id)} AND status = 'awaiting_signature'`)[0];
      if (!r) return json(404, { error: 'That one is no longer waiting on a signature — reload.' });
      if (!canSee(r)) return json(403, { error: 'Only the person who sent it can resend the link.' });
      await ensureSignTable(db);
      const q = (await db`SELECT * FROM violation_sign_requests WHERE notice_id = ${r.id} AND layout = 'resignation' ORDER BY id DESC LIMIT 1`)[0];
      if (!q) return json(409, { error: 'No signing link was ever sent for this one.' });
      const newEmail = String(body.email || '').trim(); // Fix email (v22.91)
      if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return json(400, { error: 'That email address does not look right.' });
      const store = storeOf(r.pc);
      const sign = await createSignRequest(db, { request, role: 'employee', layout: 'resignation', signerName: r.employee_name, noticeId: r.id, pc: r.pc, storeName: store?.name || q.store_name,
        employeeName: r.employee_name, phone: q.phone, email: newEmail || q.email, fileName: q.file_name, pdf: Buffer.from(r.pdf), createdBy: Number(authed.sub) || null, createdByName: myName });
      return json(200, { ok: true, sign });
    }

    if (body.action === 'refile') {
      const r = (await db`SELECT * FROM resignation_letters WHERE id = ${Number(body.id)} AND status = 'signed' AND filed_at IS NULL`)[0];
      if (!r) return json(404, { error: 'That one is already filed — reload.' });
      if (!canSee(r)) return json(403, { error: 'forbidden' });
      const out = await fileLetter(db, r.id);
      return json(200, { ok: !!out?.drive?.saved, drive: out?.drive, alert: out?.alert });
    }

    // ── submit ──
    const v = body.values || {};
    const missing = missingResignationFields(v);
    if (missing.length) return json(400, { error: `Still needed: ${missing.join(', ')}` });
    if (!inScope(v.pc)) return json(403, { error: 'You can only do this for employees at your own stores.' });
    for (const k of ['date', 'lastDay']) if (!isDate(v[k])) return json(400, { error: 'Check the dates.' });
    for (const k of ['employeeSignature', 'supervisorSignature']) if (v[k] && !isSig(v[k])) return json(400, { error: 'Sign again — a signature did not come through.' });
    const store = storeOf(v.pc);
    const roster = await loadRoster();
    const emp = (roster.stores[String(store.pc)] || []).find(e => e.id === String(body.employeeId || ''));
    if (!emp) return json(404, { error: 'This employee is not on that store\'s active roster in Paycor.' });
    if (emp.name !== v.employeeName || (emp.jobTitle && emp.jobTitle !== v.position)) return json(409, { error: "Paycor's details for this employee changed — pick the employee again." });
    const rs = body.remoteSign || null;
    const remote = !v.employeeSignature && rs;
    if (!v.employeeSignature && !rs) return json(400, { error: 'The employee has to sign, here or from an emailed link.' });
    if (remote) {
      const d = String(rs.phone || '').replace(/\D/g, '');
      if (!(d.length === 10 || (d.length === 11 && d[0] === '1'))) return json(400, { error: "Enter the employee's cell number (10 digits) for the signing link." });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(rs.email || '').trim())) return json(400, { error: "Enter the employee's email — the signing link goes by email." });
    }
    const pdf = Buffer.from(String(body.pdf || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (pdf.length < 1000 || pdf.length > 8e6 || pdf.subarray(0, 5).toString() !== '%PDF-') return json(400, { error: 'The PDF did not come through — try again.' });

    const key = createHash('sha256').update(resignationFingerprint(v) + '|' + (v.employeeSignature || '') + '|' + v.supervisorSignature).digest('hex').slice(0, 32);
    const formValues = Object.fromEntries(Object.entries(v).filter(([k]) => !/Signature$/.test(k)));
    const status = remote ? 'awaiting_signature' : 'signed';
    const inserted = await db`INSERT INTO resignation_letters (form_key, status, pdf, form_values, pc, employee_id, employee_name, position, store_address, last_day, form_date, supervisor_name, supervisor_title, employee_signed, signed_at, submitted_by, submitted_by_name)
      VALUES (${key}, ${status}, ${pdf}, ${JSON.stringify(formValues)}, ${String(store.pc)}, ${emp.id}, ${emp.name}, ${v.position || ''}, ${v.storeAddress}, ${v.lastDay}, ${v.date},
        ${v.supervisorName}, ${v.supervisorTitle}, ${!remote}, ${remote ? null : new Date().toISOString()}, ${Number(authed.sub) || null}, ${myName})
      ON CONFLICT (form_key) DO NOTHING RETURNING id`;
    const row = (await db`SELECT * FROM resignation_letters WHERE form_key = ${key}`)[0];

    if (row.status === 'signed') {
      const out = row.filed_at ? { drive: { saved: true, link: row.drive_link }, alert: row.alert_summary } : await fileLetter(db, row.id);
      return json(200, { ok: true, id: row.id, status: 'signed', already: !inserted.length, drive: out?.drive, alert: out?.alert });
    }
    // Waiting on the employee: email the link (a repeat press within a minute doesn't send twice).
    await ensureSignTable(db);
    const ten = String(rs.phone).replace(/\D/g, '').slice(-10);
    const recent = (await db`SELECT expires_at FROM violation_sign_requests WHERE notice_id = ${row.id} AND layout = 'resignation' AND phone = ${ten}
      AND signed_at IS NULL AND cancelled_at IS NULL AND created_at > now() - interval '1 minute' ORDER BY id DESC LIMIT 1`)[0];
    let sign;
    try {
      sign = recent ? { sent: true, already: true, expiresAt: recent.expires_at }
        : await createSignRequest(db, { request, role: 'employee', layout: 'resignation', signerName: emp.name, noticeId: row.id, pc: store.pc, storeName: store.name, employeeName: emp.name,
          phone: rs.phone, email: String(rs.email).trim(), fileName: resignationFileName(v, store.name), pdf, createdBy: Number(authed.sub) || null, createdByName: myName });
    } catch (e) { console.error('[resignation-letter] sign link', e.message); sign = { error: e.message }; }
    return json(200, { ok: true, id: row.id, status: row.status, already: !inserted.length, sign });
  } catch (e) {
    console.error('[resignation-letter]', e.message);
    return json(502, { error: /Paycor/.test(e.message) ? 'Paycor is not responding — try again in a minute.' : 'Something went wrong — try again.' });
  }
};
