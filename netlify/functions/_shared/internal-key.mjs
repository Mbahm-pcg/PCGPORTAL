// @ts-check
// _shared/internal-key.mjs — how our own server functions prove a call came from us (v23.37).
// Some jobs call /.netlify/functions/paycor over the web (tips report, employee directory). They send
// `x-pcg-internal: <key>`; the key is derived from DEAL_SESSION_SECRET, which only our functions
// have — so it can't be guessed or sent by a browser, and it's never shown or logged.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const INTERNAL_HEADER = 'x-pcg-internal';

export function internalKey() {
  const s = process.env.DEAL_SESSION_SECRET;
  return s ? createHmac('sha256', s).update('pcg-internal-call|paycor|v1').digest('hex') : '';
}

/** @param {Request} request */
export function isInternalCall(request) {
  const got = String(request.headers.get(INTERNAL_HEADER) || '');
  const want = internalKey();
  return !!want && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
