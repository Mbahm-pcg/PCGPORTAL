// reconciliation.mjs — Sales reconciliation checker
// Compares Pulse POS sales at two time points to flag late-sync discrepancies

import https from 'node:https';
import { getStore } from '@netlify/blobs';

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

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers });

  let payload;
  try { payload = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers }); }

  const { action } = payload;

  // ── Snapshot: pull current sales for a date and save to blob ──────
  if (action === 'snapshot') {
    const { busDt } = payload;
    if (!busDt) return new Response(JSON.stringify({ error: 'Missing busDt' }), { status: 400, headers });

    const results = {};
    // Batch 8 at a time
    for (let i = 0; i < STORES.length; i += 8) {
      const batch = STORES.slice(i, i + 8);
      const batchResults = await Promise.all(batch.map(async (store) => {
        const data = await fetchSales(store.pc, busDt);
        return { pc: store.pc, name: store.name, district: store.district, ...data };
      }));
      for (const r of batchResults) results[r.pc] = r;
      if (i + 8 < STORES.length) await new Promise(r => setTimeout(r, 500));
    }

    const snapshot = { busDt, pulledAt: new Date().toISOString(), stores: results };
    const store = getBlobStore();
    await store.setJSON(`pcg_recon_snapshot_${busDt}`, { savedAt: new Date().toISOString(), data: snapshot });

    return new Response(JSON.stringify({ ok: true, busDt, storeCount: Object.keys(results).length }), { status: 200, headers });
  }

  // ── Compare: pull current vs saved snapshot, find differences ─────
  if (action === 'compare') {
    const { busDt } = payload;
    if (!busDt) return new Response(JSON.stringify({ error: 'Missing busDt' }), { status: 400, headers });

    // Load saved snapshot
    const store = getBlobStore();
    let saved = null;
    try {
      const raw = await store.get(`pcg_recon_snapshot_${busDt}`, { type: 'json' });
      saved = raw?.data || raw;
    } catch {}

    if (!saved) return new Response(JSON.stringify({ error: `No snapshot found for ${busDt}. Take a snapshot first.` }), { status: 404, headers });

    // Pull fresh data now
    const fresh = {};
    for (let i = 0; i < STORES.length; i += 8) {
      const batch = STORES.slice(i, i + 8);
      const batchResults = await Promise.all(batch.map(async (s) => {
        const data = await fetchSales(s.pc, busDt);
        return { pc: s.pc, name: s.name, district: s.district, ...data };
      }));
      for (const r of batchResults) fresh[r.pc] = r;
      if (i + 8 < STORES.length) await new Promise(r => setTimeout(r, 500));
    }

    // Compare
    const diffs = [];
    for (const s of STORES) {
      const old = saved.stores?.[s.pc];
      const now = fresh[s.pc];
      if (!old || !now) continue;

      const netDiff = (now.netSales || 0) - (old.netSales || 0);
      const taxDiff = (now.tax || 0) - (old.tax || 0);

      if (Math.abs(netDiff) > 0.01 || Math.abs(taxDiff) > 0.01) {
        diffs.push({
          pc: s.pc, name: s.name, district: s.district,
          oldNet: Math.round((old.netSales || 0) * 100) / 100,
          newNet: Math.round((now.netSales || 0) * 100) / 100,
          netDiff: Math.round(netDiff * 100) / 100,
          oldTax: Math.round((old.tax || 0) * 100) / 100,
          newTax: Math.round((now.tax || 0) * 100) / 100,
          taxDiff: Math.round(taxDiff * 100) / 100,
          errCorCount: now.errCorCount || 0,
          errCorTotal: Math.round((now.errCorTotal || 0) * 100) / 100,
        });
      }
    }

    diffs.sort((a, b) => Math.abs(b.netDiff) - Math.abs(a.netDiff));

    const result = {
      busDt,
      snapshotTaken: saved.pulledAt,
      comparedAt: new Date().toISOString(),
      hoursSinceSnapshot: Math.round((Date.now() - new Date(saved.pulledAt).getTime()) / 3600000 * 10) / 10,
      totalStores: STORES.length,
      storesWithDiffs: diffs.length,
      totalNetDiff: Math.round(diffs.reduce((s, d) => s + d.netDiff, 0) * 100) / 100,
      totalAbsDiff: Math.round(diffs.reduce((s, d) => s + Math.abs(d.netDiff), 0) * 100) / 100,
      diffs,
    };

    // Save comparison result
    await store.setJSON(`pcg_recon_compare_${busDt}`, { savedAt: new Date().toISOString(), data: result });

    return new Response(JSON.stringify(result), { status: 200, headers });
  }

  // ── History: get saved comparisons ────────────────────────────────
  if (action === 'history') {
    const store = getBlobStore();
    const { blobs } = await store.list({ prefix: 'pcg_recon_compare_' });
    const history = [];
    for (const b of blobs.slice(-14)) { // last 14 days
      try {
        const raw = await store.get(b.key, { type: 'json' });
        const data = raw?.data || raw;
        if (data) history.push({
          busDt: data.busDt,
          comparedAt: data.comparedAt,
          hoursSinceSnapshot: data.hoursSinceSnapshot,
          storesWithDiffs: data.storesWithDiffs,
          totalNetDiff: data.totalNetDiff,
          totalAbsDiff: data.totalAbsDiff,
        });
      } catch {}
    }
    return new Response(JSON.stringify({ history: history.reverse() }), { status: 200, headers });
  }

  // ── WTD History: get saved WTD comparisons ─────────────────────────
  if (action === 'wtdHistory') {
    const store = getBlobStore();
    const { blobs } = await store.list({ prefix: 'pcg_recon_wtd_compare_' });
    const history = [];
    for (const b of blobs.slice(-8)) {
      try {
        const raw = await store.get(b.key, { type: 'json' });
        const data = raw?.data || raw;
        if (data) history.push({
          weekStart: data.weekStart,
          weekEnd: data.weekEnd,
          comparedAt: data.comparedAt,
          hoursSinceSnapshot: data.hoursSinceSnapshot,
          storesWithDiffs: data.storesWithDiffs,
          totalNetDiff: data.totalNetDiff,
          totalAbsDiff: data.totalAbsDiff,
        });
      } catch {}
    }
    return new Response(JSON.stringify({ history: history.reverse() }), { status: 200, headers });
  }

  // ── WTD Detail: load a specific WTD comparison ────────────────────
  if (action === 'wtdDetail') {
    const { weekStart } = payload;
    if (!weekStart) return new Response(JSON.stringify({ error: 'Missing weekStart' }), { status: 400, headers });
    const store = getBlobStore();
    try {
      const raw = await store.get(`pcg_recon_wtd_compare_${weekStart}`, { type: 'json' });
      const data = raw?.data || raw;
      if (data) return new Response(JSON.stringify(data), { status: 200, headers });
    } catch {}
    return new Response(JSON.stringify({ error: `No WTD comparison for week of ${weekStart}` }), { status: 404, headers });
  }

  // ── WTD Snapshot status: check if a snapshot exists for a week ─────
  if (action === 'wtdSnapshotStatus') {
    const store = getBlobStore();
    const { blobs } = await store.list({ prefix: 'pcg_recon_wtd_snapshot_' });
    const snapshots = [];
    for (const b of blobs.slice(-4)) {
      try {
        const raw = await store.get(b.key, { type: 'json' });
        const data = raw?.data || raw;
        if (data) snapshots.push({
          weekStart: data.weekStart,
          weekEnd: data.weekEnd,
          pulledAt: data.pulledAt,
          storeCount: Object.keys(data.stores || {}).length,
          totalNet: Math.round(Object.values(data.stores || {}).reduce((s, st) => s + (st.netSales || 0), 0) * 100) / 100,
        });
      } catch {}
    }
    return new Response(JSON.stringify({ snapshots: snapshots.reverse() }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers });
};
