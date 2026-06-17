// reconciliation-cron.mjs — Scheduled WTD sales reconciliation
// Sunday 12:01 AM ET: snapshot the full Sun–Sat week that just ended
// Tuesday 12:01 AM ET: re-pull the same week and compare against Sunday's snapshot

import https from 'node:https';
import { getStore } from '@netlify/blobs';

export const config = { schedule: '1 4 * * 0,2' };

const POS = {
  p227: { host: 'pos-ra.dunkindonuts.com', path: '/p227', xkey: 'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL', apikey: 'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=' },
  p228: { host: 'pos-ra.dunkindonuts.com', path: '/p228', xkey: 'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP', apikey: 'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=' },
};

const STORES = [
  { pc:"339616", name:"Wadsworth", district:1 }, { pc:"340794", name:"Front", district:1 },
  { pc:"351099", name:"Sonic", district:2 }, { pc:"351259", name:"Rosemore", district:2 },
  { pc:"302642", name:"County Line", district:2 }, { pc:"352894", name:"Street Rd", district:2 },
  { pc:"341350", name:"Yardley", district:2 }, { pc:"337839", name:"Warrington", district:2 },
  { pc:"330338", name:"Drexel Hill", district:3 }, { pc:"337063", name:"Sharon Hill", district:3 },
  { pc:"343832", name:"Lansdowne", district:3 }, { pc:"304669", name:"Collingdale", district:3 },
  { pc:"355146", name:"Gallery", district:3 }, { pc:"300496", name:"Cobbs Creek", district:3 },
  { pc:"304863", name:"18th St", district:3 }, { pc:"354561", name:"Carlisle", district:3 },
  { pc:"332393", name:"Lindbergh", district:3 }, { pc:"341167", name:"5th Street", district:4 },
  { pc:"340870", name:"Hunting Park", district:4 }, { pc:"335981", name:"Lehigh", district:4 },
  { pc:"353150", name:"Bakers Square", district:4 }, { pc:"351050", name:"Allegheny", district:4 },
  { pc:"345985", name:"Wissahickon", district:4 }, { pc:"356374", name:"Montgomeryville", district:5 },
  { pc:"353843", name:"Tollgate", district:5 }, { pc:"353047", name:"Silverdale", district:5 },
  { pc:"340538", name:"Easton", district:5 }, { pc:"343079", name:"Downingtown", district:6 },
  { pc:"342144", name:"Westchester", district:6 }, { pc:"364295", name:"Lionville", district:6 },
  { pc:"365361", name:"Little Welsh", district:7 }, { pc:"310382", name:"Grant", district:7 },
  { pc:"332941", name:"Bustleton", district:7 }, { pc:"343497", name:"Red Lion", district:7 },
  { pc:"302446", name:"Little Red Lion", district:7 }, { pc:"337079", name:"Holme Circle", district:7 },
  { pc:"345986", name:"Willits", district:7 }, { pc:"364412", name:"8200", district:7 },
  { pc:"345489", name:"Oxford", district:7 }, { pc:"336372", name:"Elkins Park", district:7 },
  { pc:"358933", name:"Brace Rd", district:8 }, { pc:"354865", name:"Quakertown", district:8 },
  { pc:"353689", name:"Fort Washington", district:8 }, { pc:"342184", name:"Lansdale", district:8 },
  { pc:"356316", name:"BJ's", district:8 },
];

function posRoute(pc) { return pc === '345986' ? 'p227' : 'p228'; }

function fetchSales(pc, busDt) {
  const cfg = POS[posRoute(pc)];
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
          const data = JSON.parse(raw);
          const rcs = data.revenueCenters || [];
          resolve({
            netSales: rcs.reduce((s, r) => s + (r.netSlsTtl || 0), 0),
            tax: rcs.reduce((s, r) => s + (r.taxTtl || 0), 0),
            grossSales: rcs.reduce((s, r) => s + (r.grsSlsTtl || r.grndTtl || 0), 0),
            errCorCount: rcs.reduce((s, r) => s + (r.errCorCnt || 0), 0),
            errCorTotal: rcs.reduce((s, r) => s + (r.errCorTtl || 0), 0),
          });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function getBlobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

function getWeekDates() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = et.getDay();
  // Find the most recent Sunday (start of the completed week)
  // Sunday (0): prior Sunday was 7 days ago. Tuesday (2): prior Sunday was 9 days ago.
  const daysToSun = dow === 0 ? 7 : dow + 7;
  const sun = new Date(et);
  sun.setDate(et.getDate() - daysToSun);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sun);
    d.setDate(sun.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return { weekStart: dates[0], weekEnd: dates[6], dates };
}

async function pullWeekSales(dates) {
  const storeWeek = {};
  for (const store of STORES) {
    storeWeek[store.pc] = { pc: store.pc, name: store.name, district: store.district, daily: {}, netSales: 0, tax: 0, grossSales: 0, errCorCount: 0, errCorTotal: 0 };
  }

  for (const busDt of dates) {
    console.log(`[recon-cron] Pulling ${busDt}...`);
    for (let i = 0; i < STORES.length; i += 8) {
      const batch = STORES.slice(i, i + 8);
      const results = await Promise.all(batch.map(async (store) => {
        const data = await fetchSales(store.pc, busDt);
        return { pc: store.pc, data };
      }));
      for (const { pc, data } of results) {
        if (data) {
          storeWeek[pc].daily[busDt] = data;
          storeWeek[pc].netSales += data.netSales || 0;
          storeWeek[pc].tax += data.tax || 0;
          storeWeek[pc].grossSales += data.grossSales || 0;
          storeWeek[pc].errCorCount += data.errCorCount || 0;
          storeWeek[pc].errCorTotal += data.errCorTotal || 0;
        }
      }
      if (i + 8 < STORES.length) await new Promise(r => setTimeout(r, 300));
    }
  }

  for (const pc of Object.keys(storeWeek)) {
    const s = storeWeek[pc];
    s.netSales = Math.round(s.netSales * 100) / 100;
    s.tax = Math.round(s.tax * 100) / 100;
    s.grossSales = Math.round(s.grossSales * 100) / 100;
    s.errCorTotal = Math.round(s.errCorTotal * 100) / 100;
  }

  return storeWeek;
}

export default async () => {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = et.getDay();
  const { weekStart, weekEnd, dates } = getWeekDates();
  const blobStore = getBlobStore();
  const blobKey = `pcg_recon_wtd_snapshot_${weekStart}`;

  console.log(`[recon-cron] triggered at ${now.toISOString()} (ET day=${dow}), week=${weekStart} to ${weekEnd}`);

  if (dow === 0) {
    console.log(`[recon-cron] Sunday — WTD snapshot for ${weekStart} to ${weekEnd}`);
    const storeWeek = await pullWeekSales(dates);
    const snapshot = { weekStart, weekEnd, dates, pulledAt: now.toISOString(), stores: storeWeek };
    await blobStore.setJSON(blobKey, { savedAt: now.toISOString(), data: snapshot });
    const totalNet = Object.values(storeWeek).reduce((s, st) => s + st.netSales, 0);
    console.log(`[recon-cron] WTD snapshot saved — ${Object.keys(storeWeek).length} stores, $${Math.round(totalNet).toLocaleString()} net`);
    return new Response(JSON.stringify({ ok: true, action: 'wtd-snapshot', weekStart, weekEnd, stores: Object.keys(storeWeek).length }), { status: 200 });
  }

  if (dow === 2) {
    console.log(`[recon-cron] Tuesday — WTD compare for ${weekStart} to ${weekEnd}`);

    let saved = null;
    try {
      const raw = await blobStore.get(blobKey, { type: 'json' });
      saved = raw?.data || raw;
    } catch {}

    if (!saved) {
      console.log(`[recon-cron] No WTD snapshot for ${weekStart}`);
      return new Response(JSON.stringify({ ok: false, error: `No WTD snapshot for ${weekStart}` }), { status: 200 });
    }

    const fresh = await pullWeekSales(dates);

    const diffs = [];
    for (const s of STORES) {
      const old = saved.stores?.[s.pc];
      const cur = fresh[s.pc];
      if (!old || !cur) continue;
      const netDiff = cur.netSales - old.netSales;
      const taxDiff = cur.tax - old.tax;
      if (Math.abs(netDiff) > 0.01 || Math.abs(taxDiff) > 0.01) {
        const dayDiffs = {};
        for (const dt of dates) {
          const od = old.daily?.[dt] || {};
          const nd = cur.daily?.[dt] || {};
          const dd = (nd.netSales || 0) - (od.netSales || 0);
          if (Math.abs(dd) > 0.01) dayDiffs[dt] = { oldNet: Math.round((od.netSales || 0) * 100) / 100, newNet: Math.round((nd.netSales || 0) * 100) / 100, diff: Math.round(dd * 100) / 100 };
        }
        diffs.push({
          pc: s.pc, name: s.name, district: s.district,
          oldNet: Math.round(old.netSales * 100) / 100,
          newNet: Math.round(cur.netSales * 100) / 100,
          netDiff: Math.round(netDiff * 100) / 100,
          oldTax: Math.round(old.tax * 100) / 100,
          newTax: Math.round(cur.tax * 100) / 100,
          taxDiff: Math.round(taxDiff * 100) / 100,
          errCorCount: cur.errCorCount,
          errCorTotal: Math.round(cur.errCorTotal * 100) / 100,
          dayDiffs,
        });
      }
    }
    diffs.sort((a, b) => Math.abs(b.netDiff) - Math.abs(a.netDiff));

    const result = {
      weekStart, weekEnd,
      snapshotTaken: saved.pulledAt,
      comparedAt: now.toISOString(),
      hoursSinceSnapshot: Math.round((now.getTime() - new Date(saved.pulledAt).getTime()) / 3600000 * 10) / 10,
      totalStores: STORES.length,
      storesWithDiffs: diffs.length,
      totalNetDiff: Math.round(diffs.reduce((s, d) => s + d.netDiff, 0) * 100) / 100,
      totalAbsDiff: Math.round(diffs.reduce((s, d) => s + Math.abs(d.netDiff), 0) * 100) / 100,
      diffs,
    };

    await blobStore.setJSON(`pcg_recon_wtd_compare_${weekStart}`, { savedAt: now.toISOString(), data: result });
    console.log(`[recon-cron] WTD compare saved — ${diffs.length} stores with diffs, net diff: $${result.totalNetDiff}`);
    return new Response(JSON.stringify({ ok: true, action: 'wtd-compare', weekStart, storesWithDiffs: diffs.length, totalNetDiff: result.totalNetDiff }), { status: 200 });
  }

  console.log(`[recon-cron] Not Sunday or Tuesday (day=${dow}), skipping`);
  return new Response(JSON.stringify({ ok: true, action: 'skip', day: dow }), { status: 200 });
};
