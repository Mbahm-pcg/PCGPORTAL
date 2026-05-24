// reconciliation-cron.js — Scheduled sales reconciliation
// Sunday 12:01 AM ET: snapshot Saturday's sales (right after week-end close)
// Tuesday 12:01 AM ET: compare against that snapshot (catches POS late-sync diffs)

const https = require('https');
const { getStore } = require('@netlify/blobs');

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
            voidCount: rcs.reduce((s, r) => s + (r.voidCnt || 0), 0),
            voidTotal: rcs.reduce((s, r) => s + (r.voidTtl || 0), 0),
            discounts: rcs.reduce((s, r) => s + (r.dscntTtl || 0), 0),
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

function saturdayBusDt() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = et.getDay();
  // Sunday (0): Saturday was 1 day ago. Tuesday (2): Saturday was 2 days ago.
  const daysBack = dow === 0 ? 1 : dow === 2 ? 2 : dow;
  et.setDate(et.getDate() - daysBack);
  return et.toISOString().slice(0, 10);
}

async function pullAllSales(busDt) {
  const results = {};
  for (let i = 0; i < STORES.length; i += 8) {
    const batch = STORES.slice(i, i + 8);
    const batchResults = await Promise.all(batch.map(async (store) => {
      const data = await fetchSales(store.pc, busDt);
      return { pc: store.pc, name: store.name, district: store.district, ...data };
    }));
    for (const r of batchResults) results[r.pc] = r;
    if (i + 8 < STORES.length) await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

exports.handler = async (event) => {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = et.getDay();
  const busDt = saturdayBusDt();
  const store = getBlobStore();

  console.log(`[recon-cron] triggered at ${now.toISOString()} (ET day=${dow}), busDt=${busDt}`);

  if (dow === 0) {
    // Sunday — take snapshot of Saturday's sales
    console.log(`[recon-cron] Taking snapshot for ${busDt}`);
    const results = await pullAllSales(busDt);
    const snapshot = { busDt, pulledAt: now.toISOString(), stores: results };
    await store.setJSON(`pcg_recon_snapshot_${busDt}`, { savedAt: now.toISOString(), data: snapshot });
    console.log(`[recon-cron] Snapshot saved for ${busDt} — ${Object.keys(results).length} stores`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, action: 'snapshot', busDt, stores: Object.keys(results).length }) };
  }

  if (dow === 2) {
    // Tuesday — compare current data vs Sunday's snapshot
    console.log(`[recon-cron] Comparing for ${busDt}`);

    let saved = null;
    try {
      const raw = await store.get(`pcg_recon_snapshot_${busDt}`, { type: 'json' });
      saved = raw?.data || raw;
    } catch {}

    if (!saved) {
      console.log(`[recon-cron] No snapshot found for ${busDt}, nothing to compare`);
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: `No snapshot for ${busDt}` }) };
    }

    const fresh = await pullAllSales(busDt);

    const diffs = [];
    for (const s of STORES) {
      const old = saved.stores?.[s.pc];
      const cur = fresh[s.pc];
      if (!old || !cur) continue;
      const netDiff = (cur.netSales || 0) - (old.netSales || 0);
      const taxDiff = (cur.tax || 0) - (old.tax || 0);
      if (Math.abs(netDiff) > 0.01 || Math.abs(taxDiff) > 0.01) {
        diffs.push({
          pc: s.pc, name: s.name, district: s.district,
          oldNet: Math.round((old.netSales || 0) * 100) / 100,
          newNet: Math.round((cur.netSales || 0) * 100) / 100,
          netDiff: Math.round(netDiff * 100) / 100,
          oldTax: Math.round((old.tax || 0) * 100) / 100,
          newTax: Math.round((cur.tax || 0) * 100) / 100,
          taxDiff: Math.round(taxDiff * 100) / 100,
          errCorCount: cur.errCorCount || 0,
          errCorTotal: Math.round((cur.errCorTotal || 0) * 100) / 100,
        });
      }
    }
    diffs.sort((a, b) => Math.abs(b.netDiff) - Math.abs(a.netDiff));

    const result = {
      busDt,
      snapshotTaken: saved.pulledAt,
      comparedAt: now.toISOString(),
      hoursSinceSnapshot: Math.round((now.getTime() - new Date(saved.pulledAt).getTime()) / 3600000 * 10) / 10,
      totalStores: STORES.length,
      storesWithDiffs: diffs.length,
      totalNetDiff: Math.round(diffs.reduce((s, d) => s + d.netDiff, 0) * 100) / 100,
      totalAbsDiff: Math.round(diffs.reduce((s, d) => s + Math.abs(d.netDiff), 0) * 100) / 100,
      diffs,
    };

    await store.setJSON(`pcg_recon_compare_${busDt}`, { savedAt: now.toISOString(), data: result });
    console.log(`[recon-cron] Compare saved for ${busDt} — ${diffs.length} stores with diffs, net diff: $${result.totalNetDiff}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, action: 'compare', busDt, storesWithDiffs: diffs.length, totalNetDiff: result.totalNetDiff }) };
  }

  console.log(`[recon-cron] Not a Sunday or Tuesday (day=${dow}), skipping`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, action: 'skip', day: dow }) };
};
