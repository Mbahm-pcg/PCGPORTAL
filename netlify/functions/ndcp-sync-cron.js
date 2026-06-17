// ndcp-sync-cron.js — scheduled incremental import of new NDCP order emails.
// Runs a few times a day (see netlify.toml). Pulls recent `from:natdcp.com` mail,
// skips messages already stored, and upserts the rest. The one-time historical
// import is handled separately by ndcp-backfill.js; this keeps the table current.
//
// Like email-sync-cron, this is invoked by Netlify's scheduler (no bearer secret).
// It only reads NDCP mail and performs idempotent upserts, so a stray manual POST
// is harmless. Window is generous so multi-day revision chains are never missed.
const { google } = require('googleapis');
const { sql } = require('./_shared/db');
const { ensureTable, upsertMessage } = require('./ndcp-lib/ndcp-ingest');

const WINDOW = 'newer_than:4d';

exports.handler = async (event) => {
  const isManual = event?.httpMethod === 'POST';
  const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const MAILBOX = process.env.NDCP_MAILBOX || 'reports@peoplecapitalgroup.com';

  if (!SERVICE_ACCOUNT_KEY) {
    console.warn('[ndcp-sync] GOOGLE_SERVICE_ACCOUNT_KEY not set');
    return isManual ? { statusCode: 500, body: JSON.stringify({ error: 'not configured' }) } : undefined;
  }

  let credentials;
  try { credentials = JSON.parse(SERVICE_ACCOUNT_KEY); }
  catch { console.error('[ndcp-sync] invalid service account JSON'); return isManual ? { statusCode: 500, body: JSON.stringify({ error: 'bad credentials' }) } : undefined; }

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
    return isManual
      ? { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, found: ids.length, new: todo.length, stored, skipped }) }
      : undefined;
  } catch (e) {
    console.error('[ndcp-sync] error:', e.message);
    return isManual ? { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) } : undefined;
  }
};
