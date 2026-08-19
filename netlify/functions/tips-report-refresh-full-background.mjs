// Manual trigger for tips-report-cron-background.mjs's FULL run (daily +
// weekly/biweekly rollups when busDt lands on a boundary) — that function
// declares config.schedule, and Netlify's edge blocks ALL direct external
// POSTs to any scheduled function (same issue solved for every other cron in
// this codebase) — confirmed directly (2026-08-19) that curl'ing it returns a
// real 403, not the 200 the netlify.toml comment claimed; every prior
// "manual trigger" this session was silently blocked, and the one report
// that actually sent was the function's own natural scheduled run.
//
// Invokes the existing default handler in-process (constructing a Request
// object and calling it directly) instead of duplicating its logic — no HTTP
// hop, so the edge block never comes into play.
export const config = { background: true };

import handler from './tips-report-cron-background.mjs';

export default async (request) => {
  const body = await request.json().catch(() => ({}));
  try {
    const fakeReq = new Request('https://internal.local/tips-report-cron-background', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const res = await handler(fakeReq);
    const result = await res.json().catch(() => null);
    console.log('[tips-report-refresh-full] done:', JSON.stringify(result));
  } catch (err) {
    console.error('[tips-report-refresh-full] error:', err.message);
  }
};
