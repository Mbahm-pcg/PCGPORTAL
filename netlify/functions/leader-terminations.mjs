// leader-terminations.mjs — Tools · Leader Terminations (v23.27).
//   GET  → { rows, live, canAdmin, canAnswer, canCheck, checklist }
//   POST { action: 'live', enabled }        exec / IT: switch the texting on / off
//   POST { action: 'test' }                 exec / IT: a fake case through the real texts + reply
//   POST { action: 'clearTests' }           exec / IT: remove the test cases now (they also go after 30 min)
//   POST { action: 'runNow' }               exec / IT: check Paycor now (and ask, if Live)
//   POST { action: 'answer', id, answer }   someone on the ask list (or exec): YES / NO in the portal
//   POST { action: 'check', id, item, done } IT list (or exec / IT): tick a checklist item
//   POST { action: 'done', id }             mark the whole thing done
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { ensureTable, readList, liveOn, setLive, sendTest, clearTests, textStatus, textbeltQuota, mask, detectLeaderTerminations, askWaiting, answer, CHECKLIST, ASK_KEY, IT_KEY, ROLE_LABEL } from './_shared/leader-terminations.mjs';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const storeName = (pc) => (ALL_STORES.find(s => String(s.pc) === String(pc)) || STORES.find(s => String(s.pc) === String(pc)))?.name || (pc ? `PC ${pc}` : '');

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const real = authed.realUserType || authed.userType;
  const me = String(authed.sub);
  const myName = (await db`SELECT name FROM users WHERE id = ${authed.sub}`)[0]?.name || authed.name || authed.username || '';
  const isStaff = real === 'executive' || real === 'it';
  const [askL, itL] = await Promise.all([readList(ASK_KEY), readList(IT_KEY)]);
  const canAnswer = askL.ids.includes(me) || real === 'executive';
  const canCheck = itL.ids.includes(me) || isStaff;
  if (!isStaff && !canAnswer && !canCheck) return json(403, { error: 'forbidden' });
  await ensureTable(db);

  try {
    if (request.method === 'GET') {
      const rows = (await db`SELECT * FROM leader_terminations ORDER BY detected_at DESC LIMIT 100`).map(r => ({
        id: r.id, name: r.name, role: r.role, title: r.title || ROLE_LABEL[r.role] || '', store: storeName(r.store_pc), district: r.district,
        terminationDate: r.termination_date, source: r.source, isTest: r.is_test, status: r.status, detectedAt: r.detected_at, askedAt: r.asked_at,
        askedCount: (r.asked || []).length, askedOk: (r.asked || []).filter(a => a.ok).length,
        sends: (r.asked || []).map(a => ({ phone: mask(a.phone), ok: a.ok, error: a.error || null, hasId: !!a.textId })),
        answer: r.answer, answeredBy: r.answered_by, answeredAt: r.answered_at, answeredVia: r.answered_via,
        portalOff: r.portal_off_note || null, hasAccount: !!r.user_id, checklist: r.checklist || {}, doneAt: r.done_at, doneBy: r.done_by }));
      return json(200, { rows, textbelt: isStaff ? await textbeltQuota() : null, live: await liveOn(), canAdmin: isStaff, canAnswer, canCheck, checklist: CHECKLIST, askListSize: askL.phones.length + askL.emails.length });
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = await request.json().catch(() => ({}));
    if (body.action === 'live') {
      if (!isStaff) return json(403, { error: 'Only exec or IT can switch this.' });
      await setLive(!!body.enabled, myName);
      try { await db`INSERT INTO audit_log (type, user_id, user_role, action, metadata) VALUES ('leader_termination', ${me}, ${real}, ${body.enabled ? 'live_on' : 'live_off'}, ${JSON.stringify({ by: myName })})`; } catch {}
      return json(200, { ok: true, live: !!body.enabled });
    }
    if (body.action === 'test') {
      if (!isStaff) return json(403, { error: 'Only exec or IT can send a test.' });
      return json(200, { ok: true, ...(await sendTest(db, myName)) });
    }
    if (body.action === 'delivery') {
      if (!isStaff) return json(403, { error: 'Only exec or IT can do this.' });
      const r = (await db`SELECT asked FROM leader_terminations WHERE id = ${Number(body.id)}`)[0];
      if (!r) return json(404, { error: 'Not found' });
      const out = [];
      for (const a of r.asked || []) out.push({ phone: mask(a.phone), accepted: !!a.ok, error: a.error || null, status: a.ok ? await textStatus(a.textId) : 'NOT SENT' });
      return json(200, { ok: true, delivery: out });
    }
    if (body.action === 'clearTests') {
      if (!isStaff) return json(403, { error: 'Only exec or IT can do this.' });
      return json(200, { ok: true, removed: await clearTests(db, { all: true }) });
    }
    if (body.action === 'runNow') {
      if (!isStaff) return json(403, { error: 'Only exec or IT can do this.' });
      const d = await detectLeaderTerminations(db);
      const a = await askWaiting(db);
      return json(200, { ok: true, ...d, ...a });
    }
    if (body.action === 'answer') {
      if (!canAnswer) return json(403, { error: 'Only the people on Leader termination can answer.' });
      if (!['yes', 'no'].includes(body.answer)) return json(400, { error: 'Answer yes or no.' });
      const r = await answer(db, Number(body.id), body.answer, { by: myName, via: 'portal' });
      if (r.already) return json(409, { error: `${r.answeredBy || 'Someone'} already answered ${String(r.answer || '').toUpperCase()}.` });
      return json(200, { ok: true, ...r });
    }
    if (body.action === 'check') {
      if (!canCheck) return json(403, { error: 'forbidden' });
      if (!CHECKLIST.includes(body.item)) return json(400, { error: 'Unknown item' });
      const v = body.done ? { done: true, by: myName, at: new Date().toISOString() } : { done: false, by: myName, at: new Date().toISOString() };
      const upd = (await db`UPDATE leader_terminations SET checklist = checklist || ${JSON.stringify({ [body.item]: v })}::jsonb WHERE id = ${Number(body.id)} AND status = 'approved' RETURNING id`)[0];
      if (!upd) return json(409, { error: 'Only an approved one has a checklist.' });
      return json(200, { ok: true });
    }
    if (body.action === 'done') {
      if (!canCheck) return json(403, { error: 'forbidden' });
      const upd = (await db`UPDATE leader_terminations SET done_at = now(), done_by = ${myName} WHERE id = ${Number(body.id)} AND status = 'approved' AND done_at IS NULL RETURNING id`)[0];
      if (!upd) return json(409, { error: 'Already done, or not approved.' });
      return json(200, { ok: true });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[leader-terminations]', e.message);
    return json(502, { error: /Paycor/.test(e.message) ? 'Paycor is not responding — try again in a minute.' : 'Something went wrong — try again.' });
  }
};
