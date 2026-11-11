// violation-notice.mjs — data for Tools · Violation Notice (v22.72; remote signing + approval v22.81).
//
// Flow (user, 2026-11-11): the supervisor fills in and signs → the employee and witness sign, either
// on the spot or later from an emailed link (violation-sign.mjs) → once everyone has signed it waits
// for APPROVAL: the approver (Admin · Notifications · Violation Notice approval — Sam) gets an email +
// text + push → approved: the final PDF is filed ONCE in the "Violation Notices" Shared Drive
// (VIOLATION_DRIVE_FOLDER_ID, folder per store) and Admin · Notifications · Violation Notice is
// alerted. Sent back → the supervisor is told why. Like Pay Increase.
//
//   GET                  → { stores, employees, myName, canApprove, listView, pending?, waiting?, complete? }
//   GET ?pdf=<id>        → the latest PDF (approvers / exec / IT, and the person who made it)
//   POST { values, employeeId, pdf, remoteSign? }  submit (status 'awaiting_signatures' or 'pending')
//   POST { action:'approve', id }                  approver: file in Drive + alert the list
//   POST { action:'reject', id, note }             approver: send back to the supervisor
//
// Everyone can open it (user, 2026-11-10); who they can pick is scoped here, server-side:
//   DM / Director → their districts;  manager / store_tablet → their store;  exec / IT / office → all.
// Texts never carry a link (Textbelt refuses links on this account) — the email does.
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts } from './_shared/store-status.mjs';
import { loadRoster, saveToDrive, emailWithPdf } from './transfer-notice.mjs';
import { sendSms, sendPush, sendHtmlEmail } from './_shared/channels.mjs';
import { createSignRequest, ensureSignTable } from './violation-sign.mjs';
import { missingViolationFields, violationFingerprint, violationFileName, violationAlertText, violationEmailHtml } from '../../src/violation-notice.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const NOTIFY_KEY = 'pcg_violation_notice_notify_v1';
const APPROVERS_KEY = 'pcg_violation_approvers_v1';
const PORTAL = 'https://uop.peoplecapitalgroup.com';
const storeOf = (pc) => STORES.find(s => String(s.pc) === String(pc));
const isSig = (s) => typeof s === 'string' && /^data:image\/png;base64,/.test(s) && s.length > 200 && s.length < 600000;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function readList(key) {
  const raw = await blobs().get(key, { type: 'json' }).catch(() => null);
  const l = raw?.data ?? raw ?? {};
  return {
    emails: (l.emails || []).filter(Boolean), phones: (l.phones || []).filter(Boolean),
    ids: [...new Set([...(l.emailOwners || []), ...(l.phoneOwners || [])].filter(id => id != null).map(String))],
  };
}

// Who approves: named people on the approval list; nobody named yet → every executive.
async function approvers(db) {
  const l = await readList(APPROVERS_KEY);
  if (l.ids.length) return l;
  const execs = await db`SELECT id, email, phone FROM users WHERE active IS NOT FALSE AND user_type = 'executive'`;
  return { ids: execs.map(e => String(e.id)), emails: [...new Set([...l.emails, ...execs.map(e => e.email).filter(Boolean)])], phones: [...new Set([...l.phones, ...execs.map(e => e.phone).filter(Boolean)])] };
}

async function bell(b, ids, message, tag) {
  if (!ids.length) return;
  try {
    const cur = await b.get('pcg_notifications_v1', { type: 'json' });
    const arr = Array.isArray(cur) ? cur : (cur?.data || []);
    const entry = { id: `violation_${tag}_${Date.now()}`, type: 'violation_notice', message, onlyFor: ids.map(String), read: false, createdAt: new Date().toISOString() };
    await b.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...arr].slice(0, 500) });
  } catch (e) { console.warn('[violation-notice] bell write failed', e.message); }
}

// The Violation Notice alert list (after approval): email with the PDF, text, push, bell.
async function sendAlerts(v, storeName, submittedBy, driveLink, fileName, pdf, clientId) {
  const b = blobs();
  const l = await readList(NOTIFY_KEY);
  const t = violationAlertText(v, storeName, submittedBy);
  const [emailed, sms, push] = await Promise.all([
    l.emails.length ? emailWithPdf(l.emails, t.title, violationEmailHtml(v, storeName, submittedBy, driveLink, clientId), fileName, pdf) : false,
    l.phones.length ? sendSms(l.phones, t.sms) : { sent: 0 },
    l.ids.length ? sendPush(b, l.ids, t.title, t.line, 'violation-notice') : { sent: 0 },
  ]);
  await bell(b, l.ids, t.line, 'filed');
  return { recipients: l.emails.length + l.phones.length + l.ids.length, emailed: !!emailed, texted: sms.sent || 0, pushed: push.sent || 0 };
}

// One person (the supervisor who made it): push + bell + email. Never throws.
export async function tellMaker(db, row, title, line) {
  try {
    const u = (await db`SELECT id, email FROM users WHERE id = ${row.submitted_by}`)[0];
    if (!u) return;
    const b = blobs();
    await Promise.all([sendPush(b, [String(u.id)], title, line, `violation-${row.id}`), u.email ? sendHtmlEmail([u.email], title, `<p style="font-family:Arial,sans-serif;font-size:14px">${esc(line)}</p>`) : null]);
    await bell(b, [u.id], line, 'maker');
  } catch (e) { console.error('[violation-notice] tell maker', e.message); }
}

// Email + text + push + bell to the approvers about one notice now waiting (a stored row). Used when
// it becomes pending and, every 3 hours while it still is, by pay-increase-reminder-cron.mjs.
export async function notifyViolationApprovers(db, row, { reminder = false } = {}) {
  const appr = await approvers(db);
  const store = storeOf(row.pc);
  const link = `${PORTAL}/?violation=${row.id}`;
  const waited = reminder ? Math.max(1, Math.round((Date.now() - Date.parse(row.pending_at || row.created_at)) / 3600e3)) : 0;
  const what = `a Violation Notice for ${row.employee_name} (${store?.name || 'PC ' + row.pc}) from ${row.submitted_by_name || 'a supervisor'}`;
  const title = reminder ? `Reminder: violation notice waiting for approval (${waited} h)` : `Violation notice to approve: ${row.employee_name}`;
  const line = reminder ? `${what[0].toUpperCase() + what.slice(1)} is still waiting for your approval (${waited} h).` : `${what[0].toUpperCase() + what.slice(1)} is waiting for your approval.`;
  const b = blobs();
  await Promise.all([
    appr.emails.length ? sendHtmlEmail(appr.emails, title, `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>${esc(line)}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Review and approve</a></p>
<p style="color:#666">Or open the portal: Tools, then Violation Notice.</p></div>`) : null,
    // No link in the text — Textbelt refuses links on this account; the email has it.
    appr.phones.length ? sendSms(appr.phones, `PCG: ${line} Check your email or open the portal (Tools > Violation Notice) to review it.`) : null,
    !reminder && appr.ids.length ? sendPush(b, appr.ids, title, line, `violation-${row.id}`) : null,
  ]);
  if (!reminder) await bell(b, appr.ids, line, 'request');
  await db`UPDATE violation_notices SET reminded_at = now(), reminder_count = reminder_count + ${reminder ? 1 : 0} WHERE id = ${row.id}`;
  return new Set([...appr.ids, ...appr.emails, ...appr.phones]).size;
}

export async function ensureNoticeTable(db) {
  await db`CREATE TABLE IF NOT EXISTS violation_notices (
    id serial PRIMARY KEY, form_key text UNIQUE NOT NULL, pc text, employee_id text, employee_name text, job_title text,
    notice text, types text, action text, violation_date text, form_date text, supervisor_name text, witness_name text,
    employee_signed boolean, employee_refused boolean, submitted_by integer, submitted_by_name text, created_at timestamptz DEFAULT now(),
    drive_file_id text, drive_link text, drive_error text, alerted_at timestamptz, alert_summary jsonb)`;
  // v22.81: approval step. Rows from before it have status NULL = already filed.
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS status text`;
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS pdf bytea`;
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS form_values jsonb`;
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS pending_at timestamptz`;
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS decided_by integer`;
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS decided_by_name text`;
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS decided_at timestamptz`;
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS decision_note text`;
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS reminded_at timestamptz`;
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0`;
  // v22.83 "Sent back": stays until its maker (or exec / IT) deletes it, or until it's resent.
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS deleted_at timestamptz`;
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS deleted_by_name text`;
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS resent_as integer`;
  // v22.84: 'letter' = a warning letter Sam / exec / IT uploaded (NULL = the Violation Notice form).
  await db`ALTER TABLE violation_notices ADD COLUMN IF NOT EXISTS kind text`;
}

const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
const letterFileName = (name, storeName, iso) => `Warning Letter - ${name} - ${storeName} - ${usDate(iso).replace(/\//g, '-')}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');

// A warning letter the employee has acknowledged: no approval step (it came from HR) — file it.
async function fileLetter(db, row) {
  const upd = (await db`UPDATE violation_notices SET status = 'approved', decided_by = submitted_by, decided_by_name = submitted_by_name, decided_at = now()
    WHERE id = ${row.id} AND status = 'awaiting_signatures' RETURNING *`)[0];
  if (!upd) return;
  const store = storeOf(upd.pc);
  const fileName = letterFileName(upd.employee_name, store?.name || upd.pc, upd.form_date);
  let line = `${upd.employee_name} signed to acknowledge their warning letter.`;
  try {
    const f = await saveToDrive(Buffer.from(upd.pdf), [store?.name || upd.pc, upd.employee_name], fileName, `violation:${upd.form_key}`, process.env.VIOLATION_DRIVE_FOLDER_ID || '');
    await db`UPDATE violation_notices SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${upd.id}`;
    line += ' It\'s filed in Google Drive.';
  } catch (e) {
    console.error('[violation-notice] letter drive', e.message);
    await db`UPDATE violation_notices SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${upd.id}`;
    line += ` It could NOT be filed in Google Drive (${e.message}) — tell IT.`;
  }
  await tellMaker(db, upd, `Warning letter acknowledged: ${upd.employee_name}`, line);
}

// Called by violation-sign.mjs after a remote signature: keep the latest PDF, and once nobody is
// left to sign, move it to the approver.
export async function afterRemoteSign(db, noticeId, signedPdf, signerLine) {
  await ensureNoticeTable(db);
  await db`UPDATE violation_notices SET pdf = ${signedPdf} WHERE id = ${noticeId}`;
  const open = await db`SELECT id FROM violation_sign_requests WHERE notice_id = ${noticeId} AND COALESCE(layout, 'notice') <> 'resignation' AND signed_at IS NULL AND cancelled_at IS NULL AND expires_at > now()`;
  const row = (await db`SELECT * FROM violation_notices WHERE id = ${noticeId}`)[0];
  if (!row) return;
  if (row.kind === 'letter') { if (!open.length) await fileLetter(db, row); return; }
  if (open.length) { await tellMaker(db, row, `Violation notice signed: ${row.employee_name}`, `${signerLine} Still waiting on the other signature.`); return; }
  const moved = (await db`UPDATE violation_notices SET status = 'pending', pending_at = now() WHERE id = ${noticeId} AND status = 'awaiting_signatures' RETURNING *`)[0];
  if (moved) {
    await notifyViolationApprovers(db, moved);
    await tellMaker(db, moved, `Violation notice signed: ${row.employee_name}`, `${signerLine} It's now waiting for approval.`);
  }
}

const rowItem = (r) => ({ id: r.id, pc: r.pc, storeName: storeOf(r.pc)?.name || '', employeeName: r.employee_name, jobTitle: r.job_title, notice: r.notice, types: r.types, action: r.action,
  violationDate: r.violation_date, formDate: r.form_date, submittedBy: r.submitted_by_name, createdAt: r.created_at, status: r.status, kind: r.kind || 'notice',
  decidedBy: r.decided_by_name || null, decidedAt: r.decided_at || null, note: r.decision_note || null, driveLink: r.drive_link || null, hasPdf: !!r.has_pdf });

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
    await ensureNoticeTable(db);
    const appr = await approvers(db);
    const canApprove = appr.ids.includes(String(authed.sub));
    const listView = canApprove || realType === 'executive' || realType === 'it';

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const pdfId = url.searchParams.get('pdf');
      if (pdfId) {
        const r = (await db`SELECT pdf, submitted_by FROM violation_notices WHERE id = ${Number(pdfId)}`)[0];
        if (!r?.pdf || !(listView || String(r.submitted_by) === String(authed.sub))) return json(404, { error: 'Not found' });
        return new Response(r.pdf, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="violation-notice.pdf"', 'Cache-Control': 'no-store' } });
      }
      const out = { myName, canApprove, listView, stores: STORES.filter(s => inScope(s.pc)).map(s => ({ pc: String(s.pc), name: s.name })), employees: [] };
      // Sent back: the maker sees their own; approvers / exec / IT see all. Fixing needs the saved
      // answers, which only the maker and exec / IT get.
      const mine = String(authed.sub);
      const backRows = listView
        ? await db`SELECT *, (pdf IS NOT NULL) AS has_pdf FROM violation_notices WHERE status = 'rejected' AND deleted_at IS NULL ORDER BY decided_at DESC LIMIT 200`
        : await db`SELECT *, (pdf IS NOT NULL) AS has_pdf FROM violation_notices WHERE status = 'rejected' AND deleted_at IS NULL AND submitted_by = ${Number(mine) || -1} ORDER BY decided_at DESC LIMIT 200`;
      out.sentBack = backRows.map(r => {
        const own = String(r.submitted_by) === mine;
        const canFix = own || realType === 'executive' || realType === 'it';
        return { ...rowItem(r), mine: own, canFix, employeeId: canFix ? r.employee_id : undefined, formValues: canFix ? (r.form_values || null) : undefined };
      });
      if (listView) {
        out.pending = (await db`SELECT id, pc, employee_name, job_title, notice, types, action, violation_date, form_date, submitted_by_name, created_at, status, decided_by_name, decided_at, decision_note, drive_link, (pdf IS NOT NULL) AS has_pdf FROM violation_notices WHERE status = 'pending' ORDER BY pending_at NULLS FIRST, created_at`).map(rowItem);
        out.waiting = (await db`SELECT id, pc, employee_name, job_title, notice, types, action, violation_date, form_date, submitted_by_name, created_at, status, decided_by_name, decided_at, decision_note, drive_link, (pdf IS NOT NULL) AS has_pdf FROM violation_notices WHERE status = 'awaiting_signatures' ORDER BY created_at DESC LIMIT 100`).map(rowItem);
        out.complete = (await db`SELECT id, pc, employee_name, job_title, notice, types, action, violation_date, form_date, submitted_by_name, created_at, status, decided_by_name, decided_at, decision_note, drive_link, (pdf IS NOT NULL) AS has_pdf FROM violation_notices WHERE status = 'approved' OR status IS NULL ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 300`).map(rowItem);
      }
      const roster = await loadRoster().catch(e => { console.error('[violation-notice] roster', e.message); out.rosterError = 'Paycor is not responding, so employee search is unavailable. Try again in a minute.'; return { stores: {} }; });
      for (const s of out.stores) for (const e of roster.stores[s.pc] || []) out.employees.push({ ...e, pc: s.pc });
      out.employees.sort((a, b) => a.name.localeCompare(b.name));
      return json(200, out);
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = await request.json().catch(() => ({}));

    // ── warning letter upload (Sam / exec / IT) ──
    if (body.action === 'uploadLetter') {
      if (!listView) return json(403, { error: 'Only HR (the violation notice approvers) and exec / IT can upload warning letters.' });
      const store = storeOf(body.pc);
      if (!store) return json(400, { error: 'Pick the employee again.' });
      const roster = await loadRoster();
      const emp = (roster.stores[String(store.pc)] || []).find(e => e.id === String(body.employeeId || ''));
      if (!emp) return json(404, { error: 'This employee is not on that store\'s active roster in Paycor.' });
      const d = String(body.phone || '').replace(/\D/g, '');
      if (!(d.length === 10 || (d.length === 11 && d[0] === '1'))) return json(400, { error: "Enter the employee's cell number (10 digits)." });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email || '').trim())) return json(400, { error: "Enter the employee's email — the letter goes by email." });
      if (!isDate(body.letterDate)) return json(400, { error: 'Enter the date on the letter.' });
      const f = body.file || {};
      const mime = String(f.type || '');
      if (!/^(application\/pdf|image\/jpeg|image\/png)$/.test(mime)) return json(400, { error: 'Upload the letter as a PDF (in Word: File > Save as > PDF), or a JPG / PNG photo of it.' });
      const buf = Buffer.from(String(f.data || '').replace(/^data:[^,]*,/, ''), 'base64');
      if (buf.length < 200 || buf.length > 4.2e6) return json(400, { error: 'The file is too large (4 MB max) or empty.' });
      let pdf;
      try {
        const { letterToPdf, appendAckPage } = await import('./violation-sign.mjs');
        const doc = await letterToPdf(buf, mime);
        await appendAckPage(doc, { employeeName: emp.name, storeName: store.name, letterDate: usDate(body.letterDate), from: myName ? `${myName}, People Capital Group` : null });
        pdf = Buffer.from(await doc.save());
      } catch (e) {
        console.error('[violation-notice] letter pdf', e.message);
        return json(400, { error: /encrypt/i.test(e.message) ? 'That PDF is password-protected. Save it again without a password.' : "That file couldn't be read as a PDF or photo. Save it as a PDF and try again." });
      }
      const key = createHash('sha256').update(`letter|${emp.id}|${body.letterDate}|`).update(buf).digest('hex').slice(0, 32);
      const formValues = { employeeName: emp.name, jobTitle: emp.jobTitle || '', pc: String(store.pc), date: body.letterDate, letterName: String(f.name || '').slice(0, 120) };
      const inserted = await db`INSERT INTO violation_notices (form_key, kind, status, pdf, form_values, pc, employee_id, employee_name, job_title, form_date, supervisor_name, submitted_by, submitted_by_name)
        VALUES (${key}, 'letter', 'awaiting_signatures', ${pdf}, ${JSON.stringify(formValues)}, ${String(store.pc)}, ${emp.id}, ${emp.name}, ${emp.jobTitle || ''}, ${body.letterDate}, ${myName}, ${Number(authed.sub) || null}, ${myName})
        ON CONFLICT (form_key) DO NOTHING RETURNING id`;
      const row = (await db`SELECT * FROM violation_notices WHERE form_key = ${key}`)[0];
      if (!inserted.length && row.status !== 'awaiting_signatures') return json(200, { ok: true, already: true, status: row.status });
      const sign = await createSignRequest(db, { request, role: 'employee', layout: 'letter', signerName: emp.name, noticeId: row.id, pc: store.pc, storeName: store.name, employeeName: emp.name,
        phone: body.phone, email: String(body.email).trim(), fileName: letterFileName(emp.name, store.name, body.letterDate), pdf: Buffer.from(row.pdf), createdBy: Number(authed.sub) || null, createdByName: myName });
      return json(200, { ok: true, id: row.id, status: 'awaiting_signatures', sign });
    }

    // ── resend a signing link that hasn't been used (its maker, or exec / IT) ──
    if (body.action === 'resendLink') {
      const r = (await db`SELECT * FROM violation_notices WHERE id = ${Number(body.id)} AND status = 'awaiting_signatures'`)[0];
      if (!r) return json(404, { error: 'That one is no longer waiting on a signature — reload.' });
      if (!(String(r.submitted_by) === String(authed.sub) || listView)) return json(403, { error: 'Only the person who sent it can resend the link.' });
      await ensureSignTable(db);
      const last = await db`SELECT DISTINCT ON (COALESCE(role, 'employee')) * FROM violation_sign_requests WHERE notice_id = ${r.id} AND COALESCE(layout, 'notice') <> 'resignation' ORDER BY COALESCE(role, 'employee'), id DESC`;
      const out = [];
      for (const q of last) {
        if (q.signed_at) continue;
        const store = storeOf(r.pc);
        out.push(await createSignRequest(db, { request, role: q.role || 'employee', layout: q.layout || 'notice', signerName: q.signer_name || r.employee_name, noticeId: r.id, pc: r.pc, storeName: store?.name || q.store_name,
          employeeName: r.employee_name, phone: q.phone, email: q.email, fileName: q.file_name, pdf: Buffer.from(r.pdf), createdBy: Number(authed.sub) || null, createdByName: myName }));
      }
      if (!out.length) return json(409, { error: 'Everyone has already signed — reload.' });
      return json(200, { ok: true, resent: out });
    }

    // ── sent back: resend unchanged, or delete (its maker, or exec / IT) ──
    if (body.action === 'resend' || body.action === 'delete') {
      const r = (await db`SELECT * FROM violation_notices WHERE id = ${Number(body.id)} AND status = 'rejected' AND deleted_at IS NULL`)[0];
      if (!r) return json(404, { error: 'That sent-back notice is gone — reload.' });
      if (!(String(r.submitted_by) === String(authed.sub) || realType === 'executive' || realType === 'it')) return json(403, { error: 'Only the person who wrote it can do this.' });
      if (body.action === 'delete') {
        // Kept in the database for the record; gone from every screen.
        await db`UPDATE violation_notices SET deleted_at = now(), deleted_by_name = ${myName} WHERE id = ${r.id}`;
        return json(200, { ok: true });
      }
      // Nothing changed, so every signature still stands: straight back to the approver.
      const upd = (await db`UPDATE violation_notices SET status = 'pending', pending_at = now(), decided_by = NULL, decided_by_name = NULL, decided_at = NULL, decision_note = NULL, reminded_at = NULL
        WHERE id = ${r.id} AND status = 'rejected' RETURNING *`)[0];
      if (!upd) return json(409, { error: 'This one already changed — reload.' });
      const notified = await notifyViolationApprovers(db, upd);
      return json(200, { ok: true, status: 'pending', notified });
    }

    // ── approver decisions ──
    if (body.action === 'approve' || body.action === 'reject') {
      if (!canApprove) return json(403, { error: 'Only the violation notice approver can do this.' });
      const r = (await db`SELECT * FROM violation_notices WHERE id = ${Number(body.id)}`)[0];
      if (!r) return json(404, { error: 'Not found' });
      if (body.action === 'reject') {
        const note = String(body.note || '').trim().slice(0, 400);
        if (note.length < 3) return json(400, { error: 'Say why it is being sent back.' });
        const upd = (await db`UPDATE violation_notices SET status = 'rejected', decided_by = ${Number(authed.sub)}, decided_by_name = ${myName}, decided_at = now(), decision_note = ${note}
          WHERE id = ${r.id} AND status = 'pending' RETURNING *`)[0];
        if (!upd) return json(409, { error: 'This one was already decided — reload.' });
        await tellMaker(db, upd, `Violation notice sent back: ${upd.employee_name}`, `${myName} sent back the Violation Notice for ${upd.employee_name}: "${note}". It's under Sent back in Tools > Violation Notice, where you can fix and resend it.`);
        return json(200, { ok: true });
      }
      // approve: claim it first so two quick clicks can't both file.
      const upd = (await db`UPDATE violation_notices SET status = 'approved', decided_by = ${Number(authed.sub)}, decided_by_name = ${myName}, decided_at = now()
        WHERE id = ${r.id} AND status = 'pending' RETURNING *`)[0];
      if (!upd) return json(409, { error: 'This one was already decided — reload.' });
      const store = storeOf(upd.pc);
      const v = upd.form_values || {};
      const pdf = Buffer.from(upd.pdf);
      const fileName = violationFileName(v, store?.name || upd.pc);
      let drive = { saved: false, link: '', error: null };
      try {
        const f = await saveToDrive(pdf, [store?.name || upd.pc, upd.employee_name], fileName, `violation:${upd.form_key}`, process.env.VIOLATION_DRIVE_FOLDER_ID || '');
        drive = { saved: true, link: f.webViewLink || '' };
        await db`UPDATE violation_notices SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${upd.id}`;
      } catch (e) {
        drive.error = e.message;
        console.error('[violation-notice] drive', e.message);
        await db`UPDATE violation_notices SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${upd.id}`;
      }
      let alert;
      try {
        alert = await sendAlerts(v, store?.name, upd.submitted_by_name, drive.link, fileName, pdf, store?.paycor);
        await db`UPDATE violation_notices SET alerted_at = now(), alert_summary = ${JSON.stringify(alert)} WHERE id = ${upd.id}`;
      } catch (e) { console.error('[violation-notice] alert', e.message); alert = { error: e.message }; }
      await tellMaker(db, upd, `Violation notice approved: ${upd.employee_name}`, `${myName} approved the Violation Notice for ${upd.employee_name}. It's filed in Google Drive.`);
      return json(200, { ok: drive.saved && !alert?.error, drive, alert });
    }

    // ── submit ──
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
    // Employee and/or witness not there → email them a private link to sign (violation-sign.mjs).
    const rs = body.remoteSign || {};
    const remotes = [];
    if (rs.employee && !v.employeeSignature && !v.employeeRefused) remotes.push({ role: 'employee', who: 'employee', name: emp.name, ...rs.employee });
    if (rs.witness && !v.witnessSignature) {
      if (!String(v.witnessName || '').trim()) return json(400, { error: 'Type the witness name before sending them a signing link.' });
      remotes.push({ role: 'witness', who: 'witness', name: String(v.witnessName).trim(), ...rs.witness });
    }
    for (const r of remotes) {
      const d = String(r.phone || '').replace(/\D/g, '');
      if (!(d.length === 10 || (d.length === 11 && d[0] === '1'))) return json(400, { error: `Enter the ${r.who}'s cell number (10 digits) for the signing link.` });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r.email || '').trim())) return json(400, { error: `Enter the ${r.who}'s email — the signing link goes by email.` });
    }
    const pdf = Buffer.from(String(body.pdf || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (pdf.length < 1000 || pdf.length > 8e6 || pdf.subarray(0, 5).toString() !== '%PDF-') return json(400, { error: 'The PDF did not come through — try again.' });

    const key = createHash('sha256').update(violationFingerprint(v) + '|' + (v.employeeSignature || '') + '|' + v.supervisorSignature + '|' + (v.witnessSignature || '')).digest('hex').slice(0, 32);
    // What the alert list's email needs later, without the signature images.
    const formValues = Object.fromEntries(Object.entries(v).filter(([k]) => !/Signature$/.test(k)));
    const status = remotes.length ? 'awaiting_signatures' : 'pending';
    const inserted = await db`INSERT INTO violation_notices (form_key, status, pdf, form_values, pending_at, pc, employee_id, employee_name, job_title, notice, types, action, violation_date, form_date, supervisor_name, witness_name, employee_signed, employee_refused, submitted_by, submitted_by_name)
      VALUES (${key}, ${status}, ${pdf}, ${JSON.stringify(formValues)}, ${status === 'pending' ? new Date().toISOString() : null}, ${String(store.pc)}, ${emp.id}, ${emp.name}, ${v.jobTitle || ''}, ${v.notice}, ${(v.types || []).join(',')}, ${v.action}, ${v.violationDate}, ${v.date},
        ${v.supervisorName}, ${v.witnessName || null}, ${!!v.employeeSignature}, ${!!v.employeeRefused}, ${Number(authed.sub) || null}, ${myName})
      ON CONFLICT (form_key) DO NOTHING RETURNING id`;
    const row = (await db`SELECT * FROM violation_notices WHERE form_key = ${key}`)[0];

    // Fix and resend: the sent-back notice this replaces leaves the Sent back list.
    if (body.replaces && row.id !== Number(body.replaces)) {
      await db`UPDATE violation_notices SET status = 'resent', resent_as = ${row.id} WHERE id = ${Number(body.replaces)} AND status = 'rejected'
        AND (submitted_by = ${Number(authed.sub) || -1} OR ${realType === 'executive' || realType === 'it'})`;
    }

    let notified = 0;
    if (inserted.length && row.status === 'pending') notified = await notifyViolationApprovers(db, row);

    // Signing links: on the first save, and again whenever the supervisor presses send while the
    // notice is still waiting on signatures (that's how a link is resent; the old one is cancelled).
    const remoteSign = [];
    if (remotes.length && row.status === 'awaiting_signatures') {
      await ensureSignTable(db);
      for (const r of remotes) {
        try {
          const ten = String(r.phone).replace(/\D/g, '').slice(-10);
          const done = (await db`SELECT id FROM violation_sign_requests WHERE notice_id = ${row.id} AND COALESCE(layout, 'notice') <> 'resignation' AND COALESCE(role, 'employee') = ${r.role} AND signed_at IS NOT NULL LIMIT 1`)[0];
          if (done) { remoteSign.push({ role: r.role, sent: true, signedAlready: true }); continue; }
          // A double tap within a minute must not email / text twice.
          const recent = (await db`SELECT expires_at FROM violation_sign_requests WHERE notice_id = ${row.id} AND COALESCE(layout, 'notice') <> 'resignation' AND COALESCE(role, 'employee') = ${r.role} AND phone = ${ten}
            AND signed_at IS NULL AND cancelled_at IS NULL AND created_at > now() - interval '1 minute' ORDER BY id DESC LIMIT 1`)[0];
          remoteSign.push(recent ? { role: r.role, sent: true, already: true, expiresAt: recent.expires_at }
            : await createSignRequest(db, { request, role: r.role, signerName: r.name, noticeId: row.id, pc: store.pc, storeName: store.name, employeeName: emp.name, phone: r.phone,
              email: String(r.email || '').trim(), fileName: violationFileName(v, store.name), pdf, createdBy: Number(authed.sub) || null, createdByName: myName }));
        } catch (e) { console.error('[violation-notice] sign link', r.role, e.message); remoteSign.push({ role: r.role, error: e.message }); }
      }
    }
    return json(200, { ok: true, id: row.id, status: row.status, notified, already: !inserted.length, remoteSign });
  } catch (e) {
    console.error('[violation-notice]', e.message);
    return json(502, { error: /Paycor/.test(e.message) ? 'Paycor is not responding — try again in a minute.' : 'Something went wrong — try again.' });
  }
};
