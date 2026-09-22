// no-clockin.mjs — manual endpoint for No Clock-In Alerts (exec/IT session required).
// Not scheduled (Netlify blocks HTTP calls to scheduled functions, so no-clockin-cron.mjs
// can't be hit directly). Both use the engine in no-clockin-lib/run.mjs.
//   POST /.netlify/functions/no-clockin            -> dry run: what WOULD be sent; sends nothing,
//                                                    writes no state
//   POST /.netlify/functions/no-clockin?sendTest=1 -> sends a sample alert to the caller only
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { runNoClockin, sendTestAlert, checkEmployeePunches } from './no-clockin-lib/run.mjs';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export default async (request) => {
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql());
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
    return json({ error: 'Exec/IT session required.' }, 403);
  }
  const url = new URL(request.url);
  try {
    // Diagnostic: raw Paycor punches for one employee/date, to check a specific past alert
    // against what Paycor shows NOW (e.g. a sync-lag punch that has since appeared).
    const employeeId = url.searchParams.get('employeeId');
    const date = url.searchParams.get('date');
    if (employeeId && date) return json(await checkEmployeePunches(employeeId, date));
    if (url.searchParams.get('sendTest') === '1') return json(await sendTestAlert(caller.sub));
    return json({ dryRun: true, ...(await runNoClockin({ mode: 'off' })) });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
