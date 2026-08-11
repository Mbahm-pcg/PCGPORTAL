// Manual trigger for fleet-alerts-cron.mjs's check — that function declares
// config.schedule, and Netlify's edge blocks ALL direct external POSTs to any
// scheduled function (same issue already solved for labor-cron.mjs/
// labor-refresh.mjs and tips-report-cron-background.mjs/-refresh-background.mjs)
// — this unscheduled sibling exists purely to make it reachable on demand,
// e.g. to send today's reminder immediately instead of waiting for tomorrow's
// scheduled run.
import { runFleetAlerts } from './fleet-alerts-cron.mjs';

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try {
    const summary = await runFleetAlerts();
    return new Response(JSON.stringify(summary), { status: 200, headers });
  } catch (err) {
    console.error('[fleet-alerts-refresh] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
