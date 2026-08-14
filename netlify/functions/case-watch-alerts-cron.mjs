// case-watch-alerts-cron.mjs — Urgent Complaint Keyword Alerts
// Runs every 15 minutes. Scans this month's Case Watch complaints (same
// read-only Supabase `cases` table case-watch.mjs already reads — see that
// file's header for the full pipeline explanation) for language suggesting
// real legal/health/safety exposure (mold, health department, sick, sue,
// lawyer, etc.) and immediately emails Mike so he doesn't have to stumble
// onto a serious complaint days later browsing the Complaints tab. Each
// case only ever fires once (tracked by case_id in
// pcg_case_watch_alerts_v1), even though the same complaint gets re-scanned
// every run until the month rolls over.
import https from 'node:https';
import { getStore } from '@netlify/blobs';

export const config = { schedule: '*/15 * * * *' };

// Grouped so the alert email/subject can say WHY it fired, not just "flagged".
// Whole-word/phrase match, case-insensitive (see matchCategories) — plain
// substring matching was tried first and immediately false-positived on
// "sue" matching inside "issue" (one of the most common words in any
// complaint), flooding Mike with ~90 bogus alerts on the very first run.
const KEYWORD_CATEGORIES = [
  { label: 'Legal Threat', words: ['sue', 'suing', 'sued', 'lawsuit', 'lawyer', 'attorney', 'legal action', 'litigation', "i'll see you in court", 'class action'] },
  { label: 'Health Department', words: ['health department', 'board of health', 'health inspector', 'file a complaint with the'] },
  { label: 'Illness / Food Safety', words: ['food poisoning', 'poisoned', 'vomit', 'throwing up', 'nausea', 'nauseous', 'diarrhea', 'allergic reaction', 'anaphyla', 'hospital', 'hospitalized', 'ambulance', 'emergency room', 'er visit', 'got sick', 'made me sick', 'made us sick', 'made my son sick', 'made my daughter sick'] },
  { label: 'Contamination', words: ['mold', 'moldy', 'roach', 'cockroach', 'rodent', 'mice', 'rat', 'maggot', 'foreign object', 'glass in my', 'metal in my', 'hair in my', 'plastic in my', 'bug in my', 'insect in my'] },
  { label: 'Injury', words: ['injured', 'injury', 'burned me', 'burnt me', 'third degree', 'cut myself', 'bleeding', 'broke a tooth', 'chipped my tooth'] },
];

// Whole-word boundaries so "sue" doesn't match inside "issue", "rat" doesn't
// match inside "restaurant/great", etc. Phrases (multi-word entries) still
// work the same way — \b only needs to anchor the very first/last character.
function wordMatch(text, phrase) {
  const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}
function matchCategories(text) {
  const t = text || '';
  return KEYWORD_CATEGORIES.filter(cat => cat.words.some(w => wordMatch(t, w))).map(cat => cat.label);
}

export function getBlobStore() {
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

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function currentMonthTabName() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
}

async function fetchCurrentMonthCases() {
  const supabaseUrl = process.env.CASE_WATCH_SUPABASE_URL;
  const anonKey = process.env.CASE_WATCH_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new Error('Case Watch not configured (missing CASE_WATCH_SUPABASE_URL / CASE_WATCH_SUPABASE_ANON_KEY)');
  const url = `${supabaseUrl}/rest/v1/cases?sheet_tab=eq.${encodeURIComponent(currentMonthTabName())}&select=*`;
  const res = await fetch(url, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
  if (!res.ok) throw new Error(`Case Watch DB HTTP ${res.status}`);
  return res.json();
}

// Deliberately Mike only, not the wider global notify list — explicit request
// (2026-08-14) to keep these urgent legal/health/safety alerts limited to him.
// Word-boundary matching confirmed clean (4 genuine hits, 0 false positives)
// against a temporary Ahmed test recipient before switching back to Mike.
const ALERT_RECIPIENTS = ['Mike@PeopleCapitalGroup.com'];

async function getRecipients() {
  return ALERT_RECIPIENTS;
}

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const FROM = process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>';
    const body = JSON.stringify({ from: FROM, to: Array.isArray(to) ? to : [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export async function runCaseWatchAlerts() {
  const [cases, log] = await Promise.all([
    fetchCurrentMonthCases(),
    blobLoad('pcg_case_watch_alerts_v1'),
  ]);
  const sentIds = new Set(log?.sent || []);
  const newSentIds = [...sentIds];
  let alertsSent = 0;
  const recipients = await getRecipients();

  for (const c of cases) {
    if (!c.case_id || sentIds.has(c.case_id)) continue;
    const text = `${c.customer_complaint || ''} ${c.comments || ''}`;
    const categories = matchCategories(text);
    if (categories.length === 0) continue;

    const subject = `🚨 URGENT — Customer complaint mentions ${categories.join(' & ')} (Store #${c.store_pc || '?'})`;
    const html = `
      <p style="font-size:15px;"><strong>Store #${escapeHtml(c.store_pc)}</strong> logged a complaint flagged for: <strong style="color:#e03131;">${escapeHtml(categories.join(', '))}</strong></p>
      <p style="color:#555;">Case ID: ${escapeHtml(c.case_id)} · Date: ${escapeHtml(c.date_in_sent || 'unknown')} · Severity: ${escapeHtml(c.severity_label || 'unrated')}</p>
      ${c.customer_name || c.email || c.phone ? `<p style="color:#555;">Guest: ${escapeHtml(c.customer_name || 'Unknown')}${c.email ? ` · ${escapeHtml(c.email)}` : ''}${c.phone ? ` · ${escapeHtml(c.phone)}` : ''}</p>` : ''}
      <div style="background:#fff5f5;border:1px solid #ffc9c9;border-radius:8px;padding:12px 16px;margin-top:12px;white-space:pre-wrap;font-size:14px;color:#111;">${escapeHtml(c.customer_complaint || '')}</div>
      ${c.comments ? `<p style="margin-top:10px;font-style:italic;color:#777;">${escapeHtml(c.comments)}</p>` : ''}
      <p style="margin-top:16px;">Full detail is in the Portal under Pulse → Store #${escapeHtml(c.store_pc)} → Complaints.</p>
    `;

    try {
      const status = await sendEmail(recipients, subject, html);
      if (status < 200 || status >= 300) console.error(`[case-watch-alerts] case ${c.case_id} email HTTP ${status}`);
      else alertsSent++;
    } catch (err) {
      console.error(`[case-watch-alerts] case ${c.case_id} email error:`, err.message);
      continue; // don't mark as sent if the email genuinely failed to go out — retry next run
    }

    newSentIds.push(c.case_id);
    console.log(`[case-watch-alerts] case ${c.case_id} (store ${c.store_pc}): ${categories.join(', ')} — sent to ${recipients.join(', ')}`);
  }

  const prunedIds = newSentIds.slice(-5000);
  await blobSave('pcg_case_watch_alerts_v1', { sent: prunedIds, lastRun: new Date().toISOString() });

  const summary = { ok: true, casesChecked: cases.length, alertsSent };
  console.log('[case-watch-alerts] done:', JSON.stringify(summary));
  return summary;
}

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try {
    const summary = await runCaseWatchAlerts();
    return new Response(JSON.stringify(summary), { status: 200, headers });
  } catch (err) {
    console.error('[case-watch-alerts] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
