// PCG Portal — Address autocomplete suggestions via Nominatim (OpenStreetMap).
// Returns up to 5 US address suggestions for a partial query string.
// No API key required. Proxied server-side to set a proper User-Agent.

import https from 'node:https';

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function fetchJSON(url, reqHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: reqHeaders }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, 5000);
  });
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: HEADERS });
  }

  let payload;
  try { payload = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: HEADERS }); }

  const query = (payload.query || '').trim();
  if (query.length < 3) {
    return new Response(JSON.stringify({ suggestions: [] }), { status: 200, headers: HEADERS });
  }

  const qs = new URLSearchParams({
    q: query,
    format: 'json',
    addressdetails: '1',
    countrycodes: 'us',
    limit: '8',
    dedupe: '1',
    // Bounding box covering PA + NJ: left,top,right,bottom = minLon,maxLat,maxLon,minLat
    viewbox: '-80.52,42.27,-73.89,38.93',
    bounded: '1',
  });

  const url = `https://nominatim.openstreetmap.org/search?${qs.toString()}`;

  try {
    const results = await fetchJSON(url, {
      'User-Agent': 'PCGPortal/1.0 (internal ops tool; pcg-ops.netlify.app)',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en',
      'Referer': 'https://pcg-ops.netlify.app',
    });

    const PA_NJ = new Set(['pennsylvania', 'new jersey']);

    const suggestions = (results || [])
      .filter(r => r.lat && r.lon)
      .filter(r => PA_NJ.has((r.address?.state || '').toLowerCase()))
      .map(r => {
        const a = r.address || {};
        const parts = [
          [a.house_number, a.road].filter(Boolean).join(' '),
          a.city || a.town || a.village || a.suburb || a.county || '',
          a.state || '',
          a.postcode || '',
        ].filter(Boolean);
        const label = parts.length >= 2 ? parts.join(', ') : r.display_name;
        return { label, lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
      })
      .filter((s, i, arr) => arr.findIndex(x => x.label === s.label) === i) // dedupe labels
      .slice(0, 5);

    return new Response(JSON.stringify({ suggestions }), { status: 200, headers: HEADERS });
  } catch (err) {
    console.error('[geocode-suggest] error:', err);
    return new Response(JSON.stringify({ suggestions: [] }), { status: 200, headers: HEADERS });
  }
};
