// analyst-cron.js — Scheduled function: anomalies, briefs, cases, AND email reports
// Schedule: runs at multiple times (see netlify.toml)
// DM briefs: 7 AM ET daily (11:00 UTC)
// Exec report: Sunday 10 AM ET (14:00 UTC) + Tuesday 10 AM ET (14:00 UTC)
// Anomaly detection: every run

const { detectAnomalies } = require('./analyst-lib/analyst-anomaly');
const { createCaseFromAnomaly, getCases } = require('./analyst-lib/analyst-cases');
const { buildDataContext, buildKPISnapshot, buildWeatherContext, buildSentimentContext, buildEmailContext } = require('./analyst-lib/analyst-data');
const { generateStructured } = require('./analyst-lib/analyst-claude');
const { PERSONA, buildBriefPrompt, REPORT_SYSTEM, buildReportPrompt } = require('./analyst-lib/analyst-prompts');
const { cacheSave, cacheLoad } = require('./analyst-lib/analyst-cache');
const { logAudit } = require('./analyst-lib/analyst-audit');
const { sendDMBriefs, sendExecReport, loadReportSettings } = require('./analyst-lib/analyst-reports');
const { saveReport } = require('./analyst-lib/analyst-reports-gen');

async function generateLeaderboardShoutout(today) {
  const laborData = await cacheLoad('pcg_labor_v1');
  if (!laborData?.stores) return null;

  const stores = Object.entries(laborData.stores)
    .filter(([, s]) => !s.error && s.wtd?.sales > 500)
    .map(([pc, s]) => ({
      pc,
      name: s.name,
      district: s.district,
      wtdSales: s.wtd.sales,
      wtdLaborPct: s.wtd.laborPct,
    }));

  if (stores.length < 3) return null;

  const bySales = [...stores]
    .sort((a, b) => b.wtdSales - a.wtdSales)
    .slice(0, 3);

  const byLabor = [...stores]
    .filter(s => s.wtdLaborPct > 5 && s.wtdLaborPct < 50)
    .sort((a, b) => a.wtdLaborPct - b.wtdLaborPct)
    .slice(0, 3);

  // Most improved WoW — compare current WTD to prior week for top 10 stores by sales
  const topPcs = [...stores]
    .sort((a, b) => b.wtdSales - a.wtdSales)
    .slice(0, 10)
    .map(s => s.pc);

  const improvements = (await Promise.all(
    topPcs.map(async (pc) => {
      const storeBlob = await cacheLoad(`pcg_labor_store_${pc}`);
      const weekly = storeBlob?.weekly;
      if (!Array.isArray(weekly) || weekly.length < 2) return null;
      const sorted = [...weekly].sort((a, b) => (b.weekOf || '').localeCompare(a.weekOf || ''));
      const [thisWeek, lastWeek] = sorted;
      if (!thisWeek?.sales || !lastWeek?.sales || lastWeek.sales === 0) return null;
      const pct = ((thisWeek.sales - lastWeek.sales) / lastWeek.sales) * 100;
      const store = stores.find(s => s.pc === pc);
      return store ? { ...store, improvement: pct } : null;
    })
  )).filter(Boolean).sort((a, b) => b.improvement - a.improvement);

  const mostImproved = improvements[0];

  const lines = [
    `Week of ${today}`,
    '',
    'Top stores by WTD net sales:',
    ...bySales.map((s, i) => `${i + 1}. ${s.name} — $${Math.round(s.wtdSales).toLocaleString()}`),
    '',
    'Lowest labor %:',
    ...byLabor.map((s, i) => `${i + 1}. ${s.name} — ${s.wtdLaborPct.toFixed(1)}%`),
  ];
  if (mostImproved && mostImproved.improvement > 0) {
    lines.push('', `Most improved WoW: ${mostImproved.name} — +${mostImproved.improvement.toFixed(1)}% sales vs last week`);
  }

  const result = await generateStructured({
    system: PERSONA,
    userPrompt: `Write a short, energetic weekly leaderboard shout-out for district managers and executives. Celebrate the top-performing stores. Keep it under 150 words, upbeat and motivating. Reference stores by name. No emojis. Sign off as "— Orion"\n\n${lines.join('\n')}`,
    action: 'leaderboard',
    userId: 'system',
  });

  return result.text;
}

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
        const weatherCtx = await buildWeatherContext();
        const sentimentCtx = await buildSentimentContext();
        const emailCtx = await buildEmailContext();
        const execPrompt = buildBriefPrompt('VP / Executive', today, execData, weatherCtx + sentimentCtx + emailCtx);
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
          if (distData.includes('No labor data')) continue;

          const distWeatherCtx = await buildWeatherContext({ district: d });
          const distSentimentCtx = await buildSentimentContext({ district: d });
          const distPrompt = buildBriefPrompt('District Manager', today, distData, distWeatherCtx + distSentimentCtx);
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

      // Save exec brief as report artifact (network dashboard)
      try {
        const execData = await buildKPISnapshot();
        const dataSnapshot = `${await buildDataContext()}\n\nKPI Summary:\n${JSON.stringify(execData, null, 2)}`;
        const reportResult = await generateStructured({
          system: REPORT_SYSTEM,
          userPrompt: buildReportPrompt('Generate a weekly executive dashboard with sales, labor, and anomaly overview.', dataSnapshot),
          action: 'brief',
          userId: 'system',
        });
        const reportJson = typeof reportResult === 'object' ? (reportResult.answer || reportResult.text || JSON.stringify(reportResult)) : reportResult;
        const parsed = JSON.parse(reportJson.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        await saveReport({
          type: 'dashboard',
          title: `Weekly Exec Dashboard — ${today}`,
          scope: 'network',
          createdBy: 'orion',
          trigger: 'scheduled',
          narrative: parsed.narrative || '',
          components: Array.isArray(parsed.components) ? parsed.components.slice(0, 8) : [],
        });
        console.log('[analyst-cron] Saved exec dashboard artifact');
      } catch (e) { console.warn('[analyst-cron] Failed to save exec dashboard artifact:', e.message); }

      // Save DM briefs as report artifacts
      for (let d = 1; d <= 8; d++) {
        try {
          const briefData = await cacheLoad(`analyst/briefs/${today}_${d}`);
          if (briefData?.content) {
            await saveReport({
              type: 'brief',
              title: `DM Brief — District ${d} — ${today}`,
              scope: `district:${d}`,
              createdBy: 'orion',
              trigger: 'scheduled',
              narrative: briefData.content,
              components: [],
            });
          }
        } catch (e) { console.warn(`[analyst-cron] Failed to save D${d} brief artifact:`, e.message); }
      }
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

    // ── Step 5: Weekly leaderboard shout-out (Sunday morning only) ────────
    let leaderboardPosted = false;
    if (dayET === 0 && (isMorningRun || isManual)) {
      try {
        const existing = await cacheLoad('pcg_announcements_v1') || [];
        const alreadyPosted = Array.isArray(existing) &&
          existing.some(a => a.title?.includes('Weekly Leaderboard') && a.createdAt?.startsWith(today));

        if (!alreadyPosted) {
          const shoutout = await generateLeaderboardShoutout(today);
          if (shoutout) {
            const ann = {
              id: `ann_${Date.now()}_ldr`,
              title: `Weekly Leaderboard — Week of ${today}`,
              message: shoutout,
              createdAt: new Date().toISOString(),
              createdBy: 'Orion',
              active: true,
              type: 'leaderboard',
              targets: { roles: ['executive', 'dm'] },
            };
            await cacheSave('pcg_announcements_v1', [ann, ...(Array.isArray(existing) ? existing : [])]);
            leaderboardPosted = true;
            console.log('[analyst-cron] Posted weekly leaderboard shout-out');
          }
        } else {
          console.log('[analyst-cron] Leaderboard already posted today, skipping');
        }
      } catch (err) {
        console.warn('[analyst-cron] Leaderboard shout-out failed:', err.message);
      }
    }

    // ── Step 6: Log run summary ─────────────────────────────────────────
    const summary = {
      ok: true,
      completedAt: new Date().toISOString(),
      anomaliesDetected: anomalies.length,
      casesCreated,
      briefsGenerated,
      dmBriefsSent,
      execReportSent,
      leaderboardPosted,
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
