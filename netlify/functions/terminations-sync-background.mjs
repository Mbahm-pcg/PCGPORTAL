// terminations-sync-background.mjs — exec/IT "Sync now" for the Terminations report (v22.33).
// HTTP-callable twin of terminations-sync-cron-background.mjs (scheduled functions can't be
// hit over HTTP). Returns 202 immediately; the screen polls terminations-report.mjs until
// syncedAt changes.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { runTerminationsSync } from './terminations-lib/run.mjs';

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed || (authed.userType !== 'executive' && authed.userType !== 'it')) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }
  try {
    const summary = await runTerminationsSync({ trigger: `manual:${authed.username || authed.sub}` });
    console.log('[terminations-sync-manual] done', summary);
  } catch (err) {
    console.error('[terminations-sync-manual] failed:', err.message);
  }
  return new Response(JSON.stringify({ ok: true }), { status: 202 });
};
