// Scheduled + background entry for pulse-hourly-snapshot (15-minute budget).
//
// The nightly snapshot takes ~30 s for 45 stores (hourly guest checks + item mix +
// menu dimension maps). As a synchronous scheduled function it was cut off by the
// scheduler at ~15 s every night (HTTP 499 at 14.97 s, 10/19-10/25) and retried three
// times, so the same day's snapshot was fetched from Pulse and written three times
// (idempotent by date, so the data was right — the load and the alert noise were not).
// The schedule lives here; pulse-hourly-snapshot.mjs keeps the logic and its exports.
import snapshot from './pulse-hourly-snapshot.mjs';

export const config = { schedule: '30 2 * * *' };

export default async (request, context) => {
  try {
    await snapshot(request, context);
  } catch (err) {
    console.error('[pulse-hourly-snapshot-background] error:', err.message);
  }
};
