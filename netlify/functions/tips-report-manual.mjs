// tips-report-manual.mjs — On-demand Tips report trigger, for catch-up runs
// when the nightly cron missed a day, or to regenerate a past date. Background
// function (15-min timeout, fire-and-forget) but NOT scheduled, so unlike
// tips-report-cron-background.mjs it can be manually POSTed (scheduled
// functions 403 on manual invocation — see CLAUDE.md gotcha on this).
// POST body: { "busDt": "YYYY-MM-DD" } (optional — defaults to yesterday-ET).
import { runTipsReport, etDate } from './tips-lib.mjs';

export const config = { background: true };

export default async (request) => {
  let busDt = etDate(1);
  try {
    const body = await request.json();
    if (body?.busDt) busDt = body.busDt;
  } catch {}
  const summary = await runTipsReport(busDt);
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
