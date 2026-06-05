// PCG Deal Pipeline — daily critical-date reminder cron.
// Scans unacknowledged dates on active deals, finds the ones inside their warning window
// (or overdue), and emails a digest to the deal team (deal_access members). Runs daily, so
// it's a once-a-day digest — no per-tier de-dup needed. Push is a future add-on.
//
// Warning logic mirrors src/deal-dates.mjs (the canonical, unit-tested version); kept inline
// here because that module is ESM and this function is CommonJS.
const https = require('https');
const { getStore } = require('@netlify/blobs');
const { sql } = require('./db');

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
  if (daysOut < 0) return { daysOut, level: 'overdue', tier: null };
  const max = ts.length ? Math.max(...ts) : 30;
  const tier = ts.filter((t) => daysOut <= t).sort((a, b) => a - b)[0] ?? null;
  return { daysOut, level: daysOut <= max ? 'warning' : 'none', tier };
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

async function recipientEmails(db) {
  const access = await db`SELECT user_key FROM deal_access`;
  let users = [];
  try {
    const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
    const w = await store.get('pcg_users_v1', { type: 'json' });
    const d = w?.data || w; users = Array.isArray(d) ? d : (d?.users || []);
  } catch {}
  const emails = new Set();
  for (const a of access) {
    const k = lc(a.user_key);
    if (k.includes('@')) { emails.add(k); continue; }
    const u = users.find((x) => lc(x.username) === k);
    if (u && u.email) emails.add(lc(u.email));
  }
  return [...emails];
}

exports.handler = async (event) => {
  const isManual = event && event.httpMethod === 'POST';
  const now = Date.now();
  try {
    const db = sql();
    const rows = await db`
      SELECT dd.*, d.name AS deal_name, d.deal_lead, d.brand, d.state
      FROM deal_dates dd JOIN deals d ON d.id = dd.deal_id
      WHERE d.status = 'active' AND dd.acknowledged_at IS NULL`;

    const atRisk = rows
      .map((r) => ({ ...r, w: warnLevel(r.due_date, r.warning_tiers, now) }))
      .filter((r) => r.w.level !== 'none')
      .sort((a, b) => a.w.daysOut - b.w.daysOut);

    if (atRisk.length === 0) {
      console.log('[deal-alerts] no dates in warning window');
      return isManual ? { statusCode: 200, body: JSON.stringify({ ok: true, atRisk: 0 }) } : undefined;
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

    const to = await recipientEmails(db);
    // Lead the subject with the most-urgent deal + date (list is sorted soonest-first),
    // then "+N more". Name + date type only — no $ amounts in the subject (preview-safe).
    const top = atRisk[0];
    const topLabel = DATE_LABELS[top.date_type] || top.date_type;
    const topPhrase = top.w.level === 'overdue' ? `OVERDUE ${Math.abs(top.w.daysOut)}d` : `in ${top.w.daysOut}d`;
    const safeName = String(top.deal_name || 'Deal').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    const more = atRisk.length - 1;
    const subject = `⚠ ${safeName} — ${topLabel} (${topPhrase})${more > 0 ? ` +${more} more` : ''}`;
    const sent = await sendEmail(to, subject, html);
    console.log(`[deal-alerts] ${atRisk.length} at-risk, emailed ${to.length} recipient(s): ${sent}`);
    return isManual ? { statusCode: 200, body: JSON.stringify({ ok: true, atRisk: atRisk.length, recipients: to.length, sent }) } : undefined;
  } catch (e) {
    console.error('[deal-alerts] error:', e.message);
    return isManual ? { statusCode: 500, body: JSON.stringify({ error: e.message }) } : undefined;
  }
};
