// PCG Portal — Address → {lat,lng} via the free US Census one-line geocoder.
// No API key; US-wide. CORS-gated. Manual lat/lng is the client-side fallback.
// Modern Netlify Functions (V2) runtime: default export, web Request/Response.

import https from 'node:https';

const CENSUS_HOST = 'geocoding.geo.census.gov';
const CENSUS_PATH = '/geocoder/locations/onelineaddress';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Census ${res.statusCode}`));
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: HEADERS });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: HEADERS });
  }

  let payload;
  try { payload = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: HEADERS }); }

  const address = (payload.address || '').trim();
  if (!address) return new Response(JSON.stringify({ error: 'Missing address' }), { status: 400, headers: HEADERS });

  const qs = new URLSearchParams({
    address,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
  const url = `https://${CENSUS_HOST}${CENSUS_PATH}?${qs.toString()}`;

  try {
    const json = await fetchJSON(url);
    const match = json && json.result && json.result.addressMatches && json.result.addressMatches[0];
    if (!match || !match.coordinates) {
      return new Response(JSON.stringify({ matched: false }), { status: 200, headers: HEADERS });
    }
    // Census returns coordinates as { x: longitude, y: latitude }.
    return new Response(JSON.stringify({
      matched: true,
      lat: match.coordinates.y,
      lng: match.coordinates.x,
      matchedAddress: match.matchedAddress || address,
    }), { status: 200, headers: HEADERS });
  } catch (err) {
    console.error('geocode error:', err);
    return new Response(JSON.stringify({ matched: false, error: err.message }), { status: 502, headers: HEADERS });
  }
};
