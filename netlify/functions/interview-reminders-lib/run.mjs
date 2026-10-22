// interview-reminders-lib/run.mjs — Paradox ("Ally from Dunkin'") interview reminders (v22.6).
//
// Paradox emails interview invites to each store's own mailbox ({pc}@peoplecapitalgroup.com)
// but can't text managers. Every run:
//   1. reads each open store's mailbox (Gmail, read-only, via the service account's
//      domain-wide delegation) for new paradox.ai messages carrying a calendar invite;
//   2. keeps interview_invites current (new / rescheduled via SEQUENCE / cancelled);
//   3. sends the reminder that's due (about 1 day before, 8am–9pm ET; and ~1 hour before)
//      by TEXT and EMAIL, once each.
//
// INTERVIEW_REMINDERS_MODE:
//   unset / "live" — the store's manager(s); the district's DM if the store has no
//                    manager with a phone/email on file. Went live v22.10 after testing.
//   "shadow"       — every reminder for EVERY store goes ONLY to the person whose
//                    portal account email is INTERVIEW_REMINDERS_SHADOW_EMAIL
//                    (default ahmed@peoplecapitalgroup.com), labelled with who it would
//                    have gone to. Heavy — a text per interview network-wide.
//   "off"          — nothing runs.
// Admin can switch individual managers/DMs off (mutedUsers, below).
import { google } from 'googleapis';
import { getStore } from '@netlify/blobs';
import { sql } from '../_shared/db.mjs';
import { sendSms, sendEmail } from '../_shared/channels.mjs';
import { refreshStoreList } from '../_shared/store-status.mjs';
import { STORES, ALL_STORES } from '../labor-cron.mjs';
import { parseIcs, candidateFromSummary, meetingLink } from '../../../src/interview-ics.mjs';
import { dueReminder, reminderText } from '../../../src/interview-reminders.mjs';

const DOMAIN = process.env.INTERVIEW_MAILBOX_DOMAIN || 'peoplecapitalgroup.com';
const STATUS_KEY = 'pcg_interview_reminders_status';
// { mutedUsers: [user id] } — set in Admin: managers/DMs who have reminders switched off
// (they're skipped; a muted manager does NOT hand off to the DM).
const CONFIG_KEY = 'pcg_interview_reminders_config';
const ids = (v) => (Array.isArray(v) ? v : []).map(String).filter(x => /^\d+$/.test(x));
export async function loadConfig() {
  try {
    const w = await blobs().get(CONFIG_KEY, { type: 'json' });
    return { mutedUsers: ids(w?.data?.mutedUsers) };
  } catch { return { mutedUsers: [] }; }
}
export async function saveConfig(patch) {
  const cur = await loadConfig();
  const data = { mutedUsers: patch.mutedUsers !== undefined ? [...new Set(ids(patch.mutedUsers))] : cur.mutedUsers };
  await blobs().setJSON(CONFIG_KEY, { savedAt: new Date().toISOString(), data });
  return data;
}
export const reminderMode = () => {
  const m = String(process.env.INTERVIEW_REMINDERS_MODE || 'live').toLowerCase();
  return ['off', 'shadow', 'live'].includes(m) ? m : 'live';
};
const shadowEmail = () => (process.env.INTERVIEW_REMINDERS_SHADOW_EMAIL || 'ahmed@peoplecapitalgroup.com').toLowerCase();

let _ready = false;
export async function ensureTables(db) {
  if (_ready) return;
  await db`CREATE TABLE IF NOT EXISTS interview_invites (
    uid          text NOT NULL,
    store_pc     text NOT NULL,
    candidate    text,
    summary      text,
    start_at     timestamptz,
    end_at       timestamptz,
    link         text,
    status       text NOT NULL DEFAULT 'active',
    sequence     integer NOT NULL DEFAULT 0,
    source_msg   text,
    sent_day_at  timestamptz,
    sent_hour_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (uid, store_pc)
  )`;
  await db`CREATE TABLE IF NOT EXISTS interview_seen_messages (
    store_pc text NOT NULL,
    msg_id   text NOT NULL,
    seen_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_pc, msg_id)
  )`;
  _ready = true;
}

const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const etHourNow = () => Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }));

function gmailFor(mailbox) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}');
  const auth = new google.auth.JWT({
    email: credentials.client_email, key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'], subject: mailbox,
  });
  return google.gmail({ version: 'v1', auth });
}

async function calendarText(gmail, msg) {
  const parts = [];
  const walk = (p) => { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); };
  walk(msg.payload);
  for (const p of parts) {
    if (!(/text\/calendar|application\/ics/i.test(p.mimeType || '') || /\.ics$/i.test(p.filename || ''))) continue;
    let data = p.body?.data;
    if (!data && p.body?.attachmentId) {
      const a = await gmail.users.messages.attachments.get({ userId: 'me', messageId: msg.id, id: p.body.attachmentId });
      data = a.data?.data;
    }
    if (data) return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  }
  return null;
}

async function upsertEvent(db, pc, e, msgId) {
  if (!e.uid || !e.start || !/interview/i.test(e.summary || '')) return false;
  const cancelled = e.method === 'CANCEL' || e.status === 'CANCELLED';
  const candidate = candidateFromSummary(e.summary);
  const link = meetingLink(e);
  const ex = (await db`SELECT start_at, sequence FROM interview_invites WHERE uid = ${e.uid} AND store_pc = ${pc}`)[0];
  if (!ex) {
    await db`INSERT INTO interview_invites (uid, store_pc, candidate, summary, start_at, end_at, link, status, sequence, source_msg)
      VALUES (${e.uid}, ${pc}, ${candidate}, ${e.summary || null}, ${e.start}, ${e.end || null}, ${link}, ${cancelled ? 'cancelled' : 'active'}, ${e.sequence || 0}, ${msgId})`;
    return true;
  }
  if ((e.sequence || 0) < (ex.sequence || 0)) return false; // an older copy of the invite
  const moved = new Date(ex.start_at).toISOString() !== e.start;
  await db`UPDATE interview_invites SET candidate = ${candidate}, summary = ${e.summary || null}, start_at = ${e.start}, end_at = ${e.end || null},
      link = ${link}, status = ${cancelled ? 'cancelled' : 'active'}, sequence = ${e.sequence || 0}, source_msg = ${msgId}, updated_at = now(),
      sent_day_at = CASE WHEN ${moved} THEN NULL ELSE sent_day_at END, sent_hour_at = CASE WHEN ${moved} THEN NULL ELSE sent_hour_at END
    WHERE uid = ${e.uid} AND store_pc = ${pc}`;
  return true;
}

async function scanMailbox(db, store) {
  const mailbox = `${store.pc}@${DOMAIN}`;
  const gmail = gmailFor(mailbox);
  const list = await gmail.users.messages.list({ userId: 'me', q: 'newer_than:14d {from:paradox.ai filename:ics subject:interview}', maxResults: 50 });
  const ids = (list.data.messages || []).map(m => m.id);
  if (!ids.length) return { found: 0, updated: 0 };
  const seen = new Set((await db`SELECT msg_id FROM interview_seen_messages WHERE store_pc = ${store.pc} AND msg_id = ANY(${ids})`).map(r => r.msg_id));
  let updated = 0;
  for (const id of ids.filter(x => !seen.has(x))) {
    const msg = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
    const ics = await calendarText(gmail, msg);
    if (ics) for (const e of parseIcs(ics)) { if (await upsertEvent(db, store.pc, e, id)) updated++; }
    await db`INSERT INTO interview_seen_messages (store_pc, msg_id) VALUES (${store.pc}, ${id}) ON CONFLICT DO NOTHING`;
  }
  return { found: ids.length, updated };
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

// Everyone on file for the store, with `muted` flagged; the caller drops the muted ones.
async function realRecipients(db, store, muted) {
  const flag = (rows) => rows.map(p => ({ ...p, muted: muted.has(String(p.id)) }));
  const mgrs = await db`SELECT id, name, phone, email FROM users WHERE active = true AND user_type = 'manager' AND store_pc::text = ${String(store.pc)} AND (phone IS NOT NULL OR email IS NOT NULL)`;
  if (mgrs.length) return flag(mgrs);
  return flag(await db`SELECT id, name, phone, email FROM users WHERE active = true AND user_type = 'dm' AND district::text = ${String(store.district)} AND (phone IS NOT NULL OR email IS NOT NULL)`);
}

async function deliver(people, text, subject) {
  const phones = people.map(p => p.phone).filter(Boolean);
  const emails = people.map(p => p.email).filter(Boolean);
  let sms = await sendSms(phones, text);
  // Textbelt rejects links on keys that aren't link-verified — retry without the link.
  if (phones.length && !sms.sent && sms.results.some(r => /url|link/i.test(r.error || ''))) {
    sms = await sendSms(phones, text.replace(/\s*Join: \S+/, ''));
  }
  for (const e of emails) { try { await sendEmail([e], subject, text); } catch {} }
  return { smsSent: sms.sent, emails: emails.length };
}

export async function runInterviewReminders({ trigger = 'cron' } = {}) {
  const mode = reminderMode();
  const startedAt = Date.now();
  if (mode === 'off') return { ok: true, mode, skipped: true };
  const db = sql();
  await ensureTables(db);
  await refreshStoreList(STORES, ALL_STORES);

  // 1) mailboxes
  const mailboxes = {};
  await pool(STORES, 6, async (store) => {
    try { mailboxes[store.pc] = { ok: true, ...(await scanMailbox(db, store)) }; }
    catch (e) { mailboxes[store.pc] = { ok: false, error: String(e?.response?.data?.error_description || e?.response?.data?.error?.message || e.message || e).slice(0, 200) }; }
  });

  // 2) reminders
  const now = Date.now();
  const etHour = etHourNow();
  const rows = await db`SELECT * FROM interview_invites WHERE status = 'active' AND start_at > now() AND start_at < now() + interval '25 hours'`;
  const storeByPc = Object.fromEntries(ALL_STORES.map(s => [String(s.pc), s]));
  let shadowPerson = null;
  if (mode === 'shadow') shadowPerson = (await db`SELECT name, phone, email FROM users WHERE lower(email) = ${shadowEmail()} LIMIT 1`)[0] || null;
  const muted = new Set((await loadConfig()).mutedUsers);
  const sent = [];
  for (const r of rows) {
    const iv = { start: new Date(r.start_at).toISOString(), status: r.status, sentDayAt: r.sent_day_at, sentHourAt: r.sent_hour_at, candidate: r.candidate, summary: r.summary, link: r.link };
    const kind = dueReminder(iv, now, etHour);
    if (!kind) continue;
    // Claim the reminder BEFORE sending, so two overlapping runs (cron + "Check mailboxes
    // now", or a slow run still going) can't both send it.
    const claimed = kind === 'day'
      ? await db`UPDATE interview_invites SET sent_day_at = now() WHERE uid = ${r.uid} AND store_pc = ${r.store_pc} AND sent_day_at IS NULL AND sent_hour_at IS NULL RETURNING uid`
      : await db`UPDATE interview_invites SET sent_hour_at = now(), sent_day_at = COALESCE(sent_day_at, now()) WHERE uid = ${r.uid} AND store_pc = ${r.store_pc} AND sent_hour_at IS NULL RETURNING uid`;
    if (!claimed.length) continue;
    const store = storeByPc[String(r.store_pc)] || { pc: r.store_pc, name: `PC# ${r.store_pc}`, district: null };
    const everyone = await realRecipients(db, store, muted);
    const real = everyone.filter(p => !p.muted);
    let text = reminderText(kind, iv, now, { storeName: store.name });
    const subject = `Interview ${kind === 'hour' ? 'in 1 hour' : 'reminder'}: ${r.candidate || 'candidate'} · ${store.name}`;
    let people = real;
    let label = null;
    if (mode === 'shadow') {
      label = everyone.length ? everyone.map(p => `${p.name}${p.muted ? ' (muted)' : p.phone ? '' : ' (no phone)'}`).join(', ') : 'nobody on file';
      text = `[TEST → ${label}] ${text}`;
      // Everyone for this store muted → test mirrors live: nothing sent.
      people = shadowPerson && !(everyone.length && !real.length) ? [shadowPerson] : [];
    }
    const result = people.length ? await deliver(people, text, mode === 'shadow' ? `[TEST] ${subject}` : subject) : { smsSent: 0, emails: 0 };
    sent.push({ at: new Date().toISOString(), kind, store: store.name, candidate: r.candidate, start: iv.start, to: people.map(p => p.name).join(', ') || 'nobody', wouldGoTo: label, ...result });
  }

  // 3) status for the admin screen
  let prevSent = [];
  try { const prev = await blobs().get(STATUS_KEY, { type: 'json' }); prevSent = prev?.data?.sent || []; } catch {}
  const summary = {
    at: new Date().toISOString(), trigger, mode, durationMs: Date.now() - startedAt,
    shadowTo: mode === 'shadow' ? (shadowPerson ? `${shadowPerson.name}${shadowPerson.phone ? '' : ' (no phone on file)'}` : `no portal user with email ${shadowEmail()}`) : null,
    mailboxes, sent: [...sent, ...prevSent].slice(0, 40),
  };
  try { await blobs().setJSON(STATUS_KEY, { savedAt: summary.at, data: summary }); } catch (e) { console.warn('[interview-reminders] status save failed:', e.message); }
  const okBoxes = Object.values(mailboxes).filter(m => m.ok).length;
  console.log(`[interview-reminders] ${mode}: ${okBoxes}/${STORES.length} mailboxes read, ${sent.length} reminder(s) sent`);
  return { ok: true, mode, mailboxesOk: okBoxes, mailboxes: STORES.length, sent: sent.length };
}
