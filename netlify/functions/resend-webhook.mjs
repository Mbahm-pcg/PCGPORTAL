// resend-webhook.mjs — Resend's email events for signing-link emails (v22.91).
//
// Resend → POST here for email.delivered / email.bounced / email.complained / email.opened. Only the
// signing-link emails (violation-sign.mjs saves each one's Resend id) are tracked; any other email's
// event is acknowledged and ignored. Shown on the Waiting on signature lists as a row of steps; a
// bounce also alerts whoever sent the link.
//
// Every request must carry a valid Resend (Svix) signature made with RESEND_WEBHOOK_SECRET (the
// "whsec_..." signing secret from the webhook's page in Resend). Unset secret → everything is refused.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from './_shared/db.mjs';
import { recordEmailEvent } from './violation-sign.mjs';

const TOLERANCE_S = 5 * 60;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function verify(secret, id, ts, sigHeader, body) {
  if (!secret || !id || !ts || !sigHeader) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest();
  return sigHeader.split(' ').some(part => {
    const [ver, sig] = part.split(',');
    if (ver !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await request.text();
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) { console.warn('[resend-webhook] RESEND_WEBHOOK_SECRET is not set — refusing'); return json(503, { error: 'not configured' }); }
  if (!verify(secret, request.headers.get('svix-id'), request.headers.get('svix-timestamp'), request.headers.get('svix-signature'), body)) return json(401, { error: 'bad signature' });
  let evt;
  try { evt = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
  const type = String(evt?.type || '');
  const emailId = evt?.data?.email_id;
  if (!emailId || !/^email\.(delivered|bounced|complained|opened)$/.test(type)) return json(200, { ok: true, ignored: true });
  try {
    const tracked = await recordEmailEvent(sql(), type, String(emailId), evt.data);
    return json(200, { ok: true, tracked });
  } catch (e) {
    console.error('[resend-webhook]', type, e.message);
    return json(500, { error: 'failed' }); // Resend retries
  }
};
