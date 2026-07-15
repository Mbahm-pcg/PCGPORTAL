// Background + scheduled entry for competitor intel (Mon 5 AM ET / 09:00 UTC).
// The -background filename gives the 15-min timeout (up to ~90 Google Places calls —
// exec ~1mi sweep + DM 5mi sweep, ~45 stores each — plus market-share Places calls,
// Claude web-search, and per-new-event drive-time calls before the weekly emails). The
// schedule lives here because the foreground competitor-cron has none. Also handles manual POSTs.
import competitorCron from './competitor-cron.mjs';

export const config = { schedule: '0 9 * * 1' };

export default async (request, context) => {
  try {
    await competitorCron(request, context);
  } catch (err) {
    console.error('[competitor-cron-background] error:', err.message);
  }
};
