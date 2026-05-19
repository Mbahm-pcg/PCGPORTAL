// leaderboard-announce-cron.js — Monday 12:00 AM ET
// Reads leaderboard results and posts targeted announcements to pcg_announcements_v1

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

function rankEmoji(rank) {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉';
}

function fmtSales(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

exports.handler = async () => {
  try {
    const leaderboard = await blobLoad('pcg_leaderboard_latest');
    if (!leaderboard?.districts) {
      console.error('[leaderboard-announce] No leaderboard data found');
      return { statusCode: 500, body: 'No leaderboard data' };
    }

    const { weekOf, weekLabel, districts } = leaderboard;
    const now = new Date().toISOString();
    const announcements = (await blobLoad('pcg_announcements_v1')) || [];
    const newAnnouncements = [];

    // ── Per-district announcements (one per district) ─────────────────
    for (const [dist, stores] of Object.entries(districts)) {
      if (!stores || stores.length === 0) continue;
      const distNum = Number(dist);

      const storeLines = stores.map(s =>
        `${rankEmoji(s.rank)}  ${s.name} — ${fmtSales(s.wtdSales)}`
      ).join('\n');

      const title = `🏆 District ${distNum} Top Performers — Week of ${weekLabel}`;
      const message = `Weekly sales rankings for District ${distNum}:\n\n${storeLines}\n\nKeep pushing — great work this week! 💪`;

      newAnnouncements.push({
        id: `lb_d${distNum}_${weekOf}`,
        type: 'leaderboard',
        title,
        message,
        weekOf,
        createdAt: now,
        createdBy: 'Orion',
        active: true,
        targets: {
          districts: [distNum],
          roles: ['executive', 'it'],
        },
      });
    }

    // ── Exec/IT network-wide announcement ────────────────────────────
    const districtLines = Object.entries(districts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([dist, stores]) => {
        const top = stores[0];
        return top
          ? `District ${dist}  →  ${top.name} — ${fmtSales(top.wtdSales)}`
          : null;
      })
      .filter(Boolean)
      .join('\n');

    newAnnouncements.push({
      id: `lb_exec_${weekOf}`,
      type: 'leaderboard',
      title: `🏆 Weekly District Champions — Week of ${weekLabel}`,
      message: `District winners for the week:\n\n${districtLines}\n\nOutstanding performance across the network! 🎉`,
      weekOf,
      createdAt: now,
      createdBy: 'Orion',
      active: true,
      targets: {
        roles: ['executive', 'it'],
      },
    });

    // Remove any old leaderboard announcements from previous weeks, keep new ones
    const filtered = announcements.filter(a => a.type !== 'leaderboard' || a.weekOf === weekOf);
    const merged = [...newAnnouncements, ...filtered];

    await blobSave('pcg_announcements_v1', merged);
    console.log(`[leaderboard-announce] Posted ${newAnnouncements.length} announcements for week of ${weekOf}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, weekOf, count: newAnnouncements.length }) };

  } catch (err) {
    console.error('[leaderboard-announce] error:', err);
    return { statusCode: 500, body: err.message };
  }
};
