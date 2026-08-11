// Manual trigger for fleet-alerts-cron.mjs's check — that function declares
// config.schedule, and Netlify's edge blocks ALL direct external POSTs to any
// scheduled function (same issue already solved for labor-cron.mjs/
// labor-refresh.mjs and tips-report-cron-background.mjs/-refresh-background.mjs)
// — this unscheduled sibling exists purely to make it reachable on demand,
// e.g. to send today's reminder immediately instead of waiting for tomorrow's
// scheduled run. Background (not synchronous): fetching users + sending push/
// email/SMS to every admin role for every due vehicle hit the ~10-26s
// synchronous function ceiling on a real run (confirmed directly — the plain
// version timed out even with only one vehicle actually due).
export const config = { background: true };

import { runFleetAlerts } from './fleet-alerts-cron.mjs';

export default async (request) => {
  try {
    const summary = await runFleetAlerts();
    console.log('[fleet-alerts-refresh] done:', JSON.stringify(summary));
  } catch (err) {
    console.error('[fleet-alerts-refresh] error:', err.message);
  }
};
