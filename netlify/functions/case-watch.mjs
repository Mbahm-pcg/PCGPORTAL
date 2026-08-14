// PCG Portal — Case Watch complaint proxy
// Read-only bridge to the separate "Case Watch" project (dunkincert.netlify.app,
// repo: dunkin-case-tracker). That app owns the whole pipeline — syncing a
// Google Sheet of guest complaints into Supabase, deriving severity — the
// Portal never touches any of that, it only reads the resulting `cases` table.
// Uses Supabase's public anon key (same one Case Watch's own dashboard ships
// to every visitor client-side) — Row Level Security on that table only ever
// grants SELECT to the anon role, so this key can't write or see anything
// beyond what Case Watch's own public dashboard already shows.
//
// Scoped to the CURRENT calendar month only — the Portal's Complaints tab is
// meant to surface what's happening right now, not be a full complaint
// archive (Case Watch itself keeps full history at dunkincert.netlify.app).
// Every case is already tagged with the sheet tab it synced from (e.g.
// "August 2026"), so filtering to that exact tag rolls the view over to the
// new month automatically at midnight on the 1st — nothing is deleted, the
// Portal just stops showing prior months.
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function currentMonthTabName() {
  // Case Watch's sheet tabs are named for Eastern time, so match that here
  // rather than the function's UTC clock (would flip a few hours early/late).
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
}

export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  const supabaseUrl = process.env.CASE_WATCH_SUPABASE_URL;
  const anonKey = process.env.CASE_WATCH_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Case Watch is not configured (missing CASE_WATCH_SUPABASE_URL / CASE_WATCH_SUPABASE_ANON_KEY env vars)' }), { status: 500, headers });
  }

  const body = await request.json().catch(() => ({}));
  const { storePc, networkSummary, networkWorst } = body;
  if (!storePc && !networkSummary && !networkWorst) return new Response(JSON.stringify({ error: 'storePc required' }), { status: 400, headers });

  try {
    if (networkWorst) {
      // Network-wide "red" (worst-severity) board for the exec/IT/office-staff
      // Complaints tab (Operations hub) — every store's worst-tier cases for
      // the current month, full detail, so a comment thread can be attached.
      const url = `${supabaseUrl}/rest/v1/cases?sheet_tab=eq.${encodeURIComponent(currentMonthTabName())}&severity_label=eq.worst&select=*&order=date_in_sent.desc`;
      const res = await fetch(url, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return new Response(JSON.stringify({ error: `Case Watch returned HTTP ${res.status}`, detail: detail.slice(0, 300) }), { status: 502, headers });
      }
      const cases = await res.json();
      return new Response(JSON.stringify({ ok: true, cases }), { status: 200, headers });
    }

    if (networkSummary) {
      // Network-wide "which stores have the most complaints" leaderboard —
      // pull every store's cases for the current month tab (just the fields
      // needed to count/categorize) and aggregate here rather than per-store.
      const url = `${supabaseUrl}/rest/v1/cases?sheet_tab=eq.${encodeURIComponent(currentMonthTabName())}&select=store_pc,complaint_category,severity_label`;
      const res = await fetch(url, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return new Response(JSON.stringify({ error: `Case Watch returned HTTP ${res.status}`, detail: detail.slice(0, 300) }), { status: 502, headers });
      }
      const rows = await res.json();
      const byStore = new Map();
      for (const r of rows) {
        const pc = r.store_pc || 'unknown';
        if (!byStore.has(pc)) byStore.set(pc, { store_pc: pc, count: 0, categories: {}, worstCount: 0, concerningCount: 0 });
        const entry = byStore.get(pc);
        entry.count++;
        const cat = r.complaint_category || 'Uncategorized';
        entry.categories[cat] = (entry.categories[cat] || 0) + 1;
        if (r.severity_label === 'worst') entry.worstCount++;
        if (r.severity_label === 'concerning') entry.concerningCount++;
      }
      const leaderboard = [...byStore.values()].map(entry => {
        const sortedCategories = Object.entries(entry.categories).sort((a, b) => b[1] - a[1]);
        const topCategory = sortedCategories[0];
        return {
          store_pc: entry.store_pc, count: entry.count, worstCount: entry.worstCount, concerningCount: entry.concerningCount,
          topCategory: topCategory ? topCategory[0] : null, topCategoryCount: topCategory ? topCategory[1] : 0,
          categories: sortedCategories.map(([name, count]) => ({ name, count })),
        };
      }).sort((a, b) => b.count - a.count);
      return new Response(JSON.stringify({ ok: true, leaderboard, month: currentMonthTabName() }), { status: 200, headers });
    }

    const url = `${supabaseUrl}/rest/v1/cases?store_pc=eq.${encodeURIComponent(String(storePc))}&sheet_tab=eq.${encodeURIComponent(currentMonthTabName())}&order=severity_score.desc,date_in_sent.desc`;
    const res = await fetch(url, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return new Response(JSON.stringify({ error: `Case Watch returned HTTP ${res.status}`, detail: detail.slice(0, 300) }), { status: 502, headers });
    }
    const cases = await res.json();
    return new Response(JSON.stringify({ ok: true, cases }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
