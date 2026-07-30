// pos-negative-cron.mjs — Daily network-wide scan for POS checks that closed with
// a negative total. Known defect: voiding then re-adding an item on a recalled
// check can leave an orphan adjustment line (no menuItem attached) behind after
// every real item nets back to $0 — that orphan line drives chkTtl below zero.
// Runs 7:30 AM ET (after the prior business day has fully closed out), alerts the
// store manager + district DM via push, and drops an entry in the shared
// notifications blob so it surfaces in the bell. Dedupes by store+date+check#.

import https from 'node:https';
import webpush from 'web-push';
import { getStore } from '@netlify/blobs';
import { isNegativeDefect } from '../../src/pos-negative-shared.mjs';

export const config = { schedule: '30 11 * * *' };

const APIS = {
  p227: {
    host:   'pos-ra.dunkindonuts.com',
    path:   '/p227',
    xkey:   'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL',
    apikey: 'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
  p228: {
    host:   'pos-ra.dunkindonuts.com',
    path:   '/p228',
    xkey:   'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP',
    apikey: 'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
};

// Keep in sync with schedule-alerts.mjs / labor-cron.mjs (see CLAUDE.md gotcha #9).
const STORES = [
  { pc:'339616', name:'Wadsworth',       district:1 },
  { pc:'340794', name:'Front',           district:1 },
  { pc:'351099', name:'Sonic',           district:2 },
  { pc:'351259', name:'Rosemore',        district:2 },
  { pc:'302642', name:'County Line',     district:2 },
  { pc:'352894', name:'Street Rd',       district:2 },
  { pc:'341350', name:'Yardley',         district:2 },
  { pc:'337839', name:'Warrington',      district:2 },
  { pc:'330338', name:'Drexel Hill',     district:3 },
  { pc:'337063', name:'Sharon Hill',     district:3 },
  { pc:'343832', name:'Lansdowne',       district:3 },
  { pc:'304669', name:'Collingdale',     district:3 },
  { pc:'355146', name:'Gallery',         district:3 },
  { pc:'300496', name:'Cobbs Creek',     district:3 },
  { pc:'304863', name:'18th St',         district:3 },
  { pc:'354561', name:'Carlisle',        district:3 },
  { pc:'332393', name:'Lindbergh',       district:3 },
  { pc:'341167', name:'5th Street',      district:4 },
  { pc:'340870', name:'Hunting Park',    district:4 },
  { pc:'335981', name:'Lehigh',          district:4 },
  { pc:'353150', name:'Bakers Square',   district:4 },
  { pc:'351050', name:'Allegheny',       district:4 },
  { pc:'345985', name:'Wissahickon',     district:4 },
  { pc:'356374', name:'Montgomeryville', district:5 },
  { pc:'353843', name:'Tollgate',        district:5 },
  { pc:'353047', name:'Silverdale',      district:5 },
  { pc:'340538', name:'Easton',          district:5 },
  { pc:'343079', name:'Downingtown',     district:6 },
  { pc:'342144', name:'Westchester',     district:6 },
  { pc:'364295', name:'Lionville',       district:6 },
  { pc:'365361', name:'Little Welsh',    district:7 },
  { pc:'310382', name:'Grant',           district:7 },
  { pc:'332941', name:'Bustleton',       district:7 },
  { pc:'343497', name:'Red Lion',        district:7 },
  { pc:'302446', name:'Little Red Lion', district:7 },
  { pc:'337079', name:'Holme Circle',    district:7 },
  { pc:'345986', name:'Willits',         district:7 },
  { pc:'364412', name:'8200',            district:7 },
  { pc:'345489', name:'Oxford',          district:7 },
  { pc:'336372', name:'Elkins Park',     district:7 },
  { pc:'358933', name:'Brace Rd',        district:8 },
  { pc:'354865', name:'Quakertown',      district:8 },
  { pc:'353689', name:'Fort Washington', district:8 },
  { pc:'342184', name:'Lansdale',        district:8 },
  { pc:'356316', name:"BJ's",            district:8 },
];

function callUpstream(cfg, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: cfg.host, port: 443, path: `${cfg.path}/${endpoint}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.xkey, 'Api-Key': cfg.apikey, 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve(raw));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('upstream request timed out')));
    req.write(data);
    req.end();
  });
}

function getBlobStore() {
  return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
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

function etDate(offsetDays) {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setDate(et.getDate() - offsetDays);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

export default async () => {
  const yesterday = etDate(1);
  console.log(`[pos-negative-cron] Checking ${STORES.length} stores for negative-total checks on ${yesterday}`);

  const [users, subs, seenLog] = await Promise.all([
    blobLoad('pcg_users_v1'),
    blobLoad('pcg_push_subscriptions_v1'),
    blobLoad('pcg_pos_negative_checks_v1'),
  ]);
  const userList = Array.isArray(users) ? users : [];
  const subMap = subs && typeof subs === 'object' ? subs : {};
  const seenIds = new Set(seenLog?.seen || []);
  const runningLog = seenLog?.log || [];

  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  const newNotifs = [];
  let totalFound = 0;
  const BATCH = 6;

  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async (store) => {
      try {
        const cfg = APIS[store.pc === '345986' ? 'p227' : 'p228'];
        const raw = await callUpstream(cfg, 'getGuestChecks', { locRef: store.pc, opnBusDt: yesterday, clsdGuestChecksOnly: true, include: 'guestChecks' });
        const data = JSON.parse(raw || '{}');
        const checks = Array.isArray(data.guestChecks) ? data.guestChecks : [];
        const negs = checks.filter(isNegativeDefect);
        const fresh = negs.filter(c => !seenIds.has(`${store.pc}_${yesterday}_${c.chkNum}`));
        if (fresh.length === 0) return;

        totalFound += fresh.length;
        fresh.forEach(c => seenIds.add(`${store.pc}_${yesterday}_${c.chkNum}`));
        runningLog.push(...fresh.map(c => ({
          pc: store.pc, storeName: store.name, district: store.district,
          date: yesterday, chkNum: c.chkNum, chkTtl: c.chkTtl, foundAt: new Date().toISOString(),
        })));

        const dm = userList.find(u => u.active !== false && u.userType === 'dm' && String(u.district) === String(store.district));
        const mgr = userList.find(u => u.active !== false && u.userType === 'manager' && String(u.storePC ?? u.storePc) === String(store.pc));
        // No STORES array in this codebase (here, labor-cron.mjs, or schedule-alerts.mjs)
        // actually carries a manager-name string, so there's no working name-based
        // fallback to fall back to if storePC isn't set on the user record — log it
        // loudly instead of silently dropping the manager's alert.
        if (!mgr) console.warn(`[pos-negative-cron] No manager user found for store ${store.name} (pc ${store.pc}) — only the DM will be alerted`);
        const pushUserIds = [dm?.id, mgr?.id].filter(Boolean).map(String);

        const worst = Math.min(...fresh.map(c => c.chkTtl));
        const title = `⚠ Negative Total — ${store.name}`;
        const message = `${fresh.length} check${fresh.length > 1 ? 's' : ''} closed with a negative total (worst: $${worst.toFixed(2)}) on ${yesterday} — likely the void/re-add POS defect`;

        for (const uid of pushUserIds) {
          for (const sub of (subMap[uid] || [])) {
            try {
              await webpush.sendNotification(sub, JSON.stringify({
                title, body: message, url: 'https://pcg-ops.netlify.app',
                tag: `pos-neg-${store.pc}-${yesterday}`, icon: '/icon-192.png',
              }));
            } catch (err) {
              // Expired/invalid subscriptions are pruned by push.mjs's own cleanup path — ignore here.
            }
          }
        }

        newNotifs.push({
          id: `posneg_${store.pc}_${yesterday}_${Date.now()}`,
          type: 'pos_negative_total',
          storePC: store.pc, district: store.district,
          message: `${store.name}: ${message}`,
          // Deep-link fields for the notification-bell click handler: jump straight
          // to this store's Transactions view for this date, and auto-open the
          // specific check if there's exactly one (ambiguous when there are several).
          date: yesterday, chkNums: fresh.map(c => c.chkNum),
          read: false, createdAt: new Date().toISOString(),
        });

        console.log(`[pos-negative-cron] ${store.name}: ${fresh.length} negative-total check(s) — alerted DM ${dm?.name || '—'}, mgr ${mgr?.name || '—'}`);
      } catch (err) {
        console.error(`[pos-negative-cron] ${store.name} error:`, err.message);
      }
    }));
  }

  if (newNotifs.length > 0) {
    const existing = await blobLoad('pcg_notifications_v1');
    const merged = [...newNotifs, ...(Array.isArray(existing) ? existing : [])].slice(0, 500);
    await blobSave('pcg_notifications_v1', merged);
  }

  await blobSave('pcg_pos_negative_checks_v1', { seen: [...seenIds].slice(-5000), log: runningLog.slice(-1000) });

  const summary = { ok: true, date: yesterday, storesChecked: STORES.length, checksFound: totalFound };
  console.log('[pos-negative-cron] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
