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
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { cleanRates, currentRate, compareToForm, buildNewRate, canMoveEffective, isDueNow, paycorNoticeText } from '../../src/pay-rate-paycor.mjs';
import { callPaycor } from './paycor.mjs';
import { createHash } from 'node:crypto';
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts, refreshStoreList } from './_shared/store-status.mjs';
import { loadRoster, liveEmployee, saveToDrive, emailWithPdf } from './transfer-notice.mjs';
import { sendSms, sendPush, sendHtmlEmail } from './_shared/channels.mjs';
import { payBasisOf, currentPayOf, rateProblem, missingPayFields, signatureProblem, secondLineLabel, storeManagerNa, signerCode, payFingerprint, payFileName, payAlertText, payEmailHtml, approvalAlertText, approvalEmailHtml } from '../../src/pay-increase.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const OFFICE_KEY = 'pcg_pay_increase_notify_v1';
const APPROVERS_KEY = 'pcg_pay_increase_approvers_v1';
// v23.1: who does the office step (effective date) — Roxy. Its own list, like the approver list.
const OFFICE_STEP_KEY = 'pcg_pay_increase_office_step_v1';
// v23.9: is "update pay in Paycor" switched on? { enabled, by, at } — flipped by exec / IT in Tools · Pay Increase.
const PAYRATE_SWITCH_KEY = 'pcg_payrate_write_v1';
// v23.10: who hears about the Paycor queue (queued, then on the day) — Admin · Notifications · Pay Increase Paycor update.
const PAYCOR_NOTIFY_KEY = 'pcg_pay_increase_paycor_notify_v1';
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

// v23.1: the people who do the office step: named on the "Pay Increase office step" list; nobody
// named there yet → the people named on the Pay Increase (office) list (who did it in v23.0), but
// with no extra emails / texts (that list already gets its own email on approval).
async function officeDoers() {
  const l = await readList(OFFICE_STEP_KEY);
  if (l.ids.length) return l;
  const o = await readList(OFFICE_KEY);
  return { ids: o.ids, emails: [], phones: [], fallback: true };
}

// Email + text (no link) + push + bell to the office-step people about one approved form; every 3
// hours while it still waits, by pay-increase-reminder-cron.mjs.
export async function notifyOfficeStep(db, row, { reminder = false } = {}) {
  const d = await officeDoers();
  const store = storeOf(row.pc);
  const link = `${PORTAL}/?payIncrease=${row.id}`;
  const who = `${row.employee_name} (${store?.name || 'PC ' + row.pc})`;
  const waited = reminder ? Math.max(1, Math.round((Date.now() - Date.parse(row.decided_at || row.created_at)) / 3600e3)) : 0;
  const title = reminder ? `Reminder: pay increase waiting on the office (${waited} h)` : `Pay increase needs the effective date: ${row.employee_name}`;
  const line = reminder ? `The pay increase for ${who} approved by ${row.decided_by_name || 'Mike'} is still waiting for the effective date (${waited} h).`
    : `${row.decided_by_name || 'Mike'} approved the pay increase for ${who}. It needs the effective date, paycheck date and your signature.`;
  const b = blobs();
  await Promise.all([
    d.emails.length ? sendHtmlEmail(d.emails, title, `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>${esc(line)}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open it</a></p>
<p style="color:#666">Or open the portal: Tools, then Pay Increase, Office tab.</p></div>`) : null,
    // No link in the text — Textbelt refuses links on this account; the email has it.
    d.phones.length ? sendSms(d.phones, `PCG: ${line} Check your email or open the portal (Tools > Pay Increase > Office).`) : null,
    !reminder && d.ids.length ? sendPush(b, d.ids, title, line, `pay-increase-office-${row.id}`) : null,
  ]);
  if (!reminder) await bell(b, d.ids, line, 'office-step');
  await db`UPDATE pay_increase_forms SET office_reminded_at = now() WHERE id = ${row.id}`;
  return new Set([...d.ids, ...d.emails, ...d.phones]).size;
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

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
const usDateTime = (d) => d.toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '') + ' ET';

// v23.0: the office's entries in the "For Office Use Only" box — the template's right-hand cells
// (src/pay-increase-pdf.mjs: centred at x 423.5; baselines 564.7 / 584.2; signature resting on 608).
export async function stampOffice(pdfBuf, effectiveDate, paycheckDate, signature, byName) {
  const doc = await PDFDocument.load(pdfBuf);
  const page = doc.getPage(0);
  const H = page.getHeight();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cx = 423.5;
  for (const [t, y] of [[usDate(effectiveDate), 564.7], [usDate(paycheckDate), 584.2]]) page.drawText(t, { x: cx - font.widthOfTextAtSize(t, 9) / 2, y: H - y, size: 9, font, color: rgb(0, 0, 0) });
  const img = await doc.embedPng(Buffer.from(String(signature).replace(/^data:[^,]*,/, ''), 'base64'));
  const s = Math.min(160 / img.width, 16 / img.height);
  page.drawImage(img, { x: cx - (img.width * s) / 2, y: H - 608, width: img.width * s, height: img.height * s });
  const who = `Payroll: ${String(byName || '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '')}, ${usDateTime(new Date())}`;
  page.drawText(who, { x: 545.5 - font.widthOfTextAtSize(who, 6.5), y: H - 618, size: 6.5, font, color: rgb(0.35, 0.35, 0.35) });
  doc.setModificationDate(new Date());
  return Buffer.from(await doc.save());
}

// v23.9 — the approved raise into Paycor. Reads today's rate first and writes ONLY when Paycor still
// shows the form's current pay (a hand edit since then → 'mismatch', a person looks). A new rate in
// the same slot, starting on the effective date. Result kept on the form (paycor_rate_*). Never throws.
async function payrateSwitchOn() {
  const raw = await blobs().get(PAYRATE_SWITCH_KEY, { type: 'json' }).catch(() => null);
  return !!(raw?.data ?? raw)?.enabled;
}
const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const formOf = (r) => ({ payBasis: r.pay_basis || 'hour', currentRate: Number(r.current_rate), newRate: Number(r.new_rate), effectiveDate: r.effective_date });
async function pushPayRate(db, r) {
  const set = async (status, error, rateId) => {
    await db`UPDATE pay_increase_forms SET paycor_rate_status = ${status}, paycor_rate_error = ${error ? String(error).slice(0, 500) : null},
      paycor_rate_id = COALESCE(${rateId || null}, paycor_rate_id), paycor_rate_at = now() WHERE id = ${r.id}`;
    return { status, error: error || null };
  };
  try {
    if (!r.employee_id) return await set('failed', 'No Paycor employee on this form');
    const res = await callPaycor(`/employees/${r.employee_id}/payrates`);
    if (res.status !== 200) return await set('failed', `Paycor pay rates ${res.status}`);
    const records = res.data?.records || res.data || [];
    const cur = currentRate(records, todayET());
    const state = compareToForm(cur, formOf(r));
    if (state === 'already') return await set('sent', null, cur?.id);
    if (state === 'none') return await set('failed', 'Paycor has no pay rate for this employee');
    if (state === 'mismatch') return await set('mismatch', `Paycor shows ${cur?.payRate ?? cur?.annualPayRate} now, not the form's ${r.current_rate}; check it in Paycor`);
    const payload = buildNewRate(cur, formOf(r), { formId: r.id, approvedBy: r.decided_by_name });
    const post = await callPaycor(`/employees/${r.employee_id}/payrates`, 'POST', payload);
    if (post.status < 200 || post.status >= 300) return await set('failed', post.data?.Detail || post.data?.detail || post.data?.title || `Paycor said ${post.status}`);
    return await set('sent', null, post.data?.id || post.data?.payRateId || null);
  } catch (e) {
    console.error('[pay-increase] paycor pay rate', r.id, e.message);
    return await set('failed', e.message);
  }
}

// ── v23.10 the Paycor queue ──
// paycor_rate_status: NULL (not asked) → 'queued' (waits for the effective date) → 'sending' (claimed)
// → 'sent' | 'failed' | 'mismatch'; or 'cancelled'. A failed / mismatched / cancelled one can be queued again.
export async function ensurePayRateColumns(db) {
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS paycor_rate_status text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS paycor_rate_error text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS paycor_rate_id text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS paycor_rate_at timestamptz`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS paycor_queued_by integer`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS paycor_queued_by_name text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS paycor_queued_at timestamptz`;
}

// Email (Open button) + text (no link) + push + bell to the "Pay Increase Paycor update" list.
// Nobody on the list yet → the person who queued it, so a problem is never silent. Never throws.
export async function notifyPaycorList(db, row, kind, extra = {}) {
  try {
    const l = await readList(PAYCOR_NOTIFY_KEY);
    let { ids, emails, phones } = l;
    if (!ids.length && !emails.length && !phones.length && row.paycor_queued_by) {
      const u = (await db`SELECT id, email FROM users WHERE id = ${row.paycor_queued_by}`)[0];
      if (u) { ids = [String(u.id)]; emails = u.email ? [u.email] : []; }
    }
    const t = paycorNoticeText(kind, row, storeOf(row.pc)?.name, extra);
    const link = `${PORTAL}/?payIncrease=${row.id}`;
    const b = blobs();
    await Promise.all([
      emails.length ? sendHtmlEmail(emails, t.title, `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>${esc(t.line)}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open it</a></p>
<p style="color:#666">Or open the portal: Tools, then Pay Increase, Complete tab.</p></div>`) : null,
      // No link in the text — Textbelt refuses links on this account; the email has it.
      phones.length ? sendSms(phones, `PCG: ${t.line}`) : null,
      ids.length ? sendPush(b, ids, t.title, t.line, `pay-increase-paycor-${row.id}`) : null,
    ]);
    await bell(b, ids, t.line, `paycor-${kind}`);
    return new Set([...ids, ...emails, ...phones]).size;
  } catch (e) { console.error('[pay-increase] paycor list notify', row.id, kind, e.message); return 0; }
}

// Send one claimed ('sending') row to Paycor and tell the list how it went.
async function sendClaimed(db, row) {
  const res = await pushPayRate(db, row);
  await notifyPaycorList(db, row, res.status === 'sent' ? 'sent' : 'problem', { error: res.error });
  return res;
}

// pay-rate-queue-cron.mjs: queued raises whose effective date has come. A row stuck in 'sending' for
// 20+ minutes (the function died mid-way) is picked up again — safe, because pushPayRate reads Paycor
// first: if the earlier POST did land, Paycor already shows the new pay and nothing is written twice.
export async function runDuePayRates(db, { limit = 4 } = {}) {
  await ensurePayRateColumns(db);
  if (!await payrateSwitchOn()) {
    const held = (await db`SELECT count(*)::int AS n FROM pay_increase_forms WHERE paycor_rate_status = 'queued' AND effective_date <= ${todayET()}`)[0]?.n || 0;
    return { held, sent: 0, problems: 0 };
  }
  const rows = await db`UPDATE pay_increase_forms SET paycor_rate_status = 'sending', paycor_rate_at = now()
    WHERE id IN (SELECT id FROM pay_increase_forms WHERE status = 'approved' AND effective_date IS NOT NULL AND effective_date <= ${todayET()}
      AND (paycor_rate_status = 'queued' OR (paycor_rate_status = 'sending' AND paycor_rate_at < now() - interval '20 minutes'))
      ORDER BY effective_date, id LIMIT ${limit})
    RETURNING *`;
  let sent = 0, problems = 0;
  for (const row of rows) {
    const res = await sendClaimed(db, row);
    if (res.status === 'sent') sent++; else problems++;
  }
  return { held: 0, sent, problems };
}

// v23.9 — move a completed form's effective date (only while it's still in the future): white out
// the two dates, write the new ones and a note, so the PDF tells the whole story.
export async function restampDates(pdfBuf, effectiveDate, paycheckDate, note) {
  const doc = await PDFDocument.load(pdfBuf);
  const page = doc.getPage(0);
  const H = page.getHeight();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cx = 423.5;
  for (const [t, top, bottom] of [[usDate(effectiveDate), 551.5, 570.5], [usDate(paycheckDate), 570.5, 590.5]]) {
    page.drawRectangle({ x: 303, y: H - bottom + 1.2, width: 241, height: bottom - top - 2.4, color: rgb(1, 1, 1) });
    page.drawText(t, { x: cx - font.widthOfTextAtSize(t, 9) / 2, y: H - (top + 13.2), size: 9, font, color: rgb(0, 0, 0) });
  }
  const line = String(note).normalize('NFKD').replace(/[^\x20-\x7E]/g, '').slice(0, 170);
  page.drawText(line, { x: 67.5, y: H - 640, size: 7, font, color: rgb(0.35, 0.35, 0.35) });
  doc.setModificationDate(new Date());
  return Buffer.from(await doc.save());
}

const rowValues = (r) => ({ payBasis: r.pay_basis || 'hour', employeeName: r.employee_name, position: r.position, pc: r.pc, currentRate: Number(r.current_rate), newRate: Number(r.new_rate), reason: r.reason, date: r.form_date, signer: r.signer,
  smName: r.sm_name || '', dmName: r.dm_name || '', secondLabel: r.second_label || '' });

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const realType = authed.realUserType || authed.userType;
  // v23.3: permanently closed stores (Locations) are left out of every list here — Willits' Paycor
  // company is shut, and asking it for a roster returned 403 (2026-11-23).
  await refreshStoreList(STORES, ALL_STORES);
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
  // v23.0 three steps (user, 2026-11-23): maker → approver (Mike) → OFFICE (Roxy: effective date,
  // paycheck date, payroll signature; everything above is locked) → Drive + the maker is emailed.
  // status 'office' = approved, waiting on the office; 'approved' = complete and filed.
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS effective_date text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS paycheck_date text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS office_by integer`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS office_by_name text`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS office_at timestamptz`;
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS office_reminded_at timestamptz`;
  // v23.9 the raise into Paycor: 'sent' | 'failed' | 'mismatch' | NULL (not tried), + effective-date moves.
  await ensurePayRateColumns(db); // + v23.10 queue columns
  await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS effective_changes jsonb`;

  const appr = await approvers(db);
  const canApprove = appr.ids.includes(String(authed.sub));
  // v23.0: the office step is done by the people added BY NAME to the office list (Roxy, Ella…), or exec / IT.
  const doers = await officeDoers();
  const canOffice = doers.ids.includes(String(authed.sub)) || realType === 'executive' || realType === 'it';
  // v22.63: executives / IT (and approvers, and the office) get the list screen.
  const listView = canApprove || canOffice;

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
      const out = { payrateWrite: await payrateSwitchOn(), paycorNotifyCount: await readList(PAYCOR_NOTIFY_KEY).then(l => new Set([...l.ids, ...l.emails, ...l.phones]).size).catch(() => 0), canAdmin: realType === 'executive' || realType === 'it', today: todayET(), canApprove, canOffice, listView, role: realType, secondLabel: secondLineLabel(realType, me.username), smNa: storeManagerNa(realType), myName, stores: [], employees: [] };
      if (realType === 'manager' && me.store_pc) {
        const st = storeOf(me.store_pc);
        const dm = st && (await db`SELECT name FROM users WHERE active IS NOT FALSE AND user_type = 'dm' AND district::text = ${String(st.district)} LIMIT 1`)[0];
        out.dmNameGuess = dm?.name || '';
      }
      if (listView) {
        const item = (r) => ({ id: r.id, pc: r.pc, storeName: storeOf(r.pc)?.name || '', employeeName: r.employee_name, position: r.position,
          payBasis: r.pay_basis || 'hour', currentRate: Number(r.current_rate), newRate: Number(r.new_rate), reason: r.reason, formDate: r.form_date, submittedBy: r.submitted_by_name, createdAt: r.created_at,
          approvedBy: r.decided_by_name || null, approvedAt: r.decided_at || null, driveLink: r.drive_link || null, hasPdf: !!r.has_pdf,
          effectiveDate: r.effective_date || null, paycheckDate: r.paycheck_date || null, officeBy: r.office_by_name || null, officeAt: r.office_at || null,
          paycorRateStatus: r.paycor_rate_status || null, paycorRateError: r.paycor_rate_error || null, paycorRateAt: r.paycor_rate_at || null, effectiveChanges: r.effective_changes || [],
          paycorQueuedBy: r.paycor_queued_by_name || null, paycorQueuedAt: r.paycor_queued_at || null });
        out.pending = (await db`SELECT id, pc, employee_name, position, current_rate, new_rate, pay_basis, reason, form_date, submitted_by_name, created_at, decided_by_name, decided_at, drive_link, (pdf IS NOT NULL) AS has_pdf
          FROM pay_increase_forms WHERE status = 'pending' ORDER BY created_at`).map(item);
        out.office = (await db`SELECT id, pc, employee_name, position, current_rate, new_rate, pay_basis, reason, form_date, submitted_by_name, created_at, decided_by_name, decided_at, drive_link, (pdf IS NOT NULL) AS has_pdf
          FROM pay_increase_forms WHERE status = 'office' ORDER BY decided_at`).map(item);
        // Complete = approved, plus forms sent before the approval step existed (status NULL).
        out.complete = (await db`SELECT id, pc, employee_name, position, current_rate, new_rate, pay_basis, reason, form_date, submitted_by_name, created_at, decided_by_name, decided_at, drive_link, effective_date, paycheck_date, office_by_name, office_at, paycor_rate_status, paycor_rate_error, paycor_rate_at, paycor_queued_by_name, paycor_queued_at, effective_changes, (pdf IS NOT NULL) AS has_pdf
          FROM pay_increase_forms WHERE status = 'approved' OR status IS NULL ORDER BY COALESCE(office_at, decided_at, created_at) DESC LIMIT 300`).map(item);
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
      // approve (v23.0): claim it first so two quick clicks can't both send. It goes to the OFFICE
      // (effective date etc.); it's filed in Drive only once the office completes it.
      const upd = (await db`UPDATE pay_increase_forms SET status = 'office', decided_by = ${Number(authed.sub)}, decided_by_name = ${myName}, decided_at = now()
        WHERE id = ${r.id} AND status = 'pending' RETURNING *`)[0];
      if (!upd) return json(409, { error: 'This one was already decided — reload.' });
      const store = storeOf(upd.pc);
      const v = rowValues(upd);
      let alert;
      try {
        alert = await alertOffice(v, store?.name, upd.submitted_by_name, `${PORTAL}/?payIncrease=${upd.id}`, payFileName(v, store?.name), Buffer.from(upd.pdf), store?.paycor, myName);
        await db`UPDATE pay_increase_forms SET alerted_at = now(), alert_summary = ${JSON.stringify(alert)} WHERE id = ${upd.id}`;
      } catch (e) { console.error('[pay-increase] office alert', e.message); alert = { error: e.message }; }
      let officeNotified = 0;
      try { officeNotified = await notifyOfficeStep(db, upd); } catch (e) { console.error('[pay-increase] office step notify', e.message); }
      await tellMaker(db, upd, 'approved', { by: myName });
      return json(200, { ok: !alert?.error, status: 'office', alert, officeNotified });
    }

    // ── v23.0 office step: effective date, paycheck date, payroll signature → stamped, filed, maker told ──
    if (body.action === 'complete') {
      if (!canOffice) return json(403, { error: 'Only the people on Admin · Notifications · Pay Increase office step (added by name), exec or IT can complete this.' });
      const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
      if (!isDate(body.effectiveDate)) return json(400, { error: 'Enter the effective date.' });
      if (!isDate(body.paycheckDate)) return json(400, { error: 'Enter the effective pay rate paycheck date.' });
      if (!isSig(body.payrollSignature)) return json(400, { error: 'Sign the payroll line.' });
      const r = (await db`SELECT * FROM pay_increase_forms WHERE id = ${Number(body.id)} AND status = 'office'`)[0];
      if (!r) return json(409, { error: 'This one is not waiting on the office any more — reload.' });
      const pdf = await stampOffice(Buffer.from(r.pdf), body.effectiveDate, body.paycheckDate, body.payrollSignature, myName);
      const upd = (await db`UPDATE pay_increase_forms SET status = 'approved', pdf = ${pdf}, effective_date = ${body.effectiveDate}, paycheck_date = ${body.paycheckDate},
          office_by = ${Number(authed.sub)}, office_by_name = ${myName}, office_at = now() WHERE id = ${r.id} AND status = 'office' RETURNING *`)[0];
      if (!upd) return json(409, { error: 'Someone else just completed it — reload.' });
      const store = storeOf(upd.pc);
      const v = rowValues(upd);
      const fileName = payFileName(v, store?.name);
      const drive = { saved: false, link: '', error: null };
      try {
        const f = await saveToDrive(pdf, [store?.name || upd.pc, upd.employee_name], fileName, `payinc:${upd.form_key}`, process.env.PAY_DRIVE_FOLDER_ID || '');
        drive.saved = true; drive.link = f.webViewLink || '';
        await db`UPDATE pay_increase_forms SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL WHERE id = ${upd.id}`;
      } catch (e) {
        drive.error = e.message;
        console.error('[pay-increase] drive', e.message);
        await db`UPDATE pay_increase_forms SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${upd.id}`;
      }
      // The person who made it: when it was completed and when it takes effect, with the final form.
      try {
        const u = (await db`SELECT id, email FROM users WHERE id = ${upd.submitted_by}`)[0];
        if (u) {
          const t = approvalAlertText('completed', upd, store?.name, { at: usDateTime(new Date()), effective: usDate(upd.effective_date), paycheck: usDate(upd.paycheck_date), by: myName });
          const b = blobs();
          await Promise.all([
            u.email ? emailWithPdf([u.email], t.title, `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>${esc(t.line)}</p><p>The completed form is attached.</p></div>`, fileName, pdf) : null,
            sendPush(b, [String(u.id)], t.title, t.line, `pay-increase-${upd.id}`),
          ]);
          await bell(b, [u.id], t.line, 'completed');
        }
      } catch (e) { console.error('[pay-increase] tell maker (completed)', e.message); }
      // v23.10: Paycor is NOT touched here — the office then presses "Update pay in Paycor" and
      // confirms (queuePayRate). paycorReady tells the screen to offer that button.
      return json(200, { ok: true, drive, paycorReady: await payrateSwitchOn(), id: upd.id, effectiveDate: upd.effective_date });
    }

    // ── v23.9 Paycor pay rate: switch, read-only look, retry, move the effective date ──
    if (body.action === 'payrateSwitch') {
      if (!(realType === 'executive' || realType === 'it')) return json(403, { error: 'Only exec or IT can switch this.' });
      await blobs().setJSON(PAYRATE_SWITCH_KEY, { savedAt: new Date().toISOString(), data: { enabled: !!body.enabled, by: myName, at: new Date().toISOString() } });
      try { await db`INSERT INTO audit_log (type, user_id, user_role, action, metadata) VALUES ('payrate', ${String(authed.sub)}, ${realType}, ${body.enabled ? 'payrate_write_on' : 'payrate_write_off'}, ${JSON.stringify({ by: myName })})`; } catch {}
      return json(200, { ok: true, enabled: !!body.enabled });
    }
    if (body.action === 'paycorRates') {
      if (!(realType === 'executive' || realType === 'it')) return json(403, { error: 'Only exec or IT can look at Paycor pay rates.' });
      const r = (await db`SELECT * FROM pay_increase_forms WHERE id = ${Number(body.id)}`)[0];
      if (!r?.employee_id) return json(404, { error: 'Not found' });
      const res = await callPaycor(`/employees/${r.employee_id}/payrates`);
      if (res.status !== 200) return json(502, { error: `Paycor pay rates ${res.status}` });
      const records = res.data?.records || res.data || [];
      const cur = currentRate(records, todayET());
      const form = { ...formOf(r), effectiveDate: r.effective_date || body.effectiveDate || todayET() };
      return json(200, { rates: cleanRates(records), current: cur, state: compareToForm(cur, form), wouldSend: cur ? buildNewRate(cur, form, { formId: r.id, approvedBy: r.decided_by_name }) : null });
    }
    // v23.10: "Update pay in Paycor" (confirmed by the office). Effective date still ahead → queued,
    // the list is told now and again on the day. Today or already past → sent right now.
    if (body.action === 'queuePayRate') {
      if (!canOffice) return json(403, { error: 'forbidden' });
      if (!await payrateSwitchOn()) return json(409, { error: 'Updating Paycor is switched off. Exec or IT can switch it on in Tools > Pay Increase.' });
      const r = (await db`SELECT * FROM pay_increase_forms WHERE id = ${Number(body.id)} AND status = 'approved' AND effective_date IS NOT NULL`)[0];
      if (!r) return json(404, { error: 'Not found' });
      if (r.paycor_rate_status === 'sent') return json(200, { ok: true, paycor: { status: 'sent' } });
      if (r.paycor_rate_status === 'queued') return json(200, { ok: true, queued: true, effectiveDate: r.effective_date });
      if (r.paycor_rate_status === 'sending') return json(409, { error: 'It is being sent to Paycor right now. Reload in a minute.' });
      const now = isDueNow(r.effective_date, todayET());
      const claimed = (await db`UPDATE pay_increase_forms SET paycor_rate_status = ${now ? 'sending' : 'queued'}, paycor_rate_error = NULL, paycor_rate_at = now(),
          paycor_queued_by = ${Number(authed.sub)}, paycor_queued_by_name = ${myName}, paycor_queued_at = now()
        WHERE id = ${r.id} AND (paycor_rate_status IS NULL OR paycor_rate_status IN ('failed', 'mismatch', 'cancelled')) RETURNING *`)[0];
      if (!claimed) return json(409, { error: 'Someone else just did this — reload.' });
      try { await db`INSERT INTO audit_log (type, user_id, user_role, action, metadata) VALUES ('payrate', ${String(authed.sub)}, ${realType}, ${now ? 'payrate_send_now' : 'payrate_queued'}, ${JSON.stringify({ form: r.id, effective: r.effective_date, by: myName })})`; } catch {}
      if (now) return json(200, { ok: true, queued: false, paycor: await sendClaimed(db, claimed) });
      const notified = await notifyPaycorList(db, claimed, 'queued', { by: myName });
      return json(200, { ok: true, queued: true, effectiveDate: claimed.effective_date, notified });
    }
    if (body.action === 'cancelPayRate') {
      if (!canOffice) return json(403, { error: 'forbidden' });
      const upd = (await db`UPDATE pay_increase_forms SET paycor_rate_status = 'cancelled', paycor_rate_error = NULL, paycor_rate_at = now()
        WHERE id = ${Number(body.id)} AND paycor_rate_status = 'queued' RETURNING *`)[0];
      if (!upd) return json(409, { error: 'It is not waiting in the queue any more — reload.' });
      try { await db`INSERT INTO audit_log (type, user_id, user_role, action, metadata) VALUES ('payrate', ${String(authed.sub)}, ${realType}, 'payrate_queue_cancelled', ${JSON.stringify({ form: upd.id, by: myName })})`; } catch {}
      await notifyPaycorList(db, upd, 'cancelled', { by: myName });
      return json(200, { ok: true });
    }
    if (body.action === 'changeEffective') {
      if (!canOffice) return json(403, { error: 'forbidden' });
      const isDate = (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x || ''));
      if (!isDate(body.effectiveDate) || !isDate(body.paycheckDate)) return json(400, { error: 'Enter the new effective date and paycheck date.' });
      const reason = String(body.reason || '').trim().slice(0, 200);
      if (reason.length < 3) return json(400, { error: 'Say why the date is changing.' });
      const r = (await db`SELECT * FROM pay_increase_forms WHERE id = ${Number(body.id)} AND status = 'approved' AND effective_date IS NOT NULL`)[0];
      if (!r) return json(404, { error: 'Not found' });
      if (r.paycor_rate_status === 'sending') return json(409, { error: 'It is being sent to Paycor right now. Try again in a minute.' });
      if (!canMoveEffective(r.effective_date, todayET())) return json(409, { error: `This raise already took effect on ${usDate(r.effective_date)}. Paycor may already have paid at the new rate, so change it in Paycor directly.` });
      if (body.effectiveDate <= todayET()) return json(400, { error: 'The new effective date has to be after today.' });
      // Paycor first (if the raise was already written there): move that rate's start date.
      let paycor = null;
      if (r.paycor_rate_status === 'sent' && r.paycor_rate_id) {
        try {
          const res = await callPaycor(`/employees/${r.employee_id}/payrates`);
          const rec = (res.data?.records || res.data || []).find(x => String(x.id || x.payRateId) === String(r.paycor_rate_id));
          if (!rec) paycor = { status: 'failed', error: 'The rate written earlier is no longer in Paycor' };
          else {
            const put = await callPaycor(`/employees/${r.employee_id}/payrates/${r.paycor_rate_id}`, 'PUT', { ...rec, effectiveStartDate: `${body.effectiveDate}T00:00:00` });
            paycor = put.status >= 200 && put.status < 300 ? { status: 'sent' } : { status: 'failed', error: put.data?.Detail || put.data?.title || `Paycor said ${put.status}` };
          }
        } catch (e) { paycor = { status: 'failed', error: e.message }; }
        if (paycor.status !== 'sent') return json(502, { error: `Paycor did not accept the new date (${paycor.error}). Nothing was changed.` });
      }
      const change = { from: r.effective_date, to: body.effectiveDate, paycheckFrom: r.paycheck_date, paycheckTo: body.paycheckDate, by: myName, at: new Date().toISOString(), reason };
      const pdf = await restampDates(Buffer.from(r.pdf), body.effectiveDate, body.paycheckDate,
        `Effective date changed from ${usDate(r.effective_date)} to ${usDate(body.effectiveDate)} by ${myName} on ${usDateTime(new Date())}: ${reason}`);
      const upd = (await db`UPDATE pay_increase_forms SET pdf = ${pdf}, effective_date = ${body.effectiveDate}, paycheck_date = ${body.paycheckDate},
          effective_changes = COALESCE(effective_changes, '[]'::jsonb) || ${JSON.stringify([change])}::jsonb WHERE id = ${r.id} RETURNING *`)[0];
      const store = storeOf(upd.pc);
      const fileName = payFileName(rowValues(upd), store?.name).replace(/\.pdf$/, ` (revised ${usDate(body.effectiveDate).replace(/\//g, '-')}).pdf`);
      let drive = { saved: false };
      try {
        const f = await saveToDrive(pdf, [store?.name || upd.pc, upd.employee_name], fileName, `payinc:${upd.form_key}:eff:${body.effectiveDate}`, process.env.PAY_DRIVE_FOLDER_ID || '');
        drive = { saved: true, link: f.webViewLink || '' };
        await db`UPDATE pay_increase_forms SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null} WHERE id = ${upd.id}`;
      } catch (e) { drive = { saved: false, error: e.message }; }
      try { await db`INSERT INTO audit_log (type, user_id, user_role, action, metadata) VALUES ('payrate', ${String(authed.sub)}, ${realType}, 'effective_date_changed', ${JSON.stringify({ form: upd.id, ...change })})`; } catch {}
      // The maker hears about it.
      try {
        const u = (await db`SELECT id, email FROM users WHERE id = ${upd.submitted_by}`)[0];
        if (u) {
          const line = `The pay increase for ${upd.employee_name} (${store?.name || 'PC ' + upd.pc}) now takes effect ${usDate(body.effectiveDate)} (was ${usDate(change.from)}), first on the paycheck dated ${usDate(body.paycheckDate)}. Changed by ${myName}: ${reason}`;
          const b = blobs();
          await Promise.all([u.email ? emailWithPdf([u.email], `Pay increase effective date changed: ${upd.employee_name}`, `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>${esc(line)}</p><p>The updated form is attached.</p></div>`, fileName, pdf) : null,
            sendPush(b, [String(u.id)], 'Pay increase date changed', line, `pay-increase-${upd.id}`)]);
          await bell(b, [u.id], line, 'eff-change');
        }
      } catch (e) { console.error('[pay-increase] tell maker (date change)', e.message); }
      // v23.10: a queued Paycor update simply moves with the date; its list hears about it.
      if (upd.paycor_rate_status === 'queued') await notifyPaycorList(db, upd, 'moved', { from: change.from, by: myName });
      return json(200, { ok: true, drive, paycor, queued: upd.paycor_rate_status === 'queued' });
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
