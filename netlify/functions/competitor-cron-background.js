// Background wrapper for competitor-cron (roadmap 10.5). Netlify runs functions
// ending in -background with a 15-minute timeout, so the heavy work — up to 45
// sequential Google Places calls plus a Claude web-search promo call before the
// final email — can't hit the 26s sync limit and drop the weekly email.
// This is the SCHEDULED entry (see netlify.toml) and also handles manual POSTs.
const { handler: competitorHandler } = require('./competitor-cron');

exports.handler = async (event) => {
  const fakeEvent = { ...event, httpMethod: 'POST' };
  try {
    await competitorHandler(fakeEvent);
  } catch (err) {
    console.error('[competitor-cron-background] error:', err.message);
  }
};
