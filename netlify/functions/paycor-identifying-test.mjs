// paycor-identifying-test.mjs — TEMPORARY, read-only, exec/IT-gated.
// Confirms whether the newly-enabled Paycor "View Legal Entity Employees
// Identifying Data" / "...SSN and BirthDate" scopes are actually reachable
// through the CURRENT refresh token yet, or whether that token still needs to
// be re-issued via Paycor's activation flow to pick up the new scope.
// Never echoes a real birthDate value — only proves whether one came back.
// Remove once the real DOB-autofill feature is built (or once we've confirmed
// re-activation is required and moved on to that).
import { requireActiveUser } from './auth-lib/require-user.js';
import { neon } from '@neondatabase/serverless';

const db = () => neon(process.env.NEON_DATABASE_URL);

// Warrington — pc 337839 / Paycor legal entity 193888 — small store, fine for
// a one-shot feasibility check.
const TEST_LEGAL_ENTITY_ID = '193888';

export default async (request) => {
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db());
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
    return new Response(JSON.stringify({ error: 'Exec/IT session required.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  const target = new URL('/.netlify/functions/paycor', request.url);
  let body = {};
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: request.headers.get('cookie') || '',
        authorization: request.headers.get('authorization') || '',
      },
      body: JSON.stringify({ action: 'identifyingData', legalEntityId: TEST_LEGAL_ENTITY_ID }),
    });
    body = await res.json().catch(() => ({}));
    var httpStatus = res.status;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Request to paycor.mjs failed', detail: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const safe = {
    httpStatus,
    paycorStatus: body.status ?? null,
    count: body.count ?? 0,
    sampleHasBirthDate: !!(Array.isArray(body.records) && body.records[0]?.birthDate),
    rawError: body.error ?? undefined,
  };
  return new Response(JSON.stringify(safe), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
