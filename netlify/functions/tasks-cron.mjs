// tasks-cron.mjs — Daily task maintenance at 9 AM UTC (5 AM ET).
// 1. Pre-generates today's task instances for all 45 stores (idempotent).
// 2. Computes natural language compliance alerts vs. 14-day historical average.
// 3. Writes pcg_task_alerts_v1 blob for the Tasks Dashboard to display.
// 4. Pushes DMs (district-scoped) and store managers with compliance alerts.

import webpush from 'web-push';
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { STORE_BY_PC } from './ndcp-lib/store-map.js';

function etDate() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return f.format(new Date());
}

function etYesterday() {
  const [y, m, d] = etDate().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1, 12));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function dowOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

function daysSinceEpoch(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

async function blobLoad(key) {
  const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
  const result = await store.get(key, { type: 'json' });
  return (result && result.data !== undefined) ? result.data : null;
}

async function blobSave(key, data) {
  const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
  await store.setJSON(key, { savedAt: new Date().toISOString(), data });
}

export default async (_req, _ctx) => {
  const db = sql();
  const date = etDate();
  const yesterday = etYesterday();
  const dow = dowOf(date);
  const dayNum = daysSinceEpoch(date);
  const allPcs = Object.values(STORE_BY_PC).map((s) => s.pc);

  // ── 1. Pre-generate today's instances ──────────────────────────────────────
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

  // ── 2. Compliance alert data ───────────────────────────────────────────────
  const [yesterdayMissed, historicalAvg, openToday] = await Promise.all([
    // Tasks still open (not completed) from yesterday = missed
    db`
      SELECT store_pc, COUNT(*)::int AS cnt
      FROM task_instances
      WHERE business_date = ${yesterday}::date AND status = 'open'
      GROUP BY store_pc`,

    // 14-day rolling avg of missed tasks per store (excluding yesterday)
    db`
      SELECT store_pc, ROUND(AVG(daily_missed), 1)::float AS avg_missed
      FROM (
        SELECT store_pc, business_date, COUNT(*)::int AS daily_missed
        FROM task_instances
        WHERE business_date >= (${yesterday}::date - INTERVAL '14 days')
          AND business_date < ${yesterday}::date
          AND status = 'open'
        GROUP BY store_pc, business_date
      ) sub
      GROUP BY store_pc`,

    // Tasks open today
    db`
      SELECT store_pc, COUNT(*)::int AS cnt
      FROM task_instances
      WHERE business_date = ${date}::date AND status = 'open'
      GROUP BY store_pc`,
  ]);

  // Build lookup maps
  const missedMap = {};
  for (const r of yesterdayMissed) missedMap[String(r.store_pc)] = r.cnt;

  const avgMap = {};
  for (const r of historicalAvg) avgMap[String(r.store_pc)] = r.avg_missed;

  const openTodayMap = {};
  for (const r of openToday) openTodayMap[String(r.store_pc)] = r.cnt;

  // ── 3. Build alerts array ──────────────────────────────────────────────────
  const alerts = [];

  for (const storeInfo of Object.values(STORE_BY_PC)) {
    const pc = String(storeInfo.pc);
    const missed = missedMap[pc] || 0;
    const avg = avgMap[pc] || 0;
    const open = openTodayMap[pc] || 0;

    if (missed === 0 && open === 0) continue; // nothing to report

    // Only alert if meaningfully above average or has open tasks
    const aboveAvg = avg > 0 ? missed > avg * 1.3 : missed >= 3;
    if (!aboveAvg && open < 3) continue;

    let severity = 'low';
    if (missed >= 5 || (avg > 0 && missed > avg * 2)) severity = 'high';
    else if (missed >= 3 || (avg > 0 && missed > avg * 1.5)) severity = 'medium';

    let message = '';
    if (missed > 0 && avg > 0) {
      message = `${storeInfo.name} missed ${missed} task${missed !== 1 ? 's' : ''} yesterday — higher than their usual ${avg}. `;
    } else if (missed > 0) {
      message = `${storeInfo.name} missed ${missed} task${missed !== 1 ? 's' : ''} yesterday. `;
    }
    if (open > 0) {
      message += `${open} task${open !== 1 ? 's' : ''} still open today.`;
    }
    message = message.trim();

    alerts.push({
      storePC: storeInfo.pc,
      storeName: storeInfo.name,
      district: storeInfo.district,
      severity,
      missedYesterday: missed,
      avgMissed: avg,
      openToday: open,
      message,
    });
  }

  // Sort: high → medium → low, then by missedYesterday desc
  alerts.sort((a, b) => {
    const sev = { high: 0, medium: 1, low: 2 };
    return (sev[a.severity] - sev[b.severity]) || (b.missedYesterday - a.missedYesterday);
  });

  // ── 4. Write blob for dashboard ────────────────────────────────────────────
  await blobSave('pcg_task_alerts_v1', { date: yesterday, alerts });
  console.log(`[tasks-cron] ${date}: wrote ${alerts.length} alerts to pcg_task_alerts_v1`);

  // ── 5. Push notifications ──────────────────────────────────────────────────
  let alertsSent = 0;

  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return new Response(JSON.stringify({ ok: true, date, generated, alerts_written: alerts.length, alerts_sent: 0, reason: 'VAPID not configured' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'noreply@pcgops.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  const [users, subs] = await Promise.all([
    blobLoad('pcg_users_v1'),
    blobLoad('pcg_push_subscriptions_v1'),
  ]);

  const userList = Array.isArray(users) ? users : [];
  const subMap = (subs && typeof subs === 'object') ? subs : {};

  const findDM = (storePc) => {
    const info = STORE_BY_PC[storePc];
    if (!info) return null;
    return userList.find((u) => u.active !== false && u.userType === 'dm' && String(u.district) === String(info.district)) || null;
  };

  const findMgr = (storePc) => {
    const info = STORE_BY_PC[storePc];
    if (!info) return null;
    return userList.find((u) => u.active !== false && u.userType === 'manager' && (
      String(u.storePC) === String(storePc) ||
      (u.name || '').toLowerCase().replace(/[^a-z]/g, '') === (info.mgr || '').toLowerCase().replace(/[^a-z]/g, '')
    )) || null;
  };

  const sendTo = async (user, payload) => {
    for (const sub of (subMap[String(user.id)] || [])) {
      await webpush.sendNotification(sub, JSON.stringify(payload)).catch(() => {});
      alertsSent++;
    }
  };

  // Track which DMs we already notified (one push per DM summarizing their district)
  const dmNotified = new Set();

  for (const alert of alerts) {
    const storePc = alert.storePC;
    const dm = findDM(storePc);
    const mgr = findMgr(storePc);

    // DM gets one push per district (not per store to avoid spam)
    if (dm && !dmNotified.has(String(dm.id))) {
      const distAlerts = alerts.filter((a) => String(a.district) === String(alert.district));
      const highCount = distAlerts.filter((a) => a.severity === 'high').length;
      const body = highCount > 0
        ? `${highCount} store${highCount !== 1 ? 's' : ''} with high missed tasks in District ${alert.district}`
        : `${distAlerts.length} store${distAlerts.length !== 1 ? 's' : ''} with task compliance issues in District ${alert.district}`;
      await sendTo(dm, {
        title: `Task Compliance — District ${alert.district}`,
        body,
        icon: '/icon-192.png', url: 'https://pcg-ops.netlify.app', tag: `task-compliance-d${alert.district}`,
      });
      dmNotified.add(String(dm.id));
    }

    // Manager gets push for their own store
    if (mgr) {
      await sendTo(mgr, {
        title: `Task Alert — ${alert.storeName}`,
        body: alert.message,
        icon: '/icon-192.png', url: 'https://pcg-ops.netlify.app', tag: `task-alert-${storePc}`,
      });
    }
  }

  console.log(`[tasks-cron] ${date}: sent ${alertsSent} push alerts for ${alerts.length} alert stores`);

  return new Response(JSON.stringify({
    ok: true, date, generated, alerts_written: alerts.length, alerts_sent: alertsSent,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
