// netlify/functions/system-health.mjs
// On-demand System Health recompute for the dashboard's "Refresh now".
// Exec/IT only (server-enforced). Same buildSnapshot as the cron, minus alerting.
import { getStore } from '@netlify/blobs';
import { buildSnapshot } from '../../src/system-health.mjs';
import { resolveCaller } from './_shared/auth.mjs';
import { sql } from './_shared/db.mjs';
import { sessionGate } from './auth-lib/require-user.js';

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
  const { action = 'refresh', userId, userRole } = payload;

  // Auth gate (mirrors analyst.mjs): revoked session → 401; non-exec/IT → 403.
  const eventShim = { headers: { authorization: request.headers.get('authorization') || '', cookie: request.headers.get('cookie') || '' } };
  if (await sessionGate(eventShim, sql()) === 'revoked') return json(401, { error: 'Session ended. Please sign in again.' });
  const caller = await resolveCaller(userId);
  const effRole = caller?.role || userRole;
  if (!EXEC_ROLES.has(effRole)) return json(403, { error: 'This information is limited to Exec/IT.' });

  const store = healthStore();

  if (action === 'get') {
    try { const raw = await store.get(SNAPSHOT_KEY, { type: 'json' }); return json(200, { ok: true, snapshot: (raw && raw.data) || null }); }
    catch { return json(200, { ok: true, snapshot: null }); }
  }

  // action === 'refresh' → live recompute.
  const nowMs = Date.now();
  let activePcs = [];
  try { const { blobs } = await store.list({ prefix: 'pcg_labor_store_' }); activePcs = blobs.map(b => b.key.replace('pcg_labor_store_', '')); } catch {}
  const readSavedAt = async (key) => {
    try { const raw = await store.get(key, { type: 'json' }); if (!raw || !raw.savedAt) return null; const ms = Date.parse(raw.savedAt); return Number.isFinite(ms) ? ms : null; } catch { return null; }
  };
  let beats = {};
  try { const raw = await store.get(BEATS_KEY, { type: 'json' }); beats = (raw && raw.data) ? raw.data : {}; } catch {}

  const snapshot = await buildSnapshot({ readSavedAt, activePcs, nowMs, beats });
  return json(200, { ok: true, snapshot });
};
