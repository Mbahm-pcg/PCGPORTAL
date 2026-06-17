// PCG Deal Pipeline — daily critical-date reminder cron.
// Scans unacknowledged dates on active deals, finds the ones inside their warning window
// (or overdue), and notifies the deal team (deal_access members) via email + web push.
//
// De-dup: each (date, tier) only fires ONCE — the fired tier key (e.g. '30' or 'overdue')
// is appended to deal_dates.alerted_tiers and checked before sending, so crossing a tier
// boundary alerts a single time rather than every day.
//
// Warning logic mirrors src/deal-dates.mjs (the canonical, unit-tested version); kept inline
// here because that module is ESM and this function is CommonJS.
import https from 'node:https';
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import webpush from 'web-push';

export const config = { schedule: '0 12 * * *' };

const DATE_LABELS = {
  loi_expiration: 'LOI Response / Expiration', dd_expiration: 'Due Diligence Expiration',
  emd_hard: 'Earnest Money Goes Hard', financing_contingency: 'Financing Contingency',
  closing: 'Closing', lease_execution: 'Lease Execution Target', possession: 'Delivery of Possession',
  rent_commencement: 'Rent Commencement', construction_commencement: 'Construction Commencement',
  option_notice: 'Option / Renewal Notice', pct_rent_report: '% Rent Report Due',
  cam_audit: 'CAM Reconciliation / Audit Window', coi_renewal: 'Insurance / COI Renewal',
  estoppel_response: 'Estoppel / SNDA Response',
};
const lc = (s) => (s == null ? '' : String(s).trim().toLowerCase());
// Escape DB free-text before interpolating into the digest email HTML (prevents HTML injection).
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

// Neon returns DATE columns as JS Date objects (not strings) — normalize to YYYY-MM-DD.
function toYMD(d) {
  if (d instanceof Date) return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
  return String(d == null ? '' : d).slice(0, 10);
}
function daysUntil(due, nowMs) {
  const t = Date.parse(toYMD(due) + 'T00:00:00Z');
  return Number.isNaN(t) ? Infinity : Math.ceil((t - nowMs) / 86400000);
}
function warnLevel(dueStr, tiers, nowMs) {
  const daysOut = daysUntil(dueStr, nowMs);
  const ts = (Array.isArray(tiers) ? tiers : []).map(Number).filter((n) => n > 0);
  if (daysOut < 0) return { daysOut, level: 'overdue', tier: null, tierKey: 'overdue' };
  const max = ts.length ? Math.max(...ts) : 30;
  const tier = ts.filter((t) => daysOut <= t).sort((a, b) => a - b)[0] ?? null;
  const level = daysOut <= max ? 'warning' : 'none';
  // De-dup key: the specific tier crossed (or the default-30 window when no tiers are set).
  const tierKey = level === 'none' ? null : (tier != null ? String(tier) : 'default');
  return { daysOut, level, tier, tierKey };
}

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

// Resolve deal_access members to both email addresses and push user-ids (from pcg_users_v1).
async function recipients(db) {
  const access = await db`SELECT user_key FROM deal_access`;
  let users = [];
  try {
    const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
    const w = await store.get('pcg_users_v1', { type: 'json' });
    const d = w?.data || w; users = Array.isArray(d) ? d : (d?.users || []);
  } catch {}
  const emails = new Set();
  const pushIds = new Set();
  for (const a of access) {
    const k = lc(a.user_key);
    // Match a portal user by email or username so we can also push to their devices.
    const u = users.find((x) => lc(x.email) === k || lc(x.username) === k);
    if (k.includes('@')) emails.add(k);
    else if (u && u.email) emails.add(lc(u.email));
    if (u && u.id != null) pushIds.add(String(u.id));
  }
  return { emails: [...emails], pushIds: [...pushIds] };
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

export default async (request) => {
  const isManual = request.method === 'POST';
  const now = Date.now();
  try {
    const db = sql();
    const rows = await db`
      SELECT dd.*, d.name AS deal_name, d.deal_lead, d.brand, d.state
      FROM deal_dates dd JOIN deals d ON d.id = dd.deal_id
      WHERE d.status = 'active' AND dd.acknowledged_at IS NULL`;

    const inWindow = rows
      .map((r) => ({ ...r, w: warnLevel(r.due_date, r.warning_tiers, now) }))
      .filter((r) => r.w.level !== 'none')
      .sort((a, b) => a.w.daysOut - b.w.daysOut);

    // Per-(date,tier) de-dup: only fire for dates whose current tier hasn't been alerted yet.
    const alreadyFired = (r) => {
      const arr = Array.isArray(r.alerted_tiers) ? r.alerted_tiers.map(String) : [];
      return r.w.tierKey != null && arr.includes(String(r.w.tierKey));
    };
    const atRisk = inWindow.filter((r) => !alreadyFired(r));

    if (atRisk.length === 0) {
      console.log(`[deal-alerts] ${inWindow.length} in window, 0 new tier(s) to alert`);
      return new Response(JSON.stringify({ ok: true, atRisk: 0, inWindow: inWindow.length }), { status: 200 });
    }

    const fmtRow = (r) => {
      const label = DATE_LABELS[r.date_type] || r.date_type;
      const when = r.w.level === 'overdue'
        ? `<span style="color:#ef4444;font-weight:700">OVERDUE ${Math.abs(r.w.daysOut)}d</span>`
        : `<span style="color:#f59e0b;font-weight:700">in ${r.w.daysOut}d</span>${r.w.tier ? ` (${r.w.tier}d tier)` : ''}`;
      return `<tr><td style="padding:6px 10px">${esc(r.deal_name)}</td><td style="padding:6px 10px">${esc(label)}</td><td style="padding:6px 10px">${toYMD(r.due_date)}</td><td style="padding:6px 10px">${when}</td><td style="padding:6px 10px">${esc(r.deal_lead)}</td></tr>`;
    };
    const html = `
      <h2 style="font-family:Arial">PCG Deal Pipeline — Critical Date Reminders</h2>
      <p style="font-family:Arial;color:#555">${atRisk.length} deal date(s) need attention.</p>
      <table style="border-collapse:collapse;font-family:Arial;font-size:13px">
        <tr style="background:#f3f4f6"><th style="padding:6px 10px;text-align:left">Deal</th><th style="padding:6px 10px;text-align:left">Date</th><th style="padding:6px 10px;text-align:left">Due</th><th style="padding:6px 10px;text-align:left">Status</th><th style="padding:6px 10px;text-align:left">Lead</th></tr>
        ${atRisk.map(fmtRow).join('')}
      </table>
      <p style="font-family:Arial;color:#888;font-size:12px">Acknowledge a date in the Deal Pipeline to stop reminders for it.</p>`;

    const { emails: to, pushIds } = await recipients(db);
    // Lead the subject with the most-urgent deal + date (list is sorted soonest-first),
    // then "+N more". Name + date type only — no $ amounts in the subject (preview-safe).
    const top = atRisk[0];
    const topLabel = DATE_LABELS[top.date_type] || top.date_type;
    const topPhrase = top.w.level === 'overdue' ? `OVERDUE ${Math.abs(top.w.daysOut)}d` : `in ${top.w.daysOut}d`;
    const safeName = String(top.deal_name || 'Deal').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    const more = atRisk.length - 1;
    const subject = `⚠ ${safeName} — ${topLabel} (${topPhrase})${more > 0 ? ` +${more} more` : ''}`;

    // Email + push are best-effort and isolated — neither failure crashes the cron.
    let sent = false, push = { sent: 0, expired: 0 };
    try { sent = await sendEmail(to, subject, html); } catch (e) { console.warn('[deal-alerts] email failed:', e.message); }
    try {
      const pushBody = `${topLabel} ${topPhrase}${more > 0 ? ` (+${more} more)` : ''}`;
      push = await sendPush(pushIds, '⚠ Deal Pipeline — Critical Date', `${safeName}: ${pushBody}`, 'deal_alerts');
    } catch (e) { console.warn('[deal-alerts] push failed:', e.message); }

    // Record the fired tier on each date so it won't re-alert tomorrow (per-(date,tier) de-dup).
    for (const r of atRisk) {
      if (r.w.tierKey == null) continue;
      try {
        await db`UPDATE deal_dates
          SET alerted_tiers = (
            SELECT to_jsonb(array(SELECT DISTINCT jsonb_array_elements_text(COALESCE(alerted_tiers,'[]'::jsonb) || ${JSON.stringify([String(r.w.tierKey)])}::jsonb)))
          )
          WHERE id = ${r.id}`;
      } catch (e) { console.warn('[deal-alerts] de-dup write failed for date', r.id, e.message); }
    }

    console.log(`[deal-alerts] ${atRisk.length} new tier(s); emailed ${to.length} (${sent}); pushed ${push.sent} (expired ${push.expired})`);
    return new Response(JSON.stringify({ ok: true, atRisk: atRisk.length, recipients: to.length, sent, push }), { status: 200 });
  } catch (e) {
    console.error('[deal-alerts] error:', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
