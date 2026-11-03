// paradox-hires-lib/run.mjs — new-hire alerts straight from the Paradox API (v22.43).
//
// Replaces waiting for Ally's "Officially Hired!" email + the 5-minute mailbox scan. Every
// minute (paradox-hires-cron.mjs):
//   1. GET /candidates?candidate_journey_status=Hire: Hired — everyone currently hired;
//   2. anything not in paradox_hires yet is a new hire;
//   3. find its store: GET /candidates filtered by job_loc_code (= the store's Dunkin' PC#,
//      confirmed 2026-11-03) + the candidate's email or job req — Paradox has no public
//      jobs API, and the candidate record carries no location (readme.paradox.ai);
//   4. send it to the people chosen in Admin → New Hires (same Test/Live switch, recipients
//      and email/text as the mailbox alerts, plus the Paycor legal #).
//
// Who sends is chosen in New Hires → "Where hires come from":
//   'email'   (default) — the mailbox scan sends; this job runs as a TRIAL: every new hire is
//             emailed to the test account only, marked [Paradox trial], to compare speed.
//   'paradox' — this job sends for real (per Test/Live); the mailbox scan only records.
// The very first run records everyone already hired and sends nothing (no backlog blast).
// Read-only against Paradox; credentials are the Paradox_ID / Paradox_API env vars.
import { getStore } from '@netlify/blobs';
import { sql } from '../_shared/db.mjs';
import { sendSms, sendHtmlEmail } from '../_shared/channels.mjs';
import { refreshStoreList } from '../_shared/store-status.mjs';
import { STORES, ALL_STORES } from '../labor-cron.mjs';
import { loadHiresConfig, hiresModeNow, hireAudience, loadLocations } from '../interview-reminders-lib/run.mjs';
import { buildHireEmail, buildHireText } from '../../../src/ally-hires.mjs';
import { HIRED_STATUS, readHiredRow, newHires, hireSource } from '../../../src/paradox-hires.mjs';

const BASE = 'https://api.paradox.ai/api/v1/public';
const STATUS_KEY = 'pcg_paradox_hires_status';
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });

// ── Paradox auth: token lasts 24h; reuse it while the function stays warm ──
let _token = null, _tokenExp = 0;
async function token() {
  if (_token && Date.now() < _tokenExp - 300000) return _token;
  const id = (process.env.Paradox_ID || '').trim(), secret = (process.env.Paradox_API || '').trim();
  if (!id || !secret) throw new Error('Paradox_ID / Paradox_API not set');
  const r = await fetch(`${BASE}/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }) });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Paradox auth failed (HTTP ${r.status})`);
  _token = j.access_token; _tokenExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return _token;
}
async function px(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${await token()}` } });
  if (r.status === 401) { _token = null; }
  if (!r.ok) throw new Error(`Paradox ${path.split('?')[0]} HTTP ${r.status}`);
  return r.json();
}

let _ready = false;
async function ensureTables(db) {
  if (_ready) return;
  await db`CREATE TABLE IF NOT EXISTS paradox_hires (
    oid          text PRIMARY KEY,
    candidate    text NOT NULL,
    job_req_id   text,
    store_pc     text,
    hired_at     timestamptz,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    notified_at  timestamptz,
    notify_note  text
  )`;
  _ready = true;
}

// Every currently-hired candidate (paged; the hired list is small — 35 on 2026-11-03).
async function fetchHired() {
  const out = [];
  for (let offset = 0; offset < 2000; offset += 50) {
    const j = await px(`/candidates?limit=50&offset=${offset}&candidate_journey_status=${encodeURIComponent(HIRED_STATUS)}`);
    const rows = Array.isArray(j?.candidates) ? j.candidates : [];
    rows.forEach(r => { const h = readHiredRow(r); if (h) out.push(h); });
    if (rows.length < 50) break;
  }
  return out;
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

// Which of our stores is this hire at? Same job req → same store, so reuse a past answer.
async function findStorePc(db, hire) {
  if (hire.jobReqId) {
    const known = (await db`SELECT store_pc FROM paradox_hires WHERE job_req_id = ${hire.jobReqId} AND store_pc IS NOT NULL LIMIT 1`)[0];
    if (known) return known.store_pc;
  }
  const filters = [
    hire.email ? `email=${encodeURIComponent(hire.email)}` : null,
    hire.jobReqId ? `job_req_id=${encodeURIComponent(hire.jobReqId)}` : null,
  ].filter(Boolean);
  for (const by of filters) {
    let found = null;
    await pool(STORES.map(s => String(s.pc)), 8, async (pc) => {
      if (found) return;
      try {
        const j = await px(`/candidates?limit=5&job_loc_code=${encodeURIComponent(pc)}&${by}&candidate_journey_status=${encodeURIComponent(HIRED_STATUS)}`);
        if (Array.isArray(j?.candidates) && j.candidates.some(r => String(r?.candidate?.OID) === hire.oid) && !found) found = pc;
      } catch {} // a store Paradox doesn't know (404) is simply not it
    });
    if (found) return found;
  }
  return null;
}

export async function runParadoxHires({ trigger = 'cron' } = {}) {
  const startedAt = Date.now();
  const db = sql();
  await ensureTables(db);
  const cfg = await loadHiresConfig();
  const source = hireSource(cfg);
  const hm = await hiresModeNow(cfg); // 'off' = ALLY_HIRES_MODE kill switch
  const status = { at: new Date().toISOString(), trigger, source, mode: hm, ok: true };
  try {
    const hired = await fetchHired();
    status.hiredInParadox = hired.length;
    const seen = new Set((await db`SELECT oid FROM paradox_hires`).map(r => String(r.oid)));
    const fresh = newHires(hired, seen);
    // First run ever: record the existing hires, send nothing.
    if (seen.size === 0 && fresh.length) {
      for (const h of fresh) {
        await db`INSERT INTO paradox_hires (oid, candidate, job_req_id, hired_at, notify_note)
          VALUES (${h.oid}, ${h.name}, ${h.jobReqId}, ${h.hiredAt}, 'already hired when Paradox alerts started — not sent') ON CONFLICT (oid) DO NOTHING`;
      }
      status.seeded = fresh.length;
    } else {
      if (fresh.length) await refreshStoreList(STORES, ALL_STORES);
      // Up to 5 per run (each store lookup is ~45 small calls); the rest are still unseen,
      // so the next minute picks them up.
      for (const h of fresh.slice(0, 5)) {
        const pc = await findStorePc(db, h);
        await db`INSERT INTO paradox_hires (oid, candidate, job_req_id, store_pc, hired_at)
          VALUES (${h.oid}, ${h.name}, ${h.jobReqId}, ${pc}, ${h.hiredAt}) ON CONFLICT (oid) DO NOTHING`;
      }
      status.newHires = fresh.length;
    }
    // Send anything not yet sent from the last 48h (a failed send retries next minute).
    const pending = await db`SELECT * FROM paradox_hires WHERE notified_at IS NULL AND (notify_note IS NULL OR notify_note = 'email failed')
      AND first_seen_at > now() - interval '48 hours' ORDER BY first_seen_at LIMIT 25`;
    status.pending = pending.length;
    if (pending.length && hm !== 'off') {
      // Trial (source still 'email'): test account only, labelled, never a text.
      const trial = source !== 'paradox';
      const aud = await hireAudience(db, cfg, trial ? 'shadow' : hm);
      const testLabel = trial ? `Paradox trial — the live alert still comes from the store email` : aud.testLabel;
      const locs = await loadLocations();
      let sent = 0;
      for (const r of pending) {
        // Claim it first so an overlapping run (a slow minute) can't send the same hire twice.
        const claimed = await db`UPDATE paradox_hires SET notify_note = 'sending' WHERE oid = ${r.oid} AND notified_at IS NULL
          AND (notify_note IS NULL OR notify_note = 'email failed') RETURNING oid`;
        if (!claimed.length) continue;
        const store = (r.store_pc && (locs.get(String(r.store_pc)) || ALL_STORES.find(x => String(x.pc) === String(r.store_pc)))) || (r.store_pc ? { pc: r.store_pc } : { name: 'Store not found in Paradox' });
        const details = [{ label: 'Source', value: 'Paradox (checked every minute)' }];
        const e = buildHireEmail({ candidate: r.candidate, store, receivedAt: r.hired_at, details, testLabel });
        const mailed = aud.emails.length ? await sendHtmlEmail(aud.emails, e.subject, e.html) : false;
        let texted = 0;
        if (aud.phones.length) { try { texted = (await sendSms(aud.phones, buildHireText({ candidate: r.candidate, store, receivedAt: r.hired_at }))).sent || 0; } catch {} }
        const ok = mailed || texted > 0;
        const note = trial ? 'emailed (Paradox trial)' : hm === 'shadow' ? 'emailed (test mode)' : [mailed ? `emailed ${aud.emails.length}` : null, aud.phones.length ? `texted ${texted}/${aud.phones.length}` : null].filter(Boolean).join(', ');
        if (ok) { sent++; await db`UPDATE paradox_hires SET notified_at = now(), notify_note = ${note} WHERE oid = ${r.oid}`; }
        else await db`UPDATE paradox_hires SET notify_note = 'email failed' WHERE oid = ${r.oid}`;
      }
      status.sent = sent;
    }
  } catch (e) {
    status.ok = false; status.error = String(e.message || e).slice(0, 300);
    console.warn('[paradox-hires] failed:', status.error);
  }
  status.durationMs = Date.now() - startedAt;
  try { await blobs().setJSON(STATUS_KEY, { savedAt: status.at, data: status }); } catch {}
  return status;
}

export async function loadParadoxHires(db) {
  await ensureTables(db);
  const rows = await db`SELECT oid, candidate, store_pc, hired_at, first_seen_at, notified_at, notify_note FROM paradox_hires ORDER BY first_seen_at DESC, hired_at DESC NULLS LAST LIMIT 15`;
  let status = null;
  try { status = (await blobs().get(STATUS_KEY, { type: 'json' }))?.data || null; } catch {}
  return { rows, status };
}
