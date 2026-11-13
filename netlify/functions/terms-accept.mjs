// terms-accept.mjs — who accepted which version of the Portal's Terms of Use (v22.92).
//
//   GET  → { version, acceptedAt } for the signed-in user (null when never accepted)
//   POST { version } → records acceptance of that version (must be the current one) + audit_log
//
// The Portal asks once per TERMS_VERSION (app.jsx); changing terms.html → bump both constants.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';

export const TERMS_VERSION = '2026-11-13';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function ensureColumns(db) {
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version text`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz`;
}

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  try {
    await ensureColumns(db);
    if (request.method === 'GET') {
      const r = (await db`SELECT terms_version, terms_accepted_at FROM users WHERE id = ${authed.sub}`)[0] || {};
      return json(200, { current: TERMS_VERSION, version: r.terms_version || null, acceptedAt: r.terms_accepted_at || null });
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = await request.json().catch(() => ({}));
    if (body.version !== TERMS_VERSION) return json(409, { error: 'The terms changed — reload the page and read the current version.' });
    await db`UPDATE users SET terms_version = ${TERMS_VERSION}, terms_accepted_at = now() WHERE id = ${authed.sub}`;
    try {
      await db`INSERT INTO audit_log (type, user_id, user_role, action, metadata) VALUES ('terms', ${String(authed.sub)}, ${authed.realUserType || authed.userType || null}, 'terms_accepted',
        ${JSON.stringify({ version: TERMS_VERSION, username: authed.username || null, ip: request.headers.get('x-nf-client-connection-ip') || null, agent: String(request.headers.get('user-agent') || '').slice(0, 200) })})`;
    } catch (e) { console.warn('[terms-accept] audit', e.message); }
    return json(200, { ok: true, version: TERMS_VERSION });
  } catch (e) {
    console.error('[terms-accept]', e.message);
    return json(502, { error: 'Something went wrong — try again.' });
  }
};
