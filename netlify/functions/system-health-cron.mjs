// netlify/functions/system-health-cron.mjs
// Every 30 min: classify all FEEDS by blob freshness, diff vs the previous
// snapshot, push+email critical transitions (6h re-alert guard), and persist.
import https from 'node:https';
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { sql } from './_shared/db.mjs';
import { buildSnapshot, diffForAlerts } from '../../src/system-health.mjs';

export const config = { schedule: '*/30 * * * *' };

const SNAPSHOT_KEY = 'pcg_system_health_v1';
const ALERTS_KEY = 'pcg_system_health_alerts_v1';
const BEATS_KEY = 'pcg_system_health_beats_v1';
const REALERT_MS = 6 * 60 * 60 * 1000;

function healthStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

// ── recipient lookup: all active exec/IT users (id for push, email for email) ──
async function recipients(db) {
  try {
    const rows = await db`SELECT id, email FROM users WHERE user_type IN ('executive','it') AND active = true`;
    return { pushIds: rows.map(r => String(r.id)), emails: rows.map(r => r.email).filter(Boolean) };
  } catch { return { pushIds: [], emails: [] }; }
}

// ── email via Resend (copied from deal-alerts-cron.mjs:52-64) ──
function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const key = process.env.RESEND_API_KEY;
    if (!key || !to.length) return resolve(false);
    const payload = JSON.stringify({ from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>', to, subject, html });
    const req = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('error', () => resolve(false)); req.write(payload); req.end();
  });
}

// ── web push (copied from deal-alerts-cron.mjs:89-102) ──
async function sendPush(pushIds, title, body, tag) {
  if (!pushIds.length) return { sent: 0 };
  const vpub = process.env.VAPID_PUBLIC_KEY, vpriv = process.env.VAPID_PRIVATE_KEY;
  if (!vpub || !vpriv) return { sent: 0 };
  const store = healthStore();
  const w = await store.get('pcg_push_subscriptions_v1', { type: 'json' });
  const subs = (w && w.data) ? w.data : {};
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:${process.env.VAPID_EMAIL || 'noreply@pcgops.com'}`, vpub, vpriv);
  const payload = JSON.stringify({ title, body: body || '', icon: '/apple-touch-icon.png', url: '/', tag: tag || undefined });
  let sent = 0;
  for (const uid of pushIds) for (const sub of (subs[String(uid)] || [])) {
    try { await webpush.sendNotification(sub, payload); sent++; } catch { /* expired sub, ignore */ }
  }
  return { sent };
}

export default async (request) => {
  const nowMs = Date.now();
  const store = healthStore();

  // Discover active store pcs from the per-store labor blobs (no hardcoded list).
  let activePcs = [];
  try {
    const { blobs } = await store.list({ prefix: 'pcg_labor_store_' });
    activePcs = blobs.map(b => b.key.replace('pcg_labor_store_', ''));
  } catch { activePcs = []; }

  // Injected reader: returns savedAt epoch ms or null (missing/error).
  const readSavedAt = async (key) => {
    try {
      const raw = await store.get(key, { type: 'json' });
      if (!raw || !raw.savedAt) return null;
      const ms = Date.parse(raw.savedAt);
      return Number.isFinite(ms) ? ms : null;
    } catch { return null; }
  };

  // Heartbeats (best-effort enrichment).
  let beats = {};
  try { const raw = await store.get(BEATS_KEY, { type: 'json' }); beats = (raw && raw.data) ? raw.data : {}; } catch {}

  // Previous snapshot for diffing.
  let prev = null;
  try { const raw = await store.get(SNAPSHOT_KEY, { type: 'json' }); prev = (raw && raw.data) ? raw.data : null; } catch {}

  const snapshot = await buildSnapshot({ readSavedAt, activePcs, nowMs, beats });

  // Alert log { lastAlerted:{key:ms}, events:[...] }.
  let log = { lastAlerted: {}, events: [] };
  try { const raw = await store.get(ALERTS_KEY, { type: 'json' }); if (raw && raw.data) log = { lastAlerted: raw.data.lastAlerted || {}, events: raw.data.events || [] }; } catch {}

  // Transitions to alert on: critical status changes...
  const transitions = diffForAlerts(prev, snapshot).filter(t => t.critical);
  const alertKeys = new Map(transitions.map(t => [t.key, t]));
  // ...plus still-not-OK critical feeds whose last alert is older than the guard.
  for (const f of snapshot.feeds) {
    if (f.critical && f.status !== 'OK' && !alertKeys.has(f.key)) {
      const last = log.lastAlerted[f.key] || 0;
      if (nowMs - last >= REALERT_MS) alertKeys.set(f.key, { key: f.key, from: f.status, to: f.status, critical: true });
    }
  }

  let alerted = 0;
  if (alertKeys.size) {
    let pushIds = [], emails = [], recipientsOk = false;
    try {
      const db = sql();
      ({ pushIds, emails } = await recipients(db));
      recipientsOk = true;
    } catch (e) {
      // DB unavailable: skip notifications AND leave the re-alert guard unarmed
      // (below) so the next run re-attempts once the DB recovers.
    }
    for (const t of alertKeys.values()) {
      const feed = snapshot.feeds.find(f => f.key === t.key) || {};
      const recovered = t.to === 'OK';
      const title = recovered ? `✅ System Health: ${feed.label} recovered` : `⚠️ System Health: ${feed.label} ${t.to}`;
      const detail = feed.error ? ` — ${feed.error}` : '';
      const body = recovered ? `${feed.label} is OK again.` : `${feed.label} is ${t.to}${detail}.`;
      if (recipientsOk) {
        try { await sendPush(pushIds, title, body, 'system_health'); } catch {}
        try { await sendEmail(emails, title, `<p>${body}</p><p>As of ${new Date(nowMs).toISOString()}.</p>`); } catch {}
        log.lastAlerted[t.key] = recovered ? 0 : nowMs; // arm guard only when recipients were reachable
        log.events.unshift({ key: t.key, from: t.from, to: t.to, at: new Date(nowMs).toISOString(), delivered: true });
        alerted++;
      } else {
        // Recipients unavailable: do NOT arm the guard, so the next run re-alerts. Record the miss.
        log.events.unshift({ key: t.key, from: t.from, to: t.to, at: new Date(nowMs).toISOString(), delivered: false });
      }
    }
    log.events = log.events.slice(0, 200);
  }

  // Persist snapshot + alert log (alerting failures never block these writes).
  await store.setJSON(SNAPSHOT_KEY, { savedAt: new Date().toISOString(), data: snapshot });
  await store.setJSON(ALERTS_KEY, { savedAt: new Date().toISOString(), data: log });

  return new Response(JSON.stringify({ ok: true, overall: snapshot.overall, alerted }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
