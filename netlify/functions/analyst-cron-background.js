// Background wrapper for analyst-cron.
// Netlify runs functions ending in -background with a 15-minute timeout.
// Returns 202 immediately; the work happens asynchronously.

const { handler: cronHandler } = require('./analyst-cron');

exports.handler = async (event) => {
  const fakeEvent = { ...event, httpMethod: 'POST' };
  try {
    await cronHandler(fakeEvent);
  } catch (err) {
    console.error('[analyst-cron-background] error:', err.message);
  }
};
