// src/ally-hires.mjs — "<Name> is Officially Hired!" emails from Ally (Paradox) (v22.24).
// Pure, no I/O. The interview-reminders job already reads every store mailbox
// ({pc}@peoplecapitalgroup.com) every 15 min; when it sees one of these it emails
// exec/IT who was hired, at which store (PC#, property name, address) — so the
// office knows without anyone forwarding it.

// "Dunkin': Niraj Bhatt is Officially Hired!" -> "Niraj Bhatt" (null if not a hire email)
export function parseHireSubject(subject) {
  const m = String(subject || '').trim().match(/^(?:dunkin['’`]?\s*[:\-–]\s*)?(.+?)\s+is\s+officially\s+hired!?\s*$/i);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim();
  return name && name.length <= 80 ? name : null;
}

// Only notify for hires received recently — the mailbox search looks back 14 days,
// so without this the first run would email every hire from the last two weeks.
export function isRecentHire(receivedMs, nowMs, hours = 48) {
  return Number.isFinite(receivedMs) && nowMs - receivedMs <= hours * 3600000 && receivedMs <= nowMs + 5 * 60000;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#39|[a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : m))
    .replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

// Labelled details Ally may include ("Position: Crew Member", "Start Date: 10/28").
const DETAIL_LABELS = ['Position', 'Job Title', 'Job', 'Role', 'Start Date', 'Start Time', 'Location', 'Store', 'Hiring Manager', 'Pay Rate', 'Wage'];
export function extractDetails(text) {
  const out = [];
  for (const label of DETAIL_LABELS) {
    const m = String(text || '').match(new RegExp(`(?:^|\\n)\\s*${label}\\s*[:\\-–]\\s*([^\\n]{1,80})`, 'i'));
    if (m && !out.some(d => d.label === label)) out.push({ label, value: m[1].trim() });
  }
  return out;
}

// Short SMS version (v22.31): who, where, when — one line, no links.
export function buildHireText({ candidate, store, receivedAt, testLabel = null }) {
  const pc = store?.pc ? String(store.pc) : '';
  const prop = store?.name || (pc ? `PC# ${pc}` : 'a store');
  const dist = store?.district ? `, District ${store.district}${store.dmName ? ` (DM ${store.dmName})` : ''}` : '';
  const when = receivedAt ? new Date(receivedAt).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  return `${testLabel ? `[TEST: would go to ${testLabel}] ` : ''}PCG new hire: ${candidate} at ${prop}${pc && store?.name ? ` (PC# ${pc})` : ''}${dist}.${when ? ` Hired ${when} ET.` : ''}`;
}

// Who gets hire alerts (set in Admin → Notification Access Panel → New Hires).
// recipients: [{ userId, email, sms }] → cleaned, de-duplicated, at least one channel each.
export function cleanHireRecipients(list) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const id = Number(r && r.userId);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    const email = !!r.email, sms = !!r.sms;
    if (!email && !sms) continue;
    seen.add(id);
    out.push({ userId: id, email, sms });
  }
  return out;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// store: Locations record ({ pc, name, legal, address, city, state, district, dmName }).
// testLabel: in test mode, who it would have gone to.
export function buildHireEmail({ candidate, store, receivedAt, details = [], testLabel = null }) {
  const pc = store?.pc ? String(store.pc) : '';
  const prop = store?.name || (pc ? `PC# ${pc}` : 'Unknown store');
  const addr = [store?.address, store?.city, store?.state].filter(Boolean).join(', ');
  const when = receivedAt ? new Date(receivedAt).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const subject = `${testLabel ? '[TEST] ' : ''}New hire: ${candidate} — ${prop}${pc ? ` (PC# ${pc})` : ''}`;
  const rows = [
    ['Store', `${prop}${pc ? ` · PC# ${pc}` : ''}`],
    ...(addr ? [['Address', addr]] : []),
    ...(store?.legal ? [['Legal entity', store.legal]] : []),
    ...(store?.district ? [['District', `District ${store.district}${store.dmName ? ` · DM ${store.dmName}` : ''}`]] : []),
    ...details.map(d => [d.label, d.value]),
    ...(when ? [['Hired (Ally)', `${when} ET`]] : []),
  ];
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1710;max-width:560px">
${testLabel ? `<p style="background:#fff4ec;border:1px solid #ffd2b8;border-radius:8px;padding:8px 12px;font-size:13px;color:#a8430f;margin:0 0 14px">Test mode — would go to: ${esc(testLabel)}</p>` : ''}
<p style="font-size:13px;color:#6b6560;margin:0 0 4px">New hire from Ally (Paradox)</p>
<h2 style="font-size:22px;margin:0 0 14px">${esc(candidate)}</h2>
<table style="border-collapse:collapse;font-size:14px;width:100%">
${rows.map(([k, v]) => `<tr><td style="padding:7px 12px 7px 0;color:#6b6560;white-space:nowrap;vertical-align:top;border-top:1px solid #eee">${esc(k)}</td><td style="padding:7px 0;border-top:1px solid #eee"><strong>${esc(v)}</strong></td></tr>`).join('\n')}
</table>
<p style="font-size:12px;color:#8a847e;margin:16px 0 0">Sent automatically by the PCG Portal from the store mailbox ${esc(pc ? `${pc}@peoplecapitalgroup.com` : '')}.</p>
</div>`;
  const text = `${testLabel ? `[TEST — would go to: ${testLabel}]\n` : ''}New hire: ${candidate}\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}`;
  return { subject, html, text };
}
