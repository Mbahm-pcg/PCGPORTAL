// Manual trigger for tips-reconcile-cron.mjs's check — that function declares
// config.schedule, and Netlify's edge blocks ALL direct external POSTs to any
// scheduled function (same issue already solved for every other cron in this
// codebase) — this unscheduled sibling exists purely to make it reachable on
// demand, with a configurable deeper lookback for a real trace-back instead
// of the daily cron's short 3-day window.
// POST body: { daysBack?: number (default 14), storePc?: string }
export const config = { background: true };

import { runReconcile } from './tips-reconcile-cron.mjs';

export default async (request) => {
  const body = await request.json().catch(() => ({}));
  const daysBack = Number.isFinite(body?.daysBack) ? body.daysBack : 14;
  const storePc = body?.storePc || null;
  try {
    const summary = await runReconcile(daysBack, storePc);
    console.log('[tips-reconcile-refresh] done:', JSON.stringify({ ...summary, details: undefined }));
  } catch (err) {
    console.error('[tips-reconcile-refresh] error:', err.message);
  }
};
