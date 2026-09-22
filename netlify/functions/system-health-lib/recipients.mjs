// netlify/functions/system-health-lib/recipients.mjs
// Who gets a System Health alert (email/push): the admin-managed override list in
// Admin > Notifications > System Health once it's been saved, otherwise every active
// exec/IT user. readOverride is injected so this is testable without real Netlify Blobs.
//
// IMPORTANT: a failure reading the override blob is NOT the same as "no override was ever
// configured" and must NOT be treated the same way. Falling back to "every active exec/IT
// user" on a read hiccup would silently defeat someone's deliberate narrowing of this list —
// confirmed as the likely cause of a 2026-09-22 incident where a saved 2-person override was
// bypassed for one alert. readOverride errors are left to propagate; the caller (already
// built for a DB outage) skips sending for that round and leaves the re-alert guard unarmed,
// so the next run retries once the read succeeds again — instead of blasting everyone.
import { getStore } from '@netlify/blobs';

const NOTIFY_KEY = 'pcg_system_health_notify_v1';

export async function defaultReadOverride() {
  const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
  const raw = await store.get(NOTIFY_KEY, { type: 'json' });
  return raw && raw.data;
}

export async function recipients(db, readOverride = defaultReadOverride) {
  const cfg = await readOverride();
  if (cfg && cfg.updatedAt) {
    const emails = Array.isArray(cfg.emails) ? cfg.emails.filter(Boolean) : [];
    const pushIds = (Array.isArray(cfg.emailOwners) ? cfg.emailOwners : []).filter(id => id != null).map(String);
    return { pushIds, emails };
  }
  // No override has ever been saved (readOverride resolved, just found nothing) — every
  // active exec/IT user. A readOverride() that THROWS does not reach this line.
  const rows = await db`SELECT id, email FROM users WHERE user_type IN ('executive','it') AND active = true`;
  return { pushIds: rows.map(r => String(r.id)), emails: rows.map(r => r.email).filter(Boolean) };
}
