// Background wrapper for reviews-cron.
// Netlify runs functions ending in -background with a 15-minute timeout.
// Returns 202 immediately; the work happens asynchronously.

const { handler: reviewsHandler } = require('./reviews-cron');

exports.handler = async (event) => {
  const fakeEvent = { ...event, httpMethod: 'POST' };
  try {
    await reviewsHandler(fakeEvent);
  } catch (err) {
    console.error('[reviews-cron-background] error:', err.message);
  }
};
