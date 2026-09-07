// netlify/functions/health-lib/record-health.mjs
// Additive heartbeat helper. Key crons call recordHealth() so the monitor can
// enrich the matching feed with last-error text + run duration. Best-effort:
// any failure here is swallowed so it never breaks the calling cron.
import { getStore } from '@netlify/blobs';

const BEATS_KEY = 'pcg_system_health_beats_v1';

export async function recordHealth(name, { ok = true, error = null, durationMs = null } = {}) {
  try {
    const store = getStore({
      name: 'pcg-portal', consistency: 'strong',
      siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN,
    });
    const raw = await store.get(BEATS_KEY, { type: 'json' });
    const beats = (raw && raw.data) ? raw.data : {};
    beats[name] = {
      ok: !!ok,
      error: error ? String(error?.message || error) : null,
      durationMs: durationMs == null ? null : Number(durationMs),
      at: new Date().toISOString(),
    };
    await store.setJSON(BEATS_KEY, { savedAt: new Date().toISOString(), data: beats });
  } catch {
    /* heartbeat must never throw into the caller */
  }
}
