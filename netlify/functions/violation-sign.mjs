// violation-sign.mjs — remote employee signature for a Violation Notice (v22.81, trial).
//
// When the employee (or witness) isn't there, the supervisor saves the notice and a private link is
// EMAILED to them, with a no-link reminder text (createSignRequest, called by violation-notice.mjs).
// They open `<portal>/?sign=<code>` on their phone — no portal account — and:
//   POST { token, action: 'hello' } → first name + store, for the greeting.
//   POST { token, last4, action: 'open' } → after the last-4-of-phone check: who it's for + the
//          notice PDF (read-only), so they can read it.
//   POST { token, last4, action: 'sign', signature } → the server stamps THEIR signature, today's
//          date and an "e-signed" audit line onto the latest copy it kept (pdf-lib) — the signer only
//          ever supplies a signature image, never form content. The notice keeps that copy; once
//          nobody is left to sign it goes to the approver (afterRemoteSign in violation-notice.mjs),
//          and only an approved notice is filed in Drive.
//
// Safety: the code is 32 random bytes (only its sha256 is stored); one notice, one person; expires
// after 3 days; dies once signed or replaced; 5 wrong last-4 tries lock it. This endpoint is public
// on purpose and can reach nothing but the one notice the code points at.
import { createHash, randomBytes } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { sql } from './_shared/db.mjs';
import { afterRemoteSign } from './violation-notice.mjs';
import { sendSms, sendHtmlEmail } from './_shared/channels.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const TTL_DAYS = 3, MAX_TRIES = 5;
const hash = (t) => createHash('sha256').update(String(t)).digest('hex');
const digits = (s) => String(s || '').replace(/\D/g, '');
const tenDigits = (s) => { const d = digits(s); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
const isSig = (s) => typeof s === 'string' && /^data:image\/png;base64,/.test(s) && s.length > 200 && s.length < 600000;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 1)}***@${d}` : ''; };
const maskPhone = (p) =>`(***) ***-${tenDigits(p).slice(-4)}`;
const etStamp = (d = new Date()) => d.toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '');
const etDate = (d = new Date()) => d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' });

// Links point only at the portal's own addresses — never at whatever Origin a request claims.
export function signOrigin(request) {
  const o = String(request.headers.get('origin') || '');
  if (/^https:\/\/([a-z0-9-]+--)?pcg-ops\.netlify\.app$/.test(o) || /^https:\/\/uop\.peoplecapitalgroup\.com$/.test(o)) return o;
  return process.env.URL || 'https://pcg-ops.netlify.app';
}

export async function ensureSignTable(db) {
  await db`CREATE TABLE IF NOT EXISTS violation_sign_requests (
    id serial PRIMARY KEY, token_hash text UNIQUE NOT NULL, notice_id integer NOT NULL, pc text, store_name text,
    employee_name text, phone text NOT NULL, email text, file_name text, pdf text NOT NULL,
    created_by integer, created_by_name text, created_at timestamptz DEFAULT now(), expires_at timestamptz NOT NULL,
    attempts integer DEFAULT 0, opened_at timestamptz, signed_at timestamptz, cancelled_at timestamptz,
    signer_ip text, signer_agent text, signed_drive_link text, signed_drive_error text)`;
  await db`ALTER TABLE violation_sign_requests ADD COLUMN IF NOT EXISTS role text DEFAULT 'employee'`;
  await db`ALTER TABLE violation_sign_requests ADD COLUMN IF NOT EXISTS signer_name text`;
  await db`ALTER TABLE violation_sign_requests ADD COLUMN IF NOT EXISTS signed_pdf text`;
  // v22.84: 'notice' (the Violation Notice form) or 'letter' (an uploaded warning letter + our
  // acknowledgment page at the end).
  await db`ALTER TABLE violation_sign_requests ADD COLUMN IF NOT EXISTS layout text DEFAULT 'notice'`;
}

// ── Warning letters (v22.84, Sam: "drag and drop it on the portal and it gets sent to them and also
// gets uploaded to the disciplinary file") ──
// An uploaded letter (PDF, or a photo / scan) gets one page added at the end: an acknowledgment of
// receipt with a signature line the employee signs from their emailed link. pdf-lib coordinates
// (bottom-left origin) on a US Letter page.
const ACK = { sigX0: 186, sigX1: 400, sigBaseline: 381, dateX: 505, dateY: 383 };
const winAnsi = (s) => String(s ?? '').normalize('NFKD').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');

export async function letterToPdf(buf, mime) {
  if (mime === 'application/pdf') {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: false });
    if (!doc.getPageCount()) throw new Error('That PDF has no pages.');
    return doc;
  }
  // A photo or scan of the letter: one page, fitted to US Letter with a margin.
  const doc = await PDFDocument.create();
  const img = mime === 'image/png' ? await doc.embedPng(buf) : await doc.embedJpg(buf);
  const page = doc.addPage([612, 792]);
  const s = Math.min(560 / img.width, 740 / img.height);
  page.drawImage(img, { x: (612 - img.width * s) / 2, y: (792 - img.height * s) / 2, width: img.width * s, height: img.height * s });
  return doc;
}

export async function appendAckPage(doc, { employeeName, storeName, letterDate, from }) {
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0), grey = rgb(0.35, 0.35, 0.35);
  const center = (t, y, f, size) => page.drawText(t, { x: (612 - f.widthOfTextAtSize(t, size)) / 2, y, size, font: f, color: ink });
  center('ACKNOWLEDGMENT OF RECEIPT', 700, bold, 16);
  center('People Capital Group', 680, font, 10);
  const para = winAnsi(`By signing below, I acknowledge that I received the warning letter from ${from || 'People Capital Group'} attached before this page. Signing confirms that I received it; it does not necessarily mean that I agree with it.`);
  const words = para.split(' '); let line = '', y = 630;
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(t, 11) > 500) { page.drawText(line, { x: 56, y, size: 11, font, color: ink }); y -= 16; line = w; } else line = t;
  }
  if (line) page.drawText(line, { x: 56, y, size: 11, font, color: ink });
  const row = (label, value, yy) => { page.drawText(label, { x: 56, y: yy, size: 11, font: bold, color: ink }); page.drawText(winAnsi(value), { x: 186, y: yy, size: 11, font, color: ink }); page.drawLine({ start: { x: 182, y: yy - 3 }, end: { x: 556, y: yy - 3 }, thickness: 0.6, color: grey }); };
  row('Employee Name:', employeeName, 520);
  row('Location:', storeName, 494);
  row('Letter Dated:', letterDate, 468);
  page.drawText('Employee Signature:', { x: 56, y: 383, size: 11, font: bold, color: ink });
  page.drawLine({ start: { x: ACK.sigX0 - 4, y: 378 }, end: { x: ACK.sigX1, y: 378 }, thickness: 0.8, color: ink });
  page.drawText('Date:', { x: 418, y: 383, size: 11, font: bold, color: ink });
  page.drawLine({ start: { x: 452, y: 378 }, end: { x: 556, y: 378 }, thickness: 0.8, color: ink });
  return doc;
}

// Each link is for one ROLE (user, 2026-11-11: "for the witness, can we do the same thing"). Both can
// be out at once; each signature is stamped onto the latest copy, so the second PDF carries both.
// Where each role signs (jsPDF top-left points, from VIO_LAYOUT in src/violation-notice-pdf.mjs).
const SPOTS = {
  employee: { x0: 317.27, x1: 477.6, baseline: 650.88, dateX: 539.2, dateY: 648.4, auditY: 20, label: 'Employee' },
  witness: { x0: 310.15, x1: 470.8, baseline: 714.19, dateX: 532.1, dateY: 711.7, auditY: 29, label: 'Witness' },
};
const roleOf = (r) => (r && r.role === 'witness' ? 'witness' : 'employee');

// Called by violation-notice.mjs after the notice itself is saved. Replaces any earlier open link
// for the same notice. Returns { sent, texted, emailed, expiresAt, phone (masked) }.
export async function createSignRequest(db, { request, role = 'employee', layout = 'notice', signerName, noticeId, pc, storeName, employeeName, phone, email, fileName, pdf, createdBy, createdByName }) {
  await ensureSignTable(db);
  role = role === 'witness' ? 'witness' : 'employee';
  layout = layout === 'letter' ? 'letter' : 'notice';
  signerName = signerName || employeeName;
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + TTL_DAYS * 86400000);
  await db`UPDATE violation_sign_requests SET cancelled_at = now() WHERE notice_id = ${noticeId} AND COALESCE(role, 'employee') = ${role} AND signed_at IS NULL AND cancelled_at IS NULL`;
  await db`INSERT INTO violation_sign_requests (token_hash, notice_id, role, layout, signer_name, pc, store_name, employee_name, phone, email, file_name, pdf, created_by, created_by_name, expires_at)
    VALUES (${hash(token)}, ${noticeId}, ${role}, ${layout}, ${signerName}, ${String(pc)}, ${storeName}, ${employeeName}, ${tenDigits(phone)}, ${email || null}, ${fileName}, ${pdf.toString('base64')}, ${createdBy}, ${createdByName}, ${expires.toISOString()})`;
  const link = `${signOrigin(request)}/?sign=${token}`;
  const until = etDate(expires);
  const what = layout === 'letter' ? `review your warning letter from ${storeName} and sign to acknowledge you received it`
    : role === 'witness' ? `sign as witness on ${employeeName}'s Violation Notice from ${storeName}` : `review and sign your Violation Notice from ${storeName}`;
  // The link goes by EMAIL; the text is only a nudge with no link (user, 2026-11-11) — Textbelt
  // refuses any text with a link until the account is verified for links.
  const emailed = await sendHtmlEmail([email], layout === 'letter' ? 'Please review and acknowledge your warning letter' : role === 'witness' ? 'Please sign as witness on a Violation Notice' : 'Please review and sign your Violation Notice',
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p>Hi ${esc(signerName)},</p><p>People Capital Group asks you to ${esc(what)}.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Review and sign</a></p>
<p style="color:#666">This private link expires ${esc(until)}. You'll be asked for the last 4 digits of your phone number.${role === 'employee' ? ' Signing confirms you received the notice, not that you agree with it.' : ''}</p></div>`);
  const sms = await sendSms([tenDigits(phone)], `People Capital Group: we emailed you a request to ${what}. Please check your email inbox (and spam folder) and sign by ${until}.`);
  // No email address in the text: Textbelt reads "peoplecapitalgroup.com" in it as a link and refuses the whole text (2026-11-11).
  const smsError = sms.sent ? null : String(sms.results?.[0]?.error || 'not sent');
  if (smsError) console.error('[violation-sign] text failed', role, smsError.replace(/https?:\S+/g, '<url>'));
  return { role, sent: !!emailed, texted: sms.sent || 0, emailed: !!emailed, textNote: smsError ? 'The reminder text did not go through' : null, expiresAt: expires.toISOString(), phone: maskPhone(phone), email: maskEmail(email) };
}

// Stamp the employee's signature + date on the employee line, and an audit line at the foot.
// Positions match VIO_LAYOUT in src/violation-notice-pdf.mjs (jsPDF top-left points; pdf-lib is bottom-left).
export async function stampPdf(pdfB64, signature, phone, role = 'employee', layout = 'notice') {
  if (layout === 'letter') return stampLetter(pdfB64, signature, phone);
  const sp = SPOTS[role] || SPOTS.employee;
  const doc = await PDFDocument.load(Buffer.from(pdfB64, 'base64'));
  const page = doc.getPage(0);
  const H = page.getHeight();
  const img = await doc.embedPng(Buffer.from(signature.replace(/^data:[^,]*,/, ''), 'base64'));
  const s = Math.min((sp.x1 - sp.x0 - 8) / img.width, 22 / img.height);
  page.drawImage(img, { x: sp.x0 + 4, y: H - sp.baseline, width: img.width * s, height: img.height * s });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const date = etDate();
  page.drawText(date, { x: sp.dateX - font.widthOfTextAtSize(date, 9) / 2, y: H - sp.dateY, size: 9, font, color: rgb(0, 0, 0) });
  const audit = `${sp.label} signed electronically ${etStamp()} ET via a private emailed link (verified with the cell number ending ${tenDigits(phone).slice(-4)}).`;
  page.drawText(audit, { x: 36, y: sp.auditY, size: 7, font, color: rgb(0.35, 0.35, 0.35) });
  doc.setModificationDate(new Date());
  return Buffer.from(await doc.save());
}

// A warning letter: the signature goes on the acknowledgment page we added at the end.
async function stampLetter(pdfB64, signature, phone) {
  const doc = await PDFDocument.load(Buffer.from(pdfB64, 'base64'));
  const page = doc.getPage(doc.getPageCount() - 1);
  const img = await doc.embedPng(Buffer.from(signature.replace(/^data:[^,]*,/, ''), 'base64'));
  const s = Math.min((ACK.sigX1 - ACK.sigX0 - 4) / img.width, 34 / img.height);
  page.drawImage(img, { x: ACK.sigX0, y: ACK.sigBaseline, width: img.width * s, height: img.height * s });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const date = etDate();
  page.drawText(date, { x: ACK.dateX - font.widthOfTextAtSize(date, 11) / 2, y: ACK.dateY, size: 11, font, color: rgb(0, 0, 0) });
  page.drawText(`Signed electronically ${etStamp()} ET via a private emailed link (verified with the cell number ending ${tenDigits(phone).slice(-4)}).`, { x: 56, y: 340, size: 8, font, color: rgb(0.35, 0.35, 0.35) });
  doc.setModificationDate(new Date());
  return Buffer.from(await doc.save());
}

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await request.json().catch(() => ({}));
  const token = String(body.token || '');
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return json(404, { error: 'This link is not valid.' });
  const db = sql();
  try {
    await ensureSignTable(db);
    const r = (await db`SELECT * FROM violation_sign_requests WHERE token_hash = ${hash(token)}`)[0];
    if (!r) return json(404, { error: 'This link is not valid.' });
    if (r.signed_at) return json(410, { error: 'This has already been signed. Thank you.', done: true });
    if (r.cancelled_at) return json(410, { error: 'This link was replaced or cancelled. Ask your supervisor to send a new one.' });
    if (new Date(r.expires_at) < new Date()) return json(410, { error: 'This link has expired. Ask your supervisor to send a new one.' });
    if (r.attempts >= MAX_TRIES) return json(423, { error: 'Too many wrong tries — this link is locked. Ask your supervisor to send a new one.' });

    const role = roleOf(r);
    const signer = r.signer_name || r.employee_name;
    const kind = r.layout === 'letter' ? 'letter' : 'notice';
    if (body.action === 'hello') return json(200, { role, kind, firstName: String(signer || '').split(' ')[0], employeeName: role === 'witness' ? r.employee_name : undefined, storeName: r.store_name });

    if (digits(body.last4) !== r.phone.slice(-4)) {
      const left = MAX_TRIES - r.attempts - 1;
      await db`UPDATE violation_sign_requests SET attempts = attempts + 1 WHERE id = ${r.id}`;
      return json(403, { error: left > 0 ? `Those digits don't match. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries — this link is locked. Ask your supervisor to send a new one.' });
    }

    if (body.action === 'open') {
      if (!r.opened_at) await db`UPDATE violation_sign_requests SET opened_at = now() WHERE id = ${r.id}`;
      return json(200, { role, kind, signerName: signer, employeeName: r.employee_name, storeName: r.store_name, expiresAt: r.expires_at, pdf: r.pdf });
    }
    if (body.action !== 'sign') return json(400, { error: 'Unknown action' });
    if (!isSig(body.signature)) return json(400, { error: 'Sign again — the signature did not come through.' });

    // Claim it first so a double tap can't sign (or alert) twice.
    const claimed = await db`UPDATE violation_sign_requests SET signed_at = now(), signer_ip = ${request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for') || null},
      signer_agent = ${String(request.headers.get('user-agent') || '').slice(0, 300)} WHERE id = ${r.id} AND signed_at IS NULL RETURNING id`;
    if (!claimed.length) return json(410, { error: 'This has already been signed. Thank you.', done: true });

    // Stamp onto the latest copy — if the other remote signer already signed, keep their signature too.
    const latest = (await db`SELECT signed_pdf FROM violation_sign_requests WHERE notice_id = ${r.notice_id} AND id <> ${r.id} AND signed_pdf IS NOT NULL ORDER BY signed_at DESC LIMIT 1`)[0];
    let signed;
    try {
      signed = await stampPdf(latest?.signed_pdf || r.pdf, body.signature, r.phone, role, kind);
      await db`UPDATE violation_sign_requests SET signed_pdf = ${signed.toString('base64')} WHERE id = ${r.id}`;
    } catch (e) { await db`UPDATE violation_sign_requests SET signed_at = NULL WHERE id = ${r.id}`; throw e; }
    if (role === 'employee') await db`UPDATE violation_notices SET employee_signed = true WHERE id = ${r.notice_id}`.catch(() => {});
    // Nothing is filed or sent to the alert list here any more (v22.81 approval step): the notice keeps
    // this latest copy, and once nobody is left to sign it goes to the approver (violation-notice.mjs).
    try {
      const line = kind === 'letter' ? `${r.employee_name} (${r.store_name}) signed to acknowledge their warning letter.` : role === 'witness' ? `${signer} signed as witness on ${r.employee_name}'s Violation Notice (${r.store_name}).` : `${r.employee_name} (${r.store_name}) signed their Violation Notice.`;
      await afterRemoteSign(db, r.notice_id, signed, line);
    } catch (e) { console.error('[violation-sign] after sign', e.message); }

    return json(200, { ok: true, pdf: signed.toString('base64') });
  } catch (e) {
    console.error('[violation-sign]', e.message);
    return json(502, { error: 'Something went wrong — try again.' });
  }
};
