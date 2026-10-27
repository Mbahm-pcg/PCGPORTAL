// interview-reminders.mjs — exec/IT status for Paradox interview reminders:
// GET: mode, muted managers/DMs, last run (per-mailbox read result, recent sends) and the upcoming interviews.
// POST { mutedUsers: [user id] }: which managers/DMs have interview reminders switched off.
// POST { action: 'testHire', msgId }: email that recorded hire to the caller only.
// POST { action: 'saveHiresConfig', live, recipients: [{ userId, email, sms }] }: New Hires settings.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { ensureTables, reminderMode, hiresModeNow, loadHiresConfig, saveHiresConfig, loadConfig, saveConfig, sendHireTest } from './interview-reminders-lib/run.mjs';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export default async (request) => {
  const db = sql();
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) return json({ error: 'Exec/IT session required.' }, 403);
  try {
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      // v22.31: who gets hire alerts (and how), and Test vs Live — chosen in the New Hires tab.
      if (body.action === 'saveHiresConfig') {
        const saved = await saveHiresConfig({ live: body.live, recipients: body.recipients }, caller.username || String(caller.sub));
        return json({ ok: true, hiresConfig: saved, hiresMode: await hiresModeNow(saved) });
      }
      if (body.action === 'testHire') {
        await ensureTables(db);
        const me = (await db`SELECT email FROM users WHERE id = ${caller.sub}`)[0];
        if (!me?.email) return json({ error: 'Your account has no email address.' }, 400);
        const r = await sendHireTest(db, body.msgId, me.email);
        return json(r, r.ok ? 200 : 400);
      }
      return json({ ok: true, config: await saveConfig({ mutedUsers: body.mutedUsers }) });
    }
    await ensureTables(db);
    const upcoming = await db`SELECT uid, store_pc, candidate, summary, start_at, link, status, sent_day_at, sent_hour_at
      FROM interview_invites WHERE start_at > now() - interval '2 hours' ORDER BY start_at LIMIT 300`;
    let status = null;
    try {
      const w = await getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN })
        .get('pcg_interview_reminders_status', { type: 'json' });
      status = w?.data || null;
    } catch {}
    // v22.24: the latest "Officially Hired" emails found in the store mailboxes.
    const hires = await db`SELECT msg_id, candidate, store_pc, received_at, notified_at, notify_note FROM ally_hires ORDER BY received_at DESC NULLS LAST LIMIT 15`;
    const hiresConfig = await loadHiresConfig();
    return json({ mode: reminderMode(), hiresMode: await hiresModeNow(hiresConfig), hiresConfig, status, upcoming, hires, config: await loadConfig() });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
