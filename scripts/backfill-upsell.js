// One-off backfill: recompute upsellRate for ALL stored days of pcg_hourly_history_{pc}
// for every store, using the corrected real-item count (top-level items only — matches
// itemCountForCheck in pulse-hourly-snapshot.js). Overwrites prior inflated values.
// Run via: npx netlify dev:exec -- node scripts/backfill-upsell.js
const https = require('https');
const { getStore } = require('@netlify/blobs');

const STORES = [
  { pc:"339616", name:"Wadsworth" }, { pc:"340794", name:"Front" }, { pc:"351099", name:"Sonic" },
  { pc:"351259", name:"Rosemore" }, { pc:"302642", name:"County Line" }, { pc:"352894", name:"Street Rd" },
  { pc:"341350", name:"Yardley" }, { pc:"337839", name:"Warrington" }, { pc:"330338", name:"Drexel Hill" },
  { pc:"337063", name:"Sharon Hill" }, { pc:"343832", name:"Lansdowne" }, { pc:"304669", name:"Collingdale" },
  { pc:"355146", name:"Gallery" }, { pc:"300496", name:"Cobbs Creek" }, { pc:"304863", name:"18th St" },
  { pc:"354561", name:"Carlisle" }, { pc:"332393", name:"Lindbergh" }, { pc:"341167", name:"5th Street" },
  { pc:"340870", name:"Hunting Park" }, { pc:"335981", name:"Lehigh" }, { pc:"353150", name:"Bakers Square" },
  { pc:"351050", name:"Allegheny" }, { pc:"345985", name:"Wissahickon" }, { pc:"356374", name:"Montgomeryville" },
  { pc:"353843", name:"Tollgate" }, { pc:"353047", name:"Silverdale" }, { pc:"340538", name:"Easton" },
  { pc:"343079", name:"Downingtown" }, { pc:"342144", name:"Westchester" }, { pc:"364295", name:"Lionville" },
  { pc:"365361", name:"Little Welsh" }, { pc:"310382", name:"Grant" }, { pc:"332941", name:"Bustleton" },
  { pc:"343497", name:"Red Lion" }, { pc:"302446", name:"Little Red Lion" }, { pc:"337079", name:"Holme Circle" },
  { pc:"345986", name:"Willits" }, { pc:"364412", name:"8200" }, { pc:"345489", name:"Oxford" },
  { pc:"336372", name:"Elkins Park" }, { pc:"358933", name:"Brace Rd" }, { pc:"354865", name:"Quakertown" },
  { pc:"353689", name:"Fort Washington" }, { pc:"342184", name:"Lansdale" }, { pc:"356316", name:"BJ's" },
];

const APIS = {
  p227: { host:'pos-ra.dunkindonuts.com', path:'/p227', xkey:'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL', apikey:'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=' },
  p228: { host:'pos-ra.dunkindonuts.com', path:'/p228', xkey:'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP', apikey:'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=' },
};
const STORE_P227 = '345986';
const apiRoute = pc => pc === STORE_P227 ? 'p227' : 'p228';

function postJSON(cfg, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = { hostname: cfg.host, port: 443, path: `${cfg.path}/${endpoint}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.xkey, 'Api-Key': cfg.apikey, 'Content-Length': Buffer.byteLength(data) } };
    const req = https.request(options, res => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => { if (res.statusCode>=200&&res.statusCode<300) { try { resolve(JSON.parse(raw)); } catch { resolve(null); } } else resolve(null); });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.write(data); req.end();
  });
}

// Real sellable menu items = top-level item lines only. Modifiers / build components are
// POS child lines (parDtlId set); tenders/tax/discounts have no menuItem. Must match
// itemCountForCheck() in pulse-hourly-snapshot.js so history and nightly values agree.
function itemCountForCheck(c) {
  return (c.detailLines || []).filter(d =>
    d.menuItem && !d.vdFlag && !d.errCorFlag && d.parDtlId == null && (d.dspQty || 0) > 0
  ).length;
}

async function upsellForDate(pc, busDt) {
  const cfg = APIS[apiRoute(pc)];
  const json = await postJSON(cfg, 'getGuestChecks', {
    locRef: pc, busDt,
    include: 'guestChecks.opnUTC,guestChecks.subTtl,guestChecks.chkTtl,guestChecks.detailLines',
  });
  const checks = json?.guestChecks || [];
  if (checks.length === 0) return null;
  let upsoldChecks = 0;
  for (const c of checks) if (itemCountForCheck(c) >= 2) upsoldChecks++;
  const totalChecks = checks.length;
  const upsellRate = Math.round((upsoldChecks / totalChecks) * 1000) / 10;
  return { upsoldChecks, totalChecks, upsellRate };
}

function getBlobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

(async () => {
  const store = getBlobStore();
  let updated = 0, skipped = 0;

  for (const s of STORES) {
    const key = `pcg_hourly_history_${s.pc}`;
    const raw = await store.get(key, { type: 'json' });
    const entries = Array.isArray(raw?.data) ? raw.data : [];
    if (entries.length === 0) { console.log(`${s.name}: no history`); skipped++; continue; }

    // Recompute EVERY stored day — existing upsellRate values used the old (inflated)
    // logic that counted modifier child-lines, so they must all be overwritten.
    const targets = entries.filter(e => e.date);
    let recomputed = 0, failed = 0;
    for (const entry of targets) {
      const result = await upsellForDate(s.pc, entry.date);
      // null = API failure/timeout or a day with zero checks. We must NOT silently keep
      // the old inflated value: stamp upsellStale so mixed old/new data is detectable,
      // and surface the count below instead of reporting a clean success.
      if (result) { Object.assign(entry, result); delete entry.upsellStale; recomputed++; }
      else if (typeof entry.upsellRate === 'number') { entry.upsellStale = true; failed++; }
    }

    await store.setJSON(key, { savedAt: new Date().toISOString(), data: entries });
    const latest = entries.find(e => typeof e.upsellRate === 'number');
    const warn = failed ? ` ⚠ ${failed} day(s) un-recomputed (stale value flagged)` : '';
    console.log(`${s.name}: recomputed ${recomputed}/${targets.length} days${warn}, latest upsellRate=${latest?.upsellRate ?? 'n/a'} (${latest?.date})`);
    updated++;
  }

  console.log(`\nDone. ${updated} stores updated, ${skipped} skipped.`);
})();
