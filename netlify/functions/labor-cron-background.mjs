// Background wrapper for labor-cron (15-min timeout). Returns 202 immediately.
// Sends the scheduled signal so labor-cron runs the full network aggregation
// (skipSchedules=false) — matching the legacy faked 'SCHEDULE' event.
import laborCron from './labor-cron.mjs';

export const config = { background: true };

export default async (request, context) => {
  try {
    await laborCron(
      new Request('https://pcg.internal/labor-cron-bg', {
        method: 'POST',
        headers: { 'x-pcg-invocation': 'scheduled' },
      }),
      context,
    );
  } catch (err) {
    console.error('[labor-cron-background] error:', err.message);
  }
};
