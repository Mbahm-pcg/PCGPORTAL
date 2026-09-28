// google-service-account-email.mjs — TEMPORARY, read-only, exec/IT-gated.
// Reveals ONLY the service account's client_email from the existing
// GOOGLE_SERVICE_ACCOUNT_KEY env var — never the private_key or any other
// field. Needed so IT knows exactly which address to share a Drive
// folder/Shared Drive with (Editor access) for the incident-report Drive
// backup feature. Remove once that sharing step is done.
import { requireActiveUser } from './auth-lib/require-user.js';
import { neon } from '@neondatabase/serverless';

const db = () => neon(process.env.NEON_DATABASE_URL);

export default async (request) => {
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db());
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
    return new Response(JSON.stringify({ error: 'Exec/IT session required.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return new Response(JSON.stringify({ error: 'GOOGLE_SERVICE_ACCOUNT_KEY not set' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  let clientEmail;
  try {
    const parsed = JSON.parse(raw);
    clientEmail = parsed.client_email || null;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not parse GOOGLE_SERVICE_ACCOUNT_KEY', detail: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ ok: true, clientEmail }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
