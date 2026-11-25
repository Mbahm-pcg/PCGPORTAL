// _shared/form-approval.mjs — the approval step shared by Transfer Notice and Time Off Request
// (v23.22, user 2026-11-24: "DM or manager → Mike for approval → then to Drive", like Pay Rate Change).
//
// Who approves: the people added BY NAME to the form's own Admin · Notifications approval list; while
// no one is named there, the Pay Rate Change approval list (Mike); while that's empty too, every
// executive. They get an email with an Open button, a text (no link — Textbelt refuses links), a phone
// push and a bell, plus a reminder every 3 hours (pay-increase-reminder-cron.mjs) until it's decided.
import { getStore } from '@netlify/blobs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { sendSms, sendPush, sendHtmlEmail } from './channels.mjs';

export const PORTAL = 'https://uop.peoplecapitalgroup.com';
const PAY_APPROVERS_KEY = 'pcg_pay_increase_approvers_v1';
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const usDay = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
export const etNow = (d = new Date()) => d.toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '') + ' ET';

async function readList(key) {
  const raw = await blobs().get(key, { type: 'json' }).catch(() => null);
  const l = raw?.data ?? raw ?? {};
  return {
    emails: (l.emails || []).filter(Boolean), phones: (l.phones || []).filter(Boolean),
    ids: [...new Set([...(l.emailOwners || []), ...(l.phoneOwners || [])].filter(id => id != null).map(String))],
  };
}

export async function formApprovers(db, key) {
  const own = await readList(key);
  if (own.ids.length) return { ...own, source: 'own' };
  const pay = await readList(PAY_APPROVERS_KEY);
  if (pay.ids.length) return { ...pay, source: 'pay' };
  const execs = await db`SELECT id, email, phone FROM users WHERE active IS NOT FALSE AND user_type = 'executive'`;
  return { ids: execs.map(e => String(e.id)), emails: execs.map(e => e.email).filter(Boolean), phones: execs.map(e => e.phone).filter(Boolean), source: 'exec' };
}

// v23.26 (review): nobody approves their own request. For one sent by `submitterId`, they're left
// out; if that leaves no one, the OTHER executives approve it. Their own email / number are dropped too.
const digits = (x) => String(x || '').replace(/\D/g, '').slice(-10);
export async function approversFor(db, key, submitterId) {
  const appr = await formApprovers(db, key);
  const me = String(submitterId ?? '');
  if (!me) return appr;
  const self = (await db`SELECT email, phone FROM users WHERE id = ${Number(me) || -1}`.catch(() => []))[0] || {};
  const notMe = (x) => ({ ...x, ids: x.ids.filter(id => id !== me), emails: x.emails.filter(e => !self.email || String(e).toLowerCase() !== String(self.email).toLowerCase()), phones: x.phones.filter(ph => !self.phone || digits(ph) !== digits(self.phone)) });
  const rest = notMe(appr);
  if (rest.ids.length) return rest;
  const execs = await db`SELECT id, email, phone FROM users WHERE active IS NOT FALSE AND user_type = 'executive' AND id <> ${Number(me) || -1}`;
  return { ids: execs.map(e => String(e.id)), emails: execs.map(e => e.email).filter(Boolean), phones: execs.map(e => e.phone).filter(Boolean), source: 'other-exec' };
}
// May this person decide this request? (cheap: the list + who sent it, the executives only if needed)
export async function mayDecide(db, appr, submitterId, userId) {
  const me = String(userId ?? ''), sub = String(submitterId ?? '');
  if (!me || me === sub) return false;
  if (appr.ids.includes(me)) return true;
  if (appr.ids.some(id => id !== sub)) return false;
  return (await db`SELECT 1 FROM users WHERE id = ${Number(me) || -1} AND user_type = 'executive' AND active IS NOT FALSE`).length > 0;
}

export async function approverNames(db, appr) {
  if (!appr.ids.length) return [];
  const rows = await db`SELECT name FROM users WHERE id = ANY(${appr.ids.map(Number).filter(Boolean)})`.catch(() => []);
  return rows.map(r => r.name).filter(Boolean);
}

export async function bell(ids, message, tag, type) {
  if (!ids.length) return;
  try {
    const b = blobs();
    const cur = await b.get('pcg_notifications_v1', { type: 'json' });
    const arr = Array.isArray(cur) ? cur : (cur?.data || []);
    const entry = { id: `${type}_${tag}_${Date.now()}`, type, message, onlyFor: ids.map(String), read: false, createdAt: new Date().toISOString() };
    await b.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...arr].slice(0, 500) });
  } catch (e) { console.warn('[form-approval] bell write failed', e.message); }
}

const button = (link, label) => `<p><a href="${esc(link)}" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${esc(label)}</a></p>`;

// The approvers: a new one waiting (or a reminder). Returns how many people/addresses were reached.
export async function notifyFormApprovers(db, key, { title, line, link, pushTag, type, where, reminder = false, waitedHours = 0, submitterId = null }) {
  const appr = await approversFor(db, key, submitterId);
  const t = reminder ? `Reminder: ${title} (waiting ${waitedHours} h)` : title;
  const l = reminder ? `Still waiting for your approval (${waitedHours} h): ${line}` : line;
  const b = blobs();
  await Promise.all([
    appr.emails.length ? sendHtmlEmail(appr.emails, t, `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>${esc(l)}</p>${button(link, 'Open it to approve')}<p style="color:#666">Or open the portal: ${esc(where)}.</p></div>`) : null,
    appr.phones.length ? sendSms(appr.phones, `PCG: ${l} Check your email or open the portal (${where}).`) : null,
    !reminder && appr.ids.length ? sendPush(b, appr.ids, t, l, pushTag, link.replace(PORTAL, '')) : null, // tap → straight to it
  ]);
  if (!reminder) await bell(appr.ids, l, 'request', type);
  return new Set([...appr.ids, ...appr.emails, ...appr.phones]).size;
}

// One person (the maker): push + bell + email. Never throws.
export async function tellPerson(db, userId, { title, line, pushTag, type, link, linkLabel, path }) {
  try {
    const u = (await db`SELECT id, email FROM users WHERE id = ${Number(userId) || -1}`)[0];
    if (!u) return;
    const b = blobs();
    await Promise.all([
      sendPush(b, [String(u.id)], title, line, pushTag, path),
      u.email ? sendHtmlEmail([u.email], title, `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>${esc(line)}</p>${link ? button(link, linkLabel || 'Open it') : ''}</div>`) : null,
    ]);
    await bell([u.id], line, 'maker', type);
  } catch (e) { console.error('[form-approval] tell person', e.message); }
}

// How the approver signs off on the PDF: a small grey line at the bottom of the last page.
export async function stampApproval(pdfBuf, text) {
  const doc = await PDFDocument.load(pdfBuf);
  const pages = doc.getPages();
  const page = pages[pages.length - 1];
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const clean = String(text).normalize('NFKD').replace(/[^\x20-\x7E]/g, '').slice(0, 180);
  page.drawText(clean, { x: 36, y: 14, size: 7, font, color: rgb(0.35, 0.35, 0.35) });
  doc.setModificationDate(new Date());
  return Buffer.from(await doc.save());
}

// The approver's title on that line (Mike → Vice President, like the other forms).
export function approverTitle(realType, username) {
  if (realType === 'executive') return String(username || '').toLowerCase() === 'mike.bahm' ? 'Vice President' : 'Executive';
  if (realType === 'it') return 'HR / IT Administrator';
  if (realType === 'director') return 'Director of Operations';
  if (realType === 'dm') return 'District Manager';
  if (realType === 'office_staff') return 'Office / HR';
  return '';
}
