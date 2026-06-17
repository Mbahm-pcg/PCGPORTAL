// PCG drive-time — proxies OSRM (public router, no key) to return real driving
// distance + time between two points. Used by the Locations "Closest to" tool.
// Fail-soft: errors return 200 with { error } so the UI just shows "unavailable".

export default async (request, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  let p;
  try { p = await request.json().catch(() => ({})); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers }); }

  const { from, to } = p;
  const ok = (x) => x && Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lng));
  if (!ok(from) || !ok(to)) return new Response(JSON.stringify({ error: 'from/to {lat,lng} required' }), { status: 400, headers });

  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const route = j && j.routes && j.routes[0];
    if (!route) return new Response(JSON.stringify({ error: 'no route' }), { status: 200, headers });
    return new Response(JSON.stringify({ miles: route.distance / 1609.344, minutes: route.duration / 60 }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'routing failed' }), { status: 200, headers });
  }
};
