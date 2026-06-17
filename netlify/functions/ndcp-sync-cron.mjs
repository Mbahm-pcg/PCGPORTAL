// ndcp-sync-cron.mjs — scheduled incremental import of new NDCP order emails.
// Runs a few times a day (see config.schedule). Pulls recent `from:natdcp.com` mail,
// skips messages already stored, and upserts the rest. The one-time historical
// import is handled separately by ndcp-backfill.js; this keeps the table current.
//
// Like email-sync-cron, this is invoked by Netlify's scheduler (no bearer secret).
// It only reads NDCP mail and performs idempotent upserts, so a stray manual POST
// is harmless. Window is generous so multi-day revision chains are never missed.
import { google } from 'googleapis';
import { sql } from './_shared/db.js';
import { ensureTable, upsertMessage } from './ndcp-lib/ndcp-ingest.js';

export const config = { schedule: '0 */6 * * *' };

const WINDOW = 'newer_than:4d';

export default async (request) => {
  const isManual = request.method === 'POST';
  const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const MAILBOX = process.env.NDCP_MAILBOX || 'reports@peoplecapitalgroup.com';

  if (!SERVICE_ACCOUNT_KEY) {
    console.warn('[ndcp-sync] GOOGLE_SERVICE_ACCOUNT_KEY not set');
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 500 });
  }

  let credentials;
  try { credentials = JSON.parse(SERVICE_ACCOUNT_KEY); }
  catch { console.error('[ndcp-sync] invalid service account JSON'); return new Response(JSON.stringify({ error: 'bad credentials' }), { status: 500 }); }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    subject: MAILBOX,
  });
  const gmail = google.gmail({ version: 'v1', auth });

  try {
    const db = sql();
    await ensureTable(db);

    const ids = [];
    let pageToken;
    do {
      const res = await gmail.users.messages.list({ userId: MAILBOX, q: `from:natdcp.com ${WINDOW}`, maxResults: 100, pageToken });
      (res.data.messages || []).forEach((m) => ids.push(m.id));
      pageToken = res.data.nextPageToken;
    } while (pageToken && ids.length < 500);

    // Skip ids already stored so each run only fetches genuinely new mail.
    const existingRows = await db`SELECT message_id FROM ndcp_orders`;
    const existing = new Set(existingRows.map((r) => r.message_id));
    const todo = ids.filter((id) => !existing.has(id));

    let stored = 0, skipped = 0;
    for (const id of todo) {
      try {
        const msgRes = await gmail.users.messages.get({ userId: MAILBOX, id, format: 'full' });
        const r = await upsertMessage(db, msgRes.data);
        if (r.stored) stored++; else skipped++;
      } catch (e) {
        skipped++;
        console.warn(`[ndcp-sync] message ${id} failed: ${e.message}`);
      }
    }

    console.log(`[ndcp-sync] window=${WINDOW} found=${ids.length} new=${todo.length} stored=${stored} skipped=${skipped}`);
    return new Response(
      JSON.stringify({ ok: true, found: ids.length, new: todo.length, stored, skipped }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    console.error('[ndcp-sync] error:', e.message);
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
