// interview-reminders-cron-background.mjs — Paradox interview reminders (scheduled, every 15 min).
// Reads each store mailbox for new interview invites and texts/emails the reminder that's due
// (~1 day before, ~1 hour before). Mode: INTERVIEW_REMINDERS_MODE (default shadow — everything
// goes to INTERVIEW_REMINDERS_SHADOW_EMAIL's account only). Engine: interview-reminders-lib/run.mjs.
// Scheduled functions can't be hit over HTTP — manual runs go through interview-reminders-run-background.mjs.
import { runInterviewReminders } from './interview-reminders-lib/run.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  try {
    const r = await runInterviewReminders({ trigger: 'cron' });
    return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[interview-reminders] run failed:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
