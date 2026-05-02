// analyst-cron.js — Scheduled function: refresh KPI cache, detect anomalies, generate briefs + cases
// Schedule: "0 10 * * *" (5:30 AM ET = 10:30 UTC, but using 10:00 UTC / 6:00 AM ET)
// Also runs every 4 hours for anomaly detection via labor-cron piggyback.

const { detectAnomalies } = require('./analyst-lib/analyst-anomaly');
const { createCaseFromAnomaly, getCases } = require('./analyst-lib/analyst-cases');
const { buildDataContext } = require('./analyst-lib/analyst-data');
const { generateStructured } = require('./analyst-lib/analyst-claude');
const { PERSONA, buildBriefPrompt } = require('./analyst-lib/analyst-prompts');
const { cacheSave, cacheLoad } = require('./analyst-lib/analyst-cache');
const { logAudit } = require('./analyst-lib/analyst-audit');

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
    const existingCases = await getCases({ limit: 50 });
    const existingKeys = new Set(existingCases.map(c => `${c.anomalyType}_${c.storeName}_${c.createdAt?.slice(0, 10)}`));

    for (const anomaly of anomalies) {
      // Skip if we already have an open case for this anomaly today
      const key = `${anomaly.type}_${anomaly.storeName}_${today}`;
      if (existingKeys.has(key)) continue;

      // Only create cases for high severity, or medium if < 5 cases today
      if (anomaly.severity === 'high' || (anomaly.severity === 'medium' && casesCreated < 5)) {
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

      // Cap at 10 new cases per run to control LLM costs
      if (casesCreated >= 10) break;
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

    // ── Step 4: Log run summary ─────────────────────────────────────────
    const summary = {
      ok: true,
      completedAt: new Date().toISOString(),
      anomaliesDetected: anomalies.length,
      casesCreated,
      briefsGenerated,
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
