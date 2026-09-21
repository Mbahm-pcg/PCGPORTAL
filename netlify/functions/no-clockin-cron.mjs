// no-clockin-cron.mjs — No Clock-In Alerts (scheduled)
// Every 15 min: alert the store manager (30 min after a shift starts with no clock-in) and
// manager + DM (60 min, "absent") by SMS, app notification and email.
// Netlify blocks HTTP calls to scheduled functions (empty 403), so manual dry runs and test
// sends live in no-clockin.mjs. Both call the shared engine in no-clockin-lib/run.mjs.
//
// Rollout switch — env NO_CLOCKIN_LIVE:
//   unset / anything else -> off:    computes and logs only, sends nothing
//   'shadow'              -> shadow: every alert goes ONLY to the user in NO_CLOCKIN_SHADOW_USER
//                                    (labelled with who it would have reached)
//   'true'                -> live:   real managers / DMs
// Spec: docs/superpowers/specs/2026-09-21-no-clockin-alerts-design.md
import { runNoClockin } from './no-clockin-lib/run.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  const flag = process.env.NO_CLOCKIN_LIVE;
  const mode = flag === 'true' ? 'live' : flag === 'shadow' ? 'shadow' : 'off';
  const summary = await runNoClockin({ mode });
  console.log('[no-clockin]', JSON.stringify({ ...summary, messages: summary.messages.length }));
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
