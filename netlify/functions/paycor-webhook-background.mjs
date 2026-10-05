// paycor-webhook-background.mjs — Receives Paycor's Time.Punch.Data webhook
// events and triggers a targeted tips reconcile for just the affected store,
// instead of waiting on the daily 3-day lookback window or the once-per-
// period finalize-gate settle pass (see tips-reconcile-cron.mjs). This is
// the real-time fix for "what about when a DM/manager manually enters it in
// Paycor" — a manual edit anywhere in an OPEN pay period, not just the last
// 3 days, now gets picked up within moments instead of possibly staying
// stale on an interim report pulled before the period closes.
//
// UNVERIFIED PAYLOAD SHAPE: built from Paycor's publicly documented event
// fields (EventType, EventId, LegalEntityId, ExtendedProperties,
// ChangedFields) found via research, NOT yet confirmed against a real
// captured delivery. Deliberately defensive: logs the full raw payload every
// time (so the first real deliveries teach us the exact shape), and only
// ever takes one bounded, cheap action (reconcile the last 3 ET days for one
// store) even if parsing comes back incomplete. A correction made further
// back than that is still caught by the existing finalize-gate settle pass
// at period close — this just closes the gap for the common case (a fix
// made close to when it's noticed), not every theoretically possible one.
//
// Signature verification: Paycor issues an Event Secret when a webhook
// subscription is registered. Until PAYCOR_WEBHOOK_SECRET is set (i.e.
// before the webhook is actually registered), verification is skipped with
// a loud warning — safe to deploy ahead of registration, but MUST be
// tightened (set the env var) once a real secret exists, or any POST to
// this public URL could trigger a reconcile.
//
// Background function (15-min budget, immediate 202 ack) rather than a
// synchronous one: Paycor's own retry behavior on a slow/failing webhook
// receiver is unconfirmed, and a 3-store-day reconcile can legitimately
// take longer than a synchronous gateway timeout would allow.
import crypto from 'node:crypto';
import { STORES, etDate, getBlobStore } from './tips-report-cron-background.mjs';
import { runReconcileForDates } from './tips-reconcile-cron.mjs';

const DEBOUNCE_MS = 60 * 1000;

function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.PAYCOR_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[paycor-webhook] PAYCOR_WEBHOOK_SECRET not set — skipping signature verification (only safe before the webhook is actually registered with Paycor)');
    return true;
  }
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(expected), b = Buffer.from(signatureHeader);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

export default async (request) => {
  const rawBody = await request.text();
  const signature = request.headers.get('x-paycor-signature') || request.headers.get('paycor-signature');
  console.log('[paycor-webhook] received payload:', rawBody.slice(0, 2000));

  if (!verifySignature(rawBody, signature)) {
    console.warn('[paycor-webhook] signature verification FAILED — ignoring event');
    return new Response(null, { status: 202 });
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch {
    console.warn('[paycor-webhook] could not parse JSON body — ignoring');
    return new Response(null, { status: 202 });
  }

  const legalEntityId = payload.LegalEntityId || payload.legalEntityId || payload.ExtendedProperties?.LegalEntityId;
  if (!legalEntityId) {
    console.warn('[paycor-webhook] no LegalEntityId found in payload — cannot map to a store, ignoring. Full payload logged above.');
    return new Response(null, { status: 202 });
  }

  const store = STORES.find(s => String(s.paycor) === String(legalEntityId));
  if (!store) {
    console.log(`[paycor-webhook] LegalEntityId ${legalEntityId} doesn't match any known tips store — ignoring (likely the office legal entity or an unmapped entity)`);
    return new Response(null, { status: 202 });
  }

  // Debounce: a single manual Paycor edit commonly fires more than one event
  // (e.g. a punch create followed by an update) within seconds of each
  // other — skip if a reconcile for this store already ran very recently.
  const blobStore = getBlobStore();
  const debounceKey = `pcg_webhook_debounce_${store.pc}`;
  try {
    const last = await blobStore.get(debounceKey, { type: 'text' });
    if (last && Date.now() - Number(last) < DEBOUNCE_MS) {
      console.log(`[paycor-webhook] debounced for ${store.name} (${store.pc}) — last triggered ${Date.now() - Number(last)}ms ago`);
      return new Response(null, { status: 202 });
    }
    await blobStore.set(debounceKey, String(Date.now()));
  } catch (e) { console.warn('[paycor-webhook] debounce check failed, proceeding anyway:', e.message); }

  const dates = [etDate(0), etDate(1), etDate(2)];
  try {
    const result = await runReconcileForDates(dates, store.pc, { sendEmail: false, budgetMs: 3 * 60 * 1000 });
    console.log(`[paycor-webhook] targeted reconcile for ${store.name} (${store.pc}) complete:`, JSON.stringify(result));
  } catch (e) {
    console.error(`[paycor-webhook] targeted reconcile for ${store.name} (${store.pc}) failed:`, e.message);
  }

  return new Response(null, { status: 202 });
};
