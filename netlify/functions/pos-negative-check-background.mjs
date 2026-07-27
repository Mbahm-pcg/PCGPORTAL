// pos-negative-check-background.mjs — Long-range (up to 1 year) scan of a store's
// Pulse checks for the negative-total POS defect. Runs as a background function
// (15-min timeout) since scanning 365 days synchronously would blow past the
// 26s manual-invoke limit. Writes incremental progress to a blob keyed by store
// PC so the frontend can poll it (same fire-and-forget + poll pattern as
// analyst-report-background). See pos-negative-check.mjs for the fast-path
// (<=30 day) synchronous version and the shared detection logic/comments.

import https from 'node:https';
import { getStore } from '@netlify/blobs';
import { isNegativeDefect } from '../../src/pos-negative-shared.mjs';

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

export default async (request) => {
  let body;
  try { body = await request.json(); } catch { body = {}; }

  const pc = String(body.pc || '');
  const days = Math.min(Math.max(parseInt(body.days) || 365, 1), 366);
  if (!pc) return new Response('Missing pc', { status: 400 });

  const cfg = APIS[pc === '345986' ? 'p227' : 'p228'];
  const key = `pcg_negcheck_${pc}`;
  const dates = Array.from({ length: days }, (_, i) => etDate(i));

  await blobSave(key, { status: 'running', done: 0, total: days, findings: [] });

  const BATCH = 15;
  const findings = [];
  for (let i = 0; i < dates.length; i += BATCH) {
    const batchDates = dates.slice(i, i + BATCH);
    const results = await Promise.all(batchDates.map(async (date) => {
      try {
        const raw = await callUpstream(cfg, 'getGuestChecks', { locRef: pc, opnBusDt: date, clsdGuestChecksOnly: true, include: 'guestChecks' });
        const data = JSON.parse(raw || '{}');
        const checks = Array.isArray(data.guestChecks) ? data.guestChecks : [];
        return checks
          .filter(isNegativeDefect)
          .map(c => ({ date, chkNum: c.chkNum, chkTtl: c.chkTtl, opnUTC: c.opnUTC, guestCheckId: c.guestCheckId }));
      } catch { return []; }
    }));
    findings.push(...results.flat());
    await blobSave(key, { status: 'running', done: Math.min(i + BATCH, dates.length), total: days, findings });
  }

  findings.sort((a, b) => b.date.localeCompare(a.date) || (b.chkNum - a.chkNum));
  await blobSave(key, { status: 'done', done: days, total: days, findings, completedAt: new Date().toISOString() });

  return new Response(JSON.stringify({ ok: true, pc, daysScanned: days, count: findings.length }), { status: 200 });
};
