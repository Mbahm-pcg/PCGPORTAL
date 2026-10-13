// time-off-sync-cron-background.mjs — daily Time-Off Balances sync (v21.84).
// 6:15 AM ET. All logic lives in time-off-lib/sync.mjs (shared with the manual
// "Sync now" action in time-off.mjs). `-background` = 15-minute budget; a full run is
// ~46 legal entities, 6 at a time, so it normally finishes well under a minute.
// Scheduled functions can't be invoked over HTTP, so there's no auth surface here.
import { runTimeOffSync } from './time-off-lib/sync.mjs';

export const config = { schedule: '15 10 * * *' };

export default async () => {
  try {
    const summary = await runTimeOffSync({ trigger: 'cron' });
    console.log('[time-off-sync-cron] done', summary);
  } catch (err) {
    console.error('[time-off-sync-cron] failed:', err.message);
  }
  return new Response('ok');
};
