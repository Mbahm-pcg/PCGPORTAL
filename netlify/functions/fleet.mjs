// PCG Portal — Fleet (company vehicles) read-only proxy.
// Read-only bridge to a separate Supabase project tracking company vehicles
// (registration/inspection/insurance due dates, operator, garaging address).
// The Portal never writes here — a separate pipeline outside this repo keeps
// the `cars` table synced. Uses Supabase's anon key with a public SELECT-only
// RLS policy on `cars`, same pattern as case-watch.mjs.
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
    return new Response(JSON.stringify({ error: 'Fleet is not configured (missing FLEET_SUPABASE_URL / FLEET_SUPABASE_ANON_KEY env vars)' }), { status: 500, headers });
  }

  try {
    const url = `${supabaseUrl}/rest/v1/cars?select=*&order=automobile_details.asc`;
    const res = await fetch(url, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return new Response(JSON.stringify({ error: `Fleet database returned HTTP ${res.status}`, detail: detail.slice(0, 300) }), { status: 502, headers });
    }
    const cars = await res.json();
    return new Response(JSON.stringify({ ok: true, cars }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
