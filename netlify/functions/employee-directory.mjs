// employee-directory.mjs — read-only search over the employee_directory
// table (synced by employee-directory-cron.mjs), scoped to one store.
// Any logged-in user may search (matches "everyone can file an incident
// report") — this only ever reveals name/DOB/email for people at a store
// the caller is already filing a report for, not new information.
import { neon } from '@neondatabase/serverless';
import { requireActiveUser } from './auth-lib/require-user.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

// Table is normally created by employee-directory-cron.mjs's own
// ensureTable — this guard just means a search hitting before the cron has
// ever run (fresh env, or a preview deploy) returns an empty result instead
// of a 500 "relation does not exist".
let _ready = false;
async function ensureTable(sql) {
  if (_ready) return;
  await sql`CREATE TABLE IF NOT EXISTS employee_directory (
    paycor_employee_id text PRIMARY KEY,
    employee_number   text,
    first_name        text,
    last_name         text,
    email             text,
    birth_date        text,
    status            text,
    store_pc          text,
    legal_entity_id   text,
    synced_at         timestamptz DEFAULT now()
  )`;
  _ready = true;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};

  try {
    const sql = db();
    await ensureTable(sql);
    const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql);
    if (!caller) return json(401, { error: 'Sign in required.' });

    if (action === 'search') {
      const storePc = String(payload.storePc || '').trim();
      const query = String(payload.query || '').trim();
      if (!storePc || query.length < 2) return json(200, { ok: true, matches: [] });
      const rows = await sql`
        SELECT paycor_employee_id, first_name, last_name, email, birth_date, status
        FROM employee_directory
        WHERE store_pc = ${storePc} AND (first_name || ' ' || last_name) ILIKE ${'%' + query + '%'}
        ORDER BY (status = 'Active') DESC, last_name, first_name
        LIMIT 10`;
      const matches = rows.map(r => ({
        paycorEmployeeId: r.paycor_employee_id, firstName: r.first_name, lastName: r.last_name,
        email: r.email, birthDate: r.birth_date, status: r.status,
      }));
      return json(200, { ok: true, matches });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('employee-directory.mjs error:', err);
    return json(500, { error: err.message });
  }
};
