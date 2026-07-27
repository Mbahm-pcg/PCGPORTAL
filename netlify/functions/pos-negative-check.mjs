// pos-negative-check.mjs — On-demand scan of recent Pulse checks for a negative
// final total. Known POS defect: voiding then re-adding an item on a recalled
// check can leave an orphan adjustment line (no menuItem attached) behind after
// every real item nets back to $0 — that orphan line drives chkTtl below zero.
// Called by the "🚩 Check Negatives" button in the Transactions section. Fast
// synchronous path for <=30 days — longer ranges (e.g. a full year) go through
// pos-negative-check-background.mjs instead, since that many sequential Pulse
// calls would blow past the 26s manual-invoke limit.

import https from 'node:https';
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

function etDate(offsetDays) {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setDate(et.getDate() - offsetDays);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers }); }

  const pc = String(body.pc || '');
  const days = Math.min(Math.max(parseInt(body.days) || 7, 1), 30);
  if (!pc) return new Response(JSON.stringify({ error: 'Missing pc' }), { status: 400, headers });

  const cfg = APIS[pc === '345986' ? 'p227' : 'p228'];
  const dates = Array.from({ length: days }, (_, i) => etDate(i));

  try {
    const results = await Promise.all(dates.map(async (date) => {
      let data;
      try { data = JSON.parse(await callUpstream(cfg, 'getGuestChecks', { locRef: pc, opnBusDt: date, clsdGuestChecksOnly: true, include: 'guestChecks' })); }
      catch { return []; }
      const checks = Array.isArray(data.guestChecks) ? data.guestChecks : [];
      return checks
        .filter(isNegativeDefect)
        .map(c => ({ date, chkNum: c.chkNum, chkTtl: c.chkTtl, opnUTC: c.opnUTC, guestCheckId: c.guestCheckId }));
    }));
    const findings = results.flat().sort((a, b) => b.date.localeCompare(a.date) || (b.chkNum - a.chkNum));
    return new Response(JSON.stringify({ ok: true, pc, daysScanned: days, findings }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers });
  }
};
