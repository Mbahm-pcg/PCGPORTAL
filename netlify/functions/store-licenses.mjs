// PCG Portal — Store Licenses read-only proxy.
// Read-only bridge to the same "Auto-details" Supabase project fleet.mjs
// already reads from (uijfbuzumzxuercjcsia) — a separate `store_licenses`
// table there is kept synced with each store's food license expiration date
// by pc_number. The Portal never writes here. Uses the same anon key /
// public SELECT-only RLS policy pattern as fleet.mjs and case-watch.mjs.
export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  const supabaseUrl = process.env.FLEET_SUPABASE_URL;
  const anonKey = process.env.FLEET_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Store licenses is not configured (missing FLEET_SUPABASE_URL / FLEET_SUPABASE_ANON_KEY env vars)' }), { status: 500, headers });
  }

  try {
    const url = `${supabaseUrl}/rest/v1/store_licenses?select=*`;
    const res = await fetch(url, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return new Response(JSON.stringify({ error: `Store licenses returned HTTP ${res.status}`, detail: detail.slice(0, 300) }), { status: 502, headers });
    }
    const licenses = await res.json();
    return new Response(JSON.stringify({ ok: true, licenses }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
