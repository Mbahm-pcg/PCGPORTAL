// reports-photo-restore.mjs — exec/IT: read the last photo-restore result (scan / restore /
// undo), written by reports-photo-restore-background.mjs. Photo data is never returned.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';

const STATUS_KEY = 'pcg_reports_photo_restore_status';
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export default async (request) => {
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql());
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) return json({ error: 'Exec/IT session required.' }, 403);
  try {
    const raw = await getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN })
      .get(STATUS_KEY, { type: 'json' });
    return json({ status: raw?.data || null });
  } catch (e) { return json({ error: e.message }, 500); }
};
