// Background wrapper for reviews-cron (15-min timeout). Returns 202 immediately.
// Plain POST → matches the legacy faked 'POST' event.
import reviewsCron from './reviews-cron.mjs';

export const config = { background: true };

export default async (request, context) => {
  try {
    await reviewsCron(new Request('https://pcg.internal/reviews-cron-bg', { method: 'POST' }), context);
  } catch (err) {
    console.error('[reviews-cron-background] error:', err.message);
  }
};
