// PCG Portal — Address → {lat,lng} via the free US Census one-line geocoder.
// No API key; US-wide. CORS-gated. Manual lat/lng is the client-side fallback.
// Uses the https module to match the other external-proxy functions (philly-data.js, pulse.js).

const https = require('https');

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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const address = (payload.address || '').trim();
  if (!address) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing address' }) };

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
      return { statusCode: 200, headers, body: JSON.stringify({ matched: false }) };
    }
    // Census returns coordinates as { x: longitude, y: latitude }.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        matched: true,
        lat: match.coordinates.y,
        lng: match.coordinates.x,
        matchedAddress: match.matchedAddress || address,
      }),
    };
  } catch (err) {
    console.error('geocode error:', err);
    return { statusCode: 502, headers, body: JSON.stringify({ matched: false, error: err.message }) };
  }
};
