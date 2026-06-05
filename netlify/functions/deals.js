// PCG Deal Pipeline — authenticated deal CRUD. Every request requires a valid
// deal session token; reads need 'view', writes need 'edit'.
const { sql } = require('./db');
const { verifyToken } = require('./deal-lib/token');
const { roleSatisfies } = require('./deal-lib/roles');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const reply = (code, obj) => ({ statusCode: code, headers: cors, body: JSON.stringify(obj) });

function authUser(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  // No `|| ''` fallback — fail closed if the secret is unset (the handler also guards this).
  return verifyToken(token, process.env.DEAL_SESSION_SECRET);
}

const STAGES = ['sourcing','loi_out','loi_executed','due_diligence','negotiating','executed','closing','ready_for_construction'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (!process.env.DEAL_SESSION_SECRET) return reply(500, { error: 'server not configured' });
  const user = authUser(event);
  if (!user) return reply(401, { error: 'unauthorized' });
  if (!roleSatisfies(user.role, 'view')) return reply(403, { error: 'forbidden' }); // explicit read gate

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'bad json' }); }
  const action = body.action;
  const db = sql();
  const needWrite = ['create','update','moveStage','handoff','markDead','addNote','addDate','updateDate','deleteDate','ackDate'].includes(action);
  if (needWrite && !roleSatisfies(user.role, 'edit')) return reply(403, { error: 'read-only access' });

  try {
    if (action === 'list') {
      const status = body.status || 'active';
      const rows = await db`SELECT * FROM deals WHERE status = ${status} ORDER BY updated_at DESC`;
      // Unacknowledged dates for the listed deals → lets the dashboard flag deadlines client-side.
      const dates = await db`
        SELECT * FROM deal_dates
        WHERE acknowledged_at IS NULL AND deal_id IN (SELECT id FROM deals WHERE status = ${status})
        ORDER BY due_date`;
      return reply(200, { deals: rows, dates });
    }
    if (action === 'get') {
      const [deal] = await db`SELECT * FROM deals WHERE id = ${body.id}`;
      if (!deal) return reply(404, { error: 'not found' });
      const dates = await db`SELECT * FROM deal_dates WHERE deal_id = ${body.id} ORDER BY due_date`;
      const notes = await db`SELECT * FROM deal_notes WHERE deal_id = ${body.id} ORDER BY created_at DESC`;
      return reply(200, { deal, dates, notes });
    }
    if (action === 'create') {
      const d = body.deal || {};
      const [row] = await db`
        INSERT INTO deals (name, address, city, state, deal_type, brand, deal_lead, broker_source, sqft, stage, created_by)
        VALUES (${d.name}, ${d.address || null}, ${d.city || null}, ${d.state || null}, ${d.deal_type}, ${d.brand || null},
                ${d.deal_lead || null}, ${d.broker_source || null}, ${d.sqft || null}, ${d.stage || 'sourcing'}, ${user.username})
        RETURNING *`;
      return reply(200, { deal: row });
    }
    if (action === 'update') {
      // Whitelist updatable columns to avoid SQL-injection via dynamic keys.
      const allowed = new Set(['name','address','city','state','deal_type','brand','pc_number','deal_lead','broker_source','sqft',
        'landlord_entity','landlord_contact','lease_structure','base_rent','rent_psf','escalations','term_years','renewal_options',
        'ti_allowance','free_rent','est_nnn_cam','cam_cap','cam_gross_up','cam_audit_window_days','percentage_rent','pct_rent_breakpoint',
        'guaranty_type','use_clause','exclusivity','radius_restriction','cotenancy','kickout','holdover','rofr_rofo','signage','parking',
        'delivery_condition','security_deposit','seller_entity','seller_contact','purchase_price','earnest_money','emd_hard',
        'title_escrow_co','lender','loan_terms','appraisal_status','phase1_status','survey_status','zoning_status','spe_entity']);
      const fields = Object.entries(body.deal || {}).filter(([k]) => allowed.has(k));
      for (const [k, v] of fields) {
        // k is from the fixed `allowed` whitelist (never user-controlled); v is parameterized.
        await db.query(`UPDATE deals SET ${k} = $1, updated_at = now() WHERE id = $2`, [v, body.id]);
      }
      const [row] = await db`SELECT * FROM deals WHERE id = ${body.id}`;
      return reply(200, { deal: row });
    }
    if (action === 'moveStage') {
      if (!STAGES.includes(body.stage)) return reply(400, { error: 'invalid stage' });
      const [row] = await db`UPDATE deals SET stage = ${body.stage}, updated_at = now() WHERE id = ${body.id} RETURNING *`;
      return reply(200, { deal: row });
    }
    if (action === 'handoff') {
      const [row] = await db`UPDATE deals SET status = 'handed_off', stage = 'ready_for_construction', updated_at = now() WHERE id = ${body.id} RETURNING *`;
      return reply(200, { deal: row });
    }
    if (action === 'markDead') {
      const [row] = await db`UPDATE deals SET status = 'dead', dead_reason = ${body.reason || null}, updated_at = now() WHERE id = ${body.id} RETURNING *`;
      return reply(200, { deal: row });
    }
    if (action === 'addNote') {
      await db`INSERT INTO deal_notes (deal_id, author, body) VALUES (${body.id}, ${user.username}, ${body.note})`;
      const notes = await db`SELECT * FROM deal_notes WHERE deal_id = ${body.id} ORDER BY created_at DESC`;
      return reply(200, { notes });
    }
    if (action === 'addDate') {
      const [row] = await db`
        INSERT INTO deal_dates (deal_id, date_type, due_date, warning_tiers, notes)
        VALUES (${body.deal_id}, ${body.date_type}, ${body.due_date}, ${JSON.stringify(body.warning_tiers || [])}::jsonb, ${body.notes || null})
        RETURNING *`;
      return reply(200, { date: row });
    }
    if (action === 'updateDate') {
      const [row] = await db`
        UPDATE deal_dates SET date_type = ${body.date_type}, due_date = ${body.due_date},
          warning_tiers = ${JSON.stringify(body.warning_tiers || [])}::jsonb, notes = ${body.notes || null}
        WHERE id = ${body.id} RETURNING *`;
      return reply(200, { date: row });
    }
    if (action === 'deleteDate') {
      await db`DELETE FROM deal_dates WHERE id = ${body.id}`;
      return reply(200, { ok: true });
    }
    if (action === 'ackDate') {
      const [row] = await db`UPDATE deal_dates SET acknowledged_by = ${user.username}, acknowledged_at = now() WHERE id = ${body.id} RETURNING *`;
      return reply(200, { date: row });
    }
    if (action === 'listAccess') {
      if (!roleSatisfies(user.role, 'admin')) return reply(403, { error: 'admin only' });
      const access = await db`SELECT user_key, role, added_by, added_at FROM deal_access ORDER BY role DESC, user_key`;
      return reply(200, { access });
    }
    if (action === 'setAccess') {
      if (!roleSatisfies(user.role, 'admin')) return reply(403, { error: 'admin only' });
      const key = String(body.user_key || '').trim().toLowerCase();
      const role = ['view', 'edit', 'admin'].includes(body.role) ? body.role : 'view';
      if (!key) return reply(400, { error: 'user_key required' });
      await db`INSERT INTO deal_access (user_key, role, added_by) VALUES (${key}, ${role}, ${user.username})
               ON CONFLICT (user_key) DO UPDATE SET role = ${role}, added_by = ${user.username}`;
      return reply(200, { ok: true });
    }
    if (action === 'removeAccess') {
      if (!roleSatisfies(user.role, 'admin')) return reply(403, { error: 'admin only' });
      const key = String(body.user_key || '').trim().toLowerCase();
      if (key === String(user.username || '').trim().toLowerCase()) return reply(400, { error: 'cannot remove yourself' });
      await db`DELETE FROM deal_access WHERE user_key = ${key}`;
      return reply(200, { ok: true });
    }
    return reply(400, { error: 'unknown action' });
  } catch (e) {
    return reply(500, { error: 'server error' });
  }
};
