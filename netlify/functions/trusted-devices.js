// PCG Portal — Trusted 2FA Devices via Netlify Blobs
// POST { action: "trust",  userId, token, expiresAt } → register a trusted device
// POST { action: "check",  userId, token }            → returns { trusted: true/false }
// POST { action: "revoke", userId }                   → remove all trusted devices for a user

const { getStore } = require('@netlify/blobs');

const BLOB_KEY = 'pcg_trusted_devices_v1';

const headers = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function getStore_() {
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, userId, token, expiresAt } = payload;
  if (!action || !userId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing action or userId' }) };

  try {
    const store = await getStore_();

    if (action === 'check') {
      if (!token) return { statusCode: 200, headers, body: JSON.stringify({ trusted: false }) };
      const devices = await loadDevices(store);
      const record = devices[token];
      const trusted = !!(record && record.userId === userId && record.expiresAt > Date.now());
      return { statusCode: 200, headers, body: JSON.stringify({ trusted }) };
    }

    if (action === 'trust') {
      if (!token || !expiresAt) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing token or expiresAt' }) };
      const maxExpiry = Date.now() + 8 * 24 * 60 * 60 * 1000; // server caps at 8 days
      const devices = await loadDevices(store);
      devices[token] = { userId, trustedAt: Date.now(), expiresAt: Math.min(expiresAt, maxExpiry) };
      await store.setJSON(BLOB_KEY, { savedAt: new Date().toISOString(), data: devices });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'revoke') {
      const devices = await loadDevices(store);
      const pruned = Object.fromEntries(
        Object.entries(devices).filter(([, r]) => r.userId !== userId)
      );
      await store.setJSON(BLOB_KEY, { savedAt: new Date().toISOString(), data: pruned });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error('Trusted devices error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
