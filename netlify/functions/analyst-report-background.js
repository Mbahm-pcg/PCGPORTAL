// Background function for on-demand report sending.
// Returns 202 immediately; generates and sends the report asynchronously.
// Supports: exec (weekly), daily, dm

const { sendExecReport, sendExecDailyReport, sendDMBriefs, loadReportSettings } = require('./analyst-lib/analyst-reports');
const { cacheLoad, cacheSave } = require('./analyst-lib/analyst-cache');

exports.handler = async (event) => {
  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch {}

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
