// PCG Portal — Scheduled Pulse Notifications
// Runs on a cron schedule, fetches daily totals + WTD from Dunkin POS API,
// and sends push + email notifications with the summary.

import https from 'node:https';
import webpush from 'web-push';
import { getStore } from '@netlify/blobs';

// ── Store configs ─────────────────────────────────────────────────────────────
const STORES = [
  { pc:"339616", name:"Wadsworth", district:1 },
  { pc:"340794", name:"Front", district:1 },
  { pc:"351099", name:"Sonic", district:2 },
  { pc:"351259", name:"Rosemore", district:2 },
  { pc:"302642", name:"County Line", district:2 },
  { pc:"352894", name:"Street Rd", district:2 },
  { pc:"341350", name:"Yardley", district:2 },
  { pc:"337839", name:"Warrington", district:2 },
  { pc:"330338", name:"Drexel Hill", district:3 },
  { pc:"337063", name:"Sharon Hill", district:3 },
  { pc:"343832", name:"Lansdowne", district:3 },
  { pc:"304669", name:"Collingdale", district:3 },
  { pc:"355146", name:"Gallery", district:3 },
  { pc:"300496", name:"Cobbs Creek", district:3 },
  { pc:"304863", name:"18th St", district:3 },
  { pc:"354561", name:"Carlisle", district:3 },
  { pc:"332393", name:"Lindbergh", district:3 },
  { pc:"341167", name:"5th Street", district:4 },
  { pc:"340870", name:"Hunting Park", district:4 },
  { pc:"335981", name:"Lehigh", district:4 },
  { pc:"353150", name:"Bakers Square", district:4 },
  { pc:"351050", name:"Allegheny", district:4 },
  { pc:"345985", name:"Wissahickon", district:4 },
  { pc:"356374", name:"Montgomeryville", district:5 },
  { pc:"353843", name:"Tollgate", district:5 },
  { pc:"353047", name:"Silverdale", district:5 },
  { pc:"340538", name:"Easton", district:5 },
  { pc:"343079", name:"Downingtown", district:6 },
  { pc:"342144", name:"Westchester", district:6 },
  { pc:"364295", name:"Lionville", district:6 },
  { pc:"365361", name:"Little Welsh", district:7 },
  { pc:"310382", name:"Grant", district:7 },
  { pc:"332941", name:"Bustleton", district:7 },
  { pc:"343497", name:"Red Lion", district:7 },
  { pc:"302446", name:"Little Red Lion", district:7 },
  { pc:"337079", name:"Holme Circle", district:7 },
  { pc:"345986", name:"Willits", district:7 },
  { pc:"364412", name:"8200", district:7 },
  { pc:"345489", name:"Oxford", district:7 },
  { pc:"336372", name:"Elkins Park", district:7 },
  { pc:"358933", name:"Brace Rd", district:8 },
  { pc:"354865", name:"Quakertown", district:8 },
  { pc:"353689", name:"Fort Washington", district:8 },
  { pc:"342184", name:"Lansdale", district:8 },
  { pc:"356316", name:"BJ's", district:8 },
];

const APIS = {
  p227: {
    host:   'pos-ra.dunkindonuts.com',
    path:   '/p227',
    xkey:   'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL',
    apikey: 'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
  p228: {
    host:   'pos-ra.dunkindonuts.com',
    path:   '/p228',
    xkey:   'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP',
    apikey: 'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
};

const STORE_P227 = '345986'; // Willits uses p227
function apiRoute(pc) { return pc === STORE_P227 ? 'p227' : 'p228'; }

// ── HTTP helper ───────────────────────────────────────────────────────────────
function postJSON(cfg, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: cfg.host,
      port: 443,
      path: `${cfg.path}/${endpoint}`,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-api-key':      cfg.xkey,
        'Api-Key':        cfg.apikey,
        'Content-Length':  Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(raw)); }
          catch { resolve(raw); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function todayET() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}`;
}

function getWeekDates(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const sun = new Date(d);
  sun.setDate(d.getDate() - d.getDay()); // back to Sunday
  const today = todayET();
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(sun);
    dd.setDate(sun.getDate() + i);
    const ds = `${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`;
    if (ds <= today) dates.push(ds);
  }
  return dates;
}

// ── POS data fetching ─────────────────────────────────────────────────────────
async function fetchLatestBusDt(pc) {
  try {
    const cfg = APIS[apiRoute(pc)];
    const j = await postJSON(cfg, 'getLatestBusDt', { locRef: pc });
    return j.busDt || j.businessDate || null;
  } catch { return null; }
}

async function fetchOpsTotals(pc, busDt) {
  const cfg = APIS[apiRoute(pc)];
  return postJSON(cfg, 'getOperationsDailyTotals', {
    locRef: pc, busDt, include: 'locRef,busDt,revenueCenters',
  });
}

function sumRVC(revenueCenters = []) {
  const s = revenueCenters.reduce((acc, r) => ({
    netSales:  acc.netSales  + (r.netSlsTtl  || 0),
    guests:    acc.guests    + (r.chkCnt     || 0),
    forecast:  acc.forecast  + (r.slsFcst    || 0),
    voids:     acc.voids     + (r.vdTtl      || 0),
    discounts: acc.discounts + ((r.itmDscTtl || 0) + (r.subDscTtl || 0)),
  }), { netSales: 0, guests: 0, forecast: 0, voids: 0, discounts: 0 });
  s.avgCheck = s.guests > 0 ? s.netSales / s.guests : 0;
  return s;
}

async function fetchAllStores(busDt, batchSize = 8) {
  const results = {};
  const pcs = STORES.map(s => s.pc);
  for (let i = 0; i < pcs.length; i += batchSize) {
    await Promise.all(pcs.slice(i, i + batchSize).map(async pc => {
      try {
        const json = await fetchOpsTotals(pc, busDt);
        results[pc] = { status: 'ok', data: sumRVC(json.revenueCenters) };
      } catch (e) {
        results[pc] = { status: 'error', error: e.message };
      }
    }));
  }
  return results;
}

function aggResults(results) {
  return Object.values(results).filter(d => d.status === 'ok').reduce((a, d) => ({
    netSales:  a.netSales  + d.data.netSales,
    guests:    a.guests    + d.data.guests,
    voids:     a.voids     + d.data.voids,
    discounts: a.discounts + d.data.discounts,
    forecast:  a.forecast  + d.data.forecast,
  }), { netSales: 0, guests: 0, voids: 0, discounts: 0, forecast: 0 });
}

// ── Formatting ────────────────────────────────────────────────────────────────
function fmtMoney(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtMoney2(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtNum(n) { return Number(n).toLocaleString('en-US'); }

// Load store statuses from cloud (to identify closed/remodel stores)
async function loadStoreStatuses(store) {
  try {
    const result = await store.get('pcg_stores_v1', { type: 'json' });
    if (result && result.data && Array.isArray(result.data)) {
      const map = {};
      result.data.forEach(s => { map[s.pc] = s.status || 'Open'; });
      return map;
    }
  } catch {}
  return {};
}

function buildSummary(daily, wtd, busDt, storesOk, storesTotal, dailyResults, storeStatuses) {
  const pct = daily.forecast > 0 ? ((daily.netSales / daily.forecast) * 100).toFixed(1) : '—';

  // Identify non-open stores
  const nonOpenStores = STORES.filter(s => {
    const status = storeStatuses[s.pc] || 'Open';
    return status !== 'Open';
  });

  // Build per-store rows for email
  const storeRows = STORES.map(s => {
    const status = storeStatuses[s.pc] || 'Open';
    const r = dailyResults[s.pc];
    const isOk = r && r.status === 'ok';
    const badge = status !== 'Open' ? ` <span style="background:#dc3545;color:#fff;padding:1px 6px;border-radius:3px;font-size:11px;">${status}</span>` : '';
    if (!isOk) return `<tr style="opacity:0.5;"><td style="padding:4px 8px; border-bottom:1px solid #eee;">${s.name}${badge}</td><td colspan="3" style="padding:4px 8px; text-align:center; border-bottom:1px solid #eee; color:#999;">No data</td></tr>`;
    const d = r.data;
    return `<tr><td style="padding:4px 8px; border-bottom:1px solid #eee;">${s.name}${badge}</td><td style="padding:4px 8px; text-align:right; border-bottom:1px solid #eee;">${fmtMoney2(d.netSales)}</td><td style="padding:4px 8px; text-align:right; border-bottom:1px solid #eee;">${fmtNum(d.guests)}</td><td style="padding:4px 8px; text-align:right; border-bottom:1px solid #eee;">${d.guests > 0 ? fmtMoney2(d.netSales / d.guests) : '—'}</td></tr>`;
  }).join('\n');

  // Non-open store note for email
  const closedNote = nonOpenStores.length > 0
    ? `<div style="margin:12px 0; padding:10px; background:#fff3cd; border-left:4px solid #ffc107; border-radius:4px; font-size:13px;">
        <strong>Note:</strong> ${nonOpenStores.map(s => `${s.name} (${storeStatuses[s.pc] || 'Closed'})`).join(', ')} — sales may be lower due to ${nonOpenStores.length === 1 ? 'this store' : 'these stores'} not operating at full capacity.
      </div>`
    : '';

  return {
    title: `PCG Pulse`,
    body: `Today's: ${fmtMoney(daily.netSales)}. WTD: ${fmtMoney(wtd.netSales)}`,
    html: `
      <h3 style="margin:0 0 4px; color:#FF671F;">Daily Pulse — ${busDt}</h3>
      <p style="margin:0 0 16px; color:#666; font-size:13px;">${storesOk} of ${storesTotal} stores reporting</p>

      ${closedNote}

      <h4 style="margin:16px 0 8px; color:#333;">Summary</h4>
      <table style="border-collapse:collapse; width:100%; font-size:14px;">
        <tr style="background:#FF671F; color:#fff;">
          <th style="padding:8px; text-align:left;">Metric</th>
          <th style="padding:8px; text-align:right;">Today</th>
          <th style="padding:8px; text-align:right;">WTD (${wtd.days || '?'} days)</th>
        </tr>
        <tr><td style="padding:6px 8px; border-bottom:1px solid #eee; font-weight:600;">Net Sales</td>
            <td style="padding:6px 8px; text-align:right; border-bottom:1px solid #eee; font-weight:bold; font-size:16px;">${fmtMoney2(daily.netSales)}</td>
            <td style="padding:6px 8px; text-align:right; border-bottom:1px solid #eee; font-weight:bold; font-size:16px;">${fmtMoney2(wtd.netSales)}</td></tr>
        <tr><td style="padding:6px 8px; border-bottom:1px solid #eee;">Guests</td>
            <td style="padding:6px 8px; text-align:right; border-bottom:1px solid #eee;">${fmtNum(daily.guests)}</td>
            <td style="padding:6px 8px; text-align:right; border-bottom:1px solid #eee;">${fmtNum(wtd.guests)}</td></tr>
        <tr><td style="padding:6px 8px; border-bottom:1px solid #eee;">Avg Check</td>
            <td style="padding:6px 8px; text-align:right; border-bottom:1px solid #eee;">${daily.guests > 0 ? fmtMoney2(daily.netSales / daily.guests) : '—'}</td>
            <td style="padding:6px 8px; text-align:right; border-bottom:1px solid #eee;">${wtd.guests > 0 ? fmtMoney2(wtd.netSales / wtd.guests) : '—'}</td></tr>
        <tr><td style="padding:6px 8px; border-bottom:1px solid #eee;">Forecast %</td>
            <td style="padding:6px 8px; text-align:right; border-bottom:1px solid #eee;">${pct}%</td>
            <td style="padding:6px 8px; text-align:right; border-bottom:1px solid #eee;">—</td></tr>
        <tr><td style="padding:6px 8px;">Discounts</td>
            <td style="padding:6px 8px; text-align:right;">${fmtMoney2(daily.discounts)}</td>
            <td style="padding:6px 8px; text-align:right;">${fmtMoney2(wtd.discounts)}</td></tr>
      </table>

      <h4 style="margin:20px 0 8px; color:#333;">Store Breakdown — ${busDt}</h4>
      <table style="border-collapse:collapse; width:100%; font-size:13px;">
        <tr style="background:#333; color:#fff;">
          <th style="padding:6px 8px; text-align:left;">Store</th>
          <th style="padding:6px 8px; text-align:right;">Net Sales</th>
          <th style="padding:6px 8px; text-align:right;">Guests</th>
          <th style="padding:6px 8px; text-align:right;">Avg Check</th>
        </tr>
        ${storeRows}
        <tr style="background:#f5f5f5; font-weight:bold;">
          <td style="padding:6px 8px;">TOTAL</td>
          <td style="padding:6px 8px; text-align:right;">${fmtMoney2(daily.netSales)}</td>
          <td style="padding:6px 8px; text-align:right;">${fmtNum(daily.guests)}</td>
          <td style="padding:6px 8px; text-align:right;">${daily.guests > 0 ? fmtMoney2(daily.netSales / daily.guests) : '—'}</td>
        </tr>
      </table>
    `,
  };
}

// ── Push notifications ────────────────────────────────────────────────────────
async function sendPushToAll(store, title, body) {
  const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:noreply@pcgops.com';
  if (!vapidPublic || !vapidPrivate) { console.warn('VAPID keys not configured, skipping push'); return { sent: 0 }; }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const SUBS_KEY = 'pcg_push_subscriptions_v1';
  const result = await store.get(SUBS_KEY, { type: 'json' });
  const subs = (result && result.data) ? result.data : {};

  const pushPayload = JSON.stringify({
    title,
    body,
    icon: '/apple-touch-icon.png',
    url: '/?tab=pulse',
    tag: 'pulse-daily',
  });

  let sent = 0, failed = 0;
  const expired = [];
  const deliveryLog = []; // track who received what

  const promises = [];
  for (const [userId, userSubs] of Object.entries(subs)) {
    if (!userSubs || !Array.isArray(userSubs)) continue;
    // Send to only the MOST RECENT subscription per user (avoid duplicates)
    const latestSub = userSubs[userSubs.length - 1];
    promises.push(
      webpush.sendNotification(latestSub, pushPayload)
        .then(() => { sent++; deliveryLog.push({ userId, status: 'sent', type: 'push' }); })
        .catch((err) => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            expired.push({ userId, endpoint: latestSub.endpoint });
            deliveryLog.push({ userId, status: 'expired', type: 'push' });
          } else {
            failed++;
            deliveryLog.push({ userId, status: 'failed', type: 'push', error: err.message });
            console.warn('Push error:', userId, err.statusCode, err.message);
          }
        })
    );
  }

  await Promise.all(promises);

  // Clean up expired + deduplicate stale subscriptions
  let needsSave = expired.length > 0;
  for (const { userId, endpoint } of expired) {
    if (subs[userId]) {
      subs[userId] = subs[userId].filter(s => s.endpoint !== endpoint);
      if (subs[userId].length === 0) delete subs[userId];
    }
  }
  // Also deduplicate: keep only the 2 most recent subscriptions per user
  for (const [userId, userSubs] of Object.entries(subs)) {
    if (userSubs && userSubs.length > 2) {
      subs[userId] = userSubs.slice(-2);
      needsSave = true;
    }
  }
  if (needsSave) {
    await store.setJSON(SUBS_KEY, { savedAt: new Date().toISOString(), data: subs });
  }

  return { sent, failed, expired: expired.length, deliveryLog };
}

// ── Email ─────────────────────────────────────────────────────────────────────
function sendEmail(to, subject, html) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) { console.warn('RESEND_API_KEY not set, skipping email'); return Promise.resolve(); }
  const FROM = process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>';

  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #FF671F; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="color: #fff; margin: 0; font-size: 18px;">PCG Daily Pulse</h2>
      </div>
      <div style="padding: 24px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 8px 8px;">
        ${html}
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #999; font-size: 12px;">Automated daily report from PCG Portal Pulse.</p>
      </div>
    </div>
  `;

  const payload = JSON.stringify({
    from: FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html: emailBody,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { resolve(raw); });
    });
    req.on('error', (e) => { console.error('Email error:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

// ── Load notification config from Blobs ───────────────────────────────────────
async function loadConfig(store) {
  try {
    const result = await store.get('pcg_pulse_notify_config', { type: 'json' });
    return (result && result.data) ? result.data : {};
  } catch { return {}; }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  // Also allow manual trigger via POST for testing. The scheduled pulse-cron entry
  // calls us with x-pcg-invocation:scheduled so dedup + disabled-config checks apply.
  const isManual = request.method === 'POST' && request.headers.get('x-pcg-invocation') !== 'scheduled';

  console.log('Pulse notify triggered at', new Date().toISOString());

  try {
    // Get Blobs store
    const store = getStore({
      name: 'pcg-portal',
      consistency: 'strong',
      siteID: process.env.PCG_SITE_ID,
      token: process.env.PCG_AUTH_TOKEN,
    });

    // Dedup: check if we already sent notifications for today's business date
    let lastRun = null;
    try {
      const lr = await store.get('pcg_pulse_notify_last_run', { type: 'json' });
      lastRun = lr?.data || lr;
    } catch {}
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayStr = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}-${String(nowET.getDate()).padStart(2,'0')}`;
    if (!isManual && lastRun?.busDt === todayStr) {
      console.log(`Pulse notify already ran for ${todayStr}, skipping (last ran ${lastRun.ranAt})`);
      return;
    }

    // Load config (email recipients, enabled state)
    const config = await loadConfig(store);
    if (config.enabled === false && !isManual) {
      console.log('Pulse notifications disabled');
      return isManual
        ? new Response(JSON.stringify({ ok: true, skipped: true, reason: 'disabled' }), { status: 200, headers })
        : undefined;
    }

    // 1. Get business date — try API first, fall back to today's date in ET
    let busDt = null;
    for (const s of STORES) {
      busDt = await fetchLatestBusDt(s.pc);
      if (busDt) break;
    }
    if (!busDt) {
      busDt = todayET();
      console.log('getLatestBusDt unavailable, using today:', busDt);
    }
    console.log('Business date:', busDt);

    // 2. Fetch daily totals for all stores
    const dailyResults = await fetchAllStores(busDt);
    const storesOk = Object.values(dailyResults).filter(d => d.status === 'ok').length;
    const daily = aggResults(dailyResults);
    console.log(`Daily: ${storesOk}/${STORES.length} stores, $${daily.netSales.toFixed(2)}`);

    // 3. Calculate WTD
    const weekDates = getWeekDates(busDt);
    let wtd = { netSales: 0, guests: 0, voids: 0, discounts: 0, forecast: 0 };
    for (const date of weekDates) {
      if (date === busDt) {
        // We already have today's data
        wtd.netSales  += daily.netSales;
        wtd.guests    += daily.guests;
        wtd.voids     += daily.voids;
        wtd.discounts += daily.discounts;
        wtd.forecast  += daily.forecast;
      } else {
        const results = await fetchAllStores(date);
        const dayAgg = aggResults(results);
        wtd.netSales  += dayAgg.netSales;
        wtd.guests    += dayAgg.guests;
        wtd.voids     += dayAgg.voids;
        wtd.discounts += dayAgg.discounts;
        wtd.forecast  += dayAgg.forecast;
      }
    }
    console.log(`WTD: $${wtd.netSales.toFixed(2)} over ${weekDates.length} days`);

    // 4. Load store statuses from cloud (for closed/remodel indicators)
    const storeStatuses = await loadStoreStatuses(store);

    // 5. Build notification content
    wtd.days = weekDates.length;
    const summary = buildSummary(daily, wtd, busDt, storesOk, STORES.length, dailyResults, storeStatuses);

    // 6. Send push notifications
    const pushResult = await sendPushToAll(store, summary.title, summary.body);
    console.log('Push result:', pushResult);

    // 7. Send email to configured recipients
    const emailTo = config.emailRecipients || [process.env.PULSE_NOTIFY_EMAIL || 'mike@peoplecapitalgroup.com'];
    await sendEmail(emailTo, `PCG Pulse — ${busDt} — ${fmtMoney(daily.netSales)}`, summary.html);
    console.log('Email sent to:', emailTo);

    const result = {
      ok: true,
      busDt,
      storesReporting: storesOk,
      daily: { netSales: daily.netSales, guests: daily.guests },
      wtd:   { netSales: wtd.netSales, guests: wtd.guests, days: weekDates.length },
      push: { sent: pushResult.sent, failed: pushResult.failed, expired: pushResult.expired },
      email: { to: emailTo },
    };

    // Save delivery log for the notification history viewer
    const logEntry = {
      ts: new Date().toISOString(),
      busDt,
      type: 'pulse_daily',
      isManual,
      push: pushResult.deliveryLog || [],
      email: emailTo.map(e => ({ to: e, status: 'sent', type: 'email' })),
      summary: { netSales: daily.netSales, guests: daily.guests },
    };
    try {
      const logKey = 'pcg_notify_log';
      const existingLog = await store.get(logKey, { type: 'json' }).catch(() => null);
      const entries = Array.isArray(existingLog?.data) ? existingLog.data : [];
      entries.unshift(logEntry);
      // Keep last 30 entries
      if (entries.length > 30) entries.length = 30;
      await store.setJSON(logKey, { savedAt: new Date().toISOString(), data: entries });
    } catch {}

    // Save last run info (wrapped in { savedAt, data } to match storage.js format)
    await store.setJSON('pcg_pulse_notify_last_run', {
      savedAt: new Date().toISOString(),
      data: { ranAt: new Date().toISOString(), busDt, ...result },
    });

    console.log('Pulse notify complete:', JSON.stringify(result));
    return isManual ? new Response(JSON.stringify(result), { status: 200, headers }) : undefined;

  } catch (err) {
    console.error('Pulse notify error:', err);
    return isManual
      ? new Response(JSON.stringify({ error: err.message }), { status: 500, headers })
      : undefined;
  }
};
