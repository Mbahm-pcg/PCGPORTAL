// competitor-cron.mjs — Roadmap 10.5 Competitive Intelligence (weekly).
// Runs Wednesday 5 AM ET (09:00 UTC): snapshots competitors near each store via
// Google Places, diffs vs last week to catch openings/closings, refreshes
// ImpactRadar-style sales impact, and researches competitor promotions (web search).
// Sends a weekly digest email. Dedicated cron so it doesn't re-trigger analyst-cron.
// No schedule config here — the -background wrapper carries the schedule.
import { runCompetitorIntel } from './analyst-lib/competitor.js';

export default async (request, context) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const body = await request.json().catch(() => ({}));
  const scheduled = request.headers.get('x-pcg-invocation') === 'scheduled' || !!body?.next_run;
  const isManual = request.method === 'POST' && !scheduled;
  const today = new Date().toISOString().slice(0, 10);
  console.log('[competitor-cron] triggered', today, isManual ? '(manual)' : '(scheduled)');

  try {
    const result = await runCompetitorIntel({ today, doDetection: true });
    console.log('[competitor-cron] result:', JSON.stringify(result));
    return isManual ? new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers }) : undefined;
  } catch (err) {
    console.error('[competitor-cron] error:', err);
    return isManual ? new Response(JSON.stringify({ error: err.message }), { status: 500, headers }) : undefined;
  }
};
