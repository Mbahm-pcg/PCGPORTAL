// schedule-alerts.mjs — Labor Schedule Risk Alerts
// Runs daily at 6 AM ET. Checks every store's projected labor % for the week ahead.
// When a store is projected ≥26% on any upcoming day, sends push + email to the DM
// and the store manager. Saves alert log to pcg_schedule_alerts_v1 blob.

import https from 'node:https';
import webpush from 'web-push';
import { getStore } from '@netlify/blobs';

export const config = { schedule: '0 10 * * 1,4' };

// ── Store config (keep in sync with labor-cron.js) ───────────────────────────
const STORES = [
  { pc:'339616', name:'Wadsworth',       district:1, email:'wadsworth@peoplecapitalgroup.com'    },
  { pc:'340794', name:'Front',           district:1, email:'front@peoplecapitalgroup.com'         },
  { pc:'351099', name:'Sonic',           district:2, email:'sonic@peoplecapitalgroup.com'         },
  { pc:'351259', name:'Rosemore',        district:2, email:'rosemore@peoplecapitalgroup.com'      },
  { pc:'302642', name:'County Line',     district:2, email:'countyline@peoplecapitalgroup.com'    },
  { pc:'352894', name:'Street Rd',       district:2, email:'streetrd@peoplecapitalgroup.com'      },
  { pc:'341350', name:'Yardley',         district:2, email:'yardley@peoplecapitalgroup.com'       },
  { pc:'337839', name:'Warrington',      district:2, email:'warrington@peoplecapitalgroup.com'    },
  { pc:'330338', name:'Drexel Hill',     district:3, email:'drexelhill@peoplecapitalgroup.com'    },
  { pc:'337063', name:'Sharon Hill',     district:3, email:'sharonhill@peoplecapitalgroup.com'    },
  { pc:'343832', name:'Lansdowne',       district:3, email:'lansdowne@peoplecapitalgroup.com'     },
  { pc:'304669', name:'Collingdale',     district:3, email:'collingdale@peoplecapitalgroup.com'   },
  { pc:'355146', name:'Gallery',         district:3, email:'gallery@peoplecapitalgroup.com'       },
  { pc:'300496', name:'Cobbs Creek',     district:3, email:'cobbscreek@peoplecapitalgroup.com'    },
  { pc:'304863', name:'18th St',         district:3, email:'18thst@peoplecapitalgroup.com'        },
  { pc:'354561', name:'Carlisle',        district:3, email:'carlisle@peoplecapitalgroup.com'      },
  { pc:'332393', name:'Lindbergh',       district:3, email:'lindbergh@peoplecapitalgroup.com'     },
  { pc:'341167', name:'5th Street',      district:4, email:'5thst@peoplecapitalgroup.com'         },
  { pc:'340870', name:'Hunting Park',    district:4, email:'huntingpark@peoplecapitalgroup.com'   },
  { pc:'335981', name:'Lehigh',          district:4, email:'lehigh@peoplecapitalgroup.com'        },
  { pc:'353150', name:'Bakers Square',   district:4, email:'bakerssquare@peoplecapitalgroup.com'  },
  { pc:'351050', name:'Allegheny',       district:4, email:'allegheny@peoplecapitalgroup.com'     },
  { pc:'345985', name:'Wissahickon',     district:4, email:'wissahickon@peoplecapitalgroup.com'   },
  { pc:'356374', name:'Montgomeryville', district:5, email:'montgomeryville@peoplecapitalgroup.com'},
  { pc:'353843', name:'Tollgate',        district:5, email:'tollgate@peoplecapitalgroup.com'      },
  { pc:'353047', name:'Silverdale',      district:5, email:'silverdale@peoplecapitalgroup.com'    },
  { pc:'340538', name:'Easton',          district:5, email:'easton@peoplecapitalgroup.com'        },
  { pc:'343079', name:'Downingtown',     district:6, email:'downingtown@peoplecapitalgroup.com'   },
  { pc:'342144', name:'Westchester',     district:6, email:'westchester@peoplecapitalgroup.com'   },
  { pc:'364295', name:'Lionville',       district:6, email:'lionville@peoplecapitalgroup.com'     },
  { pc:'365361', name:'Little Welsh',    district:7, email:'littlewelsh@peoplecapitalgroup.com'   },
  { pc:'310382', name:'Grant',           district:7, email:'grant@peoplecapitalgroup.com'         },
  { pc:'332941', name:'Bustleton',       district:7, email:'bustleton@peoplecapitalgroup.com'     },
  { pc:'343497', name:'Red Lion',        district:7, email:'redlion@peoplecapitalgroup.com'       },
  { pc:'302446', name:'Little Red Lion', district:7, email:'littleredlion@peoplecapitalgroup.com' },
  { pc:'337079', name:'Holme Circle',    district:7, email:'holmecircle@peoplecapitalgroup.com'   },
  { pc:'345986', name:'Willits',         district:7, email:'willits@peoplecapitalgroup.com'       },
  { pc:'364412', name:'8200',            district:7, email:'8200@peoplecapitalgroup.com'          },
  { pc:'345489', name:'Oxford',          district:7, email:'oxford@peoplecapitalgroup.com'        },
  { pc:'336372', name:'Elkins Park',     district:7, email:'elkinspark@peoplecapitalgroup.com'    },
  { pc:'358933', name:'Brace Rd',        district:8, email:'bracerd@peoplecapitalgroup.com'       },
  { pc:'354865', name:'Quakertown',      district:8, email:'quakertown@peoplecapitalgroup.com'    },
  { pc:'353689', name:'Fort Washington', district:8, email:'fortwashington@peoplecapitalgroup.com'},
  { pc:'342184', name:'Lansdale',        district:8, email:'lansdale@peoplecapitalgroup.com'      },
  { pc:'356316', name:"BJ's",            district:8, email:'bjs@peoplecapitalgroup.com'           },
];

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_ABB   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const ALERT_THRESHOLD = 26.0;

// ── Blob helper ───────────────────────────────────────────────────────────────
function getBlobStore() {
  return getStore({
    name: 'pcg-portal',
    siteID: process.env.PCG_SITE_ID,
    token: process.env.PCG_AUTH_TOKEN,
  });
}

async function blobLoad(key) {
  try {
    const store = getBlobStore();
    const raw = await store.get(key, { type: 'json' });
    if (!raw) return null;
    return raw.data !== undefined ? raw.data : raw;
  } catch { return null; }
}

async function blobSave(key, data) {
  const store = getBlobStore();
  await store.setJSON(key, { savedAt: new Date().toISOString(), data });
}

// ── Project one day's labor % ─────────────────────────────────────────────────
function projectDay(sched, hist, dateStr, dow) {
  if (!sched?.shifts) return null;
  const dayShifts = sched.shifts.filter(s => s.date === dateStr);
  let hrs = 0;
  const ids = new Set();
  for (const s of dayShifts) {
    if (s.startDateTime && s.endDateTime) {
      hrs += Math.max(0, Math.min((new Date(s.endDateTime) - new Date(s.startDateTime)) / 3600000, 14));
      if (s.employeeId) ids.add(s.employeeId);
    }
  }
  if (ids.size === 0) return null;

  const same = (hist?.daily || [])
    .filter(d => d.date && d.sales > 0 && d.hoursWorked > 0 && new Date(d.date + 'T12:00:00').getDay() === dow)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8);

  if (same.length < 2) return null;

  const avgSales = same.reduce((a, b) => a + b.sales, 0) / same.length;
  const avgLabor = same.reduce((a, b) => a + b.laborDollars, 0) / same.length;
  const avgHrs   = same.reduce((a, b) => a + b.hoursWorked, 0) / same.length;
  const rate     = avgHrs > 0 ? avgLabor / avgHrs : null;
  const projCost = rate ? hrs * rate : null;
  const projPct  = projCost && avgSales > 0 ? (projCost / avgSales) * 100 : null;

  return {
    scheduledCount: ids.size,
    scheduledHours: Math.round(hrs * 10) / 10,
    forecastedSales: Math.round(avgSales),
    projectedLaborCost: projCost ? Math.round(projCost) : null,
    projectedLaborPct: projPct != null ? Math.round(projPct * 10) / 10 : null,
  };
}

// ── Push notification helper ──────────────────────────────────────────────────
async function sendPushToUsers(userIds, subs, payload) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  const expired = [];
  for (const uid of userIds) {
    for (const sub of (subs[String(uid)] || [])) {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) expired.push({ uid, endpoint: sub.endpoint });
      }
    }
  }
  return expired;
}

// ── Email helper (Resend) ─────────────────────────────────────────────────────
function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      from: 'PCG Portal <alerts@peoplecapitalgroup.com>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    });
    const req = https.request({
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

// ── Email HTML template ───────────────────────────────────────────────────────
function buildAlertEmail(store, riskDays, recipientRole) {
  const rows = riskDays.map(({ dateStr, dow, proj }) => {
    const pct = proj.projectedLaborPct;
    const color = pct >= 28 ? '#ef4444' : '#f59e0b';
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #333;">${DAY_NAMES[dow]} ${dateStr}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #333;color:${color};font-weight:700;">${pct}%</td>
        <td style="padding:8px 12px;border-bottom:1px solid #333;">${proj.scheduledCount} staff · ${proj.scheduledHours}h</td>
        <td style="padding:8px 12px;border-bottom:1px solid #333;color:#94a3b8;">$${proj.forecastedSales?.toLocaleString()} est.</td>
      </tr>`;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<body style="background:#0f1117;color:#e2e8f0;font-family:'Segoe UI',Arial,sans-serif;padding:24px;margin:0;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
      <img src="https://pcg-ops.netlify.app/icon-192.png" width="40" height="40" style="border-radius:8px;" alt="PCG"/>
      <div>
        <div style="font-size:18px;font-weight:800;color:#FF671F;">PCG Portal — Labor Forecast Alert</div>
        <div style="font-size:12px;color:#94a3b8;">People Capital Group · Operations</div>
      </div>
    </div>

    <div style="background:#1e2330;border:1px solid #2d3748;border-radius:12px;padding:20px;margin-bottom:16px;">
      <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:4px;">⚠ ${store.name} — Schedule Risk</div>
      <div style="font-size:13px;color:#94a3b8;">District ${store.district} · ${recipientRole === 'dm' ? 'Your district' : 'Your store'} has projected labor above 26% this week</div>
    </div>

    <table style="width:100%;border-collapse:collapse;background:#1e2330;border:1px solid #2d3748;border-radius:8px;overflow:hidden;margin-bottom:16px;">
      <thead>
        <tr style="background:#FF671F22;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#FF671F;text-transform:uppercase;letter-spacing:0.8px;">Day</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#FF671F;text-transform:uppercase;letter-spacing:0.8px;">Projected Labor %</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#FF671F;text-transform:uppercase;letter-spacing:0.8px;">Schedule</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#FF671F;text-transform:uppercase;letter-spacing:0.8px;">Forecast Sales</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div style="background:#f59e0b18;border:1px solid #f59e0b44;border-radius:8px;padding:14px;margin-bottom:16px;">
      <div style="font-size:13px;color:#f59e0b;font-weight:600;">What to do</div>
      <div style="font-size:13px;color:#e2e8f0;margin-top:4px;">Review and adjust the schedule in Paycor for the highlighted days. Target labor below 23% for healthy margins. Reducing by 1–2 staff on peak days can bring the % back in range.</div>
    </div>

    <a href="https://pcg-ops.netlify.app" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Open Portal → Labor Tab</a>

    <div style="margin-top:20px;font-size:11px;color:#4a5568;">Automated alert from PCG Operations Portal · pcg-ops.netlify.app</div>
  </div>
</body>
</html>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  // Get today's date in ET
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const todayDs = `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}`;

  // Build this week's remaining days (tomorrow → Saturday)
  const todayDow = et.getDay();
  const upcomingDays = [];
  for (let i = 1; i <= (6 - todayDow); i++) {
    const d = new Date(et.getFullYear(), et.getMonth(), et.getDate() + i);
    const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    upcomingDays.push({ dateStr: ds, dow: d.getDay() });
  }

  if (upcomingDays.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: 'Saturday — no upcoming days to check this week' }), { status: 200, headers });
  }

  console.log(`[schedule-alerts] Checking ${STORES.length} stores for ${upcomingDays.length} upcoming days`);

  // Load blobs
  const [users, subs, existingAlerts] = await Promise.all([
    blobLoad('pcg_users_v1'),
    blobLoad('pcg_push_subscriptions_v1'),
    blobLoad('pcg_schedule_alerts_v1'),
  ]);

  const userList  = Array.isArray(users) ? users : [];
  const subMap    = subs && typeof subs === 'object' ? subs : {};

  // Already-sent keys this week (avoid duplicate alerts for same store+day)
  const sentThisWeek = new Set((existingAlerts?.sent || []).filter(k => k.startsWith(todayDs.slice(0, 7))));
  const newAlerts = existingAlerts?.alerts || [];
  const newSentKeys = [...sentThisWeek];

  // Process stores in batches of 6
  let totalAlerted = 0;
  const BATCH = 6;

  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async store => {
      try {
        const [sched, hist] = await Promise.all([
          blobLoad(`pcg_schedule_${store.pc}`),
          blobLoad(`pcg_labor_store_${store.pc}`),
        ]);

        if (!sched?.shifts) return;

        // Find at-risk days
        const riskDays = upcomingDays
          .map(({ dateStr, dow }) => {
            const key = `${store.pc}_${dateStr}`;
            if (sentThisWeek.has(key)) return null; // already alerted
            const proj = projectDay(sched, hist, dateStr, dow);
            if (!proj || proj.projectedLaborPct == null || proj.projectedLaborPct < ALERT_THRESHOLD) return null;
            return { dateStr, dow, proj, key };
          })
          .filter(Boolean);

        if (riskDays.length === 0) return;

        // Find DM and manager users
        const dm = userList.find(u => u.active !== false && u.userType === 'dm' && String(u.district) === String(store.district));
        const mgr = userList.find(u => u.active !== false && u.userType === 'manager' && (
          String(u.storePC) === String(store.pc) ||
          (u.name || '').toLowerCase().replace(/[^a-z]/g, '') === (store.mgr || '').toLowerCase().replace(/[^a-z]/g, '')
        ));

        const pushUserIds = [dm?.id, mgr?.id].filter(Boolean).map(String);
        const emailRecipients = [dm?.email, mgr?.email || store.email].filter(Boolean).filter((e, i, a) => e && a.indexOf(e) === i);

        const worstPct = Math.max(...riskDays.map(d => d.proj.projectedLaborPct));
        const daysSummary = riskDays.map(d => `${DAY_ABB[d.dow]} ${d.proj.projectedLaborPct}%`).join(', ');

        // Push notification
        if (pushUserIds.length > 0) {
          await sendPushToUsers(pushUserIds, subMap, {
            title: `⚠ Labor Risk — ${store.name}`,
            body: `Projected ${worstPct}% on ${daysSummary} — schedule review needed`,
            url: 'https://pcg-ops.netlify.app',
            tag: `schedule-risk-${store.pc}`,
            icon: '/icon-192.png',
          });
        }

        // Email notifications
        for (const email of emailRecipients) {
          const role = email === dm?.email ? 'dm' : 'manager';
          const html = buildAlertEmail(store, riskDays, role);
          await sendEmail(email, `⚠ Labor Forecast Alert — ${store.name} projected ${worstPct}% this week`, html);
        }

        // Log the alerts
        for (const { dateStr, dow, proj, key } of riskDays) {
          newAlerts.push({
            id: `${store.pc}_${dateStr}_${Date.now()}`,
            pc: store.pc, storeName: store.name, district: store.district,
            date: dateStr, day: DAY_NAMES[dow],
            projectedPct: proj.projectedLaborPct,
            scheduledCount: proj.scheduledCount, scheduledHours: proj.scheduledHours,
            forecastedSales: proj.forecastedSales,
            alertedAt: now.toISOString(),
            dmEmail: dm?.email, mgrEmail: mgr?.email || store.email,
            status: 'pending', actualPct: null,
          });
          newSentKeys.push(key);
          totalAlerted++;
        }

        console.log(`[schedule-alerts] ${store.name}: ${riskDays.length} risk days — alerted DM ${dm?.name || '—'}, mgr ${mgr?.name || '—'}`);
      } catch (err) {
        console.error(`[schedule-alerts] ${store.name} error:`, err.message);
      }
    }));
  }

  // Keep only last 90 days of alerts, keep only this-month sent keys
  const cutoff = new Date(et.getFullYear(), et.getMonth() - 3, et.getDate()).toISOString();
  const prunedAlerts = newAlerts.filter(a => a.alertedAt > cutoff).slice(-500);
  const thisMonth = todayDs.slice(0, 7);
  const prunedKeys = newSentKeys.filter(k => k.startsWith(thisMonth));

  await blobSave('pcg_schedule_alerts_v1', { sent: prunedKeys, alerts: prunedAlerts, lastRun: now.toISOString() });

  const summary = { ok: true, date: todayDs, storesChecked: STORES.length, alertsSent: totalAlerted };
  console.log('[schedule-alerts] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
