// netlify/functions/pnl-cron.js
const { buildKPISnapshot, getAllStores, getStoreLabor, getStoresByDistrict } = require('./analyst-lib/analyst-data');
const { cacheLoad } = require('./analyst-lib/analyst-cache');
const { PNL_SYSTEM, buildPnlPrompt } = require('./analyst-lib/analyst-prompts');
const { generateStructured } = require('./analyst-lib/analyst-claude');
const { saveReport } = require('./analyst-lib/analyst-reports-gen');
const { sendEmail, wrapEmail, loadReportSettings } = require('./analyst-lib/analyst-reports');

exports.handler = async (event) => {
  const isManual = event.httpMethod === 'POST';
  const now = new Date();
  const targetMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthLabel = targetMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

  async function buildMonthlyData(stores) {
    let totalSales = 0, totalLabor = 0, totalHours = 0;
    const storeResults = [];
    const weeklyBuckets = [{}, {}, {}, {}, {}];

    for (const s of stores) {
      try {
        const storeData = await getStoreLabor(s.pc);
        if (!storeData?.daily) continue;
        let sSales = 0, sLabor = 0, sHours = 0;
        for (const day of storeData.daily) {
          const d = new Date(day.date);
          if (d >= targetMonth && d <= monthEnd) {
            sSales += day.sales || 0;
            sLabor += day.laborDollars || 0;
            sHours += day.laborHours || 0;
            const weekIdx = Math.min(4, Math.floor((d.getDate() - 1) / 7));
            if (!weeklyBuckets[weekIdx][s.pc]) weeklyBuckets[weekIdx][s.pc] = { sales: 0, labor: 0 };
            weeklyBuckets[weekIdx][s.pc].sales += day.sales || 0;
            weeklyBuckets[weekIdx][s.pc].labor += day.laborDollars || 0;
          }
        }
        totalSales += sSales;
        totalLabor += sLabor;
        totalHours += sHours;
        storeResults.push({ name: s.name, pc: s.pc, district: s.district, sales: sSales, labor: sLabor, laborPct: sSales > 0 ? (sLabor / sSales * 100) : 0 });
      } catch {}
    }

    const weekSummaries = weeklyBuckets.map((bucket, i) => {
      const wSales = Object.values(bucket).reduce((a, b) => a + b.sales, 0);
      const wLabor = Object.values(bucket).reduce((a, b) => a + b.labor, 0);
      return { week: `Week ${i + 1}`, sales: wSales, labor: wLabor, laborPct: wSales > 0 ? (wLabor / wSales * 100) : 0, margin: wSales - wLabor };
    }).filter(w => w.sales > 0);

    return { totalSales, totalLabor, totalHours, laborPct: totalSales > 0 ? (totalLabor / totalSales * 100) : 0, margin: totalSales - totalLabor, storeResults, weekSummaries };
  }

  const fmtD = n => '$' + (n >= 1000000 ? (n / 1000000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toFixed(0));

  try {
    const allStores = getAllStores();
    const networkData = await buildMonthlyData(allStores);
    const dataSnapshot = `Monthly P&L for ${monthLabel}:
Total Revenue: ${fmtD(networkData.totalSales)}
Total Labor Cost: ${fmtD(networkData.totalLabor)}
Gross Margin: ${fmtD(networkData.margin)}
Labor %: ${networkData.laborPct.toFixed(1)}%
Total Hours: ${networkData.totalHours.toFixed(0)}

Weekly breakdown:
${networkData.weekSummaries.map(w => `${w.week}: Sales ${fmtD(w.sales)}, Labor ${fmtD(w.labor)}, Labor% ${w.laborPct.toFixed(1)}%, Margin ${fmtD(w.margin)}`).join('\n')}

Store rankings by labor %:
Top 5 (lowest): ${networkData.storeResults.sort((a, b) => a.laborPct - b.laborPct).slice(0, 5).map(s => `${s.name} ${s.laborPct.toFixed(1)}%`).join(', ')}
Bottom 5 (highest): ${networkData.storeResults.sort((a, b) => b.laborPct - a.laborPct).slice(0, 5).map(s => `${s.name} ${s.laborPct.toFixed(1)}%`).join(', ')}

District breakdown:
${[1,2,3,4,5,6,7,8].map(d => {
  const distStores = networkData.storeResults.filter(s => s.district === d);
  const dSales = distStores.reduce((a, b) => a + b.sales, 0);
  const dLabor = distStores.reduce((a, b) => a + b.labor, 0);
  return `District ${d}: Sales ${fmtD(dSales)}, Labor ${fmtD(dLabor)}, Labor% ${dSales > 0 ? (dLabor/dSales*100).toFixed(1) : 0}%`;
}).join('\n')}`;

    // Use generateStructured (not askAnalyst) because we need PNL_SYSTEM as the system prompt
    const reportResult = await generateStructured({
      system: PNL_SYSTEM,
      userPrompt: buildPnlPrompt(monthLabel, dataSnapshot),
      action: 'pnl',
      userId: 'system',
    });
    const reportJson = typeof reportResult === 'object' ? (reportResult.answer || reportResult.text || JSON.stringify(reportResult)) : reportResult;
    const parsed = JSON.parse(reportJson.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());

    const reportId = await saveReport({
      type: 'pnl',
      title: `Monthly P&L — ${monthLabel}`,
      scope: 'network',
      createdBy: 'orion',
      trigger: 'scheduled',
      narrative: parsed.narrative || '',
      components: Array.isArray(parsed.components) ? parsed.components.slice(0, 8) : [],
    });

    // Generate per-district P&L artifacts
    for (let d = 1; d <= 8; d++) {
      try {
        const distStores = getStoresByDistrict(d);
        const distData = await buildMonthlyData(distStores);
        if (distData.totalSales === 0) continue;
        const distSnapshot = `District ${d} P&L for ${monthLabel}:\nRevenue: ${fmtD(distData.totalSales)}\nLabor: ${fmtD(distData.totalLabor)}\nMargin: ${fmtD(distData.margin)}\nLabor%: ${distData.laborPct.toFixed(1)}%\n\nWeekly: ${distData.weekSummaries.map(w => `${w.week}: ${fmtD(w.sales)} / ${w.laborPct.toFixed(1)}%`).join(', ')}`;
        const distResult = await generateStructured({
          system: PNL_SYSTEM,
          userPrompt: buildPnlPrompt(`${monthLabel} — District ${d}`, distSnapshot),
          action: 'pnl',
          userId: 'system',
        });
        const distJson = typeof distResult === 'object' ? (distResult.answer || distResult.text || JSON.stringify(distResult)) : distResult;
        const distParsed = JSON.parse(distJson.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        await saveReport({
          type: 'pnl',
          title: `Monthly P&L — District ${d} — ${monthLabel}`,
          scope: `district:${d}`,
          createdBy: 'orion',
          trigger: 'scheduled',
          narrative: distParsed.narrative || '',
          components: Array.isArray(distParsed.components) ? distParsed.components.slice(0, 8) : [],
        });
      } catch (e) { console.warn(`Failed district ${d} P&L:`, e.message); }
    }

    // Email exec P&L
    try {
      const settings = await loadReportSettings();
      const to = settings.execReportCC || ['Mike@PeopleCapitalGroup.com'];
      const pnlHtml = `<h2>Monthly P&L — ${monthLabel}</h2><p>${parsed.narrative || ''}</p><p>Revenue: ${fmtD(networkData.totalSales)} | Labor: ${fmtD(networkData.totalLabor)} | Margin: ${fmtD(networkData.margin)} | Labor%: ${networkData.laborPct.toFixed(1)}%</p>`;
      const html = wrapEmail(`Monthly P&L — ${monthLabel}`, `ORION ANALYST • PEOPLE CAPITAL GROUP`, pnlHtml, null, reportId);
      await sendEmail({ to, subject: `Orion Monthly P&L — ${monthLabel}`, html });
    } catch (e) { console.warn('Failed P&L email:', e.message); }

    return { statusCode: 200, body: JSON.stringify({ ok: true, reportId, month: monthLabel }) };
  } catch (err) {
    console.error('P&L cron error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
