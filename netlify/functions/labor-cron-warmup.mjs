// labor-cron-warmup — Saturday 11:45 PM ET (03:45 UTC Sun). Runs the full labor
// aggregation 13 min before the leaderboard cron so WTD data is current.
// Netlify invokes on schedule with a next_run body → labor-cron runs in scheduled mode
// (isManual=false, skipSchedules=false), matching the legacy direct handler re-export.
import laborCron from './labor-cron.mjs';

export const config = { schedule: '45 3 * * 0' };

export default laborCron;
