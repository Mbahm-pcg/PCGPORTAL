// PCG Portal — Scheduled cron entry for Pulse notifications (daily 9 PM ET / 2 AM UTC).
// Invokes the pulse-notify handler in SCHEDULED mode via the x-pcg-invocation header,
// so pulse-notify honors its dedup + disabled-config checks (isManual=false).
import pulseNotify from './pulse-notify.mjs';

export const config = { schedule: '0 2 * * *' };

export default async (request, context) => {
  console.log('Pulse cron triggered at', new Date().toISOString());
  return pulseNotify(
    new Request('https://pcg.internal/pulse-notify', {
      method: 'POST',
      headers: { 'x-pcg-invocation': 'scheduled' },
    }),
    context,
  );
};
