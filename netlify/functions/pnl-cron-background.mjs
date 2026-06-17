// Background wrapper for pnl-cron (15-min timeout). Returns 202 immediately.
// Plain POST → matches the legacy faked 'POST' event.
import pnlCron from './pnl-cron.mjs';

export const config = { background: true };

export default async (request, context) => {
  try {
    await pnlCron(new Request('https://pcg.internal/pnl-cron-bg', { method: 'POST' }), context);
  } catch (err) {
    console.error('[pnl-cron-background] error:', err.message);
  }
};
