// Background function for on-demand report sending. Returns 202 immediately;
// generates and sends the report asynchronously. Supports: exec (weekly), daily, dm.
import { sendExecReport, sendExecDailyReport, sendDMBriefs, loadReportSettings } from './analyst-lib/analyst-reports.mjs';
import { cacheLoad, cacheSave } from './analyst-lib/analyst-cache.mjs';
import { refreshStoreList } from './_shared/store-status.mjs';
import { STORES as __STORE_LIST, ALL_STORES as __STORE_ALL } from './analyst-lib/analyst-data.mjs';

export const config = { background: true };

export default async (request) => {
  // v22.0: skip permanently closed stores (Locations status) for this run.
  await refreshStoreList(__STORE_LIST, __STORE_ALL, { graceDays: 0 });
  let payload = {};
  try { payload = await request.json(); } catch {}

  const { reportType, laborAdjusted } = payload;
  const settings = await loadReportSettings();

  console.log(`[analyst-report-background] Sending ${reportType} report...`);

  try {
    if (reportType === 'exec') {
      const sent = await sendExecReport(settings, laborAdjusted || false);
      console.log(`[analyst-report-background] Exec report sent: ${sent}`);
      // Save status for the UI to poll
      await cacheSave('analyst/report-last-send', { type: 'exec', sent, at: new Date().toISOString(), laborAdjusted });
    } else if (reportType === 'daily') {
      const sent = await sendExecDailyReport(settings);
      console.log(`[analyst-report-background] Daily report sent: ${sent}`);
      await cacheSave('analyst/report-last-send', { type: 'daily', sent, at: new Date().toISOString() });
    } else if (reportType === 'dm') {
      const usersBlob = await cacheLoad('pcg_portal_users');
      const sent = await sendDMBriefs(settings, Array.isArray(usersBlob) ? usersBlob : []);
      console.log(`[analyst-report-background] DM briefs sent: ${sent}`);
      await cacheSave('analyst/report-last-send', { type: 'dm', sent, at: new Date().toISOString() });
    }
  } catch (err) {
    console.error(`[analyst-report-background] Error:`, err.message);
    await cacheSave('analyst/report-last-send', { type: reportType, error: err.message, at: new Date().toISOString() });
  }
};
