// _shared/crew-time-off-lib.mjs — Crew Time Off (v23.30, user 2026-11-25). Shared by crew-time-off.mjs
// (staff, signed in) and crew-time-off-form.mjs (the crew member's form — NO sign-in).
//
//   invited  a manager / DM / office sent the crew member a private link (token, 14 days, one use)
//   manager  the crew member sent the form → their store manager (DM if none; exec / IT / office too)
//   office   the manager approved → the office (Admin · Notifications · Crew time off (office), else the
//            Pay Rate Change office step people — Roxy) approves
//   approved filed in Drive (CREW_TIMEOFF_DRIVE_FOLDER_ID, store → employee) + the Time Off Request
//            list (HR) alerted with the PDF; the crew member is told
//   rejected sent back at either step, with a note; the crew member is told why
// A store's QR poster (?crewStore=<pc>.<key>) lets a crew member start one themselves; the poster
// shows names only (never balances), and nothing reaches Paycor or Drive without both approvals.
// Texts carry no link (Textbelt refuses links until the account is verified for them) unless
// TEXTBELT_LINKS=true; the link goes by email, or the manager shows the QR on their screen.
import { getStore } from '@netlify/blobs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sendSms, sendPush, sendHtmlEmail } from './channels.mjs';
import { bell, esc, PORTAL, stampApproval, etNow } from './form-approval.mjs';
import { STORES } from '../tips-report-cron-background.mjs';
import { crewSummary, usDay } from '../../../src/crew-time-off.mjs';
import { callPaycor } from '../paycor.mjs';

export const OFFICE_KEY = 'pcg_crew_time_off_office_v1';
const PAY_OFFICE_STEP_KEY = 'pcg_pay_increase_office_step_v1';
const LINK_DAYS = 14;
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const secret = () => process.env.DEAL_SESSION_SECRET || '';
export const storeOf = (pc) => STORES.find(s => String(s.pc) === String(pc));
export const textLinks = () => process.env.TEXTBELT_LINKS === 'true';
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export const newToken = () => randomBytes(24).toString('base64url');
// v23.30: a link made on a preview deploy points at that preview (so it can be tested before going
// live); everywhere else the real address. Only this site's own preview hosts are trusted.
export const baseFor = (request) => {
  try { const u = new URL(request.url); return /^[a-z0-9]+--pcg-ops\.netlify\.app$/.test(u.host) ? u.origin : PORTAL; } catch { return PORTAL; }
};
export const linkFor = (token, base = PORTAL) => `${base}/?crew=${token}`;
export const linkExpiry = () => new Date(Date.now() + LINK_DAYS * 864e5);

// The store poster's key: a store number alone can't be guessed into a form without it.
export const posterKey = (pc) => createHmac('sha256', secret()).update(`crew-store|${pc}`).digest('base64url').slice(0, 16);
export const posterUrl = (pc, base = PORTAL) => `${base}/?crewStore=${pc}.${posterKey(pc)}`;
export function posterOk(pc, key) {
  if (!secret() || !pc || !key) return false;
  const want = posterKey(pc);
  return String(key).length === want.length && timingSafeEqual(Buffer.from(String(key)), Buffer.from(want));
}

// Attachments open in a new tab (a phone hands links to a browser that isn't signed in): a 2-hour pass.
const docSig = (id, i, exp) => createHmac('sha256', secret() || 'missing').update(`crew-doc|${id}|${i}|${exp}`).digest('base64url');
export const docUrl = (id, i) => { const exp = Date.now() + 2 * 3600e3; return `/.netlify/functions/crew-time-off-form?doc=${id}&i=${i}&exp=${exp}&sig=${docSig(id, i, exp)}`; };
export function docOk(id, i, exp, sig) {
  const want = docSig(id, i, exp);
  return !!secret() && Number(exp) > Date.now() && String(sig || '').length === want.length && timingSafeEqual(Buffer.from(String(sig)), Buffer.from(want));
}

// ── v23.30 the poster's badge check (user, 2026-11-25): pick your name AND enter your badge ID (the
// time-clock badge number), checked here on the server — never sent to the phone. 5 wrong tries lock
// that name for 30 minutes. A right one gives a 2-hour pass to fill in the form for that person only.
const normBadge = (x) => String(x || '').replace(/\D/g, '').replace(/^0+/, '');
const BADGE_TRIES = 5, LOCK_MIN = 30;
// v23.31: the number crew clock in with is Paycor's badgeNumber (= alternateEmployeeNumber, e.g.
// 332941001 — store PC + 3 digits); employeeNumber (e.g. 130, HR's) is accepted as a backup. Read live
// for that one person (fast); if Paycor doesn't answer in 8 s, the morning sync's employee number.
export async function badgesFor(db, employeeId) {
  const out = new Set();
  try {
    const res = await Promise.race([callPaycor(`/employees/${encodeURIComponent(String(employeeId))}?include=All`), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 8000))]);
    const d = res.data?.records?.[0] || res.data || {};
    for (const k of ['badgeNumber', 'alternateEmployeeNumber', 'employeeNumber']) if (normBadge(d[k])) out.add(normBadge(d[k]));
  } catch (e) { console.warn('[crew-time-off] badge lookup', e.message); }
  if (!out.size) {
    const r = (await db`SELECT employee_number FROM time_off_people WHERE paycor_employee_id = ${String(employeeId)} AND employee_number IS NOT NULL LIMIT 1`.catch(() => []))[0];
    if (normBadge(r?.employee_number)) out.add(normBadge(r.employee_number));
  }
  return out;
}
export async function checkBadge(db, store, employeeId, badge) {
  await db`CREATE TABLE IF NOT EXISTS crew_badge_attempts (employee_id text PRIMARY KEY, fails integer NOT NULL DEFAULT 0, locked_until timestamptz, last_at timestamptz)`;
  const a = (await db`SELECT fails, locked_until FROM crew_badge_attempts WHERE employee_id = ${String(employeeId)}`)[0];
  if (a?.locked_until && Date.parse(a.locked_until) > Date.now()) return { ok: false, locked: true };
  const want = await badgesFor(db, employeeId);
  if (!want.size) return { ok: false, noBadge: true };
  if (normBadge(badge) && want.has(normBadge(badge))) {
    await db`DELETE FROM crew_badge_attempts WHERE employee_id = ${String(employeeId)}`;
    return { ok: true };
  }
  const fails = (a && (!a.locked_until || Date.parse(a.locked_until) <= Date.now()) ? a.fails : 0) + 1;
  const lock = fails >= BADGE_TRIES ? new Date(Date.now() + LOCK_MIN * 60e3).toISOString() : null;
  await db`INSERT INTO crew_badge_attempts (employee_id, fails, locked_until, last_at) VALUES (${String(employeeId)}, ${lock ? 0 : fails}, ${lock}, now())
    ON CONFLICT (employee_id) DO UPDATE SET fails = ${lock ? 0 : fails}, locked_until = ${lock}, last_at = now()`;
  console.warn('[crew-time-off] badge mismatch', String(employeeId).slice(0, 6), lock ? 'LOCKED' : `${fails}/${BADGE_TRIES}`);
  return { ok: false, left: lock ? 0 : BADGE_TRIES - fails, locked: !!lock };
}
const passSig = (pc, empId, exp) => createHmac('sha256', secret() || 'missing').update(`crew-pass|${pc}|${empId}|${exp}`).digest('base64url');
export const makePass = (pc, empId) => { const exp = Date.now() + 2 * 3600e3; return `${exp}.${passSig(pc, empId, exp)}`; };
export function passOk(pass, pc, empId) {
  const [exp, sig] = String(pass || '').split('.');
  const want = passSig(pc, empId, exp);
  return !!secret() && Number(exp) > Date.now() && String(sig || '').length === want.length && timingSafeEqual(Buffer.from(String(sig)), Buffer.from(want));
}

let ready = null;
export function ensureTable(db) {
  return (ready ||= (async () => {
    await db`CREATE TABLE IF NOT EXISTS crew_time_off (
      id serial PRIMARY KEY, token_hash text UNIQUE, link_expires_at timestamptz, via text NOT NULL DEFAULT 'link',
      pc text NOT NULL, employee_id text NOT NULL, employee_name text NOT NULL, job_title text,
      invited_by integer, invited_by_name text, invite_phone text, invite_email text,
      status text NOT NULL DEFAULT 'invited', created_at timestamptz DEFAULT now(), submitted_at timestamptz,
      form_values jsonb, pdf bytea, documents_data jsonb, documents integer NOT NULL DEFAULT 0, contact_phone text, contact_email text,
      manager_by integer, manager_by_name text, manager_at timestamptz, office_by integer, office_by_name text, office_at timestamptz,
      decision_note text, rejected_by_name text, rejected_at timestamptz,
      drive_file_id text, drive_link text, drive_error text, alerted_at timestamptz, reminded_at timestamptz)`;
  })().catch(e => { ready = null; throw e; }));
}

export async function readList(key) {
  const raw = await blobs().get(key, { type: 'json' }).catch(() => null);
  const l = raw?.data ?? raw ?? {};
  return { emails: (l.emails || []).filter(Boolean), phones: (l.phones || []).filter(Boolean),
    ids: [...new Set([...(l.emailOwners || []), ...(l.phoneOwners || [])].filter(id => id != null).map(String))] };
}
// The office step: its own list; nobody there → the Pay Rate Change office-step people (Roxy).
export async function officePeople() {
  const own = await readList(OFFICE_KEY);
  if (own.ids.length || own.emails.length) return own;
  return readList(PAY_OFFICE_STEP_KEY);
}

// The manager step: the store's manager(s); none → the district's DM(s).
export async function storeApprovers(db, pc) {
  const st = storeOf(pc);
  let rows = await db`SELECT id, name, email, phone FROM users WHERE active IS NOT FALSE AND user_type = 'manager' AND store_pc::text = ${String(pc)}`;
  if (!rows.length && st) rows = await db`SELECT id, name, email, phone FROM users WHERE active IS NOT FALSE AND user_type = 'dm' AND district::text = ${String(st.district)}`;
  return rows;
}

const button = (link, label) => `<p><a href="${esc(link)}" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${esc(label)}</a></p>`;
const mail = (line, link, label, extra = '') => `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>${esc(line)}</p>${extra}${link ? button(link, label) : ''}</div>`;
const STAFF_LINK = `${PORTAL}/tools/crew-time-off`;

export async function notifyManagers(db, row, { reminder = false } = {}) {
  const v = row.form_values || {};
  const who = await storeApprovers(db, row.pc);
  const line = `${reminder ? 'Reminder: ' : ''}${row.employee_name} (${storeOf(row.pc)?.name || 'PC ' + row.pc}) asked for time off: ${crewSummary(v)}. Approve it or send it back.`;
  const b = blobs();
  const ids = who.map(u => String(u.id));
  await Promise.all([
    who.some(u => u.email) ? sendHtmlEmail(who.map(u => u.email).filter(Boolean), `${reminder ? 'Reminder: ' : ''}Crew time off to approve: ${row.employee_name}`, mail(line, STAFF_LINK, 'Open it')) : null,
    who.some(u => u.phone) ? sendSms(who.map(u => u.phone).filter(Boolean), `PCG: ${line} Open the portal: Tools > Crew Time Off.`) : null,
    !reminder && ids.length ? sendPush(b, ids, `Crew time off: ${row.employee_name}`, line, `crew-to-${row.id}`, '/tools/crew-time-off') : null,
  ]);
  if (!reminder) await bell(ids, line, `mgr-${row.id}`, 'crew_time_off');
  await db`UPDATE crew_time_off SET reminded_at = now() WHERE id = ${row.id}`;
  return who.length;
}

export async function notifyOffice(db, row, { reminder = false } = {}) {
  const l = await officePeople();
  const line = `${reminder ? 'Reminder: ' : ''}${row.manager_by_name || 'The manager'} approved ${row.employee_name}'s time off (${storeOf(row.pc)?.name || 'PC ' + row.pc}): ${crewSummary(row.form_values || {})}. It needs the office's approval.`;
  const b = blobs();
  await Promise.all([
    l.emails.length ? sendHtmlEmail(l.emails, `${reminder ? 'Reminder: ' : ''}Crew time off for the office: ${row.employee_name}`, mail(line, STAFF_LINK, 'Open it')) : null,
    l.phones.length ? sendSms(l.phones, `PCG: ${line} Open the portal: Tools > Crew Time Off.`) : null,
    !reminder && l.ids.length ? sendPush(b, l.ids, `Crew time off: ${row.employee_name}`, line, `crew-to-office-${row.id}`, '/tools/crew-time-off') : null,
  ]);
  if (!reminder) await bell(l.ids, line, `office-${row.id}`, 'crew_time_off');
  await db`UPDATE crew_time_off SET reminded_at = now() WHERE id = ${row.id}`;
}

// The crew member (no account): email if they gave one, and a text (no link).
export async function tellCrew(row, line, subject) {
  const email = row.contact_email || row.invite_email;
  const phone = row.contact_phone || row.invite_phone;
  await Promise.all([
    email ? sendHtmlEmail([email], subject, mail(line, null, null)) : null,
    phone ? sendSms([phone], `PCG: ${line}`) : null,
  ]);
}

// The invitation: email with the button; a text (with the link only once Textbelt allows links).
export async function sendInvite(row, token, byName, base = PORTAL) {
  const link = linkFor(token, base);
  const first = String(row.employee_name || '').split(' ')[0];
  const line = `Hi ${first}, ${byName || 'your manager'} sent you PCG's time off request form. It's only for you and works for ${LINK_DAYS} days.`;
  const out = { emailed: false, texted: false };
  if (row.invite_email) out.emailed = !!(await sendHtmlEmail([row.invite_email], 'Your time off request form', mail(line, link, 'Open the form')));
  if (row.invite_phone) {
    const sms = textLinks() ? `PCG: ${line} Open it: ${link}` : row.invite_email ? `PCG: ${line} We emailed you the link.` : `PCG: ${line} Ask your manager to show you the QR code to open it.`;
    out.texted = ((await sendSms([row.invite_phone], sms)).sent || 0) > 0;
  }
  return out;
}

export const approvalLine = (row, officeName) => `Approved by ${row.manager_by_name || 'the manager'} (manager) and ${officeName} (office) on ${etNow()} in the PCG Portal.`;
export { stampApproval, usDay };
