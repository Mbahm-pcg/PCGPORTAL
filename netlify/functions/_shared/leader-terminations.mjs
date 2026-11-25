// _shared/leader-terminations.mjs — a Store Manager / DM / Director terminated in Paycor →
// Mike, Sam and Krunal are texted "reply YES to have Ahmed deactivate their accounts" → the first
// YES turns their portal login off and sends Ahmed the checklist (v23.27, user 2026-11-25).
//
//   detect      every 15 minutes (leader-termination-cron.mjs): each active portal leader linked to
//               Paycor is read live (GET /employees/{id}); the daily Terminations list is the
//               backstop for leaders not linked (Paycor job title). Only terminations dated in the
//               last RECENT_DAYS days count, and each person + date is recorded once — never old ones.
//   ask         7am–9pm ET (overnight ones wait): a text to Admin · Notifications · Leader termination
//               (no link — Textbelt refuses links) with replyWebhookUrl + webhookData "lt:<id>", and
//               an email + push + bell. While "Live" is OFF nothing is texted; it's only recorded.
//   reply       textbelt-reply.mjs → handleReply(): Textbelt's signature checked there; the reply
//               must come from a number that was asked. First answer wins (status claim).
//   YES         the portal account is deactivated (users.active = false, as Admin · Users does),
//               audit-logged; Admin · Notifications · Leader termination (IT) — Ahmed — gets a text,
//               email, push and bell; the checklist lives in Tools · Leader Terminations.
// A TEST row (Send a test) goes through the same texts and reply, but never touches an account.
import { getStore } from '@netlify/blobs';
import { callPaycor } from '../paycor.mjs';
import { sendSms, sendPush, sendHtmlEmail } from './channels.mjs';
import { bell, esc, usDay, PORTAL } from './form-approval.mjs';
import { extractTermination } from '../../../src/terminations.mjs';
import { loadTerminations } from '../terminations-lib/run.mjs';
import { STORES, ALL_STORES } from '../tips-report-cron-background.mjs';
import { refreshStoreList } from './store-status.mjs';

export const ASK_KEY = 'pcg_leader_termination_notify_v1';
export const IT_KEY = 'pcg_leader_termination_it_v1';
const LIVE_KEY = 'pcg_leader_termination_live_v1';
const ROLES = ['manager', 'dm', 'director'];
export const ROLE_LABEL = { manager: 'Store Manager', dm: 'District Manager', director: 'Director of Operations' };
// The daily list only has the Paycor job title — leaders only, never "Assistant Manager".
const LEADER_TITLE = /^\s*(store manager|general manager|district manager|director\b.*)\s*$/i;
export const CHECKLIST = ['Portal login', 'Crunch Time', 'WorkPulse', 'Email', 'Other systems'];
const RECENT_DAYS = 7;
const WINDOW = { start: 7, end: 21 }; // texts go out 7:00–20:59 ET
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const storeOf = (pc) => ALL_STORES.find(s => String(s.pc) === String(pc)) || STORES.find(s => String(s.pc) === String(pc));
export const digits = (x) => String(x || '').replace(/\D/g, '').slice(-10);
const todayET = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(d)) % 24;
const minusDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') - n * 864e5).toISOString().slice(0, 10);
export const webhookUrl = () => `${process.env.URL || PORTAL}/.netlify/functions/textbelt-reply`;

let ready = null;
export function ensureTable(db) {
  return (ready ||= (async () => {
    await db`CREATE TABLE IF NOT EXISTS leader_terminations (
      id serial PRIMARY KEY, paycor_employee_id text NOT NULL, user_id integer, name text, role text, title text,
      store_pc text, district text, termination_date text NOT NULL, source text, is_test boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'waiting', detected_at timestamptz DEFAULT now(), asked_at timestamptz, asked jsonb,
      answer text, answered_by text, answered_phone text, answered_at timestamptz, answered_via text,
      portal_off_at timestamptz, portal_off_note text, it_told_at timestamptz,
      checklist jsonb NOT NULL DEFAULT '{}'::jsonb, done_at timestamptz, done_by text,
      UNIQUE (paycor_employee_id, termination_date))`;
  })().catch(e => { ready = null; throw e; }));
}

export async function readList(key) {
  const raw = await blobs().get(key, { type: 'json' }).catch(() => null);
  const l = raw?.data ?? raw ?? {};
  return { emails: (l.emails || []).filter(Boolean), phones: (l.phones || []).filter(Boolean),
    ids: [...new Set([...(l.emailOwners || []), ...(l.phoneOwners || [])].filter(id => id != null).map(String))] };
}
export async function liveOn() {
  const raw = await blobs().get(LIVE_KEY, { type: 'json' }).catch(() => null);
  return !!(raw?.data ?? raw)?.enabled;
}
export async function setLive(enabled, by) {
  await blobs().setJSON(LIVE_KEY, { savedAt: new Date().toISOString(), data: { enabled: !!enabled, by, at: new Date().toISOString() } });
}

// Who's asked: the Leader termination list; nobody on it yet → every executive (so nothing is missed).
async function askList(db) {
  const l = await readList(ASK_KEY);
  if (l.phones.length || l.emails.length) return l;
  const ex = await db`SELECT id, email, phone FROM users WHERE active IS NOT FALSE AND user_type = 'executive'`;
  return { ids: ex.map(e => String(e.id)), emails: ex.map(e => e.email).filter(Boolean), phones: ex.map(e => e.phone).filter(Boolean) };
}
// Who does it: the Leader termination (IT) list; nobody on it yet → every IT account.
async function itList(db) {
  const l = await readList(IT_KEY);
  if (l.phones.length || l.emails.length || l.ids.length) return l;
  const it = await db`SELECT id, email, phone FROM users WHERE active IS NOT FALSE AND user_type = 'it'`;
  return { ids: it.map(e => String(e.id)), emails: it.map(e => e.email).filter(Boolean), phones: it.map(e => e.phone).filter(Boolean) };
}
async function itName(db) {
  const l = await itList(db);
  const r = l.ids.length ? (await db`SELECT name FROM users WHERE id = ANY(${l.ids.map(Number).filter(Boolean)}) LIMIT 1`.catch(() => []))[0] : null;
  return String(r?.name || 'IT').split(' ')[0];
}

const where = (r) => (r.role === 'manager' || !r.district) ? (storeOf(r.store_pc)?.name || (r.store_pc ? `PC ${r.store_pc}` : '')) : `District ${r.district}`;
const titleOf = (r) => r.title || ROLE_LABEL[r.role] || 'Leader';
const who = (r) => `${r.is_test ? 'TEST (not real): ' : ''}${r.name} (${titleOf(r)}${where(r) ? `, ${where(r)}` : ''})`;

// ── detect ──
// v23.28: test cases ("Send a test") clear themselves after 30 minutes — or now, from the screen.
export async function clearTests(db, { all = false } = {}) {
  await ensureTable(db);
  const gone = all ? await db`DELETE FROM leader_terminations WHERE is_test RETURNING id`
    : await db`DELETE FROM leader_terminations WHERE is_test AND detected_at < now() - interval '30 minutes' RETURNING id`;
  return gone.length;
}

export async function detectLeaderTerminations(db) {
  await ensureTable(db);
  await clearTests(db).catch(() => {});
  await refreshStoreList(STORES, ALL_STORES).catch(() => {});
  const cutoff = minusDays(todayET(), RECENT_DAYS);
  const found = [];
  const leaders = await db`SELECT id, name, user_type, store_pc, district, paycor_employee_id FROM users
    WHERE active IS NOT FALSE AND user_type = ANY(${ROLES}) AND paycor_employee_id IS NOT NULL AND paycor_employee_id <> ''`;
  let checked = 0, errors = 0;
  const queue = [...leaders];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let u; (u = queue.shift());) {
      try {
        const res = await callPaycor(`/employees/${encodeURIComponent(u.paycor_employee_id)}`);
        if (res.status !== 200 || !res.data) { errors++; continue; }
        checked++;
        const rec = res.data?.records?.[0] || res.data;
        const t = extractTermination({ ...rec, id: rec.id || u.paycor_employee_id }, u.store_pc || '');
        if (t && t.terminationDate >= cutoff) found.push({ paycorId: String(u.paycor_employee_id), userId: u.id, name: u.name || t.name, role: u.user_type, title: t.jobTitle || ROLE_LABEL[u.user_type], storePc: u.store_pc || null, district: u.district ?? null, date: t.terminationDate, source: 'live' });
      } catch (e) { errors++; console.warn('[leader-terminations] paycor', u.id, e.message); }
    }
  }));
  // Backstop: the morning Terminations list, for leaders whose account isn't linked to Paycor.
  const term = await loadTerminations().catch(() => null);
  for (const r of term?.rows || []) {
    if (!r?.id || !r.terminationDate || r.terminationDate < cutoff || !LEADER_TITLE.test(String(r.jobTitle || ''))) continue;
    if (found.some(f => f.paycorId === String(r.id))) continue;
    const st = storeOf(r.pc);
    // their portal account: by Paycor id, else same name AND same store / district (never a namesake elsewhere)
    const u = (await db`SELECT id, name, user_type, store_pc, district, active FROM users WHERE paycor_employee_id = ${String(r.id)} LIMIT 1`)[0]
      || (await db`SELECT id, name, user_type, store_pc, district, active FROM users WHERE lower(name) = lower(${r.name}) AND user_type = ANY(${ROLES})
          AND (store_pc::text = ${String(r.pc)} OR district::text = ${String(st?.district ?? '')}) LIMIT 1`)[0];
    const role = u?.user_type || (/district/i.test(r.jobTitle) ? 'dm' : /director/i.test(r.jobTitle) ? 'director' : 'manager');
    found.push({ paycorId: String(r.id), userId: u && u.active !== false ? u.id : null, name: r.name, role, title: r.jobTitle, storePc: String(r.pc), district: u?.district ?? st?.district ?? null, date: r.terminationDate, source: 'daily' });
  }
  const created = [];
  for (const f of found) {
    const ins = await db`INSERT INTO leader_terminations (paycor_employee_id, user_id, name, role, title, store_pc, district, termination_date, source)
      VALUES (${f.paycorId}, ${f.userId}, ${f.name}, ${f.role}, ${f.title}, ${f.storePc}, ${f.district == null ? null : String(f.district)}, ${f.date}, ${f.source})
      ON CONFLICT (paycor_employee_id, termination_date) DO NOTHING RETURNING *`;
    if (ins[0]) created.push(ins[0]);
  }
  if (created.length) console.log(`[leader-terminations] new: ${created.map(r => `${r.name} (${r.role}, ${r.termination_date})`).join('; ')}`);
  return { leaders: leaders.length, checked, errors, found: found.length, created: created.length };
}

// ── ask ──
export async function askWaiting(db, { force = false } = {}) {
  await ensureTable(db);
  if (!force) {
    if (!(await liveOn())) return { asked: 0, held: 'live-off' };
    const h = etHour();
    if (h < WINDOW.start || h >= WINDOW.end) return { asked: 0, held: 'night' };
  }
  const rows = await db`SELECT * FROM leader_terminations WHERE status = 'waiting' AND is_test = false ORDER BY detected_at LIMIT 10`;
  for (const r of rows) await ask(db, r);
  return { asked: rows.length };
}

export async function ask(db, row) {
  const claimed = (await db`UPDATE leader_terminations SET status = 'asking', asked_at = now() WHERE id = ${row.id} AND status = 'waiting' RETURNING *`)[0];
  if (!claimed) return null;
  const l = await askList(db);
  const it = await itName(db);
  const line = `${who(claimed)} was terminated in Paycor on ${usDay(claimed.termination_date)}.`;
  const sms = `PCG: ${line} Reply YES to have ${it} deactivate their accounts (Crunch Time, WorkPulse, etc.) and turn off their portal login, or NO to skip.`;
  const res = await sendSms(l.phones, sms, { replyWebhookUrl: webhookUrl(), webhookData: `lt:${claimed.id}` });
  const asked = (res.results || []).map(x => ({ phone: x.number, ok: !!x.success, textId: x.textId || null, error: x.error || null }));
  const b = blobs();
  const link = `${PORTAL}/tools/leader-terminations`;
  await Promise.all([
    l.emails.length ? sendHtmlEmail(l.emails, `${claimed.is_test ? 'TEST: ' : ''}Leader terminated: ${claimed.name}`, `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>${esc(line)}</p><p>Reply <b>YES</b> to the text to have ${esc(it)} deactivate their accounts (Crunch Time, WorkPulse, etc.) and turn off their portal login, or <b>NO</b> to skip. The first answer counts.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Answer in the portal</a></p></div>`) : null,
    l.ids.length ? sendPush(b, l.ids, `Leader terminated: ${claimed.name}`, `${line} Reply YES or NO to the text.`, `leader-term-${claimed.id}`, '/tools/leader-terminations') : null,
  ]);
  await bell(l.ids, `${line} Reply YES or NO to the text, or answer in Tools · Leader Terminations.`, `ask-${claimed.id}`, 'leader_termination');
  await db`UPDATE leader_terminations SET asked = ${JSON.stringify(asked)} WHERE id = ${claimed.id}`;
  return { phones: asked.length, sent: asked.filter(a => a.ok).length, emails: l.emails.length };
}

// ── answer (a text reply, or the portal) ──
export function parseAnswer(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[^a-z ]/g, ' ').trim();
  if (/^(stop|stopall|unsubscribe|cancel|end|quit)\b/.test(t)) return 'stop'; // Textbelt handles opt-outs; never text back
  if (/^(y|yes|yeah|yep|yup|approve|approved|do it|go ahead)\b/.test(t)) return 'yes'; // not "ok": often just "got it"
  if (/^(n|no|nope|nah|skip|dont|do not|deny)\b/.test(t)) return 'no';
  return null;
}

async function nameForPhone(db, phone) {
  const d = digits(phone);
  const rows = await db`SELECT name, phone FROM users WHERE active IS NOT FALSE AND phone IS NOT NULL`.catch(() => []);
  return rows.find(u => digits(u.phone) === d)?.name || null;
}
const textThem = (phones, msg, rowId) => phones.length ? sendSms(phones, `PCG: ${msg}`, rowId ? { replyWebhookUrl: webhookUrl(), webhookData: `lt:${rowId}` } : undefined) : null;

export async function handleReply(db, { fromNumber, text, data }) {
  await ensureTable(db);
  const m = /^lt:(\d+)$/.exec(String(data || ''));
  if (!m) return { ignored: 'not ours' };
  const row = (await db`SELECT * FROM leader_terminations WHERE id = ${Number(m[1])}`)[0];
  if (!row) return { ignored: 'no such row' };
  const from = digits(fromNumber);
  if (!(row.asked || []).some(a => digits(a.phone) === from)) return { ignored: 'number was not asked' };
  const name = (await nameForPhone(db, fromNumber)) || `(${from.slice(0, 3)}) ${from.slice(3, 6)}-${from.slice(6)}`;
  const ans = parseAnswer(text);
  if (ans === 'stop') return { ignored: 'opt-out' };
  if (!ans) { await textThem([fromNumber], `Please reply YES or NO about ${row.name}.`, row.id); return { asked: 'again' }; }
  return answer(db, row.id, ans, { by: name, phone: fromNumber, via: 'text' });
}

export async function answer(db, id, ans, { by, phone = null, via }) {
  const upd = (await db`UPDATE leader_terminations SET status = ${ans === 'yes' ? 'approved' : 'declined'}, answer = ${ans}, answered_by = ${by},
      answered_phone = ${phone}, answered_at = now(), answered_via = ${via}
    WHERE id = ${id} AND status IN ('asking', 'waiting') RETURNING *`)[0];
  if (!upd) {
    const r = (await db`SELECT * FROM leader_terminations WHERE id = ${id}`)[0];
    if (phone && r?.answered_by) await textThem([phone], `${r.answered_by} already answered ${String(r.answer || '').toUpperCase()} about ${r.name}. Nothing else to do.`);
    return { already: true, answeredBy: r?.answered_by || null, answer: r?.answer || null };
  }
  const others = (upd.asked || []).filter(a => a.ok && digits(a.phone) !== digits(phone)).map(a => a.phone);
  if (ans === 'no') {
    if (phone) await textThem([phone], `OK, nothing will be done for ${upd.name}.`);
    if (others.length) await textThem(others, `${by} answered NO about ${upd.name}. Nothing else to do.`);
    return { ok: true, answer: 'no' };
  }
  // YES → portal login off (never for a test), then IT is told.
  let off = null;
  if (!upd.is_test && upd.user_id) {
    const u = (await db`UPDATE users SET active = false, updated_at = now() WHERE id = ${upd.user_id} AND active IS NOT FALSE RETURNING id`)[0];
    off = u ? 'off' : 'already';
    const at = new Date().toISOString();
    await db`UPDATE leader_terminations SET portal_off_at = now(), portal_off_note = ${off === 'off' ? 'Turned off automatically' : 'Was already off'},
      checklist = checklist || ${JSON.stringify({ 'Portal login': { done: true, by: 'automatic', at } })}::jsonb WHERE id = ${upd.id}`;
    try { await db`INSERT INTO audit_log (type, user_id, user_role, action, metadata) VALUES ('leader_termination', ${String(upd.user_id)}, ${upd.role}, 'portal_login_deactivated', ${JSON.stringify({ row: upd.id, name: upd.name, approvedBy: by, via })})`; } catch {}
  } else if (!upd.is_test) {
    await db`UPDATE leader_terminations SET portal_off_note = 'No portal account found for them' WHERE id = ${upd.id}`;
  }
  const itFirst = await itName(db);
  const offLine = upd.is_test ? ' (test: no account was touched)' : off === 'off' ? ' Their portal login is now off.' : off === 'already' ? ' Their portal login was already off.' : ' No portal account was found for them.';
  if (phone) await textThem([phone], `Thanks. ${itFirst} has been told to deactivate ${upd.name}'s accounts.${offLine}`);
  if (others.length) await textThem(others, `${by} answered YES about ${upd.name}; ${itFirst} has been told. Nothing else to do.`);
  await tellIT(db, { ...upd, portal_off_note: off }, by);
  return { ok: true, answer: 'yes', portal: off };
}

async function tellIT(db, r, by) {
  const l = await itList(db);
  const line = `${by} approved: deactivate ${who(r)}'s accounts (terminated ${usDay(r.termination_date)}).${r.is_test ? ' This is a TEST, nothing was touched.' : r.portal_off_note === 'off' ? ' Their portal login was turned off automatically.' : ''}`;
  const link = `${PORTAL}/tools/leader-terminations`;
  const b = blobs();
  await Promise.all([
    l.phones.length ? sendSms(l.phones, `PCG: ${line} Checklist: Tools > Leader Terminations (Crunch Time, WorkPulse, email...).`) : null,
    l.emails.length ? sendHtmlEmail(l.emails, `${r.is_test ? 'TEST: ' : ''}Deactivate accounts: ${r.name}`, `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>${esc(line)}</p>
<p>To do: ${CHECKLIST.map(esc).join(', ')}. Tick each off in the portal.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open the checklist</a></p></div>`) : null,
    l.ids.length ? sendPush(b, l.ids, `Deactivate accounts: ${r.name}`, line, `leader-term-it-${r.id}`, '/tools/leader-terminations') : null,
  ]);
  await bell(l.ids, line, `it-${r.id}`, 'leader_termination');
  await db`UPDATE leader_terminations SET it_told_at = now() WHERE id = ${r.id}`;
}

// A clearly-marked fake case that goes through the real texts and the real reply — touches no account.
export async function sendTest(db, byName) {
  await ensureTable(db);
  const st = STORES[0] || {};
  const ins = (await db`INSERT INTO leader_terminations (paycor_employee_id, user_id, name, role, title, store_pc, district, termination_date, source, is_test)
    VALUES (${`test-${Date.now()}`}, NULL, 'Test Person', 'manager', 'Store Manager', ${String(st.pc || '')}, ${st.district == null ? null : String(st.district)}, ${todayET()}, ${`test by ${byName}`}, true) RETURNING *`)[0];
  return { id: ins.id, ...(await ask(db, ins)) };
}
