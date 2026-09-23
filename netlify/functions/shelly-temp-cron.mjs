// shelly-temp-cron.mjs — Walk-in cooler/freezer temp alerts (scheduled)
// Every 10 min: check every Shelly temp sensor against the two-tier thresholds (Warning at
// 5°C sustained 30 min, Red-flag at 7°C instant, or Prolonged-warning after 2 hours stuck
// in between) and auto-create a HIGH-priority Maintenance ticket + notify when warranted.
// Spec: docs/superpowers/specs/2026-09-23-shelly-temp-alerts-design.md
import { runShellyTempCheck } from './shelly-temp-lib/run.mjs';

export const config = { schedule: '*/10 * * * *' };

export default async () => {
  const summary = await runShellyTempCheck();
  console.log('[shelly-temp]', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
