// Manual trigger for food-license-alerts-cron.mjs's check — that function
// declares config.schedule, and Netlify's edge blocks ALL direct external
// POSTs to any scheduled function (same issue already solved for labor-cron
// and the fleet/tips report crons) — this unscheduled sibling exists purely
// to make it reachable on demand. Background (not synchronous) since sending
// email/SMS to every recipient for every due license can add up, same
// reasoning as fleet-alerts-refresh-background.mjs.
export const config = { background: true };

import { runFoodLicenseAlerts } from './food-license-alerts-cron.mjs';

export default async (request) => {
  try {
    const summary = await runFoodLicenseAlerts();
    console.log('[food-license-alerts-refresh] done:', JSON.stringify(summary));
  } catch (err) {
    console.error('[food-license-alerts-refresh] error:', err.message);
  }
};
