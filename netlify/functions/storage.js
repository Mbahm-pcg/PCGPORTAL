// PCG Portal — Cloud Storage via Netlify Blobs
// Handles save/load of scorecard data so it persists across devices & browsers

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, key, data } = payload;
  if (!action || !key) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing action or key' }) };

  // Sanitize key — allow alphanumeric, underscore, hyphen, slash, dot (for path-style keys like analyst/briefs/...)
  const safeKey = key.replace(/[^a-zA-Z0-9_\-/.]/g, '_').slice(0, 128);

  try {
    const store = getStore({
      name: 'pcg-portal',
      consistency: 'strong',
      siteID: process.env.PCG_SITE_ID,
      token: process.env.PCG_AUTH_TOKEN,
    });

    if (action === 'save') {
      if (!data) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing data' }) };
      await store.setJSON(safeKey, { savedAt: new Date().toISOString(), data });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, key: safeKey }) };
    }

    if (action === 'load') {
      const result = await store.get(safeKey, { type: 'json' });
      if (!result) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data: null }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
    }

    if (action === 'delete') {
      await store.delete(safeKey);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error('Storage error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
