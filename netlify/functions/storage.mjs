// PCG Portal — Cloud Storage via Netlify Blobs
// Handles save/load of scorecard data so it persists across devices & browsers

import { getStore } from '@netlify/blobs';

export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST')   return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  let payload;
  try { payload = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers }); }

  const { action, key, data } = payload;
  if (!action || !key) return new Response(JSON.stringify({ error: 'Missing action or key' }), { status: 400, headers });

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
      if (!data) return new Response(JSON.stringify({ error: 'Missing data' }), { status: 400, headers });
      await store.setJSON(safeKey, { savedAt: new Date().toISOString(), data });
      return new Response(JSON.stringify({ ok: true, key: safeKey }), { status: 200, headers });
    }

    if (action === 'load') {
      const result = await store.get(safeKey, { type: 'json' });
      if (!result) return new Response(JSON.stringify({ ok: true, data: null }), { status: 200, headers });
      return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers });
    }

    if (action === 'delete') {
      await store.delete(safeKey);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers });

  } catch (err) {
    console.error('Storage error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
