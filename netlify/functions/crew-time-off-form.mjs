// crew-time-off-form.mjs — the crew member's side of Crew Time Off (v23.30). NO sign-in: every
// request carries either a private link token (one person, 14 days, one use) or a store poster key.
//   GET  ?t=<token>            → { mode:'link', employee, store, position, balances, phone, email } or { state }
//   GET  ?s=<pc>&k=<key>       → { mode:'poster', store, employees:[{ id, name }] } — names only, never balances
//   GET  ?doc=&i=&exp=&sig=    → an attached document (signed, 2 hours; for the approvers' "open in a new tab")
//   POST { action:'verify', s, k, employeeId, badge } → poster only: name + badge ID (Paycor employee number) → { pass, balances }
//   POST { t | s,k,employeeId,pass, values, pdf, documents } → sent to the store manager
import { sql } from './_shared/db.mjs';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { refreshStoreList } from './_shared/store-status.mjs';
import { loadRoster } from './transfer-notice.mjs';
import { ensureTable, hashToken, posterOk, storeOf, docOk, notifyManagers, checkBadge, makePass, passOk } from './_shared/crew-time-off-lib.mjs';
import { crewValues, missingCrewFields, crewProblem, positionFor } from '../../src/crew-time-off.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const isSig = (s) => typeof s === 'string' && /^data:image\/png;base64,/.test(s) && s.length > 200 && s.length < 600000;
const DOC_TYPES = /^(application\/pdf|image\/(jpeg|png|heic|heif|webp|gif))$/;
const MAX_DOCS = 3, MAX_DOC_BYTES = 3.6 * 1024 * 1024;
const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function balancesFor(db, employeeId) {
  const rows = await db`SELECT balances FROM time_off_people WHERE paycor_employee_id = ${String(employeeId)}`.catch(() => []);
  return rows.flatMap(r => (Array.isArray(r.balances) ? r.balances : [])).map(b => ({ type: b.type, current: b.current }));
}

export default async (request) => {
  const db = sql();
  await ensureTable(db);
  const url = new URL(request.url);
  try {
    if (request.method === 'GET') {
      if (url.searchParams.get('doc')) {
        const id = Number(url.searchParams.get('doc')), i = Number(url.searchParams.get('i'));
        if (!docOk(id, i, url.searchParams.get('exp'), url.searchParams.get('sig'))) return new Response('This link has expired. Open the request in the portal again.', { status: 403 });
        const r = (await db`SELECT documents_data FROM crew_time_off WHERE id = ${id}`)[0];
        const d = Array.isArray(r?.documents_data) ? r.documents_data[i] : null;
        if (!d) return new Response('This document is no longer here — once approved it is in Google Drive.', { status: 404 });
        return new Response(Buffer.from(String(d.data || ''), 'base64'), { status: 200, headers: { 'Content-Type': d.type, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(d.name || 'document')}`,
          'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" } });
      }
      const t = url.searchParams.get('t');
      if (t) {
        const r = (await db`SELECT * FROM crew_time_off WHERE token_hash = ${hashToken(t)}`)[0];
        if (!r) return json(200, { state: 'unknown' });
        if (r.status !== 'invited') return json(200, { state: 'sent', employee: r.employee_name });
        if (r.link_expires_at && Date.parse(r.link_expires_at) < Date.now()) return json(200, { state: 'expired', employee: r.employee_name });
        const st = storeOf(r.pc);
        return json(200, { mode: 'link', employee: r.employee_name, employeeId: r.employee_id, store: st?.name || '', location: st?.name || '', position: positionFor(r.job_title),
          balances: await balancesFor(db, r.employee_id), phone: r.invite_phone || '', email: r.invite_email || '', today: todayET() });
      }
      const s = url.searchParams.get('s'), k = url.searchParams.get('k');
      if (s) {
        await refreshStoreList(STORES, ALL_STORES);
        const st = storeOf(s);
        if (!st || !posterOk(s, k)) return json(200, { state: 'unknown' });
        const roster = await loadRoster().catch(() => ({ stores: {} }));
        const employees = (roster.stores[String(st.pc)] || []).map(e => ({ id: e.id, name: e.name })).sort((a, b) => a.name.localeCompare(b.name));
        return json(200, { mode: 'poster', store: st.name, location: st.name, employees, today: todayET() });
      }
      return json(400, { error: 'Missing link' });
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });

    const body = await request.json().catch(() => ({}));
    if (body.action === 'verify') {
      await refreshStoreList(STORES, ALL_STORES);
      const st = storeOf(body.s);
      if (!st || !posterOk(body.s, body.k)) return json(403, { error: 'This QR code is not valid. Ask your manager.' });
      const roster = await loadRoster().catch(() => ({ stores: {} }));
      const emp = (roster.stores[String(st.pc)] || []).find(e => e.id === String(body.employeeId || ''));
      if (!emp) return json(404, { error: 'Pick your name again.' });
      const c = await checkBadge(db, st, emp.id, body.badge);
      if (c.locked) return json(429, { error: 'Too many wrong badge IDs. Try again in 30 minutes, or ask your manager to send you the form.' });
      if (c.noBadge) return json(409, { error: "We can't check your badge ID yet. Ask your manager to send you the form." });
      if (!c.ok) return json(401, { error: `That badge ID doesn't match ${emp.name}. ${c.left} ${c.left === 1 ? 'try' : 'tries'} left.` });
      return json(200, { ok: true, pass: makePass(st.pc, emp.id), employee: emp.name, position: positionFor(emp.jobTitle), balances: await balancesFor(db, emp.id) });
    }
    const v = crewValues(body.values || {});
    const missing = missingCrewFields(v);
    if (missing.length) return json(400, { error: `Still needed: ${missing.join(', ')}` });
    const problem = crewProblem(v, todayET());
    if (problem) return json(400, { error: problem });
    if (!isSig(v.signature)) return json(400, { error: 'Sign again — the signature did not come through.' });
    const pdf = Buffer.from(String(body.pdf || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (pdf.length < 1000 || pdf.length > 3e6 || pdf.subarray(0, 5).toString() !== '%PDF-') return json(400, { error: 'The form did not come through — try again.' });
    const docs = (Array.isArray(body.documents) ? body.documents : []).slice(0, MAX_DOCS).map(d => ({ name: String(d.name || 'document').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120), type: String(d.type || ''), data: String(d.data || '').replace(/^data:[^,]*,/, '') }));
    if (docs.some(d => !DOC_TYPES.test(d.type) || !d.data)) return json(400, { error: 'Documents can be photos or PDFs.' });
    if (docs.reduce((n, d) => n + Buffer.byteLength(d.data, 'base64'), 0) > MAX_DOC_BYTES) return json(400, { error: 'The documents are too large together (3.5 MB max). Take smaller photos or send fewer.' });

    let row;
    if (body.t) {
      const r = (await db`SELECT * FROM crew_time_off WHERE token_hash = ${hashToken(body.t)}`)[0];
      if (!r) return json(404, { error: 'This link is not valid.' });
      if (r.status !== 'invited') return json(409, { error: 'This form was already sent.' });
      if (r.link_expires_at && Date.parse(r.link_expires_at) < Date.now()) return json(410, { error: 'This link has expired. Ask your manager for a new one.' });
      if (v.employeeName !== r.employee_name) return json(400, { error: 'Your name on the form has to match the name the link was sent to.' });
      row = (await db`UPDATE crew_time_off SET status = 'manager', submitted_at = now(), form_values = ${JSON.stringify(v)}, pdf = ${pdf}, documents_data = ${JSON.stringify(docs)}, documents = ${docs.length},
          contact_phone = ${v.phone}, contact_email = ${v.email || null} WHERE id = ${r.id} AND status = 'invited' RETURNING *`)[0];
      if (!row) return json(409, { error: 'This form was already sent.' });
    } else {
      const s = String(body.s || '');
      await refreshStoreList(STORES, ALL_STORES);
      const st = storeOf(s);
      if (!st || !posterOk(s, body.k)) return json(403, { error: 'This QR code is not valid. Ask your manager.' });
      const roster = await loadRoster().catch(() => ({ stores: {} }));
      const emp = (roster.stores[String(st.pc)] || []).find(e => e.id === String(body.employeeId || ''));
      if (!emp) return json(404, { error: 'Pick your name from the list again.' });
      if (!passOk(body.pass, st.pc, emp.id)) return json(401, { error: 'Enter your badge ID again (it was more than 2 hours ago).' });
      if (v.employeeName !== emp.name) return json(400, { error: 'Pick your name from the list again.' });
      // the same person asking for the same dates twice while the first one still waits → once
      const dup = (await db`SELECT id FROM crew_time_off WHERE employee_id = ${emp.id} AND status IN ('manager', 'office') AND form_values->>'startDate' = ${v.startDate} LIMIT 1`)[0];
      if (dup) return json(409, { error: 'You already sent a request for these dates. Your manager has it.' });
      row = (await db`INSERT INTO crew_time_off (via, pc, employee_id, employee_name, job_title, status, submitted_at, form_values, pdf, documents_data, documents, contact_phone, contact_email)
        VALUES ('poster', ${String(st.pc)}, ${emp.id}, ${emp.name}, ${emp.jobTitle || null}, 'manager', now(), ${JSON.stringify(v)}, ${pdf}, ${JSON.stringify(docs)}, ${docs.length}, ${v.phone}, ${v.email || null}) RETURNING *`)[0];
    }
    const notified = await notifyManagers(db, row).catch(e => { console.error('[crew-time-off-form] notify', e.message); return 0; });
    return json(200, { ok: true, id: row.id, notified });
  } catch (e) {
    console.error('[crew-time-off-form]', e.message);
    return json(502, { error: 'Something went wrong — try again in a minute.' });
  }
};
