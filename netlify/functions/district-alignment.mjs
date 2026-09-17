// PCG Portal — District Alignment sandbox. Holds a draft copy of district/DM
// assignments, completely separate from the real `stores`/`users` data — see
// docs/superpowers/specs/2026-09-17-district-alignment-design.md. Editing
// actions (added in a later task) are exec/IT only; `get` is open to any
// signed-in user (the whole point is everyone can view it).
import { neon } from '@neondatabase/serverless';
import { getStore } from '@netlify/blobs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { buildSeedFromLive } from './district-alignment-lib/seed.mjs';

const BLOB_KEY = 'pcg_district_alignment_v1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

function blobStore() {
  return getStore({
    name: 'pcg-portal',
    consistency: 'strong',
    siteID: process.env.PCG_SITE_ID,
    token: process.env.PCG_AUTH_TOKEN,
  });
}

async function loadDraft() {
  const wrapped = await blobStore().get(BLOB_KEY, { type: 'json' });
  return wrapped?.data || null;
}
async function saveDraft(draft) {
  await blobStore().setJSON(BLOB_KEY, { savedAt: new Date().toISOString(), data: draft });
}

function isFullAdminClaims(claims) {
  return !!claims && (claims.userType === 'executive' || claims.userType === 'it');
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};
  if (!action) return json(400, { error: 'Missing action' });

  const eventShim = {
    headers: {
      authorization: request.headers.get('authorization') || '',
      cookie: request.headers.get('cookie') || '',
    },
  };

  try {
    const sql = db();
    const claims = await requireActiveUser(eventShim, sql);
    if (!claims) return json(401, { error: 'Sign in required' });

    if (action === 'get') {
      let draft = await loadDraft();
      if (!draft) {
        if (!Array.isArray(payload.liveStores)) {
          return json(400, { error: 'No draft exists yet — first call must include liveStores to seed from' });
        }
        draft = buildSeedFromLive(payload.liveStores);
        await saveDraft(draft);
      }
      return json(200, { ok: true, draft });
    }

    if (action === 'reset') {
      if (!isFullAdminClaims(claims)) return json(403, { error: 'Exec/IT only' });
      if (!Array.isArray(payload.liveStores)) return json(400, { error: 'Missing liveStores' });
      const draft = buildSeedFromLive(payload.liveStores);
      await saveDraft(draft);
      return json(200, { ok: true, draft });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('district-alignment.mjs error:', err);
    return json(500, { error: err.message });
  }
};
