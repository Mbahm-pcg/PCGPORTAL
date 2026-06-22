// audit-backfill.mjs — one-time migration helper.
// Copies legacy per-event access blobs (analyst/access/{date}/*) into the Neon
// audit_log table so the DB-backed audit log (v16.52) shows history that predates
// the cutover. Processes ONE date per call (bounded work, safe under the 26s
// limit) and is idempotent: it deletes that date's access rows before reinserting,
// so re-running a date never duplicates.
//   POST { date: 'YYYY-MM-DD' }  ->  { ok, date, found, inserted }
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';

const toInt = (v) => {
  if (v == null || v === '') return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : null;
};

export default async (request) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers });

  let body = {};
  try { body = await request.json(); } catch {}
  const date = body.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ error: 'Missing/invalid date (YYYY-MM-DD)' }), { status: 400, headers });
  }

  try {
    const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
    const db = sql();

    const { blobs } = await store.list({ prefix: `analyst/access/${date}/` });
    const raw = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
    // Legacy blobs are { savedAt, data: {event} }; tolerate any stored unwrapped.
    const events = raw.filter(Boolean).map(r => r.data || r).filter(e => e && (e.ts || e.action));

    // Idempotent: clear this date's access rows first so re-runs don't duplicate.
    await db`DELETE FROM audit_log WHERE type = 'access' AND created_at >= ${date}::date AND created_at < (${date}::date + INTERVAL '1 day')`;

    // Insert in bounded-concurrency chunks to stay fast without exhausting sockets.
    let inserted = 0;
    const CHUNK = 25;
    for (let i = 0; i < events.length; i += CHUNK) {
      await Promise.all(events.slice(i, i + CHUNK).map(e => db`
        INSERT INTO audit_log (type, user_id, user_role, action, district, status_code, latency_ms, error, metadata, created_at)
        VALUES ('access', ${e.userId ?? null}, ${e.userRole ?? null}, ${e.action ?? null}, ${toInt(e.district)}, ${toInt(e.statusCode)}, ${toInt(e.latencyMs)}, ${e.error ?? null}, ${e.meta ? JSON.stringify(e.meta) : null}::jsonb, ${e.ts || `${date}T12:00:00Z`}::timestamptz)
      `.then(() => { inserted++; }).catch((err) => { console.warn('backfill row failed:', err.message); })));
    }

    return new Response(JSON.stringify({ ok: true, date, found: events.length, inserted }), { status: 200, headers });
  } catch (err) {
    console.error('audit-backfill error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers });
  }
};
