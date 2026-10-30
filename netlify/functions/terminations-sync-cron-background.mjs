// terminations-sync-cron-background.mjs — daily Terminations report sync (v22.33).
// 5:30 AM ET. All logic lives in terminations-lib/run.mjs (shared with the manual
// "Sync now" twin). `-background` = 15-minute budget: ~46 stores of paged rosters.
// Scheduled functions can't be invoked over HTTP, so there's no auth surface here.
import { runTerminationsSync } from './terminations-lib/run.mjs';

export const config = { schedule: '30 9 * * *' };

export default async () => {
  try {
    const summary = await runTerminationsSync({ trigger: 'cron' });
    console.log('[terminations-sync-cron] done', summary);
  } catch (err) {
    console.error('[terminations-sync-cron] failed:', err.message);
  }
  return new Response('ok');
};
