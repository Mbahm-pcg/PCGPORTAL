// paradox-hires-cron.mjs — every minute: new hires straight from the Paradox API (v22.43).
// All logic lives in paradox-hires-lib/run.mjs (see its header for Trial vs Paradox source).
import { runParadoxHires } from './paradox-hires-lib/run.mjs';

export const config = { schedule: '* * * * *' };

export default async () => {
  const r = await runParadoxHires({ trigger: 'cron' });
  if (!r.ok || r.newHires || r.seeded || r.sent) console.log('[paradox-hires]', JSON.stringify(r));
  return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
