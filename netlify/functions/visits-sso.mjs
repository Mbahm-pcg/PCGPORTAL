// visits-sso.mjs — sign-in handoff to PCG Store Visits, the separate hidden visit tracker
// (v22.59). The tracker's "Sign in with the PCG portal" button opens this URL; if the browser
// is signed in to the portal as an executive or IT, it gets a 2-minute, single-use signed token
// and is sent to the tracker, which starts its own session. No one else gets through.
// The tracker's address lives only in env VISITS_TRACKER_URL (not in the portal's code/UI), and
// both sites share VISITS_SSO_SECRET.
import crypto from 'node:crypto';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';

const page = (status, text) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>PCG</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;line-height:1.5"><p>${text}</p></body>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

function sign(payload, secret, ttlSeconds) {
  const iat = Math.floor(Date.now() / 1000);
  const p = Buffer.from(JSON.stringify({ ...payload, iat, exp: iat + ttlSeconds })).toString('base64url');
  return `${p}.${crypto.createHmac('sha256', secret).update(p).digest('base64url')}`;
}

export default async (request) => {
  const target = process.env.VISITS_TRACKER_URL, secret = process.env.VISITS_SSO_SECRET;
  if (!target || !secret) return page(503, 'This sign-in is not set up yet.');
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return page(401, 'Sign in to the PCG portal first, then come back and press "Sign in with the PCG portal" again. <a href="/">Open the portal</a>');
  const role = authed.realUserType || authed.userType;
  if (role !== 'executive' && role !== 'it') return page(403, 'Your portal account does not have access to this page.');
  const me = (await db`SELECT name FROM users WHERE id = ${authed.sub}`)[0];
  const t = sign({ aud: 'pcg-visits', sub: authed.sub, name: me?.name || authed.name || authed.username || 'PCG user', role, nonce: crypto.randomBytes(16).toString('hex') }, secret, 120);
  return new Response(null, { status: 302, headers: { Location: `${target.replace(/\/$/, '')}/api/sso?t=${encodeURIComponent(t)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
};
