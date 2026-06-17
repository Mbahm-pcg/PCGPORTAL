// tasks.js — Ops Task & Checklist system API (portal-native, Workpulse-independent).
// See docs/TASK_CHECKLIST_SYSTEM_PLAN.md.
//
// One endpoint, action-dispatched (like ndcp.js). Unauthenticated read/write consistent
// with the portal's other function endpoints; tab + role gating is done client-side.
// Backed by Neon Postgres. Tables are created on demand (ensureTable), no migration step.
//
// Actions
//   ── Manager / DM / Exec (consume) ──
//   list        {store_pc, date}          → today's instances for a store (+ status counts)
//   complete    {instance_id, value?, note?, by?, checklist?}  → mark an instance done
//   reopen      {instance_id}             → set an instance back to open
//   dashboard   {store_pc, date}          → per-category rollup for one store
//   rollup      {date, district?}         → per-store rollup (DM = their district, Exec = all 45)
//   ── Exec / IT (admin "Book Task") ──
//   admin_templates                       → all templates (+ assigned-location count)
//   admin_save_template  {template}       → create/update a template
//   admin_set_locations  {template_id, store_pcs[]}  → assign stores
//   admin_toggle_active  {template_id, active}
//   seed                                  → load the starter catalog (idempotent by name)

const { sql } = require('./db');
const { STORE_BY_PC } = require('./ndcp-lib/store-map');
const { CATALOG, SHIFT_WINDOWS } = require('./tasks-lib/catalog');

const ALLOWED_ORIGINS = ['https://uop.peoplecapitalgroup.com', 'https://pcg-ops.netlify.app'];
function corsFor(event) {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
}

// ── Date / time helpers (operate in ET, since stores + crons are ET) ──
function etNow() {
  // Date parts in America/New_York regardless of server TZ.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {}; for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, minute: +p.minute };
}
function dowOf(dateStr) { // 0=Sun..6=Sat, from 'YYYY-MM-DD' (noon avoids TZ edge)
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}
function daysSinceEpoch(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

// Compute display status from stored status + date + shift window (ET now).
function computeStatus(row, now) {
  if (row.status === 'completed') return 'completed';
  const isPast = row.business_date < now.date;
  if (isPast) return 'missed';
  if (row.business_date === now.date && row.shift_time) {
    const w = SHIFT_WINDOWS[row.shift_time];
    if (w && (now.hour > w.endHour || (now.hour === w.endHour && now.minute > w.endMin))) return 'overdue';
  }
  return 'open';
}

// Tally instance rows into status counts + pct. With keyFn, also returns per-group counts
// (key in `.key`). Shared by the list / dashboard / rollup actions so the four status
// buckets and pct math live in exactly one place.
function tally(rows, now, keyFn) {
  const blank = () => ({ open: 0, overdue: 0, missed: 0, completed: 0, all: 0 });
  const withPct = (o) => ({ ...o, pct: o.all ? Math.round((o.completed / o.all) * 100) : 0 });
  const totals = blank();
  const groups = {};
  for (const r of rows) {
    const s = computeStatus(r, now);
    totals[s]++; totals.all++;
    if (keyFn) {
      const k = keyFn(r) || 'Other';
      if (!groups[k]) groups[k] = { key: k, ...blank() };
      groups[k][s]++; groups[k].all++;
    }
  }
  return { totals: withPct(totals), groups: Object.values(groups).map(withPct) };
}

async function ensureTable(db) {
  await db`
    CREATE TABLE IF NOT EXISTS task_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      task_type TEXT DEFAULT 'shift',
      category TEXT,
      label TEXT,
      input_type TEXT DEFAULT 'checklist',
      frequency TEXT DEFAULT 'daily',
      shift_time TEXT,
      recur_days INT,
      target NUMERIC, min_val NUMERIC, max_val NUMERIC, unit TEXT,
      allow_signoff BOOL DEFAULT false,
      is_master BOOL DEFAULT false,
      active BOOL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS task_templates_name_idx ON task_templates(name)`;
  await db`
    CREATE TABLE IF NOT EXISTS task_template_locations (
      template_id INT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
      store_pc TEXT NOT NULL,
      PRIMARY KEY (template_id, store_pc)
    )`;
  await db`
    CREATE TABLE IF NOT EXISTS task_instances (
      id SERIAL PRIMARY KEY,
      template_id INT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
      store_pc TEXT NOT NULL,
      business_date DATE NOT NULL,
      shift_time TEXT,
      status TEXT DEFAULT 'open',
      value NUMERIC,
      note TEXT,
      checklist JSONB,
      completed_by TEXT, completed_at TIMESTAMPTZ,
      signed_off_by TEXT, signed_off_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (template_id, store_pc, business_date)
    )`;
  await db`CREATE INDEX IF NOT EXISTS task_instances_store_date_idx ON task_instances(store_pc, business_date)`;
}

// Lazily generate any missing instances for one or more stores on a date, from active,
// assigned, scheduled templates. Single set-based INSERT across ALL given stores (one
// round-trip total) — the schedule rule lives in SQL so the 45-store roll-up stays well
// under the function timeout. `general` recurrence is anchored to each template's creation
// day (so "every N days" is predictable from when it was set up, not the Unix epoch).
async function generateInstances(db, storePcs, dateStr) {
  const pcs = (Array.isArray(storePcs) ? storePcs : [storePcs]).map(String);
  if (!pcs.length) return;
  const dow = dowOf(dateStr);          // 0=Sun..6=Sat (weekly tasks fire on Monday=1)
  const dayNum = daysSinceEpoch(dateStr);
  await db`
    INSERT INTO task_instances (template_id, store_pc, business_date, shift_time)
    SELECT t.id, l.store_pc, ${dateStr}::date, t.shift_time
    FROM task_templates t
    JOIN task_template_locations l ON l.template_id = t.id
    WHERE t.active = true AND l.store_pc = ANY(${pcs})
      AND (
        t.frequency = 'daily'
        OR (t.frequency = 'weekly'  AND ${dow} = 1)
        OR (t.frequency = 'general' AND t.recur_days IS NOT NULL AND t.recur_days > 0
            AND ${dayNum} >= floor(extract(epoch FROM t.created_at) / 86400)
            AND ((${dayNum} - floor(extract(epoch FROM t.created_at) / 86400))::int % t.recur_days) = 0)
      )
    ON CONFLICT (template_id, store_pc, business_date) DO NOTHING`;
}

exports.handler = async (event) => {
  const cors = corsFor(event);
  const reply = (code, obj) => ({ statusCode: code, headers: cors, body: JSON.stringify(obj) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'bad json' }); }
  const action = body.action || 'list';
  const db = sql();

  try {
    await ensureTable(db);
    const now = etNow();

    // ───────────────────────── consume ─────────────────────────
    if (action === 'list') {
      const storePc = String(body.store_pc || '');
      const date = String(body.date || now.date);
      if (!storePc) return reply(400, { error: 'store_pc required' });
      await generateInstances(db, storePc, date);
      const rows = await db`
        SELECT i.id, i.template_id, i.store_pc, i.business_date::text AS business_date,
               i.shift_time, i.status, i.value, i.note, i.checklist,
               i.completed_by, i.completed_at, i.signed_off_by, i.signed_off_at,
               t.name, t.category, t.label, t.input_type, t.task_type,
               t.target, t.min_val, t.max_val, t.unit, t.allow_signoff
        FROM task_instances i JOIN task_templates t ON t.id = i.template_id
        WHERE i.store_pc = ${storePc} AND i.business_date = ${date}
        ORDER BY t.category, t.name`;
      const tasks = rows.map((r) => ({ ...r, statusComputed: computeStatus(r, now) }));
      const { totals } = tally(rows, now);
      return reply(200, { store_pc: storePc, date, counts: totals, tasks });
    }

    if (action === 'complete') {
      const id = +body.instance_id;
      if (!id) return reply(400, { error: 'instance_id required' });
      await db`
        UPDATE task_instances SET
          status = 'completed',
          value = ${body.value ?? null},
          note = ${body.note ?? null},
          checklist = ${body.checklist ? JSON.stringify(body.checklist) : null}::jsonb,
          completed_by = ${body.by ?? null},
          completed_at = now()
        WHERE id = ${id}`;
      return reply(200, { ok: true, instance_id: id });
    }

    if (action === 'reopen') {
      const id = +body.instance_id;
      if (!id) return reply(400, { error: 'instance_id required' });
      await db`UPDATE task_instances SET status='open', completed_by=null, completed_at=null WHERE id=${id}`;
      return reply(200, { ok: true, instance_id: id });
    }

    if (action === 'dashboard') {
      const storePc = String(body.store_pc || '');
      const date = String(body.date || now.date);
      if (!storePc) return reply(400, { error: 'store_pc required' });
      await generateInstances(db, storePc, date);
      const rows = await db`
        SELECT i.id, i.status, i.business_date::text AS business_date, i.shift_time, t.category
        FROM task_instances i JOIN task_templates t ON t.id = i.template_id
        WHERE i.store_pc = ${storePc} AND i.business_date = ${date}`;
      const { totals, groups } = tally(rows, now, (r) => r.category || 'Other');
      const categories = groups.map((g) => ({ category: g.key, open: g.open, overdue: g.overdue, missed: g.missed, completed: g.completed, all: g.all, pct: g.pct }))
        .sort((a, b) => b.all - a.all);
      return reply(200, { store_pc: storePc, date, totals, categories });
    }

    if (action === 'rollup') {
      const date = String(body.date || now.date);
      const district = body.district ? +body.district : null;
      const stores = Object.values(STORE_BY_PC).filter((s) => !district || s.district === district);
      await generateInstances(db, stores.map((s) => s.pc), date);
      const rows = await db`
        SELECT i.store_pc, i.status, i.business_date::text AS business_date, i.shift_time
        FROM task_instances i
        WHERE i.business_date = ${date}
          AND i.store_pc = ANY(${stores.map((s) => s.pc)})`;
      const { groups } = tally(rows, now, (r) => r.store_pc);
      const gmap = {}; groups.forEach((g) => { gmap[g.key] = g; });
      const list = stores.map((s) => {
        const g = gmap[s.pc] || { open: 0, overdue: 0, missed: 0, completed: 0, all: 0, pct: 0 };
        return { pc: s.pc, name: s.name, district: s.district, dmName: s.dmName, open: g.open, overdue: g.overdue, missed: g.missed, completed: g.completed, all: g.all, pct: g.pct };
      }).sort((a, b) => a.pct - b.pct);
      return reply(200, { date, district, stores: list });
    }

    // ───────────────────────── admin (Exec/IT) ─────────────────────────
    if (action === 'admin_templates') {
      const rows = await db`
        SELECT t.*, COALESCE(l.cnt, 0)::int AS location_count
        FROM task_templates t
        LEFT JOIN (SELECT template_id, count(*) cnt FROM task_template_locations GROUP BY template_id) l
          ON l.template_id = t.id
        ORDER BY t.category, t.name`;
      return reply(200, { templates: rows });
    }

    if (action === 'admin_save_template') {
      const x = body.template || {};
      if (!x.name) return reply(400, { error: 'name required' });
      if (x.id) {
        await db`
          UPDATE task_templates SET
            name=${x.name}, task_type=${x.task_type || 'shift'}, category=${x.category || null},
            label=${x.label || null}, input_type=${x.input_type || 'checklist'},
            frequency=${x.frequency || 'daily'}, shift_time=${x.shift_time || null}, recur_days=${x.recur_days ?? null},
            target=${x.target ?? null}, min_val=${x.min_val ?? null}, max_val=${x.max_val ?? null}, unit=${x.unit || null},
            allow_signoff=${!!x.allow_signoff}, is_master=${!!x.is_master}, active=${x.active !== false},
            updated_at=now()
          WHERE id=${+x.id}`;
        return reply(200, { ok: true, id: +x.id });
      }
      const ins = await db`
        INSERT INTO task_templates
          (name, task_type, category, label, input_type, frequency, shift_time, recur_days,
           target, min_val, max_val, unit, allow_signoff, is_master, active)
        VALUES
          (${x.name}, ${x.task_type || 'shift'}, ${x.category || null}, ${x.label || null},
           ${x.input_type || 'checklist'}, ${x.frequency || 'daily'}, ${x.shift_time || null}, ${x.recur_days ?? null},
           ${x.target ?? null}, ${x.min_val ?? null}, ${x.max_val ?? null}, ${x.unit || null},
           ${!!x.allow_signoff}, ${!!x.is_master}, ${x.active !== false})
        ON CONFLICT (name) DO UPDATE SET
          task_type=EXCLUDED.task_type, category=EXCLUDED.category, label=EXCLUDED.label,
          input_type=EXCLUDED.input_type, frequency=EXCLUDED.frequency, shift_time=EXCLUDED.shift_time,
          recur_days=EXCLUDED.recur_days, target=EXCLUDED.target, min_val=EXCLUDED.min_val,
          max_val=EXCLUDED.max_val, unit=EXCLUDED.unit, allow_signoff=EXCLUDED.allow_signoff,
          is_master=EXCLUDED.is_master, active=EXCLUDED.active, updated_at=now()
        RETURNING id`;
      return reply(200, { ok: true, id: ins[0].id });
    }

    if (action === 'admin_get_locations') {
      const id = +body.template_id;
      if (!id) return reply(400, { error: 'template_id required' });
      const rows = await db`SELECT store_pc FROM task_template_locations WHERE template_id = ${id}`;
      return reply(200, { template_id: id, store_pcs: rows.map((r) => r.store_pc) });
    }

    if (action === 'admin_set_locations') {
      const id = +body.template_id;
      const pcs = Array.isArray(body.store_pcs) ? body.store_pcs.map(String) : [];
      if (!id) return reply(400, { error: 'template_id required' });
      await db`DELETE FROM task_template_locations WHERE template_id = ${id}`;
      if (pcs.length) {
        await db`
          INSERT INTO task_template_locations (template_id, store_pc)
          SELECT ${id}, pc FROM unnest(${pcs}::text[]) AS pc
          ON CONFLICT DO NOTHING`;
      }
      return reply(200, { ok: true, template_id: id, count: pcs.length });
    }

    if (action === 'admin_toggle_active') {
      const id = +body.template_id;
      if (!id) return reply(400, { error: 'template_id required' });
      await db`UPDATE task_templates SET active=${!!body.active}, updated_at=now() WHERE id=${id}`;
      return reply(200, { ok: true, template_id: id, active: !!body.active });
    }

    if (action === 'seed') {
      const all45 = Object.values(STORE_BY_PC).map((s) => s.pc);
      // Two set-based statements (templates, then assignments) instead of ~1,800 per-row
      // inserts — keeps the one-time catalog load well under the 26s function timeout.
      const col = (k, map) => CATALOG.map((c) => (map ? map(c[k]) : c[k]) ?? null);
      await db`
        INSERT INTO task_templates
          (name, task_type, category, label, input_type, frequency, shift_time, recur_days,
           target, min_val, max_val, unit, allow_signoff, is_master, active)
        SELECT * FROM unnest(
          ${col('name')}::text[], ${col('task_type')}::text[], ${col('category')}::text[], ${col('label')}::text[],
          ${col('input_type')}::text[], ${col('frequency')}::text[], ${col('shift_time')}::text[], ${col('recur_days')}::int[],
          ${col('target')}::numeric[], ${col('min_val')}::numeric[], ${col('max_val')}::numeric[], ${col('unit')}::text[],
          ${col('allow_signoff', Boolean)}::bool[], ${col('is_master', Boolean)}::bool[], ${col('active', (v) => v !== false)}::bool[]
        )
        ON CONFLICT (name) DO UPDATE SET category=EXCLUDED.category`;
      const all45Names = CATALOG.filter((c) => c.all45).map((c) => c.name);
      let assigned = 0;
      if (all45Names.length) {
        await db`
          INSERT INTO task_template_locations (template_id, store_pc)
          SELECT t.id, pc
          FROM task_templates t
          CROSS JOIN unnest(${all45}::text[]) AS pc
          WHERE t.name = ANY(${all45Names}::text[])
          ON CONFLICT DO NOTHING`;
        assigned = all45Names.length * all45.length;
      }
      return reply(200, { ok: true, templates: CATALOG.length, assignments: assigned });
    }

    return reply(400, { error: 'unknown action: ' + action });
  } catch (e) {
    console.error('[tasks] error:', e.message);
    return reply(500, { error: 'server error', detail: e.message });
  }
};
