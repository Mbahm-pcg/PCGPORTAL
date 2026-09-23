// shelly-temp.mjs — manual endpoint for the walk-in cooler/freezer temp-alert automation
// (exec/IT session required). Not scheduled (Netlify blocks HTTP calls to scheduled
// functions, so shelly-temp-cron.mjs can't be hit directly). Both use the engine in
// shelly-temp-lib/run.mjs.
//   POST /.netlify/functions/shelly-temp            -> dry run: what WOULD happen (thresholds,
//                                                        who'd be notified); sends nothing,
//                                                        creates no ticket, writes no state
//   POST /.netlify/functions/shelly-temp?live=1     -> runs it for real, exactly like the
//                                                        scheduled cron would this same minute
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { runShellyTempCheck } from './shelly-temp-lib/run.mjs';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export default async (request) => {
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql());
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
    return json({ error: 'Exec/IT session required.' }, 403);
  }
  const url = new URL(request.url);
  try {
    const live = url.searchParams.get('live') === '1';
    return json(await runShellyTempCheck({ dryRun: !live }));
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
