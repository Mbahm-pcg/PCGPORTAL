// analyst-cron.js — Scheduled function: anomalies, briefs, cases, AND email reports
// Schedule: runs at multiple times (see netlify.toml)
// DM briefs: 7 AM ET daily (11:00 UTC)
// Exec report: Sunday 10 AM ET (14:00 UTC) + Tuesday 10 AM ET (14:00 UTC)
// Anomaly detection: every run

const { detectAnomalies } = require('./analyst-lib/analyst-anomaly');
const { createCaseFromAnomaly, getCases } = require('./analyst-lib/analyst-cases');
const { buildDataContext } = require('./analyst-lib/analyst-data');
const { generateStructured } = require('./analyst-lib/analyst-claude');
const { PERSONA, buildBriefPrompt } = require('./analyst-lib/analyst-prompts');
const { cacheSave, cacheLoad } = require('./analyst-lib/analyst-cache');
const { logAudit } = require('./analyst-lib/analyst-audit');
const { sendDMBriefs, sendExecReport, loadReportSettings } = require('./analyst-lib/analyst-reports');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const isManual = event.httpMethod === 'POST';
  const startedAt = new Date().toISOString();
  const today = startedAt.slice(0, 10);
  console.log('[analyst-cron] triggered at', startedAt, isManual ? '(manual)' : '(scheduled)');

  try {
    // ── Step 1: Detect anomalies across all stores ──────────────────────
    console.log('[analyst-cron] Running anomaly detection...');
    const anomalies = await detectAnomalies();
    console.log(`[analyst-cron] Found ${anomalies.length} anomalies`);

    // ── Step 2: Create Business Cases from high/medium severity anomalies ──
    let casesCreated = 0;
    const CAP = 16; // raised from 10 to guarantee coverage across all 8 districts
    const existingCases = await getCases({ limit: 50 });
    const existingKeys = new Set(existingCases.map(c => `${c.anomalyType}_${c.storeName}_${c.createdAt?.slice(0, 10)}`));

    // Filter to actionable candidates not already covered today
    const severityRank = { high: 0, medium: 1, low: 2 };
    const candidates = anomalies
      .filter(a => {
        const key = `${a.type}_${a.storeName}_${today}`;
        return !existingKeys.has(key) && (a.severity === 'high' || a.severity === 'medium');
      })
      .sort((a, b) => (severityRank[a.severity] ?? 2) - (severityRank[b.severity] ?? 2));

    // Pass 1: guarantee one case per district using each district's highest-severity anomaly
    const districtsSeen = new Set();
    const pass1 = [];
    for (const anomaly of candidates) {
      const d = Number(anomaly.district);
      if (!isNaN(d) && !districtsSeen.has(d)) {
        districtsSeen.add(d);
        pass1.push(anomaly);
      }
    }

    // Pass 2: fill remaining cap slots from all remaining candidates by severity
    const pass1Keys = new Set(pass1.map(a => `${a.type}_${a.storeName}`));
    const pass2 = candidates.filter(a => !pass1Keys.has(`${a.type}_${a.storeName}`));

    for (const anomaly of [...pass1, ...pass2]) {
      if (casesCreated >= CAP) break;
      try {
        const dataContext = await buildDataContext({ district: anomaly.district });
        const created = await createCaseFromAnomaly(anomaly, dataContext);
        if (created) {
          casesCreated++;
          console.log(`[analyst-cron] Created case: ${created.title}`);
        }
      } catch (err) {
        console.warn(`[analyst-cron] Failed to create case for ${anomaly.storeName}:`, err.message);
      }
    }

    // ── Step 3: Generate Today's Brief (exec + per-district for DMs) ────
    // Only generate briefs on the morning run or manual trigger
    const hour = new Date().getUTCHours();
    const isMorningRun = hour >= 9 && hour <= 12; // 5-8 AM ET
    let briefsGenerated = 0;

    if (isMorningRun || isManual) {
      // Executive brief (network-wide)
      try {
        const execData = await buildDataContext({ includeStoreDetail: true });
        const execPrompt = buildBriefPrompt('VP / Executive', today, execData);
        const execResult = await generateStructured({
          system: PERSONA,
          userPrompt: execPrompt,
          action: 'brief',
          userId: 'system',
        });
        const execBrief = {
          date: today,
          scope: 'Network',
          role: 'VP / Executive',
          content: execResult.text,
          generatedAt: new Date().toISOString(),
          model: execResult.model,
        };
        await cacheSave(`analyst/briefs/${today}_network`, execBrief);
        briefsGenerated++;
        console.log('[analyst-cron] Generated exec brief');
      } catch (err) {
        console.warn('[analyst-cron] Failed to generate exec brief:', err.message);
      }

      // Per-district briefs (for DMs)
      for (let d = 1; d <= 8; d++) {
        try {
          const distData = await buildDataContext({ district: d });
          // Skip districts with no data
          if (distData.includes('No labor data')) continue;

          const distPrompt = buildBriefPrompt('District Manager', today, distData);
          const distResult = await generateStructured({
            system: PERSONA,
            userPrompt: distPrompt,
            action: 'brief',
            userId: 'system',
          });
          const distBrief = {
            date: today,
            scope: `District ${d}`,
            role: 'District Manager',
            content: distResult.text,
            generatedAt: new Date().toISOString(),
            model: distResult.model,
          };
          await cacheSave(`analyst/briefs/${today}_${d}`, distBrief);
          briefsGenerated++;
        } catch (err) {
          console.warn(`[analyst-cron] Failed to generate D${d} brief:`, err.message);
        }
      }
      console.log(`[analyst-cron] Generated ${briefsGenerated} briefs`);
    }

    // ── Step 4: Email reports (time-gated) ────────────────────────────
    let dmBriefsSent = 0;
    let execReportSent = false;
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hourET = nowET.getHours();
    const dayET = nowET.getDay(); // 0=Sun, 2=Tue

    const reportSettings = await loadReportSettings();

    // DM daily briefs — send at 7 AM ET (cron fires at 11 UTC)
    if ((hourET >= 6 && hourET <= 8) || isManual) {
      if (reportSettings.dmBriefEnabled !== false) {
        try {
          // Load users from blob to get DM emails
          const usersBlob = await cacheLoad('pcg_portal_users');
          dmBriefsSent = await sendDMBriefs(reportSettings, Array.isArray(usersBlob) ? usersBlob : []);
          console.log(`[analyst-cron] Sent ${dmBriefsSent} DM briefs`);
        } catch (err) {
          console.warn('[analyst-cron] DM briefs failed:', err.message);
        }
      }
    }

    // Exec weekly report — Sunday 10 AM ET (preliminary) + Tuesday 10 AM ET (post-adjustment)
    if (((dayET === 0 || dayET === 2) && hourET >= 9 && hourET <= 11) || isManual) {
      if (reportSettings.execReportEnabled !== false) {
        try {
          const isLaborAdjusted = dayET === 2; // Tuesday = post-adjustment
          execReportSent = await sendExecReport(reportSettings, isLaborAdjusted);
          console.log(`[analyst-cron] Sent exec report (${isLaborAdjusted ? 'post-adjustment' : 'preliminary'})`);
        } catch (err) {
          console.warn('[analyst-cron] Exec report failed:', err.message);
        }
      }
    }

    // ── Step 5: Log run summary ─────────────────────────────────────────
    const summary = {
      ok: true,
      completedAt: new Date().toISOString(),
      anomaliesDetected: anomalies.length,
      casesCreated,
      briefsGenerated,
      dmBriefsSent,
      execReportSent,
      isManual,
    };

    await logAudit({
      type: 'cron_run',
      ...summary,
    });

    console.log('[analyst-cron] complete:', JSON.stringify(summary));

    return isManual
      ? { statusCode: 200, headers, body: JSON.stringify(summary) }
      : undefined;

  } catch (err) {
    console.error('[analyst-cron] fatal error:', err);
    await logAudit({ type: 'cron_error', error: err.message }).catch(() => {});
    return isManual
      ? { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
      : undefined;
  }
};
