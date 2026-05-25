// Background wrapper for pnl-cron.
// Netlify runs functions ending in -background with a 15-minute timeout.
// Returns 202 immediately; the work happens asynchronously.

const { handler: pnlHandler } = require('./pnl-cron');

exports.handler = async (event) => {
  const fakeEvent = { ...event, httpMethod: 'POST' };
  try {
    await pnlHandler(fakeEvent);
  } catch (err) {
    console.error('[pnl-cron-background] error:', err.message);
  }
};
