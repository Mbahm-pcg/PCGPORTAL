// maint-actions.mjs — Orion maintenance tool-use: the action tools the maintenance
// assistant can call (close/comment/assign/reschedule/add-expense/create-followup)
// plus their executor. Writes go straight to the same Neon tables the Tickets UI
// reads (maint_tickets / maint_ticket_comments / maint_ticket_expenses) via targeted
// SQL, and drop a 'system' comment on the ticket so the activity log shows what Orion
// did and on whose behalf. Every action is reversible (close↔reopen, comments/expenses
// deletable). Permission is re-checked here as defense-in-depth.

import https from 'node:https';
import { sql } from '../_shared/db.mjs';
import { cacheLoad } from './analyst-cache.mjs';
import { findStoreByPcOrName } from './analyst-data.mjs';

// ── Anthropic tool schemas ──────────────────────────────────────────────────
const MAINT_TOOLS = [
  {
    name: 'update_ticket_status',
    description: "Change a ticket's status. Use 'In Progress' when starting work, 'Closed' when the job is done, 'Open' to reopen a closed ticket.",
    input_schema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'Ticket number (e.g. T-0003) or numeric id exactly as shown on the board.' },
        status: { type: 'string', enum: ['Open', 'In Progress', 'Closed'], description: 'The new status.' },
      },
      required: ['ticket', 'status'],
    },
  },
  {
    name: 'add_ticket_comment',
    description: "Add a comment / note to a ticket's activity log (e.g. what you checked, what you found).",
    input_schema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'Ticket number or id.' },
        text: { type: 'string', description: 'The comment text.' },
      },
      required: ['ticket', 'text'],
    },
  },
  {
    name: 'assign_ticket',
    description: 'Set who owns / is assigned to a ticket.',
    input_schema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'Ticket number or id.' },
        assignee: { type: 'string', description: "The person's name, or 'me' to assign it to the current user." },
      },
      required: ['ticket', 'assignee'],
    },
  },
  {
    name: 'set_ticket_due_date',
    description: "Set or change a ticket's due date (reschedule).",
    input_schema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'Ticket number or id.' },
        due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format. Resolve relative dates (today/tomorrow/Friday) to an actual date first.' },
      },
      required: ['ticket', 'due_date'],
    },
  },
  {
    name: 'add_ticket_expense',
    description: 'Log an expense (parts, materials, supplies) against a ticket.',
    input_schema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'Ticket number or id.' },
        amount: { type: 'number', description: 'Dollar amount, e.g. 45.20.' },
        description: { type: 'string', description: 'What the expense was for, e.g. "Plantronics headset battery".' },
        category: { type: 'string', description: 'Optional category, e.g. Parts, Tools, Vendor.' },
      },
      required: ['ticket', 'amount', 'description'],
    },
  },
  {
    name: 'create_followup_ticket',
    description: 'Create a new follow-up maintenance ticket for a store.',
    input_schema: {
      type: 'object',
      properties: {
        store_pc: { type: 'string', description: 'The store PC# the ticket is for.' },
        title: { type: 'string', description: 'Short title for the ticket.' },
        category: { type: 'string', description: 'Optional category (e.g. Equipment Repair, POS, Plumbing).' },
        priority: { type: 'string', enum: ['Low', 'Medium', 'High'], description: 'Optional priority (default Medium).' },
        description: { type: 'string', description: 'Optional details.' },
      },
      required: ['store_pc', 'title'],
    },
  },
];

const WRITE_ROLES = new Set(['maintenance', 'executive', 'it']);
const initialsOf = (name) => (name || '?').split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);

async function resolveActorName(db, actorId) {
  if (actorId == null) return null;
  try { const r = await db`SELECT name FROM users WHERE id = ${actorId}`; return r[0]?.name || null; } catch { return null; }
}

// ── Ticket-creation email (Resend) ──────────────────────────────────────────
// The manual UI path (AdminTickets' sendTicketNotification in app.jsx) sends an email
// on every new ticket; Orion's create_followup_ticket writes straight to Postgres and
// had no equivalent, so tickets it created never notified anyone. Mirrors the same
// recipient logic (admin notify list + the store's own email) server-side.
function sendResendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>',
      to,
      subject,
      html,
    });
    const req = https.request({
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

async function sendTicketCreatedEmail(ticket, actor) {
  if (!process.env.RESEND_API_KEY) return;
  let notifyEmails = [];
  let stores = [];
  try { notifyEmails = (await cacheLoad('pcg_ticket_notify_v1')) || []; } catch {}
  try { stores = (await cacheLoad('pcg_stores_v1')) || []; } catch {}
  const storeEmail = stores.find((s) => String(s.pc) === String(ticket.storePC))?.email || null;
  const to = [...notifyEmails.filter((e) => e && e.includes('@')), ...(storeEmail ? [storeEmail] : [])];
  if (!to.length) return;

  const prioColor = { High: '#ef4444', Medium: '#f59e0b', Low: '#22c55e' }[ticket.priority] || '#aaa';
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;">
      <p style="font-size:13px;color:#666;">Created by Orion, on behalf of ${actor}.</p>
      <h2 style="margin:0 0 8px;">${ticket.number} — ${ticket.title}</h2>
      <span style="display:inline-block;background:${prioColor}18;color:${prioColor};border-radius:20px;padding:4px 13px;font-size:11px;font-weight:700;">${ticket.priority} Priority</span>
      ${ticket.description ? `<p style="margin:16px 0;color:#374151;">${ticket.description}</p>` : ''}
      <p style="font-size:13px;color:#666;">Store: ${ticket.storeName || ('PC ' + ticket.storePC)}${ticket.category ? ` &middot; ${ticket.category}` : ''}</p>
    </div>`;
  try { await sendResendEmail(to, `[PCG Ticket ${ticket.number}] ${ticket.title} — ${ticket.storeName || ticket.storePC}`, html); }
  catch { /* best-effort */ }
}

async function findTicket(db, ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  let rows = await db`SELECT id, number, title, status, store_pc, store_name FROM maint_tickets WHERE number = ${s} OR id::text = ${s} LIMIT 1`;
  if (!rows.length) rows = await db`SELECT id, number, title, status, store_pc, store_name FROM maint_tickets WHERE number ILIKE ${'%' + s + '%'} ORDER BY created_at DESC LIMIT 1`;
  return rows[0] || null;
}

/**
 * Execute one maintenance tool. ctx = { actorId, role }. Returns a small result
 * object the model gets back as a tool_result: { ok, summary } or { ok:false, error }.
 */
async function executeMaintTool(name, input, ctx = {}) {
  if (!WRITE_ROLES.has(ctx.role)) return { ok: false, error: 'You do not have permission to change tickets.' };
  const db = sql();
  if (ctx._actorName === undefined) ctx._actorName = await resolveActorName(db, ctx.actorId);
  const actor = ctx._actorName || 'Maintenance';
  const now = new Date().toISOString();

  // Resolve the target ticket for ticket-scoped tools.
  let tk = null;
  if (name !== 'create_followup_ticket') {
    tk = await findTicket(db, input?.ticket);
    if (!tk) return { ok: false, error: `No ticket found matching "${input?.ticket}".` };
  }

  const sysComment = async (ticketId, text) => {
    try {
      await db`INSERT INTO maint_ticket_comments (id, ticket_id, author, initials, type, text, created_at)
               VALUES (${Date.now()}, ${ticketId}, ${'Orion'}, ${'OR'}, ${'system'}, ${text}, ${now}) ON CONFLICT DO NOTHING`;
    } catch { /* audit comment is best-effort */ }
  };

  try {
    switch (name) {
      case 'update_ticket_status': {
        const status = input.status;
        if (status === 'Closed') {
          await db`UPDATE maint_tickets SET status='Closed', closed_by=${actor}, closed_at=${now}, updated_at=${now} WHERE id=${tk.id}`;
        } else if (status === 'In Progress') {
          await db`UPDATE maint_tickets SET status='In Progress', started_by=COALESCE(started_by, ${actor}), started_at=COALESCE(started_at, ${now}), updated_at=${now} WHERE id=${tk.id}`;
        } else {
          await db`UPDATE maint_tickets SET status='Open', closed_by=NULL, closed_at=NULL, updated_at=${now} WHERE id=${tk.id}`;
        }
        await sysComment(tk.id, `Status → ${status} (via Orion, by ${actor})`);
        return { ok: true, summary: `${tk.number} set to ${status}.` };
      }
      case 'add_ticket_comment': {
        await db`INSERT INTO maint_ticket_comments (id, ticket_id, author, initials, type, text, created_at)
                 VALUES (${Date.now()}, ${tk.id}, ${actor}, ${initialsOf(actor)}, ${'comment'}, ${input.text}, ${now}) ON CONFLICT DO NOTHING`;
        return { ok: true, summary: `Comment added to ${tk.number}.` };
      }
      case 'assign_ticket': {
        const who = (input.assignee === 'me' || /^my ?self$/i.test(input.assignee || '')) ? actor : input.assignee;
        await db`UPDATE maint_tickets SET ticket_owner=${who}, updated_at=${now} WHERE id=${tk.id}`;
        await sysComment(tk.id, `Assigned to ${who} (via Orion, by ${actor})`);
        return { ok: true, summary: `${tk.number} assigned to ${who}.` };
      }
      case 'set_ticket_due_date': {
        await db`UPDATE maint_tickets SET due_date=${String(input.due_date)}, updated_at=${now} WHERE id=${tk.id}`;
        await sysComment(tk.id, `Due date → ${input.due_date} (via Orion, by ${actor})`);
        return { ok: true, summary: `${tk.number} due ${input.due_date}.` };
      }
      case 'add_ticket_expense': {
        const amt = Number(input.amount);
        if (!Number.isFinite(amt)) return { ok: false, error: 'Invalid amount.' };
        const eid = `exp_${Date.now()}_${Math.round(Math.random() * 1e6).toString(36)}`;
        await db`INSERT INTO maint_ticket_expenses (id, ticket_id, no_expense, description, amount, category, added_by, added_at)
                 VALUES (${eid}, ${tk.id}, false, ${input.description ?? null}, ${amt}, ${input.category ?? null}, ${actor}, ${now})`;
        await sysComment(tk.id, `Expense $${amt.toFixed(2)} — ${input.description || ''} (via Orion, by ${actor})`);
        return { ok: true, summary: `$${amt.toFixed(2)} expense added to ${tk.number}.` };
      }
      case 'create_followup_ticket': {
        // The model doesn't always have store roster context (esp. on the maintenance
        // persona), so it can pass a store NAME instead of a PC# — resolve either to the
        // real numeric PC here rather than trusting the raw input, or tickets get filed
        // under a nonexistent "store_pc" that never matches any user's assigned store.
        const resolvedStore = findStoreByPcOrName(input.store_pc);
        if (!resolvedStore) return { ok: false, error: `Could not find a store matching "${input.store_pc}". Use the store's PC# or exact name.` };
        const storePC = resolvedStore.pc;

        const id = Date.now();
        // Next number = highest existing T-#### suffix + 1. count(*) would collide after any
        // deletion (number is not the PK), so derive it from the max numeric suffix instead.
        const [{ maxn }] = await db`SELECT COALESCE(MAX(NULLIF(regexp_replace(number, '[^0-9]', '', 'g'), '')::int), 0) AS maxn FROM maint_tickets`;
        const number = `T-${String((maxn || 0) + 1).padStart(4, '0')}`;
        const st = await db`SELECT store_name, address FROM maint_tickets WHERE store_pc=${storePC} ORDER BY created_at DESC LIMIT 1`;
        const storeName = st[0]?.store_name || resolvedStore.name;
        await db`INSERT INTO maint_tickets (id, number, title, description, status, priority, category, store_pc, store_name, address, created_by, created_at, updated_at)
                 VALUES (${id}, ${number}, ${input.title}, ${input.description ?? null}, 'Open', ${input.priority || 'Medium'}, ${input.category ?? null}, ${storePC}, ${storeName}, ${st[0]?.address ?? null}, ${actor}, ${now}, ${now})`;
        await sysComment(id, `Ticket created via Orion, by ${actor}`);
        sendTicketCreatedEmail({
          number, title: input.title, description: input.description, priority: input.priority || 'Medium',
          category: input.category, storePC, storeName,
        }, actor).catch(() => {});
        return { ok: true, summary: `Created ${number} "${input.title}" for ${storeName}.` };
      }
      default:
        return { ok: false, error: `Unknown tool ${name}.` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export { MAINT_TOOLS, executeMaintTool };
