// textbelt-reply.mjs — Textbelt posts SMS replies here (v23.27). We only text with a reply address for
// the leader-termination question (Mike / Sam / Krunal answer YES or NO), so that's all it handles.
//
// Security: nobody signs in here, so every request must carry Textbelt's signature —
// X-textbelt-signature = HMAC-SHA256(key: TEXTBELT_API_KEY, timestamp + raw JSON body), hex — and an
// X-textbelt-timestamp no more than 15 minutes old. Anything else is refused. Then the reply must
// come from a number that was asked about that termination (handleReply). Payload:
// { textId, fromNumber, text, data } where data is the webhookData we sent ("lt:<id>").
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from './_shared/db.mjs';
import { handleReply } from './_shared/leader-terminations.mjs';

const ok = (body = { ok: true }) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

export function verifyTextbelt(raw, timestamp, signature, key) {
  if (!key || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 15 * 60) return false;
  const want = createHmac('sha256', key).update(String(timestamp) + raw).digest('hex');
  const got = String(signature).trim().toLowerCase();
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const raw = await request.text();
  // v23.29: every call is logged (no content, no numbers) — so "did Textbelt post anything?" has an answer.
  console.log('[textbelt-reply] call', JSON.stringify({ bytes: raw.length, hasTimestamp: !!request.headers.get('x-textbelt-timestamp'), hasSignature: !!request.headers.get('x-textbelt-signature'), type: request.headers.get('content-type') || '' }));
  if (!verifyTextbelt(raw, request.headers.get('x-textbelt-timestamp'), request.headers.get('x-textbelt-signature'), process.env.TEXTBELT_API_KEY)) {
    console.warn('[textbelt-reply] refused: bad or missing signature');
    return new Response('Forbidden', { status: 403 });
  }
  let body = {};
  try { body = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }
  try {
    const r = await handleReply(sql(), body);
    console.log('[textbelt-reply]', JSON.stringify({ data: body.data, ...r }));
    return ok(r);
  } catch (e) {
    console.error('[textbelt-reply]', e.message);
    return ok({ error: 'handled' }); // 200 so Textbelt doesn't retry a reply we already acted on
  }
};
