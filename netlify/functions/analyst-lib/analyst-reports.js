// analyst-reports.js — Scheduled email reports (DM daily brief, exec weekly report)
const https = require('https');
const { buildDataContext, buildKPISnapshot, STORES, getStoresByDistrict } = require('./analyst-data');
const { generateStructured } = require('./analyst-claude');
const { PERSONA } = require('./analyst-prompts');
const { cacheSave, cacheLoad } = require('./analyst-cache');
const { logAudit } = require('./analyst-audit');

// ── Pulse POS direct fetcher (same API as pulse.js / labor-cron.js) ──────────
const POS_APIS = {
  p227: { host: 'pos-ra.dunkindonuts.com', path: '/p227', xkey: 'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL', apikey: 'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=' },
  p228: { host: 'pos-ra.dunkindonuts.com', path: '/p228', xkey: 'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP', apikey: 'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=' },
};
function posRoute(pc) { return pc === '345986' ? 'p227' : 'p228'; }

function fetchPOSSales(pc, busDt) {
  const cfg = POS_APIS[posRoute(pc)];
  const body = JSON.stringify({ locRef: pc, busDt, include: 'locRef,busDt,revenueCenters' });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: cfg.host, port: 443, path: `${cfg.path}/getOperationsDailyTotals`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.xkey, 'Api-Key': cfg.apikey, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const netSales = (json.revenueCenters || []).reduce((sum, r) => sum + (r.netSlsTtl || 0), 0);
          resolve(netSales);
        } catch { resolve(0); }
      });
    });
    req.on('error', () => resolve(0));
    req.setTimeout(20000, () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// ── Paycor labor fetcher (uses same OAuth as labor-cron) ─────────────────────
const PAYCOR_HOST = 'apis.paycor.com';
let paycorTokenCache = { accessToken: null, refreshToken: process.env.PAYCOR_REFRESH_TOKEN || null, expiresAt: 0 };
let paycorRefreshPromise = null;

async function getPaycorToken() {
  if (paycorTokenCache.accessToken && Date.now() < paycorTokenCache.expiresAt - 60000) return paycorTokenCache.accessToken;
  if (paycorRefreshPromise) return paycorRefreshPromise;
  paycorRefreshPromise = (async () => {
    if (!paycorTokenCache.refreshToken) throw new Error('No Paycor refresh token');
    const formBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(paycorTokenCache.refreshToken)}&client_id=${encodeURIComponent(process.env.PAYCOR_CLIENT_ID)}&client_secret=${encodeURIComponent(process.env.PAYCOR_CLIENT_SECRET)}`;
    const tokenPath = `/sts/v1/common/token?subscription-key=${process.env.PAYCOR_SUBSCRIPTION_KEY}`;
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: PAYCOR_HOST, port: 443, path: tokenPath, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(formBody) } }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data.access_token) {
              paycorTokenCache = { accessToken: data.access_token, refreshToken: data.refresh_token || paycorTokenCache.refreshToken, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
              resolve(data.access_token);
            } else reject(new Error('Token refresh failed'));
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(formBody);
      req.end();
    });
  })();
  try { return await paycorRefreshPromise; } finally { paycorRefreshPromise = null; }
}

function fetchPaycorPunches(legalEntityId, startDate, endDate) {
  return new Promise(async (resolve) => {
    try {
      const token = await getPaycorToken();
      const path = `/v1/legalentities/${legalEntityId}/punches?startDate=${startDate}&endDate=${endDate}`;
      const req = https.request({ hostname: PAYCOR_HOST, port: 443, path, method: 'GET', headers: { 'Authorization': `Bearer ${token}`, 'Ocp-Apim-Subscription-Key': process.env.PAYCOR_SUBSCRIPTION_KEY, 'Content-Type': 'application/json' } }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            const records = data.records || data || [];
            const totalHours = Array.isArray(records) ? records.reduce((sum, r) => sum + (r.hourAmount || 0), 0) : 0;
            resolve(totalHours);
          } catch { resolve(0); }
        });
      });
      req.on('error', () => resolve(0));
      req.setTimeout(25000, () => { req.destroy(); resolve(0); });
      req.end();
    } catch { resolve(0); }
  });
}

// ── Fetch last week's data from live APIs when blobs are empty ────────────────
async function fetchLastWeekLive(weekDates) {
  console.log(`[analyst-reports] Fetching last week live data for ${weekDates.length} days...`);
  const storeData = [];

  // Process in batches of 5 stores to avoid rate limits
  for (let i = 0; i < STORES.length; i += 5) {
    const batch = STORES.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (store) => {
      // Fetch sales for each day of the week from Pulse POS
      let weekSales = 0;
      for (const dt of weekDates) {
        const daySales = await fetchPOSSales(store.pc, dt);
        weekSales += daySales;
      }

      // Fetch labor hours from Paycor for the week range
      let weekHours = 0;
      try {
        weekHours = await fetchPaycorPunches(store.paycor, weekDates[0], weekDates[weekDates.length - 1]);
      } catch {}

      // Estimate labor cost using cached pay rates or avg rate
      const payRates = await cacheLoad(`pcg_payrates_${store.paycor}`);
      let avgRate = 13; // fallback
      if (payRates?.rates) {
        const rates = Object.values(payRates.rates).filter(r => r.payType !== 'Salary' && r.payRate > 0);
        if (rates.length > 0) avgRate = rates.reduce((s, r) => s + r.payRate, 0) / rates.length;
      }
      const weekLabor = weekHours * avgRate;

      return { name: store.name, district: store.district, weekSales, weekLabor, weekLaborPct: weekSales > 0 ? (weekLabor / weekSales) * 100 : 0 };
    }));
    storeData.push(...results);

    // Pause between batches
    if (i + 5 < STORES.length) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[analyst-reports] Fetched live data for ${storeData.length} stores`);
  return storeData;
}

// ── DM district mapping (fallback if user data not available) ────────────────
const DM_INFO = {
  1: { name: 'Taylor Cormier', email: 'taylor@peoplecapitalgroup.com' },
  2: { name: 'Jay Patel', email: 'jay@peoplecapitalgroup.com' },
  3: { name: 'Sonia Khalique', email: 'sonia@peoplecapitalgroup.com' },
  4: { name: 'Yolicet Grin-Martinez', email: 'yolicet@peoplecapitalgroup.com' },
  5: { name: 'Shreyes Mehta', email: 'sunny@peoplecapitalgroup.com' },
  6: { name: 'Mohamed', email: 'Mohamed@peoplecapitalgroup.com' },
  7: { name: 'Sharmin Akter', email: 'sharmin@peoplecapitalgroup.com' },
  8: { name: 'Mike (District 8)', email: null },
};

// ── Email sender ─────────────────────────────────────────────────────────────
function sendEmail({ to, cc, subject, html }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) { console.warn('RESEND_API_KEY not set, skipping email'); return Promise.resolve(); }
  const FROM = process.env.NOTIFY_FROM || 'Orion — PCG Analyst <noreply@pcgops.com>';

  const payload = {
    from: FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (cc && cc.length > 0) payload.cc = Array.isArray(cc) ? cc : [cc];

  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { console.log('[analyst-reports] email sent:', raw); resolve(raw); });
    });
    req.on('error', (e) => { console.error('[analyst-reports] email error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── Load report settings from blobs ──────────────────────────────────────────
async function loadReportSettings() {
  const settings = await cacheLoad('analyst/report-settings');
  return settings || {
    execReportCC: ['Mike@PeopleCapitalGroup.com'],
    dmBriefCC: ['Mike@PeopleCapitalGroup.com'],
    execReportEnabled: true,
    dmBriefEnabled: true,
  };
}

// ── Email template wrapper ───────────────────────────────────────────────────
function wrapEmail(title, subtitle, bodyHtml, footerNote, reportId) {
  return `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 680px; margin: 0 auto; background: #ffffff;">
      <div style="background: linear-gradient(135deg, #0b0b0c 0%, #1a1a2e 100%); padding: 28px 32px; border-radius: 8px 8px 0 0;">
        <div style="display: flex; align-items: center; gap: 14px;">
          <!--logo removed-->
          <div>
            <h1 style="color: #fff; margin: 0; font-size: 20px; font-weight: 700;">${title}</h1>
            <p style="color: #FF671F; margin: 4px 0 0; font-size: 13px; font-weight: 600; letter-spacing: 0.5px;">${subtitle}</p>
          </div>
        </div>
      </div>
      <div style="padding: 28px 32px; border: 1px solid #e5e5e5; border-top: 3px solid #FF671F; border-radius: 0 0 8px 8px;">
        ${bodyHtml}
        ${footerNote ? `<div style="margin-top: 24px; padding: 14px 18px; background: #fff8f0; border-left: 3px solid #FF671F; border-radius: 0 6px 6px 0; font-size: 12px; color: #8b6914; line-height: 1.5;">${footerNote}</div>` : ''}
        ${reportId ? `<div style="text-align:center;margin:16px 0"><a href="https://pcg-ops.netlify.app/?tab=reports&report=${reportId}" style="display:inline-block;padding:10px 24px;background:#FF671F;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:14px">View in Portal</a></div>` : ''}
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #999; font-size: 11px; text-align: center;">
          Generated by Orion — PCG Unified Operations Portal<br/>
          People Capital Group &bull; Confidential — Internal Use Only
        </p>
      </div>
    </div>
  `;
}

// ── Generate DM Daily Brief Email ────────────────────────────────────────────
async function generateDMBrief(district) {
  const today = new Date().toISOString().slice(0, 10);
  const dataContext = await buildDataContext({ district });
  if (typeof dataContext === 'string' && dataContext.includes('No labor data')) return null;

  const prompt = `Generate a morning briefing email for a District Manager (District ${district}) on ${today}.

Include:
1. A one-line greeting ("Good morning, here's your District ${district} brief for ${today}")
2. 3-5 key bullets: what happened yesterday, what to watch today
3. A "Store Spotlight" — highlight the best and worst performing store in the district
4. Any overtime or labor alerts
5. One actionable recommendation

Format as clean HTML suitable for email. Use <strong> for emphasis, <ul>/<li> for lists. Keep it under 250 words. Do not use markdown — use HTML tags only.

Data:
${dataContext}`;

  const result = await generateStructured({
    system: PERSONA,
    userPrompt: prompt,
    action: 'brief',
    userId: 'system',
  });

  return result.text;
}

// ── Generate Exec Daily Report Email ─────────────────────────────────────────
async function generateExecDailyReport() {
  const today = new Date().toISOString().slice(0, 10);
  const snapshot = await buildKPISnapshot();
  if (snapshot.error) return null;

  const net = snapshot.network;
  const stores = snapshot.stores || [];
  const fmtD = v => '$' + Math.round(v).toLocaleString();
  const fmtP = v => (v || 0).toFixed(1) + '%';

  const tblStyle = 'width:100%;border-collapse:collapse;font-size:14px;margin:12px 0 20px;';
  const thStyle = 'padding:10px 12px;text-align:left;border-bottom:2px solid #FF671F;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#666;';
  const tdStyle = 'padding:8px 12px;border-bottom:1px solid #eee;';
  const tdBold = 'padding:8px 12px;border-bottom:1px solid #eee;font-weight:700;';

  // LLM executive summary
  const dataContext = await buildDataContext({ includeStoreDetail: false });
  let summaryText = '';
  try {
    const r = await generateStructured({ system: PERSONA, userPrompt: `Write a 2-3 sentence daily operations summary for ${today}. Network Sales Today: ${fmtD(net.sales)}, Labor: ${fmtP(net.laborPct)}, ${net.storeCount} stores, ${net.overtimeCount} OT, ${net.scheduledNow} scheduled now. Be concise. Plain text only, no HTML, no markdown.`, action: 'brief', userId: 'system' });
    summaryText = r.text.replace(/<[^>]+>/g, '').replace(/```/g, '').replace(/\*\*/g, '').trim();
  } catch { summaryText = `Today the network recorded ${fmtD(net.sales)} in sales across ${net.storeCount} stores.`; }

  let html = '';
  html += `<h3 style="color:#0b0b0c;font-size:16px;margin:0 0 8px;">Daily Summary — ${today}</h3>`;
  html += `<p style="font-size:14px;line-height:1.6;color:#333;margin:0 0 20px;">${summaryText}</p>`;

  html += `<h3 style="color:#0b0b0c;font-size:16px;margin:0 0 8px;">Today's KPIs</h3>`;
  html += `<table style="${tblStyle}"><tr><th style="${thStyle}">Metric</th><th style="${thStyle}">Value</th></tr>`;
  html += `<tr><td style="${tdStyle}">Net Sales</td><td style="${tdBold}color:#00d084;">${fmtD(net.sales)}</td></tr>`;
  html += `<tr><td style="${tdStyle}">Labor Cost</td><td style="${tdBold}">${fmtD(net.laborDollars)}</td></tr>`;
  html += `<tr><td style="${tdStyle}">Labor %</td><td style="${tdBold}color:${net.laborPct > 26 ? '#f44336' : net.laborPct > 23 ? '#ff9800' : '#4caf50'};">${fmtP(net.laborPct)}</td></tr>`;
  html += `<tr><td style="${tdStyle}">Scheduled Now</td><td style="${tdBold}">${net.scheduledNow}</td></tr>`;
  html += `<tr><td style="${tdStyle}">Overtime</td><td style="${tdBold}">${net.overtimeCount}</td></tr>`;
  html += `</table>`;

  // Top/bottom 3 by today's labor %
  const withLabor = stores.filter(s => s.today.sales > 0 && s.today.laborPct > 0);
  withLabor.sort((a, b) => a.today.laborPct - b.today.laborPct);
  const best3 = withLabor.slice(0, 3);
  const worst3 = withLabor.slice(-3).reverse();

  html += `<div style="display:flex;gap:24px;flex-wrap:wrap;">`;
  html += `<div style="flex:1;min-width:180px;"><h3 style="color:#4caf50;font-size:14px;margin:0 0 8px;">Best Today</h3>`;
  for (const s of best3) html += `<div style="padding:4px 0;font-size:13px;border-bottom:1px solid #f0f0f0;"><strong>${s.name}</strong> — <span style="color:#4caf50;font-weight:700;">${fmtP(s.today.laborPct)}</span> · ${fmtD(s.today.sales)}</div>`;
  html += `</div>`;
  html += `<div style="flex:1;min-width:180px;"><h3 style="color:#f44336;font-size:14px;margin:0 0 8px;">Worst Today</h3>`;
  for (const s of worst3) html += `<div style="padding:4px 0;font-size:13px;border-bottom:1px solid #f0f0f0;"><strong>${s.name}</strong> — <span style="color:#f44336;font-weight:700;">${fmtP(s.today.laborPct)}</span> · ${fmtD(s.today.sales)}</div>`;
  html += `</div></div>`;

  return html;
}

// ── Generate Exec Weekly Report Email ────────────────────────────────────────
async function generateExecReport(isLaborAdjusted) {
  const today = new Date().toISOString().slice(0, 10);

  // Calculate last completed week (Sun-Sat)
  const now = new Date(today + 'T12:00:00');
  const dayOfWeek = now.getDay(); // 0=Sun
  // Last Saturday = most recent Saturday before today
  const lastSat = new Date(now);
  lastSat.setDate(now.getDate() - (dayOfWeek === 0 ? 1 : dayOfWeek + 1));
  // Last Sunday = 6 days before last Saturday
  const lastSun = new Date(lastSat);
  lastSun.setDate(lastSat.getDate() - 6);
  const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const weekStart = fmtDate(lastSun);
  const weekEnd = fmtDate(lastSat);

  const fmtD = v => '$' + Math.round(v).toLocaleString();
  const fmtP = v => (v || 0).toFixed(1) + '%';

  // Build list of dates in last completed week
  const lwDates = [];
  const d = new Date(lastSun);
  while (d <= lastSat) {
    lwDates.push(fmtDate(d));
    d.setDate(d.getDate() + 1);
  }

  // Pull last week's data — try blobs first, fall back to live API calls
  let storeWeekData = [];
  let usedLiveData = false;

  // Try blobs first
  for (const store of STORES) {
    const history = await cacheLoad(`pcg_labor_store_${store.pc}`);
    const daily = history?.daily || [];
    let weekSales = 0, weekLabor = 0;
    for (const dt of lwDates) {
      const entry = daily.find(e => e.date === dt);
      if (entry) {
        weekSales += entry.sales || 0;
        weekLabor += entry.laborDollars || 0;
      }
    }
    storeWeekData.push({ name: store.name, district: store.district, weekSales, weekLabor, weekLaborPct: weekSales > 0 ? (weekLabor / weekSales) * 100 : 0 });
  }

  // Check if blobs had real data — if total sales is $0 or very low, fetch live
  const blobTotal = storeWeekData.reduce((s, st) => s + st.weekSales, 0);
  if (blobTotal < 1000) {
    console.log(`[analyst-reports] Blob data insufficient (${blobTotal}), fetching from live APIs...`);
    storeWeekData = await fetchLastWeekLive(lwDates);
    usedLiveData = true;
  }

  // Build district summaries from last week's data
  const distMap = {};
  for (const s of storeWeekData) {
    const d = s.district || 0;
    if (!distMap[d]) distMap[d] = { sales: 0, labor: 0, stores: 0 };
    distMap[d].sales += s.weekSales;
    distMap[d].labor += s.weekLabor;
    distMap[d].stores++;
  }

  // Sort stores by last week's labor % for top/bottom
  const storesWithData = storeWeekData.filter(s => s.weekSales > 0);
  storesWithData.sort((a, b) => a.weekLaborPct - b.weekLaborPct);
  const best5 = storesWithData.slice(0, 5);
  const worst5 = storesWithData.slice(-5).reverse();

  // Network totals for last week
  const wtdSales = storeWeekData.reduce((s, st) => s + st.weekSales, 0);
  const wtdLabor = storeWeekData.reduce((s, st) => s + st.weekLabor, 0);
  const wtdLaborPct = wtdSales > 0 ? (wtdLabor / wtdSales) * 100 : 0;
  const storeCount = STORES.length;

  const tblStyle = 'width:100%;border-collapse:collapse;font-size:14px;margin:12px 0 20px;';
  const thStyle = 'padding:10px 12px;text-align:left;border-bottom:2px solid #FF671F;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#666;';
  const tdStyle = 'padding:8px 12px;border-bottom:1px solid #eee;';
  const tdBold = 'padding:8px 12px;border-bottom:1px solid #eee;font-weight:700;';

  // Build the HTML directly — no LLM formatting needed for the data tables
  let html = '';

  // Get LLM to write ONLY the executive summary (2-3 sentences) — much more reliable
  const dataContext = await buildDataContext({ includeStoreDetail: false });
  const summaryPrompt = `Write a 2-3 sentence executive summary for a weekly operations report covering the week of ${weekStart} to ${weekEnd}. Network Sales: ${fmtD(wtdSales)}, Labor: ${fmtP(wtdLaborPct)}, ${storeCount} stores. ${isLaborAdjusted ? 'This is the post-adjustment report — labor figures are final.' : 'This is the preliminary report — labor figures may change after DM adjustments.'} Be concise and professional. Return plain text only, no HTML tags, no markdown.`;

  let summaryText = '';
  try {
    const summaryResult = await generateStructured({ system: PERSONA, userPrompt: summaryPrompt, action: 'brief', userId: 'system' });
    summaryText = summaryResult.text.replace(/<[^>]+>/g, '').replace(/```/g, '').replace(/\*\*/g, '').trim();
  } catch { summaryText = `The network recorded ${fmtD(wtdSales)} in sales across ${storeCount} stores with a ${fmtP(wtdLaborPct)} labor rate for the week of ${weekStart} to ${weekEnd}.`; }

  html += `<h3 style="color:#0b0b0c;font-size:16px;margin:0 0 8px;">Executive Summary — Week of ${weekStart} to ${weekEnd}</h3>`;
  html += `<p style="font-size:14px;line-height:1.6;color:#333;margin:0 0 20px;">${summaryText}</p>`;

  // Network KPIs
  const storesWithSales = storeWeekData.filter(s => s.weekSales > 0).length;
  html += `<h3 style="color:#0b0b0c;font-size:16px;margin:0 0 8px;">Network KPIs — ${weekStart} to ${weekEnd}</h3>`;
  html += `<table style="${tblStyle}">`;
  html += `<tr><th style="${thStyle}">Metric</th><th style="${thStyle}">Value</th></tr>`;
  html += `<tr><td style="${tdStyle}">Net Sales</td><td style="${tdBold}color:#00d084;">${fmtD(wtdSales)}</td></tr>`;
  html += `<tr><td style="${tdStyle}">Labor Cost</td><td style="${tdBold}">${fmtD(wtdLabor)}</td></tr>`;
  html += `<tr><td style="${tdStyle}">Labor %</td><td style="${tdBold}color:${wtdLaborPct > 26 ? '#f44336' : wtdLaborPct > 23 ? '#ff9800' : '#4caf50'};">${fmtP(wtdLaborPct)}</td></tr>`;
  html += `<tr><td style="${tdStyle}">Stores</td><td style="${tdBold}">${storeCount} total (${storesWithSales} reporting)</td></tr>`;
  html += `</table>`;

  // District Scorecard — DM names from DM_INFO mapping

  html += `<h3 style="color:#0b0b0c;font-size:16px;margin:0 0 8px;">District Scorecard</h3>`;
  html += `<table style="${tblStyle}">`;
  html += `<tr><th style="${thStyle}">District</th><th style="${thStyle}">DM</th><th style="${thStyle}">Sales</th><th style="${thStyle}">Labor Cost</th><th style="${thStyle}">Labor %</th><th style="${thStyle}">Stores</th></tr>`;
  const distEntries = Object.entries(distMap).sort((a, b) => {
    const aPct = a[1].sales > 0 ? (a[1].labor / a[1].sales) * 100 : 0;
    const bPct = b[1].sales > 0 ? (b[1].labor / b[1].sales) * 100 : 0;
    return aPct - bPct;
  });
  for (const [d, v] of distEntries) {
    const pct = v.sales > 0 ? (v.labor / v.sales) * 100 : 0;
    const pctColor = pct > 26 ? '#f44336' : pct > 23 ? '#ff9800' : '#4caf50';
    const dm = DM_INFO[d]?.name || DM_INFO[Number(d)]?.name || '—';
    html += `<tr><td style="${tdBold}">D${d}</td><td style="${tdStyle}">${dm}</td><td style="${tdStyle}">${fmtD(v.sales)}</td><td style="${tdStyle}">${fmtD(v.labor)}</td><td style="${tdStyle}color:${pctColor};font-weight:700;">${fmtP(pct)}</td><td style="${tdStyle}">${v.stores}</td></tr>`;
  }
  html += `</table>`;

  // Top 5 / Bottom 5 by Labor %
  html += `<h3 style="color:#0b0b0c;font-size:16px;margin:20px 0 8px;">Top 5 — Best Labor %</h3>`;
  html += `<table style="${tblStyle}"><tr><th style="${thStyle}">Store</th><th style="${thStyle}">District</th><th style="${thStyle}">Labor %</th><th style="${thStyle}">Sales</th></tr>`;
  for (const s of best5) {
    html += `<tr><td style="${tdBold}">${s.name}</td><td style="${tdStyle}">D${s.district}</td><td style="${tdStyle}color:#4caf50;font-weight:700;">${fmtP(s.weekLaborPct)}</td><td style="${tdStyle}">${fmtD(s.weekSales)}</td></tr>`;
  }
  html += `</table>`;

  html += `<h3 style="color:#0b0b0c;font-size:16px;margin:20px 0 8px;">Bottom 5 — Highest Labor %</h3>`;
  html += `<table style="${tblStyle}"><tr><th style="${thStyle}">Store</th><th style="${thStyle}">District</th><th style="${thStyle}">Labor %</th><th style="${thStyle}">Sales</th></tr>`;
  for (const s of worst5) {
    html += `<tr><td style="${tdBold}">${s.name}</td><td style="${tdStyle}">D${s.district}</td><td style="${tdStyle}color:#f44336;font-weight:700;">${fmtP(s.weekLaborPct)}</td><td style="${tdStyle}">${fmtD(s.weekSales)}</td></tr>`;
  }
  html += `</table>`;

  // Top 5 / Bottom 5 by Sales
  const bySales = [...storesWithData].sort((a, b) => b.weekSales - a.weekSales);
  const topSales5 = bySales.slice(0, 5);
  const bottomSales5 = bySales.slice(-5).reverse();

  html += `<h3 style="color:#0b0b0c;font-size:16px;margin:20px 0 8px;">Top 5 — Highest Sales</h3>`;
  html += `<table style="${tblStyle}"><tr><th style="${thStyle}">Store</th><th style="${thStyle}">District</th><th style="${thStyle}">Sales</th><th style="${thStyle}">Labor %</th></tr>`;
  for (const s of topSales5) {
    html += `<tr><td style="${tdBold}">${s.name}</td><td style="${tdStyle}">D${s.district}</td><td style="${tdStyle}color:#00d084;font-weight:700;">${fmtD(s.weekSales)}</td><td style="${tdStyle}">${fmtP(s.weekLaborPct)}</td></tr>`;
  }
  html += `</table>`;

  html += `<h3 style="color:#0b0b0c;font-size:16px;margin:20px 0 8px;">Bottom 5 — Lowest Sales</h3>`;
  html += `<table style="${tblStyle}"><tr><th style="${thStyle}">Store</th><th style="${thStyle}">District</th><th style="${thStyle}">Sales</th><th style="${thStyle}">Labor %</th></tr>`;
  for (const s of bottomSales5) {
    html += `<tr><td style="${tdBold}">${s.name}</td><td style="${tdStyle}">D${s.district}</td><td style="${tdStyle}color:#f44336;font-weight:700;">${fmtD(s.weekSales)}</td><td style="${tdStyle}">${fmtP(s.weekLaborPct)}</td></tr>`;
  }
  html += `</table>`;

  // Weather summary for the week (Philadelphia area)
  try {
    const wxData = await new Promise((resolve) => {
      const wxUrl = `/v1/forecast?latitude=40.084&longitude=-75.052&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max&temperature_unit=fahrenheit&timezone=America/New_York&start_date=${weekStart}&end_date=${weekEnd}`;
      const req = https.request({ hostname: 'api.open-meteo.com', port: 443, path: wxUrl, method: 'GET' }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
      req.end();
    });

    if (wxData?.daily) {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const wxIcon = (code) => {
        if (code == null) return '🌡️';
        if (code <= 1) return '☀️';
        if (code <= 3) return '⛅';
        if (code <= 48) return '🌫️';
        if (code <= 57) return '🌦️';
        if (code <= 67) return '🌧️';
        if (code <= 77) return '❄️';
        if (code <= 82) return '🌧️';
        return '⛈️';
      };

      html += `<h3 style="color:#0b0b0c;font-size:16px;margin:20px 0 8px;">Weather — Philadelphia (${weekStart} to ${weekEnd})</h3>`;
      html += `<table style="${tblStyle}"><tr><th style="${thStyle}">Day</th><th style="${thStyle}"></th><th style="${thStyle}">High</th><th style="${thStyle}">Low</th><th style="${thStyle}">Rain %</th></tr>`;
      for (let i = 0; i < (wxData.daily.time || []).length; i++) {
        const dt = wxData.daily.time[i];
        const dayName = dayNames[new Date(dt + 'T12:00:00').getDay()];
        const hi = Math.round(wxData.daily.temperature_2m_max[i]);
        const lo = Math.round(wxData.daily.temperature_2m_min[i]);
        const rain = wxData.daily.precipitation_probability_max?.[i] || 0;
        const icon = wxIcon(wxData.daily.weather_code?.[i]);
        html += `<tr><td style="${tdBold}">${dayName} ${dt.slice(5)}</td><td style="${tdStyle}">${icon}</td><td style="${tdStyle}">${hi}°F</td><td style="${tdStyle}">${lo}°F</td><td style="${tdStyle}${rain > 50 ? 'color:#2196f3;font-weight:700;' : ''}">${rain}%</td></tr>`;
      }
      html += `</table>`;
    }
  } catch (e) { console.warn('[analyst-reports] Weather fetch failed:', e.message); }

  return html;
}

// ── Send DM Daily Briefs ─────────────────────────────────────────────────────
async function sendDMBriefs(settings, users) {
  const today = new Date().toISOString().slice(0, 10);
  let sent = 0;

  for (let d = 1; d <= 8; d++) {
    try {
      const briefHtml = await generateDMBrief(d);
      if (!briefHtml) continue;

      // Find DM email from users list — skip if excluded
      const dmUser = (users || []).find(u => u.userType === 'dm' && u.district === d && u.active);
      const excludedDM = settings.excludeDM || [];
      if (dmUser && excludedDM.includes(dmUser.id)) { console.log(`[analyst-reports] DM D${d} excluded, skipping`); continue; }
      const dmEmail = dmUser?.email || DM_INFO[d]?.email;
      if (!dmEmail) { console.log(`[analyst-reports] No email for DM D${d}, skipping`); continue; }

      const cc = settings.dmBriefCC || [];
      const subject = `Orion Brief — District ${d} — ${today}`;
      const html = wrapEmail(
        `District ${d} Morning Brief`,
        `ORION ANALYST • ${today}`,
        briefHtml,
        null
      );

      await sendEmail({ to: dmEmail, cc, subject, html });
      sent++;
      console.log(`[analyst-reports] Sent DM brief for D${d} to ${dmEmail}`);
    } catch (err) {
      console.warn(`[analyst-reports] Failed DM brief D${d}:`, err.message);
    }
  }

  return sent;
}

// ── Send Exec Weekly Report ──────────────────────────────────────────────────
async function sendExecReport(settings, isLaborAdjusted) {
  const today = new Date().toISOString().slice(0, 10);

  try {
    const reportHtml = await generateExecReport(isLaborAdjusted);
    if (!reportHtml) return false;

    // Build recipient list: CC list minus excluded users
    const excludedExec = settings.excludeExec || [];
    const to = (settings.execReportCC || ['Mike@PeopleCapitalGroup.com']).filter(email => {
      // CC emails aren't user IDs so they're never excluded — exclusion only applies to auto-detected users
      return true;
    });
    if (to.length === 0) { console.log('[analyst-reports] No exec report recipients, skipping'); return false; }
    const reportType = isLaborAdjusted ? 'Post-Adjustment' : 'Preliminary';
    const subject = `Orion Exec Report — ${reportType} — Week of ${today}`;

    const laborCaveat = !isLaborAdjusted
      ? '<strong>⚠️ Labor Data Notice:</strong> This report contains preliminary labor figures. District Managers are required to complete all labor adjustments by <strong>Monday at 1:00 PM ET</strong>. A final post-adjustment report will be sent on Tuesday at 10:00 AM ET with corrected figures.'
      : '<strong>✅ Post-Adjustment Report:</strong> This report reflects labor data after DM corrections. Figures should be final.';

    const html = wrapEmail(
      `Weekly Executive Report — ${reportType}`,
      `ORION ANALYST • PEOPLE CAPITAL GROUP • ${today}`,
      reportHtml,
      laborCaveat
    );

    await sendEmail({ to, subject, html });
    console.log(`[analyst-reports] Sent exec report (${reportType}) to ${to.join(', ')}`);
    return true;
  } catch (err) {
    console.warn(`[analyst-reports] Failed exec report:`, err.message);
    return false;
  }
}

// ── Send Exec Daily Report ───────────────────────────────────────────────────
async function sendExecDailyReport(settings) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const reportHtml = await generateExecDailyReport();
    if (!reportHtml) return false;
    const to = settings.execReportCC || ['Mike@PeopleCapitalGroup.com'];
    const subject = `Orion Daily Exec Report — ${today}`;
    const html = wrapEmail(
      `Daily Executive Report`,
      `ORION ANALYST • PEOPLE CAPITAL GROUP • ${today}`,
      reportHtml,
      null
    );
    await sendEmail({ to, subject, html });
    console.log(`[analyst-reports] Sent exec daily report to ${to.join(', ')}`);
    return true;
  } catch (err) {
    console.warn('[analyst-reports] Failed exec daily report:', err.message);
    return false;
  }
}

module.exports = { sendDMBriefs, sendExecReport, sendExecDailyReport, loadReportSettings, sendEmail, wrapEmail };
