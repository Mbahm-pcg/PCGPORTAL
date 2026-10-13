// employee-directory.mjs — read-only search over the employee_directory
// table (synced by employee-directory-cron.mjs), scoped to one store.
// Any logged-in user may search (matches "everyone can file an incident
// report") — this only ever reveals name/DOB/email for people at a store
// the caller is already filing a report for, not new information.
import { neon } from '@neondatabase/serverless';
import { requireActiveUser } from './auth-lib/require-user.js';
import { STORES, callPaycorProxy } from './tips-report-cron-background.mjs';

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

    // ── contact (v21.96) ─────────────────────────────────────────────────────
    // { paycorEmployeeId } -> { address, phone, email, birthDate } read LIVE from
    // Paycor's person record (View Person Addresses / Phone / Email scopes) for
    // the Incident Report's Subject Employee fields. Nothing is stored or logged.
    // The person record also carries SSN, gender, ethnicity, etc. — only the four
    // fields above are ever picked out; everything else is dropped right here.
    // Narrower than `search`: exec/IT/office staff any store, a DM only their
    // district's stores, a manager only their own store. The employee's store
    // comes from employee_directory (server-side), never from the request.
    if (action === 'contact') {
      const id = String(payload.paycorEmployeeId || '').trim();
      if (!/^[0-9a-f-]{20,}$/i.test(id)) return json(400, { error: 'Missing paycorEmployeeId' });
      const rows = await sql`SELECT store_pc FROM employee_directory WHERE paycor_employee_id = ${id} LIMIT 1`;
      if (!rows.length) return json(404, { error: 'Employee not found' });
      const storePc = String(rows[0].store_pc || '');
      const ut = caller.userType;
      let allowed = ut === 'executive' || ut === 'it' || ut === 'office_staff';
      if (!allowed && ut === 'dm') {
        const store = STORES.find(s => String(s.pc) === storePc);
        allowed = !!store && String(store.district) === String(caller.district);
      }
      if (!allowed && ut === 'manager') {
        const me = await sql`SELECT store_pc FROM users WHERE id = ${caller.sub}`;
        allowed = !!me.length && String(me[0].store_pc || '') === storePc;
      }
      if (!allowed) return json(403, { error: 'Not allowed for this store' });

      const emp = JSON.parse(await callPaycorProxy('raw', { path: `/employees/${id}?include=All` }) || '{}');
      const personPath = String(emp?.person?.url || '').replace(/^.*\/v1(?=\/)/, '');
      let person = {};
      if (personPath.startsWith('/')) {
        person = JSON.parse(await callPaycorProxy('raw', { path: `${personPath}${personPath.includes('?') ? '&' : '?'}include=All` }) || '{}');
      }
      const addrs = Array.isArray(person.addresses) ? person.addresses : [];
      const a = addrs.find(x => /home|primary|resident/i.test(x?.type || '')) || addrs[0] || null;
      const address = a ? [
        [a.streetLine1, a.streetLine2, a.suite].filter(Boolean).join(' '),
        a.city, [a.state, a.zipCode].filter(Boolean).join(' '),
      ].filter(Boolean).join(', ') : '';
      const phones = Array.isArray(person.phones) ? person.phones : [];
      const p = phones.find(x => /mobile|cell/i.test(x?.type || '')) || phones.find(x => /home/i.test(x?.type || '')) || phones[0] || null;
      let phone = '';
      if (p) {
        const digits = `${p.areaCode || ''}${p.phoneNumber || p.subscriberNumber || ''}`.replace(/\D/g, '');
        phone = digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : [p.areaCode, p.phoneNumber].filter(Boolean).join(' ');
      }
      const email = person?.email?.emailAddress || emp?.email?.emailAddress || '';
      const birthDate = person?.demographicData?.birthDate ? String(person.demographicData.birthDate).slice(0, 10) : '';
      return json(200, { ok: true, contact: { address, phone, email, birthDate } });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('employee-directory.mjs error:', err);
    return json(500, { error: err.message });
  }
};
