// no-clockin-cron.mjs — No Clock-In Alerts (scheduled)
// Every 15 min: alert the store manager (30 min after a shift starts with no clock-in) and
// manager + DM (60 min, "absent") by SMS, app notification and email.
// Netlify blocks HTTP calls to scheduled functions (empty 403), so manual dry runs and test
// sends live in no-clockin.mjs. Both call the shared engine in no-clockin-lib/run.mjs.
//
// Rollout safety: this only SENDS (and writes state) when env NO_CLOCKIN_LIVE=true;
// otherwise it computes and logs only.
// Spec: docs/superpowers/specs/2026-09-21-no-clockin-alerts-design.md
import { runNoClockin } from './no-clockin-lib/run.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  const live = process.env.NO_CLOCKIN_LIVE === 'true';
  const summary = await runNoClockin({ live });
  console.log('[no-clockin]', JSON.stringify({ ...summary, messages: summary.messages.length }));
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
