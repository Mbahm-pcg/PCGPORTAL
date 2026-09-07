// netlify/functions/system-health.mjs
// On-demand System Health recompute for the dashboard's "Refresh now".
// Exec/IT only (server-enforced). Same buildSnapshot as the cron, minus alerting.
import { getStore } from '@netlify/blobs';
import { buildSnapshot, FEEDS } from '../../src/system-health.mjs';
import { resolveCaller } from './_shared/auth.mjs';
import { sql } from './_shared/db.mjs';
import { sessionGate, requireUser } from './auth-lib/require-user.js';

const EXEC_ROLES = new Set(['executive', 'it']);
const SNAPSHOT_KEY = 'pcg_system_health_v1';
const BEATS_KEY = 'pcg_system_health_beats_v1';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
function json(status, body) { return new Response(JSON.stringify(body), { status, headers }); }

function healthStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return json(405, { error: 'POST only' });

  const payload = await request.json().catch(() => ({}));
  const { action = 'refresh' } = payload;

  const eventShim = { headers: { authorization: request.headers.get('authorization') || '', cookie: request.headers.get('cookie') || '' } };

  // Require a valid, non-revoked portal session; derive identity + role from the VERIFIED token.
  const authed = requireUser(eventShim);
  if (!authed) return json(401, { error: 'Sign in required.' });
  if (await sessionGate(eventShim, sql()) === 'revoked') return json(401, { error: 'Session ended. Please sign in again.' });
  const caller = await resolveCaller(authed.sub);
  if (!caller || !EXEC_ROLES.has(caller.role)) return json(403, { error: 'This information is limited to Exec/IT.' });

  const store = healthStore();

  if (action === 'get') {
    try { const raw = await store.get(SNAPSHOT_KEY, { type: 'json' }); return json(200, { ok: true, snapshot: (raw && raw.data) || null }); }
    catch { return json(200, { ok: true, snapshot: null }); }
  }

  // action === 'refresh' → live recompute.
  const nowMs = Date.now();

  // Only monitor operational stores (status === 'Open' in pcg_stores_v1). Non-operational
  // stores (Temp Closed / Remodel / Coming Soon) keep stale blobs and would be falsely
  // flagged. Missing blob → openPcs null → no filtering (fail-open). Mirrors the cron.
  let openPcs = null;
  try {
    const raw = await store.get('pcg_stores_v1', { type: 'json' });
    const list = (raw && raw.data) ? raw.data : null;
    if (Array.isArray(list)) openPcs = new Set(list.filter(s => s && s.status === 'Open').map(s => String(s.pc)));
  } catch { openPcs = null; }
  const keepOpen = (pcs) => (openPcs ? pcs.filter(pc => openPcs.has(pc)) : pcs);

  let activePcs = [];
  try { const { blobs } = await store.list({ prefix: 'pcg_labor_store_' }); activePcs = keepOpen(blobs.map(b => b.key.replace('pcg_labor_store_', ''))); } catch {}

  // Scope each per-store feed to the operational stores that actually have THAT feed's blob.
  const activePcsByKey = {};
  for (const f of FEEDS) {
    if (!f.perStore) continue;
    try {
      const { blobs } = await store.list({ prefix: f.blobKey });
      activePcsByKey[f.key] = keepOpen(blobs.map(b => b.key.slice(f.blobKey.length)));
    } catch { activePcsByKey[f.key] = []; }
  }

  const readSavedAt = async (key) => {
    try { const raw = await store.get(key, { type: 'json' }); if (!raw || !raw.savedAt) return null; const ms = Date.parse(raw.savedAt); return Number.isFinite(ms) ? ms : null; } catch { return null; }
  };
  let beats = {};
  try { const raw = await store.get(BEATS_KEY, { type: 'json' }); beats = (raw && raw.data) ? raw.data : {}; } catch {}

  const snapshot = await buildSnapshot({ readSavedAt, activePcs, activePcsByKey, nowMs, beats });
  return json(200, { ok: true, snapshot });
};
