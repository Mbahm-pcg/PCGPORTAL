// PCG Portal — Trusted 2FA Devices via Netlify Blobs
// POST { action: "trust",  userId, token, expiresAt } → register a trusted device
// POST { action: "check",  userId, token }            → returns { trusted: true/false }
// POST { action: "revoke", userId }                   → remove all trusted devices for a user

import { getStore } from '@netlify/blobs';

const BLOB_KEY = 'pcg_trusted_devices_v1';

const headers = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function getBlobStore() {
  return getStore({
    name: 'pcg-portal',
    consistency: 'strong',
    siteID: process.env.PCG_SITE_ID,
    token: process.env.PCG_AUTH_TOKEN,
  });
}

async function loadDevices(store) {
  const result = await store.get(BLOB_KEY, { type: 'json' });
  const now = Date.now();
  const devices = result?.data || {};
  // Prune expired entries on every read
  const fresh = Object.fromEntries(
    Object.entries(devices).filter(([, r]) => r.expiresAt > now)
  );
  return fresh;
}

export default async (request, context) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  let payload;
  try { payload = await request.json().catch(() => ({})); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers }); }

  const { action, userId, token, expiresAt } = payload;
  if (!action || !userId) return new Response(JSON.stringify({ error: 'Missing action or userId' }), { status: 400, headers });

  try {
    const store = await getBlobStore();

    if (action === 'check') {
      if (!token) return new Response(JSON.stringify({ trusted: false }), { status: 200, headers });
      const devices = await loadDevices(store);
      const record = devices[token];
      const trusted = !!(record && record.userId === userId && record.expiresAt > Date.now());
      return new Response(JSON.stringify({ trusted }), { status: 200, headers });
    }

    if (action === 'trust') {
      if (!token || !expiresAt) return new Response(JSON.stringify({ error: 'Missing token or expiresAt' }), { status: 400, headers });
      const maxExpiry = Date.now() + 8 * 24 * 60 * 60 * 1000; // server caps at 8 days
      const devices = await loadDevices(store);
      devices[token] = { userId, trustedAt: Date.now(), expiresAt: Math.min(expiresAt, maxExpiry) };
      await store.setJSON(BLOB_KEY, { savedAt: new Date().toISOString(), data: devices });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    if (action === 'revoke') {
      const devices = await loadDevices(store);
      const pruned = Object.fromEntries(
        Object.entries(devices).filter(([, r]) => r.userId !== userId)
      );
      await store.setJSON(BLOB_KEY, { savedAt: new Date().toISOString(), data: pruned });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers });

  } catch (err) {
    console.error('Trusted devices error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
