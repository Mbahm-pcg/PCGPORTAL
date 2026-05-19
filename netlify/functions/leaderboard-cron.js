// leaderboard-cron.js — Saturday 11:58 PM ET research
// Ranks stores by Sun–Sat WTD sales per district, saves results for Monday announcement.
// Uses per-store daily blobs to compute a true Sun–Sat week (matching Pulse week start).

const { getStore } = require('@netlify/blobs');

function getBlobStore() {
  return getStore({
    name: 'pcg-portal',
    consistency: 'strong',
    siteID: process.env.PCG_SITE_ID,
    token: process.env.PCG_AUTH_TOKEN,
  });
}

async function blobLoad(key) {
  try {
    const store = getBlobStore();
    const raw = await store.get(key, { type: 'json' });
    return raw?.data ?? raw ?? null;
  } catch { return null; }
}

async function blobSave(key, data) {
  const store = getBlobStore();
  await store.setJSON(key, { savedAt: new Date().toISOString(), data });
}

exports.handler = async () => {
  try {
    const labor = await blobLoad('pcg_labor_v1');
    if (!labor?.stores) {
      console.error('[leaderboard-cron] pcg_labor_v1 missing or empty');
      return { statusCode: 500, body: 'No labor data' };
    }

    // Week = Sunday 12:00 AM → Saturday 11:59 PM (matching Pulse week start)
    // Find the most recent Sunday regardless of what day this runs
    const now = new Date();
    const daysToSunday = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const sunday = new Date(now.getTime() - daysToSunday * 86400000);
    const weekOf = sunday.toISOString().slice(0, 10);
    const weekLabel = sunday.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

    // Build the 7 date strings: Sun through Sat
    const weekDates = Array.from({ length: 7 }, (_, i) =>
      new Date(sunday.getTime() + i * 86400000).toISOString().slice(0, 10)
    );

    // Load per-store daily blobs in parallel and sum Sun–Sat sales
    const storeEntries = Object.entries(labor.stores);
    const storeWTDs = await Promise.all(
      storeEntries.map(async ([pc, s]) => {
        const storeBlob = await blobLoad(`pcg_labor_store_${pc}`);
        const daily = storeBlob?.daily || [];
        const wtdSales = weekDates.reduce((sum, d) => {
          const entry = daily.find(e => e.date === d);
          return sum + (entry?.sales || 0);
        }, 0);
        return { pc, s, wtdSales };
      })
    );

    // Group by district, rank by Sun–Sat WTD sales
    const byDistrict = {};
    for (const { pc, s, wtdSales } of storeWTDs) {
      const dist = Number(s.district);
      if (!dist) continue;
      if (!byDistrict[dist]) byDistrict[dist] = [];
      byDistrict[dist].push({
        pc: String(pc),
        name: s.name || `Store ${pc}`,
        district: dist,
        wtdSales,
      });
    }

    // Sort each district by WTD sales descending, keep top 3
    const districts = {};
    for (const [dist, stores] of Object.entries(byDistrict)) {
      districts[dist] = stores
        .sort((a, b) => b.wtdSales - a.wtdSales)
        .slice(0, 3)
        .map((s, i) => ({ ...s, rank: i + 1 }));
    }

    const result = {
      weekOf,
      weekLabel,
      computedAt: new Date().toISOString(),
      districts,
    };

    await blobSave('pcg_leaderboard_latest', result);
    console.log(`[leaderboard-cron] Saved Sun–Sat rankings for week of ${weekOf} — ${Object.keys(districts).length} districts`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, weekOf, districts: Object.keys(districts).length }) };

  } catch (err) {
    console.error('[leaderboard-cron] error:', err);
    return { statusCode: 500, body: err.message };
  }
};
