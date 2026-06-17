// analyst-cache.js — Blob-backed cache for KPI snapshots and analyst artifacts
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'pcg-portal';

function getBlobStore() {
  return getStore({
    name: STORE_NAME,
    consistency: 'strong',
    siteID: process.env.PCG_SITE_ID,
    token: process.env.PCG_AUTH_TOKEN,
  });
}

/** Save JSON to a blob key with timestamp wrapper */
async function cacheSave(key, data) {
  const store = getBlobStore();
  await store.setJSON(key, { savedAt: new Date().toISOString(), data });
}

/** Load JSON from a blob key, returns data (unwrapped) or null */
async function cacheLoad(key) {
  try {
    const store = getBlobStore();
    const raw = await store.get(key, { type: 'json' });
    return raw?.data || raw || null;
  } catch { return null; }
}

/** List blob keys matching a prefix */
async function cacheList(prefix) {
  try {
    const store = getBlobStore();
    const { blobs } = await store.list({ prefix });
    return blobs.map(b => b.key);
  } catch { return []; }
}

/** Delete a blob key */
async function cacheDelete(key) {
  try {
    const store = getBlobStore();
    await store.delete(key);
  } catch {}
}

export { cacheSave, cacheLoad, cacheList, cacheDelete, getBlobStore };
