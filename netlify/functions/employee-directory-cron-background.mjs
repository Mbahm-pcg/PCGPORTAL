// employee-directory-cron-background.mjs — daily sync of Name + Paycor ID +
// DOB + work email into the employee_directory table, per store. Feeds the
// Incident Report's Subject Employee type-ahead (employee-directory.mjs's
// search action). Read-only from Paycor's side — this never writes back.
//
// Named "-background" (not just "employee-directory-cron.mjs") after a real
// manually-triggered run hit a hard 60000ms timeout partway through 45+
// stores × 2 Paycor calls each — confirmed 2026-09-28 via Netlify's own
// function log showing a suspiciously round Duration: 60000 ms. Same fix
// tips-report-cron-background.mjs already needed for the identical shape of
// problem (many stores × Paycor calls routinely exceeds the standard
// timeout) — the "-background" filename suffix is what grants the 15-minute
// execution budget.
import { neon } from '@neondatabase/serverless';
import { STORES } from './labor-cron.mjs';
import { fetchAllEmployees, fetchAllIdentifyingData } from './tips-report-cron-background.mjs';
import { buildDirectoryRows } from '../../src/employee-directory.mjs';

export const config = { schedule: '0 8 * * *' }; // 4am ET

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

let _ready = false;
async function ensureTable() {
  if (_ready) return;
  const sql = db();
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
  await sql`CREATE INDEX IF NOT EXISTS idx_employee_directory_store ON employee_directory(store_pc)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_employee_directory_name ON employee_directory(store_pc, last_name, first_name)`;
  _ready = true;
}

async function upsertRows(rows) {
  if (!rows.length) return;
  const sql = db();
  const stmts = rows.map(r => sql`
    INSERT INTO employee_directory (
      paycor_employee_id, employee_number, first_name, last_name, email, birth_date, status, store_pc, legal_entity_id, synced_at
    ) VALUES (
      ${r.paycorEmployeeId}, ${r.employeeNumber}, ${r.firstName}, ${r.lastName}, ${r.email}, ${r.birthDate}, ${r.status}, ${r.storePc}, ${r.legalEntityId}, now()
    )
    ON CONFLICT (paycor_employee_id) DO UPDATE SET
      employee_number = EXCLUDED.employee_number, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
      email = EXCLUDED.email, birth_date = EXCLUDED.birth_date, status = EXCLUDED.status,
      store_pc = EXCLUDED.store_pc, legal_entity_id = EXCLUDED.legal_entity_id, synced_at = EXCLUDED.synced_at`);
  await sql.transaction(stmts);
}

export default async () => {
  await ensureTable();
  const results = [];
  for (const store of STORES) {
    try {
      const [employees, identifying] = await Promise.all([
        fetchAllEmployees(store.paycor),
        fetchAllIdentifyingData(store.paycor),
      ]);
      const rows = buildDirectoryRows(employees, identifying, store.pc, store.paycor);
      await upsertRows(rows);
      results.push({ store: store.pc, count: rows.length, ok: true });
    } catch (e) {
      console.warn('[employee-directory-cron-background] store failed:', store.pc, e.message);
      results.push({ store: store.pc, ok: false, error: e.message });
    }
  }
  const ok = results.filter(r => r.ok).length;
  console.log(`[employee-directory-cron-background] synced ${ok}/${STORES.length} stores`);
  return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
