// tips-report-cron-background.mjs — Nightly network-wide Tips report. Runs
// 12am ET, right after the prior business day fully closes. Scheduled as the
// -background variant (15-min timeout) — 46 stores x Pulse + Paycor calls
// routinely exceeds the 26s sync limit; a first run without this suffix got
// cut off mid-way with no email sent. See tips-lib.mjs for the actual report
// logic (shared with tips-report-manual.mjs, the on-demand catch-up trigger).
import { runTipsReport, etDate } from './tips-lib.mjs';

export const config = { schedule: '0 4 * * *' };

export default async () => {
  const summary = await runTipsReport(etDate(1));
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
