// PCG Deal Pipeline — authenticated deal CRUD. Every request requires a valid
// deal session token; reads need 'view', writes need 'edit'.
import https from 'node:https';
import { sql } from './_shared/db.mjs';
import { getStore } from '@netlify/blobs';
import { verifyToken } from './deal-lib/token.js';
import { roleSatisfies } from './deal-lib/roles.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const reply = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: cors });

function authUser(request) {
  const raw = request.headers.get('authorization') || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  // No `|| ''` fallback — fail closed if the secret is unset (the handler also guards this).
  return verifyToken(token, process.env.DEAL_SESSION_SECRET);
}

const STAGES = ['sourcing','loi_out','loi_executed','due_diligence','negotiating','executed','closing','ready_for_construction'];

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!process.env.DEAL_SESSION_SECRET) return reply(500, { error: 'server not configured' });
  const user = authUser(request);
  if (!user) return reply(401, { error: 'unauthorized' });
  if (!roleSatisfies(user.role, 'view')) return reply(403, { error: 'forbidden' }); // explicit read gate

  let body; try { body = await request.json(); } catch { return reply(400, { error: 'bad json' }); }
  const action = body.action;
  const db = sql();
  // Lightweight system-event log into deal_notes (kind='system'). Best-effort: never throw.
  const logSystem = async (dealId, text) => {
    try { await db`INSERT INTO deal_notes (deal_id, author, body, kind) VALUES (${dealId}, ${user.username}, ${text}, 'system')`; } catch {}
  };
  const STAGE_LABELS = { sourcing:'Sourcing', loi_out:'LOI Out', loi_executed:'LOI Executed', due_diligence:'Due Diligence', negotiating:'Negotiating', executed:'Executed', closing:'Closing', ready_for_construction:'Ready for Construction' };
  const needWrite = ['create','update','moveStage','handoff','markDead','addNote','addDate','updateDate','deleteDate','ackDate','sendReminder'].includes(action);
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
      const [prev] = await db`SELECT stage FROM deals WHERE id = ${body.id}`;
      const [row] = await db`UPDATE deals SET stage = ${body.stage}, updated_at = now() WHERE id = ${body.id} RETURNING *`;
      if (row) {
        const fromLbl = prev ? (STAGE_LABELS[prev.stage] || prev.stage) : '?';
        await logSystem(body.id, `Stage moved: ${fromLbl} → ${STAGE_LABELS[body.stage] || body.stage}`);
      }
      return reply(200, { deal: row });
    }
    if (action === 'handoff') {
      const [row] = await db`UPDATE deals SET status = 'handed_off', stage = 'ready_for_construction', updated_at = now() WHERE id = ${body.id} RETURNING *`;
      if (row) await logSystem(body.id, 'Handed off to Construction (Ready for Construction)');
      return reply(200, { deal: row });
    }
    if (action === 'markDead') {
      const [row] = await db`UPDATE deals SET status = 'dead', dead_reason = ${body.reason || null}, updated_at = now() WHERE id = ${body.id} RETURNING *`;
      if (row) await logSystem(body.id, `Marked dead${body.reason ? ': ' + String(body.reason).slice(0, 280) : ''}`);
      return reply(200, { deal: row });
    }
    if (action === 'addNote') {
      await db`INSERT INTO deal_notes (deal_id, author, body, kind) VALUES (${body.id}, ${user.username}, ${body.note}, 'user')`;
      const notes = await db`SELECT * FROM deal_notes WHERE deal_id = ${body.id} ORDER BY created_at DESC`;
      return reply(200, { notes });
    }
    if (action === 'addDate') {
      const recurring = ['monthly', 'quarterly', 'annual'].includes(body.recurring) ? body.recurring : null;
      const [row] = await db`
        INSERT INTO deal_dates (deal_id, date_type, due_date, warning_tiers, recurring, notes)
        VALUES (${body.deal_id}, ${body.date_type}, ${body.due_date}, ${JSON.stringify(body.warning_tiers || [])}::jsonb, ${recurring}, ${body.notes || null})
        RETURNING *`;
      return reply(200, { date: row });
    }
    if (action === 'updateDate') {
      const recurring = ['monthly', 'quarterly', 'annual'].includes(body.recurring) ? body.recurring : null;
      // Reset de-dup state on edit (due_date/tiers may change → the date should be free to re-alert).
      const [row] = await db`
        UPDATE deal_dates SET date_type = ${body.date_type}, due_date = ${body.due_date},
          warning_tiers = ${JSON.stringify(body.warning_tiers || [])}::jsonb, recurring = ${recurring}, notes = ${body.notes || null},
          alerted_tiers = '[]'::jsonb
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
    if (action === 'listLeads') {
      const leads = await db`SELECT id, name FROM deal_leads ORDER BY name`;
      // Resolve each lead's phone from the pcg_users_v1 blob by case-insensitive name match.
      let users = [];
      try {
        const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
        const w = await store.get('pcg_users_v1', { type: 'json' });
        const d = w?.data || w; users = Array.isArray(d) ? d : (d?.users || []);
      } catch {}
      const phoneByName = {};
      for (const u of users) {
        const nm = String(u.name || '').trim().toLowerCase();
        const ph = String(u.phone || '').replace(/\D/g, '');
        if (nm && ph && !phoneByName[nm]) phoneByName[nm] = ph; // first non-empty wins
      }
      const withPhones = leads.map(l => ({ ...l, phone: phoneByName[String(l.name || '').trim().toLowerCase()] || null }));
      return reply(200, { leads: withPhones });
    }
    if (action === 'addLead') {
      if (!roleSatisfies(user.role, 'admin')) return reply(403, { error: 'admin only' });
      const name = String(body.name || '').trim();
      if (!name) return reply(400, { error: 'name required' });
      await db`INSERT INTO deal_leads (name, added_by) VALUES (${name}, ${user.username}) ON CONFLICT (name) DO NOTHING`;
      const leads = await db`SELECT id, name FROM deal_leads ORDER BY name`;
      return reply(200, { leads });
    }
    if (action === 'removeLead') {
      if (!roleSatisfies(user.role, 'admin')) return reply(403, { error: 'admin only' });
      await db`DELETE FROM deal_leads WHERE id = ${body.id}`;
      const leads = await db`SELECT id, name FROM deal_leads ORDER BY name`;
      return reply(200, { leads });
    }
    if (action === 'sendReminder') {
      const rawPhone = String(body.phone || '').replace(/\D/g, '');
      const msg = String(body.message || '').slice(0, 600);
      if (!rawPhone || !msg) return reply(400, { error: 'phone and message required' });
      const KEY = process.env.TEXTBELT_API_KEY;
      let smsOk = false, smsInfo = { error: 'TEXTBELT_API_KEY not set' };
      if (KEY) {
        let cleaned = rawPhone; if (cleaned.length === 10) cleaned = '1' + cleaned;
        const postData = new URLSearchParams({ phone: '+' + cleaned, message: msg, key: KEY }).toString();
        smsInfo = await new Promise((resolve) => {
          const req = https.request({ hostname: 'textbelt.com', port: 443, path: '/text', method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) } },
            (res) => { let raw = ''; res.on('data', d => raw += d); res.on('end', () => { let j = {}; try { j = JSON.parse(raw); } catch {} resolve(j); }); });
          req.on('error', (e) => resolve({ success: false, error: e.message }));
          req.write(postData); req.end();
        });
        smsOk = !!smsInfo.success;
      }
      // Audit note (logged whether the send succeeded or failed). author + created_at recorded by the table.
      const noteBody = `📱 SMS reminder ${smsOk ? 'sent' : 'FAILED'} to ${body.phone || rawPhone} — "${msg}"`;
      await db`INSERT INTO deal_notes (deal_id, author, body) VALUES (${body.deal_id}, ${user.username}, ${noteBody})`;
      const notes = await db`SELECT * FROM deal_notes WHERE deal_id = ${body.deal_id} ORDER BY created_at DESC`;
      return reply(smsOk ? 200 : 207, { ok: smsOk, sms: smsInfo, notes });
    }
    return reply(400, { error: 'unknown action' });
  } catch (e) {
    return reply(500, { error: 'server error' });
  }
};
