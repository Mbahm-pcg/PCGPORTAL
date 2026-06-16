// PCG drive-time — proxies OSRM (public router, no key) to return real driving
// distance + time between two points. Used by the Locations "Closest to" tool.
// Fail-soft: errors return 200 with { error } so the UI just shows "unavailable".

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { from, to } = p;
  const ok = (x) => x && Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lng));
  if (!ok(from) || !ok(to)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'from/to {lat,lng} required' }) };

  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const route = j && j.routes && j.routes[0];
    if (!route) return { statusCode: 200, headers, body: JSON.stringify({ error: 'no route' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ miles: route.distance / 1609.344, minutes: route.duration / 60 }) };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: err.message || 'routing failed' }) };
  }
};
