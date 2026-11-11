// joy-cron-background.mjs — hourly refresh of the Joy in Childhood leaderboard (v22.75).
// See joy-lib/run.mjs. Background (15 min) because a first run backfills the whole campaign.
import { runJoy } from './joy-lib/run.mjs';

export const config = { schedule: '7 * * * *' }; // every hour, 7 past

export default async () => {
  try { await runJoy(); } catch (e) { console.error('[joy-cron]', e.message); }
  return new Response('ok');
};
