// Manual trigger for case-watch-alerts-cron.mjs's check — that function
// declares config.schedule, and Netlify's edge blocks ALL direct external
// POSTs to any scheduled function (same issue already solved for fleet/food
// license/labor crons) — this unscheduled sibling exists purely to make it
// reachable on demand. Background (not synchronous) since sending email to
// every recipient for every newly-flagged case can add up.
export const config = { background: true };

import { runCaseWatchAlerts } from './case-watch-alerts-cron.mjs';

export default async (request) => {
  try {
    const summary = await runCaseWatchAlerts();
    console.log('[case-watch-alerts-refresh] done:', JSON.stringify(summary));
  } catch (err) {
    console.error('[case-watch-alerts-refresh] error:', err.message);
  }
};
