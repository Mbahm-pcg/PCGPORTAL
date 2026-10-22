// interview-reminders-run-background.mjs — exec/IT "Check mailboxes now" (fire-and-forget;
// the result lands in the pcg_interview_reminders_status blob, read by interview-reminders.mjs).
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { runInterviewReminders } from './interview-reminders-lib/run.mjs';

export default async (request) => {
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql());
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
    return new Response(JSON.stringify({ error: 'Exec/IT session required.' }), { status: 403 });
  }
  try { await runInterviewReminders({ trigger: `manual:${caller.username || caller.sub}` }); }
  catch (e) { console.error('[interview-reminders] manual run failed:', e); }
  return new Response('', { status: 202 });
};
