// Scheduled + background entry for analyst-cron (15-minute budget).
//
// The schedule lives HERE, not on analyst-cron.mjs (v22.18, 2026-10-25). As a
// synchronous scheduled function the analyst run was cut off by Netlify's scheduler at
// ~15 s on every invocation 10/19-10/25 (HTTP 499 at 14.98 s in the function logs) and
// then retried up to three times per slot. Each retry ran in parallel with the copies
// the scheduler had already given up on, filed its own cases, and none of them ever
// reached the completion write — which is why System Health showed Orion Analyst DOWN
// and the home page kept 7 AM / 10 AM alerts all day.
//
// Same pattern as competitor-cron-background.mjs / tips-report-cron-background.mjs.
// Forwards the scheduler's request with the explicit scheduled marker so the foreground
// handler keeps its time gates (briefs only on the morning run, exec report Sun/Tue).
// Netlify blocks external POST to a scheduled function, so a manual run is
// POST /.netlify/functions/analyst-cron (manual mode, 26 s cap — smoke tests only).
import analystCron from './analyst-cron.mjs';

export const config = { schedule: '0 11,14 * * *' };

export default async (request, context) => {
  let bodyText = '';
  try { bodyText = await request.text(); } catch { bodyText = ''; }
  const headers = new Headers(request.headers);
  headers.set('x-pcg-invocation', 'scheduled');
  headers.set('content-type', 'application/json');
  const forwarded = new Request('https://pcg.internal/analyst-cron-bg', {
    method: 'POST',
    headers,
    body: bodyText || JSON.stringify({ next_run: null, forwardedBy: 'analyst-cron-background' }),
  });
  try {
    await analystCron(forwarded, context);
  } catch (err) {
    console.error('[analyst-cron-background] error:', err.message);
  }
};
