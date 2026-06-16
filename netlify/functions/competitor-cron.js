// competitor-cron.js — Roadmap 10.5 Competitive Intelligence (weekly).
// Runs Wednesday 5 AM ET (09:00 UTC): snapshots competitors near each store via
// Google Places, diffs vs last week to catch openings/closings, refreshes
// ImpactRadar-style sales impact, and researches competitor promotions (web search).
// Sends a weekly digest email. Dedicated cron so it doesn't re-trigger analyst-cron.
const { runCompetitorIntel } = require('./analyst-lib/competitor');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const isManual = event && event.httpMethod === 'POST';
  const today = new Date().toISOString().slice(0, 10);
  console.log('[competitor-cron] triggered', today, isManual ? '(manual)' : '(scheduled)');

  try {
    const result = await runCompetitorIntel({ today, doDetection: true });
    console.log('[competitor-cron] result:', JSON.stringify(result));
    return isManual ? { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) } : undefined;
  } catch (err) {
    console.error('[competitor-cron] error:', err);
    return isManual ? { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) } : undefined;
  }
};
