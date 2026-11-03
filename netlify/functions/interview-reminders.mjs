// interview-reminders.mjs — exec/IT status for Paradox interview reminders:
// GET: mode, muted managers/DMs, last run (per-mailbox read result, recent sends) and the upcoming interviews.
// POST { mutedUsers: [user id] }: which managers/DMs have interview reminders switched off.
// POST { action: 'testHire', msgId }: email that recorded hire to the caller only.
// POST { action: 'saveHiresConfig', live, recipients: [{ userId, email, sms }], source }: New Hires settings.
// v22.45: POST { action: 'saveInterviewSource', source: 'paradox'|'email' } — where interviews come from.
//         POST { action: 'checkParadoxInterviews' } — read-only: Paradox times vs the Gmail invites.
// v22.43: GET also returns paradoxHires (rows + last run) from the every-minute Paradox API job.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { loadParadoxHires } from './paradox-hires-lib/run.mjs';
import { compareWithGmail } from './paradox-lib/interviews.mjs';
import { refreshStoreList } from './_shared/store-status.mjs';
import { STORES, ALL_STORES } from './labor-cron.mjs';
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
        const saved = await saveHiresConfig({ live: body.live, recipients: body.recipients, source: body.source }, caller.username || String(caller.sub));
        return json({ ok: true, hiresConfig: saved, hiresMode: await hiresModeNow(saved) });
      }
      if (body.action === 'saveInterviewSource') {
        return json({ ok: true, config: await saveConfig({ source: body.source === 'paradox' ? 'paradox' : 'email' }) });
      }
      if (body.action === 'checkParadoxInterviews') {
        await ensureTables(db);
        await refreshStoreList(STORES, ALL_STORES);
        return json({ ok: true, check: await compareWithGmail(db, STORES) });
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
    // Only the interviews from the chosen source (Paradox rows have uid 'px:…').
    const remCfg = await loadConfig();
    const pxLike = 'px:%';
    const upcoming = remCfg.source === 'paradox'
      ? await db`SELECT uid, store_pc, candidate, summary, start_at, link, status, sent_day_at, sent_hour_at
          FROM interview_invites WHERE start_at > now() - interval '2 hours' AND uid LIKE ${pxLike} ORDER BY start_at LIMIT 300`
      : await db`SELECT uid, store_pc, candidate, summary, start_at, link, status, sent_day_at, sent_hour_at
          FROM interview_invites WHERE start_at > now() - interval '2 hours' AND uid NOT LIKE ${pxLike} ORDER BY start_at LIMIT 300`;
    let status = null;
    try {
      const w = await getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN })
        .get('pcg_interview_reminders_status', { type: 'json' });
      status = w?.data || null;
    } catch {}
    // v22.24: the latest "Officially Hired" emails found in the store mailboxes.
    const hires = await db`SELECT msg_id, candidate, store_pc, received_at, notified_at, notify_note FROM ally_hires ORDER BY received_at DESC NULLS LAST LIMIT 15`;
    const hiresConfig = await loadHiresConfig();
    let paradoxHires = null;
    try { paradoxHires = await loadParadoxHires(db); } catch (e) { paradoxHires = { rows: [], status: { ok: false, error: e.message } }; }
    return json({ mode: reminderMode(), hiresMode: await hiresModeNow(hiresConfig), hiresConfig, status, upcoming, hires, paradoxHires, config: remCfg });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
