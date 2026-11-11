// missing-hours.mjs — data for Tools · Missing Hours (v22.89).
//
// Flow (user, 2026-11-11): a manager (their store), DM or Director (their districts) fills in HR's
// "Employee Missing Hours" form and signs → it waits for approval (Admin · Notifications · Missing
// Hours approval — Ella; nobody named → every executive) with email + text + push and 3-hour
// reminders (pay-increase-reminder-cron.mjs) → approved: the hours are STAGED in Paycor's payroll
// grid for that employee (v2 payrollhours, employeeId GUID, earning code Reg, one line per day, its
// own processId — staging only; payroll still reviews and submits in Paycor), the form is filed in
// the Missing Hours Drive (MISSING_HOURS_DRIVE_FOLDER_ID, store → employee) and the person who sent
// it is told. Sent back → they're told why; they can fix and resend, or delete it.
//
//   GET                  → { stores, employees, myName, canApprove, seeAll, pending, sentBack, complete }
//   GET ?pdf=<id>        → the form (approvers / exec / IT, and the person who sent it)
//   POST { values, employeeId, pdf, replaces? }      submit
//   POST { action:'approve' | 'reject', id, note? } approver
//   POST { action:'retry', id }                      approver / exec / IT: resend a failed Paycor stage
//   POST { action:'delete', id }                     maker / exec / IT: drop a sent-back form
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts } from './_shared/store-status.mjs';
import { loadRoster, saveToDrive } from './transfer-notice.mjs';
import { callPaycor } from './paycor.mjs';
import { sendSms, sendPush, sendHtmlEmail } from './_shared/channels.mjs';
import { missingHoursProblems, missingHoursFingerprint, missingHoursFileName, missingHoursRowsHtml, usDate, fmtHours, rowHours, periodFor, MH_MAX_ROWS } from '../../src/missing-hours.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const APPROVERS_KEY = 'pcg_missing_hours_approvers_v1';
const PORTAL = 'https://uop.peoplecapitalgroup.com';
const storeOf = (pc) => STORES.find(s => String(s.pc) === String(pc));
const isSig = (s) => typeof s === 'string' && /^data:image\/png;base64,/.test(s) && s.length > 200 && s.length < 600000;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const todayEt = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etStamp = (d = new Date()) => d.toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '');

// Same mapping the tips send uses (app.jsx paycorDeptCodeForJobTitle).
const deptCodeFor = (t) => (/store\s*manager|general\s*manager/i.test(t || '') ? 104 : /asst\.?\s*manager|assist(ant)?\s*manager/i.test(t || '') ? 103 : /shift\s*leader/i.test(t || '') ? 102 : 101);
const EARNING_CODE = 'Reg';
// Deterministic GUID-shaped processId per form — a retry re-sends the same batch, never a second one.
function processIdFor(seed) {
  const b = createHash('sha256').update(seed).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function readList(key) {
  const raw = await blobs().get(key, { type: 'json' }).catch(() => null);
  const l = raw?.data ?? raw ?? {};
  return { emails: (l.emails || []).filter(Boolean), phones: (l.phones || []).filter(Boolean), ids: [...new Set([...(l.emailOwners || []), ...(l.phoneOwners || [])].filter(id => id != null).map(String))] };
}
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
    const entry = { id: `missinghours_${tag}_${Date.now()}`, type: 'missing_hours', message, onlyFor: ids.map(String), read: false, createdAt: new Date().toISOString() };
    await b.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...arr].slice(0, 500) });
  } catch (e) { console.warn('[missing-hours] bell write failed', e.message); }
}
async function tellMaker(db, row, title, line) {
  try {
    const u = (await db`SELECT id, email FROM users WHERE id = ${row.submitted_by}`)[0];
    if (!u) return;
    const b = blobs();
    await Promise.all([sendPush(b, [String(u.id)], title, line, `missinghours-${row.id}`), u.email ? sendHtmlEmail([u.email], title, `<p style="font-family:Arial,sans-serif;font-size:14px">${esc(line)}</p>`) : null]);
    await bell(b, [u.id], line, 'maker');
  } catch (e) { console.error('[missing-hours] tell maker', e.message); }
}

export async function notifyMissingHoursApprovers(db, row, { reminder = false } = {}) {
  const appr = await approvers(db);
  const store = storeOf(row.pc);
  const v = row.form_values || {};
  const link = `${PORTAL}/?missingHours=${row.id}`;
  const waited = reminder ? Math.max(1, Math.round((Date.now() - Date.parse(row.created_at)) / 3600e3)) : 0;
  const what = `missing hours for ${row.employee_name} (${store?.name || 'PC ' + row.pc}, ${fmtHours(Number(row.total_hours))} h) from ${row.submitted_by_name || 'a manager'}`;
  const cap = what[0].toUpperCase() + what.slice(1);
  const title = reminder ? `Reminder: missing hours waiting for approval (${waited} h)` : `Missing hours to approve: ${row.employee_name}`;
  const line = reminder ? `${cap} are still waiting for your approval (${waited} h).` : `${cap} are waiting for your approval.`;
  const b = blobs();
  await Promise.all([
    appr.emails.length ? sendHtmlEmail(appr.emails, title, `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>${esc(line)}</p>${missingHoursRowsHtml(v)}
<p><a href="${esc(link)}" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Review and approve</a></p>
<p style="color:#666">Once approved, the hours are added to the employee's Paycor payroll grid for review before payroll is submitted.</p></div>`) : null,
    // No link in the text — Textbelt refuses links on this account; the email has it.
    appr.phones.length ? sendSms(appr.phones, `PCG: ${line} Check your email or open the portal (Tools > Missing Hours) to review it.`) : null,
    !reminder && appr.ids.length ? sendPush(b, appr.ids, title, line, `missinghours-${row.id}`) : null,
  ]);
  if (!reminder) await bell(b, appr.ids, line, 'request');
  await db`UPDATE missing_hours_forms SET reminded_at = now(), reminder_count = reminder_count + ${reminder ? 1 : 0} WHERE id = ${row.id}`;
  return new Set([...appr.ids, ...appr.emails, ...appr.phones]).size;
}

export async function ensureMissingHoursTable(db) {
  await db`CREATE TABLE IF NOT EXISTS missing_hours_forms (
    id serial PRIMARY KEY, form_key text UNIQUE NOT NULL, status text NOT NULL, pdf bytea, form_values jsonb,
    pc text, employee_id text, employee_name text, job_title text, period_start text, period_end text, total_hours numeric,
    submitted_by integer, submitted_by_name text, created_at timestamptz DEFAULT now(), reminded_at timestamptz, reminder_count integer NOT NULL DEFAULT 0,
    decided_by integer, decided_by_name text, decided_at timestamptz, decision_note text,
    paycor_status text, paycor_process_id text, paycor_error text, paycor_sent_at timestamptz,
    drive_file_id text, drive_link text, drive_error text, deleted_at timestamptz, resent_as integer)`;
}

// Stage the approved hours in Paycor: one line per day, Reg, the employee's department by job title.
async function stageInPaycor(db, row) {
  const store = storeOf(row.pc);
  const v = row.form_values || {};
  const processId = row.paycor_process_id || processIdFor(`missing-hours_${row.form_key}`);
  await db`UPDATE missing_hours_forms SET paycor_status = 'sending', paycor_process_id = ${processId} WHERE id = ${row.id}`;
  try {
    if (!store?.paycor) throw new Error('No Paycor legal entity for this store');
    const pg = await callPaycor(`/legalentities/${store.paycor}/paygroups`);
    const groups = Array.isArray(pg.data?.records) ? pg.data.records : (Array.isArray(pg.data) ? pg.data : []);
    const payGroupId = groups[0]?.payGroupId;
    if (!payGroupId) throw new Error("Couldn't look up the store's Paycor pay group");
    // Department from the employee's job title today (live roster), like the tips send.
    const roster = await loadRoster().catch(() => ({ stores: {} }));
    const live = (roster.stores[String(row.pc)] || []).find(e => e.id === row.employee_id);
    const departmentCode = deptCodeFor(live?.jobTitle || row.job_title);
    const importEarnings = (v.rows || []).filter(r => r.hours > 0).map(r => ({
      departmentCode, earningCode: EARNING_CODE, earningHours: r.hours,
      businessStartDate: `${r.date}T00:00:00Z`, businessEndDate: `${r.date}T23:59:59Z`, payGroupId,
    }));
    if (!importEarnings.length) throw new Error('No hours to send');
    const res = await callPaycor(`/legalentities/${store.paycor}/payrollhours?replaceData=true`, 'POST',
      { integrationVendor: 'PCG Portal', processId, importEmployees: [{ employeeId: row.employee_id, importEarnings }] }, 'v2');
    if (res.status < 200 || res.status >= 300) throw new Error(res.data?.Detail || res.data?.detail || res.data?.message || `Paycor said HTTP ${res.status}`);
    await db`UPDATE missing_hours_forms SET paycor_status = 'sent', paycor_error = NULL, paycor_sent_at = now() WHERE id = ${row.id}`;
    return { ok: true };
  } catch (e) {
    console.error('[missing-hours] paycor', row.id, e.message);
    await db`UPDATE missing_hours_forms SET paycor_status = 'failed', paycor_error = ${String(e.message).slice(0, 500)} WHERE id = ${row.id}`;
    return { ok: false, error: e.message };
  }
}

// The approved form with an approval line at the foot, filed in Drive (store → employee).
async function fileForm(db, row, approverName) {
  try {
    const doc = await PDFDocument.load(Buffer.from(row.pdf));
    const page = doc.getPage(0);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(`Approved by ${approverName} on ${etStamp()} ET in the PCG Portal.`, { x: 72, y: 40, size: 8, font, color: rgb(0.3, 0.3, 0.3) });
    const pdf = Buffer.from(await doc.save());
    await db`UPDATE missing_hours_forms SET pdf = ${pdf} WHERE id = ${row.id}`;
    const store = storeOf(row.pc);
    const f = await saveToDrive(pdf, [store?.name || row.pc, row.employee_name], missingHoursFileName(row.form_values || {}, store?.name), `missinghours:${row.form_key}`, process.env.MISSING_HOURS_DRIVE_FOLDER_ID || '');
    await db`UPDATE missing_hours_forms SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${row.id}`;
    return { saved: true, link: f.webViewLink || '' };
  } catch (e) {
    console.error('[missing-hours] drive', row.id, e.message);
    await db`UPDATE missing_hours_forms SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${row.id}`;
    return { saved: false, error: e.message };
  }
}

const rowItem = (r) => {
  const v = r.form_values || {};
  return { id: r.id, pc: r.pc, storeName: storeOf(r.pc)?.name || '', employeeName: r.employee_name, jobTitle: r.job_title, periodStart: r.period_start, periodEnd: r.period_end,
    totalHours: Number(r.total_hours), days: (v.rows || []).length, submittedBy: r.submitted_by_name, createdAt: r.created_at, status: r.status,
    decidedBy: r.decided_by_name || null, decidedAt: r.decided_at || null, note: r.decision_note || null, paycorStatus: r.paycor_status || null, paycorError: r.paycor_error || null,
    driveLink: r.drive_link || null, hasPdf: !!r.has_pdf };
};

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const realType = authed.realUserType || authed.userType;
  if (!['executive', 'it', 'dm', 'director', 'manager'].includes(realType)) return json(403, { error: 'forbidden' });
  await syncDistricts(STORES, ALL_STORES);
  const me = (await db`SELECT name, store_pc FROM users WHERE id = ${authed.sub}`)[0] || {};
  const myName = me.name || authed.name || authed.username || '';
  // Manager → their store; DM / Director → their districts; exec / IT → all (user, 2026-11-11).
  let allowed = null;
  if (realType === 'dm' || realType === 'director') {
    const ds = claimDistricts(authed);
    allowed = new Set(STORES.filter(s => ds.includes(String(s.district))).map(s => String(s.pc)));
  } else if (realType === 'manager') allowed = new Set(me.store_pc ? [String(me.store_pc)] : []);
  const inScope = (pc) => !!storeOf(pc) && (!allowed || allowed.has(String(pc)));
  const mine = Number(authed.sub) || -1;

  try {
    await ensureMissingHoursTable(db);
    const appr = await approvers(db);
    const canApprove = appr.ids.includes(String(authed.sub));
    const seeAll = canApprove || realType === 'executive' || realType === 'it';
    const canSee = (r) => seeAll || Number(r.submitted_by) === mine;

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const pdfId = url.searchParams.get('pdf');
      if (pdfId) {
        const r = (await db`SELECT pdf, submitted_by FROM missing_hours_forms WHERE id = ${Number(pdfId)}`)[0];
        if (!r?.pdf || !canSee(r)) return json(404, { error: 'Not found' });
        return new Response(r.pdf, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="missing-hours.pdf"', 'Cache-Control': 'no-store' } });
      }
      const rows = seeAll
        ? await db`SELECT *, (pdf IS NOT NULL) AS has_pdf FROM missing_hours_forms WHERE deleted_at IS NULL AND status IN ('pending', 'rejected', 'approved') ORDER BY created_at DESC LIMIT 400`
        : await db`SELECT *, (pdf IS NOT NULL) AS has_pdf FROM missing_hours_forms WHERE deleted_at IS NULL AND status IN ('pending', 'rejected', 'approved') AND submitted_by = ${mine} ORDER BY created_at DESC LIMIT 400`;
      const items = rows.map(r => {
        const own = Number(r.submitted_by) === mine;
        const canFix = own || realType === 'executive' || realType === 'it';
        return { ...rowItem(r), mine: own, canFix, employeeId: canFix ? r.employee_id : undefined, formValues: canFix && r.status === 'rejected' ? (r.form_values || null) : undefined };
      });
      const out = { myName, canApprove, seeAll, stores: STORES.filter(s => inScope(s.pc)).map(s => ({ pc: String(s.pc), name: s.name })), employees: [],
        pending: items.filter(i => i.status === 'pending').reverse(), sentBack: items.filter(i => i.status === 'rejected'), complete: items.filter(i => i.status === 'approved') };
      const roster = await loadRoster().catch(e => { console.error('[missing-hours] roster', e.message); out.rosterError = 'Paycor is not responding, so employee search is unavailable. Try again in a minute.'; return { stores: {} }; });
      for (const s of out.stores) for (const e of roster.stores[s.pc] || []) out.employees.push({ ...e, pc: s.pc });
      out.employees.sort((a, b) => a.name.localeCompare(b.name));
      return json(200, out);
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = await request.json().catch(() => ({}));

    if (body.action === 'delete') {
      const r = (await db`SELECT * FROM missing_hours_forms WHERE id = ${Number(body.id)} AND status = 'rejected' AND deleted_at IS NULL`)[0];
      if (!r) return json(404, { error: 'That sent-back form is gone — reload.' });
      if (!(Number(r.submitted_by) === mine || realType === 'executive' || realType === 'it')) return json(403, { error: 'Only the person who sent it can delete it.' });
      await db`UPDATE missing_hours_forms SET deleted_at = now() WHERE id = ${r.id}`;
      return json(200, { ok: true });
    }

    if (body.action === 'retry') {
      if (!(canApprove || realType === 'executive' || realType === 'it')) return json(403, { error: 'forbidden' });
      const r = (await db`SELECT * FROM missing_hours_forms WHERE id = ${Number(body.id)} AND status = 'approved'`)[0];
      if (!r) return json(404, { error: 'Not found' });
      const paycor = r.paycor_status === 'sent' ? { ok: true } : await stageInPaycor(db, r);
      const drive = r.drive_link ? { saved: true, link: r.drive_link } : await fileForm(db, r, r.decided_by_name || myName);
      if (paycor.ok && r.paycor_status !== 'sent') await tellMaker(db, r, `Missing hours sent to Paycor: ${r.employee_name}`, `The missing hours for ${r.employee_name} (${fmtHours(Number(r.total_hours))} h) are now in Paycor.`);
      return json(200, { ok: paycor.ok, paycor, drive });
    }

    if (body.action === 'approve' || body.action === 'reject') {
      if (!canApprove) return json(403, { error: 'Only the missing hours approver can do this.' });
      if (body.action === 'reject') {
        const note = String(body.note || '').trim().slice(0, 400);
        if (note.length < 3) return json(400, { error: 'Say why it is being sent back.' });
        const upd = (await db`UPDATE missing_hours_forms SET status = 'rejected', decided_by = ${mine}, decided_by_name = ${myName}, decided_at = now(), decision_note = ${note}
          WHERE id = ${Number(body.id)} AND status = 'pending' RETURNING *`)[0];
        if (!upd) return json(409, { error: 'This one was already decided — reload.' });
        await tellMaker(db, upd, `Missing hours sent back: ${upd.employee_name}`, `${myName} sent back the missing hours for ${upd.employee_name}: "${note}". It's under Sent back in Tools > Missing Hours, where you can fix and resend it.`);
        return json(200, { ok: true });
      }
      const upd = (await db`UPDATE missing_hours_forms SET status = 'approved', decided_by = ${mine}, decided_by_name = ${myName}, decided_at = now()
        WHERE id = ${Number(body.id)} AND status = 'pending' RETURNING *`)[0];
      if (!upd) return json(409, { error: 'This one was already decided — reload.' });
      const paycor = await stageInPaycor(db, upd);
      const drive = await fileForm(db, upd, myName);
      await tellMaker(db, upd, `Missing hours approved: ${upd.employee_name}`, paycor.ok
        ? `${myName} approved the missing hours for ${upd.employee_name} (${fmtHours(Number(upd.total_hours))} h, ${usDate(upd.period_start)} - ${usDate(upd.period_end)}). They're in Paycor now.`
        : `${myName} approved the missing hours for ${upd.employee_name}, but they could NOT be added to Paycor yet (${paycor.error}). IT has been flagged in the portal.`);
      return json(200, { ok: paycor.ok, paycor, drive });
    }

    // ── submit ──
    const v = body.values || {};
    // Hours, total and pay period are worked out here again — never taken from the browser.
    v.rows = (Array.isArray(v.rows) ? v.rows : []).slice(0, MH_MAX_ROWS).map(r => ({ date: String(r?.date || ''), clockIn: String(r?.clockIn || ''), clockOut: String(r?.clockOut || ''), hours: rowHours(r) }));
    v.total = Math.round(v.rows.reduce((t, r) => t + r.hours, 0) * 100) / 100;
    const per = v.rows[0] && /^\d{4}-\d{2}-\d{2}$/.test(v.rows[0].date) ? periodFor(v.rows[0].date) : null;
    v.periodStart = per?.start || ''; v.periodEnd = per?.end || '';
    const problems = missingHoursProblems(v, todayEt());
    if ((body.values?.rows || []).length > MH_MAX_ROWS) problems.push(`At most ${MH_MAX_ROWS} days per form`);
    if (problems.length) return json(400, { error: `Still needed: ${problems.join(', ')}` });
    if (!isSig(v.signature)) return json(400, { error: 'Sign again — the signature did not come through.' });
    if (!inScope(v.pc)) return json(403, { error: 'You can only send missing hours for employees at your own stores.' });
    const store = storeOf(v.pc);
    const roster = await loadRoster();
    const emp = (roster.stores[String(store.pc)] || []).find(e => e.id === String(body.employeeId || ''));
    if (!emp) return json(404, { error: 'This employee is not on that store\'s active roster in Paycor.' });
    if (emp.name !== v.employeeName) return json(409, { error: "Paycor's details for this employee changed — pick the employee again." });
    const pdf = Buffer.from(String(body.pdf || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (pdf.length < 1000 || pdf.length > 8e6 || pdf.subarray(0, 5).toString() !== '%PDF-') return json(400, { error: 'The PDF did not come through — try again.' });

    const key = createHash('sha256').update(missingHoursFingerprint(v) + '|' + v.signature).digest('hex').slice(0, 32);
    const formValues = Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'signature'));
    const inserted = await db`INSERT INTO missing_hours_forms (form_key, status, pdf, form_values, pc, employee_id, employee_name, job_title, period_start, period_end, total_hours, submitted_by, submitted_by_name)
      VALUES (${key}, 'pending', ${pdf}, ${JSON.stringify(formValues)}, ${String(store.pc)}, ${emp.id}, ${emp.name}, ${emp.jobTitle || ''}, ${v.periodStart}, ${v.periodEnd}, ${Number(v.total) || 0}, ${mine}, ${myName})
      ON CONFLICT (form_key) DO NOTHING RETURNING id`;
    const row = (await db`SELECT * FROM missing_hours_forms WHERE form_key = ${key}`)[0];
    if (body.replaces && row.id !== Number(body.replaces)) {
      await db`UPDATE missing_hours_forms SET status = 'resent', resent_as = ${row.id} WHERE id = ${Number(body.replaces)} AND status = 'rejected'
        AND (submitted_by = ${mine} OR ${realType === 'executive' || realType === 'it'})`;
    }
    const notified = inserted.length ? await notifyMissingHoursApprovers(db, row) : 0;
    return json(200, { ok: true, id: row.id, status: row.status, notified, already: !inserted.length });
  } catch (e) {
    console.error('[missing-hours]', e.message);
    return json(502, { error: /Paycor/.test(e.message) ? 'Paycor is not responding — try again in a minute.' : 'Something went wrong — try again.' });
  }
};
