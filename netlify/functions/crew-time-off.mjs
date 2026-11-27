// @ts-check
// crew-time-off.mjs — Tools · Crew Time Off, the staff side (v23.30). Signed in.
// Who: Store Managers (their store), DMs / Directors (their districts), exec / IT / office staff (all).
//   GET              → { stores, employees, lists: { manager, office, invited, done }, canOffice, today }
//   GET ?pdf=<id>    → the signed form
//   GET ?poster=<pc> → { url, store } — the store's QR poster address
//   POST { action:'invite', pc, employeeId, phone, email } → a private link (email; text without the link
//        until Textbelt allows links) — returns { link } so the screen can show it as a QR
//   POST { action:'cancel', id }                         → withdraw an unused link
//   POST { action:'manager', id, decision:'approve'|'reject', note } → the store manager's step
//   POST { action:'office',  id, decision:'approve'|'reject', note } → the office step → Drive + HR
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { refreshStoreList } from './_shared/store-status.mjs';
import { loadRoster, saveToDrive } from './transfer-notice.mjs';
import { emailWithFiles, saveDocToDrive } from './time-off-request.mjs';
import { timeOffAlertText, timeOffEmailHtml } from '../../src/time-off-request.mjs';
import { crewSummary, crewFileName, usDay, isEmail, isPhone } from '../../src/crew-time-off.mjs';
import { baseFor, ensureTable, storeOf, newToken, hashToken, linkFor, linkExpiry, sendInvite, posterUrl, docUrl, officePeople, notifyOffice, tellCrew, stampApproval, approvalLine, readList } from './_shared/crew-time-off-lib.mjs';
import { sendSms, sendPush } from './_shared/channels.mjs';
import { contactsFrom, pickContact } from '../../src/paycor-fields.mjs';
import { getStore } from '@netlify/blobs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const ROLES = new Set(['manager', 'dm', 'director', 'executive', 'it', 'office_staff']);
const HR_KEY = 'pcg_time_off_notify_v1'; // the Time Off Request list (HR) — told once a crew request is approved
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const real = authed.realUserType || authed.userType;
  if (!ROLES.has(real)) return json(403, { error: 'forbidden' });
  await ensureTable(db);
  await refreshStoreList(STORES, ALL_STORES);
  const me = (await db`SELECT id, name, store_pc FROM users WHERE id = ${authed.sub}`)[0] || {};
  const myName = me.name || authed.name || authed.username || '';
  let allowed = null; // null = every store
  if (real === 'manager') allowed = new Set(me.store_pc ? [String(me.store_pc)] : []);
  else if (real === 'dm' || real === 'director') { const ds = claimDistricts(authed); allowed = new Set(STORES.filter(s => ds.includes(String(s.district))).map(s => String(s.pc))); }
  const inScope = (pc) => !!storeOf(pc) && (!allowed || allowed.has(String(pc)));
  const office = await officePeople();
  const canOffice = office.ids.includes(String(authed.sub)) || real === 'executive' || real === 'it';
  const url = new URL(request.url);

  try {
    if (request.method === 'GET') {
      const pdfId = url.searchParams.get('pdf');
      if (pdfId) {
        const r = (await db`SELECT pdf, pc FROM crew_time_off WHERE id = ${Number(pdfId)}`)[0];
        if (!r?.pdf || !(inScope(r.pc) || canOffice)) return json(404, { error: 'Not found' });
        return new Response(r.pdf, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="crew-time-off.pdf"', 'Cache-Control': 'no-store' } });
      }
      // v23.32: the manager's phone home — how many wait for their approval, and their store's QR.
      if (url.searchParams.get('summary')) {
        const waiting = (await db`SELECT id, pc, employee_name, form_values, submitted_at FROM crew_time_off WHERE status = 'manager' ORDER BY submitted_at`)
          .filter(r => inScope(r.pc)).map(r => ({ id: r.id, name: r.employee_name, store: storeOf(r.pc)?.name || '', summary: r.form_values ? crewSummary(r.form_values) : '', submittedAt: r.submitted_at }));
        const myPc = real === 'manager' ? String(me.store_pc || '') : '';
        return json(200, { waiting, poster: myPc && storeOf(myPc) ? { url: posterUrl(myPc, baseFor(request)), store: storeOf(myPc).name } : null });
      }
      // v23.32 (user): the crew member's cell + email from Paycor, to pre-fill "Send a form". The employee
      // record, then the person record it points to (where Paycor keeps personal contact details). Only
      // values that look like an email or a phone number come back — nothing else from those records.
      const contactId = url.searchParams.get('contact');
      if (contactId) {
        if (!inScope(url.searchParams.get('pc'))) return json(403, { error: 'forbidden' });
        const roster = await loadRoster().catch(() => ({ stores: {} }));
        if (!(roster.stores[String(url.searchParams.get('pc'))] || []).some(e => e.id === contactId)) return json(404, { error: 'Not on that store roster.' });
        const { callPaycor } = await import('./paycor.mjs');
        const capped = (path) => Promise.race([callPaycor(path), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 7000))]).catch(() => null);
        // v23.36: the tested readers in src/paycor-fields.mjs (phone / email only; SSN / birth / bank never).
        // Paycor's "Get Person by EmployeeID" — /v1/employees/{id}/person — asked for Phones and Email
        // separately (as one list Paycor ignored it), never "All" (that includes the SSN).
        const eid = encodeURIComponent(contactId);
        const phones = [], emails = [];
        const add = (o, key) => { const c = contactsFrom(o, key); phones.push(...c.phones); emails.push(...c.emails); };
        const [pPhones, pEmail] = await Promise.all([capped(`/employees/${eid}/person?include=Phones`), capped(`/employees/${eid}/person?include=Email`)]);
        for (const p of [pPhones, pEmail]) if (p?.status === 200 && p.data) add(p.data, 'person');
        if (!emails.length) {
          for (const t of ['Home', 'Work']) {
            const e = await capped(`/employees/${eid}?emailType=${t}`);
            const rec = e?.data?.records?.[0] || e?.data;
            if (e?.status === 200 && rec?.email) { add({ email: rec.email }, `employee.${t.toLowerCase()}`); if (emails.length) break; }
          }
        }
        const picked = pickContact({ phones, emails });
        return json(200, { ...picked, found: { phones: phones.length, emails: emails.length } });
      }
      const posterPc = url.searchParams.get('poster');
      if (posterPc) {
        if (!inScope(posterPc)) return json(403, { error: 'forbidden' });
        return json(200, { url: posterUrl(posterPc, baseFor(request)), store: storeOf(posterPc)?.name || '' });
      }
      const stores = STORES.filter(s => inScope(s.pc)).map(s => ({ pc: String(s.pc), name: s.name }));
      const roster = await loadRoster().catch(() => ({ stores: {} }));
      const employees = [];
      for (const s of stores) for (const e of roster.stores[s.pc] || []) employees.push({ id: e.id, name: e.name, jobTitle: e.jobTitle, pc: s.pc });
      employees.sort((a, b) => a.name.localeCompare(b.name));
      const rows = await db`SELECT id, via, pc, employee_name, job_title, status, created_at, submitted_at, form_values, documents, documents_data IS NOT NULL AS has_docs,
          (SELECT json_agg(json_build_object('name', d->>'name', 'type', d->>'type')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(documents_data) = 'array' THEN documents_data ELSE '[]'::jsonb END) d) AS doc_meta,
          invited_by_name, invite_phone, invite_email, link_expires_at, manager_by_name, manager_at, office_by_name, office_at, decision_note, rejected_by_name, rejected_at, drive_link, (pdf IS NOT NULL) AS has_pdf
        FROM crew_time_off WHERE created_at > now() - interval '120 days' ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT 400`;
      const item = (r) => ({ id: r.id, via: r.via, pc: r.pc, store: storeOf(r.pc)?.name || `PC ${r.pc}`, name: r.employee_name, status: r.status,
        summary: r.form_values ? crewSummary(r.form_values) : null, values: r.form_values ? { phone: r.form_values.phone, email: r.form_values.email, leaveType: r.form_values.leaveType, totalHours: r.form_values.totalHours } : null,
        createdAt: r.created_at, submittedAt: r.submitted_at, invitedBy: r.invited_by_name, invitePhone: r.invite_phone, inviteEmail: r.invite_email, linkExpires: r.link_expires_at,
        managerBy: r.manager_by_name, managerAt: r.manager_at, officeBy: r.office_by_name, officeAt: r.office_at, note: r.decision_note, rejectedBy: r.rejected_by_name, rejectedAt: r.rejected_at,
        driveLink: r.drive_link, hasPdf: !!r.has_pdf, docs: (r.doc_meta || []).map((d, i) => ({ name: d.name, type: d.type, url: docUrl(r.id, i) })) });
      const mine = rows.filter(r => inScope(r.pc));
      return json(200, {
        stores, employees, canOffice, today: todayET(), role: real,
        lists: {
          manager: mine.filter(r => r.status === 'manager').map(item),
          office: (canOffice ? rows : mine).filter(r => r.status === 'office').map(item),
          invited: mine.filter(r => r.status === 'invited').map(item),
          done: (canOffice ? rows : mine).filter(r => r.status === 'approved' || r.status === 'rejected').slice(0, 80).map(item),
        },
      });
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = await request.json().catch(() => ({}));

    // v23.30: clear a badge lockout (5 wrong tries → 30 minutes) — exec / IT only.
    if (body.action === 'unlockBadge') {
      if (!(real === 'executive' || real === 'it')) return json(403, { error: 'Only exec or IT can unlock a badge ID.' }); // v23.32: not managers (user)
      await db`CREATE TABLE IF NOT EXISTS crew_badge_attempts (employee_id text PRIMARY KEY, fails integer NOT NULL DEFAULT 0, locked_until timestamptz, last_at timestamptz)`;
      const gone = await db`DELETE FROM crew_badge_attempts WHERE employee_id = ${String(body.employeeId || '')} RETURNING employee_id`;
      return json(200, { ok: true, unlocked: gone.length > 0 });
    }
    if (body.action === 'invite') {
      if (!inScope(body.pc)) return json(403, { error: 'You can only send this to people at your own stores.' });
      const phone = String(body.phone || '').trim(), email = String(body.email || '').trim();
      if (!email) return json(400, { error: "Enter their email: the form's link goes by email." }); // v23.34: email required, cell optional (user)
      if (phone && !isPhone(phone)) return json(400, { error: 'Check the cell number (10 digits).' });
      if (email && !isEmail(email)) return json(400, { error: 'Check the email address.' });
      const roster = await loadRoster().catch(() => ({ stores: {} }));
      const emp = (roster.stores[String(body.pc)] || []).find(e => e.id === String(body.employeeId || ''));
      if (!emp) return json(404, { error: 'This employee is not on that store\'s active roster in Paycor.' });
      const token = newToken();
      const row = (await db`INSERT INTO crew_time_off (token_hash, link_expires_at, via, pc, employee_id, employee_name, job_title, invited_by, invited_by_name, invite_phone, invite_email)
        VALUES (${hashToken(token)}, ${linkExpiry().toISOString()}, 'link', ${String(body.pc)}, ${emp.id}, ${emp.name}, ${emp.jobTitle || null}, ${Number(authed.sub) || null}, ${myName}, ${phone || null}, ${email || null}) RETURNING *`)[0];
      const sent = await sendInvite(row, token, myName, baseFor(request)).catch(e => { console.error('[crew-time-off] invite', e.message); return { emailed: false, texted: false }; });
      return json(200, { ok: true, id: row.id, link: linkFor(token, baseFor(request)), ...sent });
    }

    const r = (await db`SELECT * FROM crew_time_off WHERE id = ${Number(body.id)}`)[0];
    if (!r) return json(404, { error: 'Not found' });

    if (body.action === 'cancel') {
      if (!inScope(r.pc)) return json(403, { error: 'forbidden' });
      const upd = (await db`UPDATE crew_time_off SET status = 'rejected', decision_note = 'Link withdrawn', rejected_by_name = ${myName}, rejected_at = now(), token_hash = NULL
        WHERE id = ${r.id} AND status = 'invited' RETURNING id`)[0];
      if (!upd) return json(409, { error: 'It was already used.' });
      return json(200, { ok: true });
    }

    const reject = body.decision === 'reject';
    const note = String(body.note || '').trim().slice(0, 400);
    if (reject && note.length < 3) return json(400, { error: 'Say why it is being sent back.' });

    if (body.action === 'manager') {
      if (!(inScope(r.pc) || real === 'office_staff' || canOffice)) return json(403, { error: 'Only their store manager, DM or the office can do this.' });
      if (reject) {
        const upd = (await db`UPDATE crew_time_off SET status = 'rejected', decision_note = ${note}, rejected_by_name = ${myName}, rejected_at = now() WHERE id = ${r.id} AND status = 'manager' RETURNING *`)[0];
        if (!upd) return json(409, { error: 'This one was already decided — reload.' });
        await tellCrew(upd, `${myName} sent back your time off request (${crewSummary(upd.form_values || {})}). Why: ${note}. Ask your manager for a new form.`, 'Your time off request was sent back');
        return json(200, { ok: true });
      }
      const upd = (await db`UPDATE crew_time_off SET status = 'office', manager_by = ${Number(authed.sub)}, manager_by_name = ${myName}, manager_at = now() WHERE id = ${r.id} AND status = 'manager' RETURNING *`)[0];
      if (!upd) return json(409, { error: 'This one was already decided — reload.' });
      await notifyOffice(db, upd).catch(e => console.error('[crew-time-off] office notify', e.message));
      await tellCrew(upd, `${myName} approved your time off request (${crewSummary(upd.form_values || {})}). The office will confirm it.`, 'Your manager approved your time off');
      return json(200, { ok: true });
    }

    if (body.action === 'office') {
      if (!canOffice) return json(403, { error: 'Only the office (Admin · Notifications · Crew time off (office)), exec or IT can do this.' });
      if (reject) {
        const upd = (await db`UPDATE crew_time_off SET status = 'rejected', decision_note = ${note}, rejected_by_name = ${myName}, rejected_at = now() WHERE id = ${r.id} AND status = 'office' RETURNING *`)[0];
        if (!upd) return json(409, { error: 'This one was already decided — reload.' });
        await tellCrew(upd, `The office sent back your time off request (${crewSummary(upd.form_values || {})}). Why: ${note}. Talk to your manager.`, 'Your time off request was sent back');
        return json(200, { ok: true });
      }
      // approve, or file again an approved one whose filing failed
      const refile = r.status === 'approved' && (!r.drive_file_id || !r.alerted_at);
      const upd = refile ? r : (await db`UPDATE crew_time_off SET status = 'approved', office_by = ${Number(authed.sub)}, office_by_name = ${myName}, office_at = now() WHERE id = ${r.id} AND status = 'office' RETURNING *`)[0];
      if (!upd) return json(409, { error: 'This one was already decided — reload.' });
      const v = upd.form_values || {};
      let pdf = Buffer.from(upd.pdf);
      if (!refile) {
        try { pdf = await stampApproval(pdf, approvalLine(upd, myName)); await db`UPDATE crew_time_off SET pdf = ${pdf} WHERE id = ${upd.id}`; }
        catch (e) { console.error('[crew-time-off] stamp', e.message); }
      }
      const st = storeOf(upd.pc);
      const root = process.env.CREW_TIMEOFF_DRIVE_FOLDER_ID || process.env.TIMEOFF_DRIVE_FOLDER_ID || '';
      const folder = [st?.name || `PC ${upd.pc}`, upd.employee_name];
      const fileName = crewFileName(v);
      const docs = (Array.isArray(upd.documents_data) ? upd.documents_data : []).map(d => ({ name: d.name, type: d.type, buf: Buffer.from(String(d.data || ''), 'base64') }));
      let drive = { saved: !!upd.drive_file_id, link: upd.drive_link || '', error: null };
      const docLinks = docs.map(d => ({ name: d.name, link: '' }));
      if (!drive.saved) {
        try {
          const f = await saveToDrive(pdf, folder, fileName, `crewtimeoff:${upd.id}`, root);
          for (let i = 0; i < docs.length; i++) {
            const d = await saveDocToDrive(docs[i].buf, `${fileName.replace(/\.pdf$/, '')} - ${docs[i].name}`, docs[i].type, folder, `crewtimeoff:${upd.id}:doc${i}`, root);
            docLinks[i].link = d.webViewLink || '';
          }
          drive = { saved: true, link: f.webViewLink || '', error: null };
          await db`UPDATE crew_time_off SET drive_file_id = ${f.id}, drive_link = ${f.webViewLink || null}, drive_error = NULL, documents_data = NULL WHERE id = ${upd.id}`;
        } catch (e) {
          drive = { saved: false, link: '', error: e.message };
          console.error('[crew-time-off] drive', e.message);
          await db`UPDATE crew_time_off SET drive_error = ${String(e.message).slice(0, 500)} WHERE id = ${upd.id}`;
        }
      }
      let alert = null;
      const claimed = await db`UPDATE crew_time_off SET alerted_at = now() WHERE id = ${upd.id} AND alerted_at IS NULL RETURNING id`;
      if (claimed.length) {
        try {
          const l = await readList(HR_KEY);
          const t = timeOffAlertText(v);
          const [emailed, sms, push] = await Promise.all([
            l.emails.length ? emailWithFiles(l.emails, `Crew: ${t.title}`, timeOffEmailHtml(v, drive.link, docLinks), [{ name: fileName, buf: pdf }, ...docs]) : false,
            l.phones.length ? sendSms(l.phones, `Crew: ${t.sms}`) : { sent: 0 },
            l.ids.length ? sendPush(blobs(), l.ids, `Crew: ${t.title}`, t.line, 'crew-time-off', '/tools/crew-time-off') : { sent: 0 },
          ]);
          alert = { recipients: l.emails.length + l.phones.length + l.ids.length, emailed: !!emailed, texted: sms.sent || 0, pushed: push.sent || 0 };
        } catch (e) { console.error('[crew-time-off] HR alert', e.message); await db`UPDATE crew_time_off SET alerted_at = NULL WHERE id = ${upd.id}`; alert = { error: e.message }; }
      }
      if (!refile) await tellCrew(upd, `Your time off (${crewSummary(v)}) is approved.`, 'Your time off is approved');
      return json(200, { ok: drive.saved && !alert?.error, drive, alert });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[crew-time-off]', e.message);
    return json(502, { error: /Paycor/.test(e.message) ? 'Paycor is not responding — try again in a minute.' : 'Something went wrong — try again.' });
  }
};

// For the 3-hour reminders (pay-increase-reminder-cron.mjs).
export { notifyOffice } from './_shared/crew-time-off-lib.mjs';
export { notifyManagers } from './_shared/crew-time-off-lib.mjs';
