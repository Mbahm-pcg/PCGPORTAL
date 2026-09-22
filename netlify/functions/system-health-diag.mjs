// system-health-diag.mjs — TEMPORARY, read-only, exec/IT-gated diagnostic.
// system-health-cron.mjs is a scheduled function (Netlify blocks direct HTTP calls to those
// with an empty 403), so there's no way to observe its live recipients() output otherwise.
// Calls the exact same exported recipients() the cron uses — no separate logic, no writes.
// Remove once the System Health recipient-override investigation (2026-09-22) is closed.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { getStore } from '@netlify/blobs';
import { recipients } from './system-health-cron.mjs';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export default async (request) => {
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql());
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
    return json({ error: 'Exec/IT session required.' }, 403);
  }
  try {
    const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
    const raw = await store.get('pcg_system_health_notify_v1', { type: 'json' });
    const live = await recipients(sql());
    return json({ blobRaw: raw, liveRecipients: live });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
