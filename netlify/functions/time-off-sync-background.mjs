// time-off-sync-background.mjs — exec/IT "Sync now" for Time-Off Balances (v21.84).
// HTTP-callable twin of time-off-sync-cron-background.mjs (scheduled functions can't be
// hit over HTTP). Returns 202 immediately; the caller polls time-off.mjs `status`.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { runTimeOffSync } from './time-off-lib/sync.mjs';

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed || (authed.userType !== 'executive' && authed.userType !== 'it')) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }
  try {
    const summary = await runTimeOffSync({ trigger: `manual:${authed.username || authed.sub}` });
    console.log('[time-off-sync-manual] done', summary);
  } catch (err) {
    console.error('[time-off-sync-manual] failed:', err.message);
  }
  return new Response(JSON.stringify({ ok: true }), { status: 202 });
};
