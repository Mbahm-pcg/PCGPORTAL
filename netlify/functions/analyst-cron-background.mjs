// Background wrapper for analyst-cron (15-min timeout). Returns 202 immediately.
// Plain POST (no scheduled signal) → analyst-cron runs in manual mode, matching the
// legacy faked 'POST' event (briefs generated regardless of hour).
import analystCron from './analyst-cron.mjs';

export const config = { background: true };

export default async (request, context) => {
  try {
    await analystCron(
      new Request('https://pcg.internal/analyst-cron-bg', { method: 'POST' }),
      context,
    );
  } catch (err) {
    console.error('[analyst-cron-background] error:', err.message);
  }
};
