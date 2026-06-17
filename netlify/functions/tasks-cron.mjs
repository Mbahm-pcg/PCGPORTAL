// tasks-cron.mjs — Daily pre-generation of task instances for all 45 stores.
// Runs at 9 AM UTC (5 AM ET / 4 AM EDT) before stores open so DM/Exec roll-ups
// are populated before any manager opens the app. Idempotent (ON CONFLICT DO NOTHING).
// See docs/TASK_CHECKLIST_SYSTEM_PLAN.md.

import { sql } from './_shared/db.mjs';
import { STORE_BY_PC } from './ndcp-lib/store-map.js';

function etDate() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return f.format(new Date());
}

function dowOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

function daysSinceEpoch(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export default async (_req, _ctx) => {
  const db = sql();
  const date = etDate();
  const dow = dowOf(date);
  const dayNum = daysSinceEpoch(date);
  const allPcs = Object.values(STORE_BY_PC).map((s) => s.pc);

  const result = await db`
    INSERT INTO task_instances (template_id, store_pc, business_date, shift_time)
    SELECT t.id, l.store_pc, ${date}::date, t.shift_time
    FROM task_templates t
    JOIN task_template_locations l ON l.template_id = t.id
    WHERE t.active = true AND l.store_pc = ANY(${allPcs})
      AND (
        t.frequency = 'daily'
        OR (t.frequency = 'weekly'  AND ${dow} = 1)
        OR (t.frequency = 'general' AND t.recur_days IS NOT NULL AND t.recur_days > 0
            AND ${dayNum} >= floor(extract(epoch FROM t.created_at) / 86400)
            AND ((${dayNum} - floor(extract(epoch FROM t.created_at) / 86400))::int % t.recur_days) = 0)
      )
    ON CONFLICT (template_id, store_pc, business_date) DO NOTHING`;

  const generated = result.count ?? 0;
  console.log(`[tasks-cron] ${date}: generated ${generated} new instances across ${allPcs.length} stores`);

  return new Response(JSON.stringify({ ok: true, date, generated, stores: allPcs.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
