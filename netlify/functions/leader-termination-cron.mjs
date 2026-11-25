// leader-termination-cron.mjs — every 15 minutes (v23.27): look for Store Managers / DMs / Directors
// newly terminated in Paycor, then ask Mike / Sam / Krunal (7am–9pm ET, and only while Tools · Leader
// Terminations is switched Live). See _shared/leader-terminations.mjs for the whole flow.
import { sql } from './_shared/db.mjs';
import { detectLeaderTerminations, askWaiting } from './_shared/leader-terminations.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  const db = sql();
  try {
    const d = await detectLeaderTerminations(db);
    const a = await askWaiting(db);
    if (d.created || a.asked || d.errors) console.log('[leader-termination-cron]', JSON.stringify({ ...d, ...a }));
    return new Response(JSON.stringify({ ...d, ...a }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[leader-termination-cron]', e.message);
    return new Response('error', { status: 500 });
  }
};
