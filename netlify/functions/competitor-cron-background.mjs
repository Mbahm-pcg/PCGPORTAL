// Background + scheduled entry for competitor intel (Wed 5 AM ET / 09:00 UTC).
// The -background filename gives the 15-min timeout (up to 45 Google Places calls +
// a Claude web-search before the weekly email). The schedule lives here because the
// foreground competitor-cron has none. Also handles manual POSTs.
import competitorCron from './competitor-cron.mjs';

export const config = { schedule: '0 9 * * 3' };

export default async (request, context) => {
  try {
    await competitorCron(request, context);
  } catch (err) {
    console.error('[competitor-cron-background] error:', err.message);
  }
};
