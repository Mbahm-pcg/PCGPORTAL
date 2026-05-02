// Background wrapper for labor-cron.
// Netlify runs functions ending in -background with a 15-minute timeout.
// Returns 202 immediately; the work happens asynchronously.

const { handler: cronHandler } = require('./labor-cron');

exports.handler = async (event) => {
  // Run the full cron (including schedules since we have 15 min)
  // Fake the event as a scheduled trigger so skipSchedules = false
  const fakeEvent = { ...event, httpMethod: 'SCHEDULE' };
  try {
    await cronHandler(fakeEvent);
  } catch (err) {
    console.error('[labor-cron-background] error:', err.message);
  }
};
