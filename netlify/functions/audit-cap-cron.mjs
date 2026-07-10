// audit-cap-cron.mjs — Field Ops Audit CAP overdue flip + escalation cron.
// Mirrors deal-alerts-cron.mjs: schedule export, Resend email assembly (raw https, no
// dependency on notify.js's HTTP endpoint), web-push send against pcg_push_subscriptions_v1
// (no dependency on push.js's HTTP endpoint), and users-table recipient lookup.
//
// Table owned by audits.mjs (Task 4): audit_caps. Daily 11:00 UTC (7am ET):
//   1) Flip status='open' CAPs whose deadline has passed to 'overdue' (RETURNING rows).
//      isOverdue() from audit-lib/caps.js is the single source of truth for "past deadline" —
//      rows are selected then filtered through it so this cron can never drift from the
//      canonical CAP lifecycle rule used elsewhere (e.g. capBoard in audits.mjs).
//   2) Owner digest — one email + one push per owner, covering that owner's CAPs due within
//      the next 48h plus anything already overdue (no escalation implied by this step alone).
//   3) VP + district-DM escalation — a single digest sent to every active `executive` user
//      plus the active `dm` user(s) for each district with an overdue CAP, scoped to CAPs
//      with status='overdue' AND escalated_at IS NULL (covers rows flipped just now, and any
//      left over from a prior run that failed after the flip but before the escalation write).
//      Sets escalated_at=now() on every escalated row so it never re-fires.
import https from 'node:https';
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { sql } from './_shared/db.mjs';
// Direct ESM named import of these CommonJS libs — same interop pattern audits.mjs uses for
// auth-lib/require-user.js, audit-lib/template.js, audit-lib/scoring.js, audit-lib/caps.js
// (cjs-module-lexer resolves named imports from `module.exports = { ... }`; verified to survive
// Netlify's function bundler because it's a static `import`, unlike `require()` at runtime).
import { isOverdue } from './audit-lib/caps.js';
// pc → { name, district, dmName } — reuse the existing shared, dependency-free store map
// instead of adding a 4th copy of the 45-store list (see CLAUDE.md "Common Gotchas" #9:
// store config is already duplicated across labor-cron.js, schedule-alerts.js, audits.mjs).
import { STORE_BY_PC } from './ndcp-lib/store-map.js';

export const config = { schedule: '0 11 * * *' };

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const fmtDeadline = (d) => {
  const t = Date.parse(d);
  if (Number.isNaN(t)) return '?';
  return new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const key = process.env.RESEND_API_KEY;
    if (!key || !to.length) return resolve(false);
    const payload = JSON.stringify({ from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>', to, subject, html });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('error', () => resolve(false));
    req.write(payload); req.end();
  });
}

// Best-effort web push to the given user-ids. Never throws; prunes expired subscriptions.
async function sendPush(pushIds, title, body, tag) {
  if (!pushIds.length) return { sent: 0, expired: 0 };
  const vpub = process.env.VAPID_PUBLIC_KEY, vpriv = process.env.VAPID_PRIVATE_KEY;
  if (!vpub || !vpriv) return { sent: 0, expired: 0 };
  let store, subs = {};
  try {
    store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
    const w = await store.get('pcg_push_subscriptions_v1', { type: 'json' });
    subs = (w && w.data) ? w.data : {};
  } catch { return { sent: 0, expired: 0 }; }
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:${process.env.VAPID_EMAIL || 'noreply@pcgops.com'}`, vpub, vpriv);
  } catch { return { sent: 0, expired: 0 }; }
  const payload = JSON.stringify({ title, body: body || '', icon: '/apple-touch-icon.png', url: '/', tag: tag || undefined });
  let sent = 0; const expired = [];
  for (const uid of pushIds) {
    for (const sub of (subs[String(uid)] || [])) {
      try { await webpush.sendNotification(sub, payload); sent++; }
      catch (err) {
        if (err && (err.statusCode === 410 || err.statusCode === 404)) expired.push({ uid: String(uid), endpoint: sub.endpoint });
      }
    }
  }
  // Prune expired subscriptions so they don't accumulate.
  if (expired.length && store) {
    try {
      for (const { uid, endpoint } of expired) {
        if (subs[uid]) { subs[uid] = subs[uid].filter((s) => s.endpoint !== endpoint); if (!subs[uid].length) delete subs[uid]; }
      }
      await store.setJSON('pcg_push_subscriptions_v1', { savedAt: new Date().toISOString(), data: subs });
    } catch {}
  }
  return { sent, expired: expired.length };
}

function capRowHtml(r) {
  const store = STORE_BY_PC[String(r.store_pc)];
  const storeLabel = store ? `${store.name} (${r.store_pc})` : String(r.store_pc || '?');
  const badge = r.status === 'overdue'
    ? `<span style="color:#ef4444;font-weight:700">OVERDUE</span>`
    : `<span style="color:#f59e0b;font-weight:700">due ${fmtDeadline(r.deadline)}</span>`;
  return `<tr><td style="padding:6px 10px">${esc(storeLabel)}</td><td style="padding:6px 10px">${esc(r.item_text || r.template_item_id)}</td><td style="padding:6px 10px">${esc(r.severity || '')}</td><td style="padding:6px 10px">${badge}</td></tr>`;
}

function digestHtml(title, intro, rows) {
  return `
    <h2 style="font-family:Arial">${esc(title)}</h2>
    <p style="font-family:Arial;color:#555">${esc(intro)}</p>
    <table style="border-collapse:collapse;font-family:Arial;font-size:13px">
      <tr style="background:#f3f4f6"><th style="padding:6px 10px;text-align:left">Store</th><th style="padding:6px 10px;text-align:left">CAP Item</th><th style="padding:6px 10px;text-align:left">Severity</th><th style="padding:6px 10px;text-align:left">Status</th></tr>
      ${rows.map(capRowHtml).join('')}
    </table>`;
}

export default async (request) => {
  const now = Date.now();
  try {
    const db = sql();

    // 1) Flip open → overdue. Select open rows, filter through the shared isOverdue() helper,
    // then UPDATE by id (rather than re-deriving "deadline < now()" in raw SQL) so the two
    // never disagree about what "overdue" means.
    const openRows = await db`SELECT * FROM audit_caps WHERE status = 'open'`;
    const overdueIds = openRows.filter((r) => isOverdue(r, now)).map((r) => r.id);
    const flipped = overdueIds.length
      ? await db`UPDATE audit_caps SET status = 'overdue', updated_at = now() WHERE id = ANY(${overdueIds}) RETURNING *`
      : [];

    // 2) Owner digest — CAPs due within 48h + already-overdue, grouped by owner.
    const digestRows = await db`
      SELECT * FROM audit_caps
      WHERE status IN ('open', 'overdue') AND deadline < now() + interval '48 hours'
      ORDER BY deadline ASC`;
    const byOwner = new Map();
    for (const r of digestRows) {
      if (r.owner_user_id == null) continue;
      if (!byOwner.has(r.owner_user_id)) byOwner.set(r.owner_user_id, []);
      byOwner.get(r.owner_user_id).push(r);
    }

    let ownerEmailed = 0, ownerPushed = 0;
    if (byOwner.size) {
      const ownerIds = [...byOwner.keys()];
      const owners = await db`SELECT id, email FROM users WHERE id = ANY(${ownerIds}) AND active = true`;
      const ownerById = new Map(owners.map((u) => [u.id, u]));
      for (const [ownerId, rows] of byOwner) {
        const owner = ownerById.get(ownerId);
        const overdueCount = rows.filter((r) => r.status === 'overdue').length;
        const subject = `Audit CAPs: ${overdueCount ? `${overdueCount} overdue, ` : ''}${rows.length} due soon`;
        const html = digestHtml('Your Corrective Action Plans', `You have ${rows.length} CAP(s) due within 48 hours or overdue.`, rows);
        if (owner?.email) {
          try { if (await sendEmail([owner.email], subject, html)) ownerEmailed++; }
          catch (e) { console.warn('[audit-cap-cron] owner email failed:', e.message); }
        }
        try {
          const r = await sendPush([String(ownerId)], 'Audit CAPs due', `${rows.length} CAP(s) due within 48h or overdue`, 'audit_caps');
          ownerPushed += r.sent;
        } catch (e) { console.warn('[audit-cap-cron] owner push failed:', e.message); }
      }
    }

    // 3) VP + district-DM escalation — every overdue CAP not yet escalated.
    const toEscalate = await db`SELECT * FROM audit_caps WHERE status = 'overdue' AND escalated_at IS NULL`;
    let escalatedCount = 0, escalationEmailed = false, escalationPushed = 0;
    if (toEscalate.length) {
      const districts = new Set();
      for (const r of toEscalate) {
        const store = STORE_BY_PC[String(r.store_pc)];
        if (store?.district != null) districts.add(store.district);
      }
      const vps = await db`SELECT id, email FROM users WHERE user_type = 'executive' AND active = true`;
      const dms = districts.size
        ? await db`SELECT id, email, district FROM users WHERE user_type = 'dm' AND active = true AND district = ANY(${[...districts]})`
        : [];
      const recipients = [...vps, ...dms];
      const emails = [...new Set(recipients.map((u) => u.email).filter(Boolean))];
      const pushIds = [...new Set(recipients.map((u) => String(u.id)))];

      const subject = `Audit CAP escalation: ${toEscalate.length} overdue`;
      const html = digestHtml('Overdue Corrective Action Plans — Escalation', `${toEscalate.length} CAP(s) crossed their deadline and require executive / DM attention.`, toEscalate);
      if (emails.length) {
        try { escalationEmailed = await sendEmail(emails, subject, html); }
        catch (e) { console.warn('[audit-cap-cron] escalation email failed:', e.message); }
      }
      if (pushIds.length) {
        try {
          const r = await sendPush(pushIds, 'Audit CAP escalation', `${toEscalate.length} CAP(s) overdue`, 'audit_caps_escalation');
          escalationPushed = r.sent;
        } catch (e) { console.warn('[audit-cap-cron] escalation push failed:', e.message); }
      }

      const escalateIds = toEscalate.map((r) => r.id);
      // Guard the escalated_at write: email and push sends already succeeded above.
      // If this UPDATE fails on a transient DB blip, degrade gracefully rather than
      // failing the entire run, which would be misleading (escalations already sent).
      try {
        await db`UPDATE audit_caps SET escalated_at = now() WHERE id = ANY(${escalateIds})`;
        escalatedCount = escalateIds.length;
      } catch (e) {
        console.warn('[audit-cap-cron] escalated_at update failed', e.message);
      }
    }

    console.log(`[audit-cap-cron] flipped ${flipped.length} overdue; digested ${byOwner.size} owner(s) (${ownerEmailed} emailed, ${ownerPushed} pushed); escalated ${escalatedCount} (${escalationEmailed ? 'emailed' : 'no email'}, ${escalationPushed} pushed)`);
    return new Response(JSON.stringify({
      ok: true,
      overdue: flipped.length,
      digestOwners: byOwner.size,
      ownerEmailed,
      ownerPushed,
      escalated: escalatedCount,
      escalationEmailed,
      escalationPushed,
    }), { status: 200 });
  } catch (e) {
    console.error('[audit-cap-cron] error:', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
