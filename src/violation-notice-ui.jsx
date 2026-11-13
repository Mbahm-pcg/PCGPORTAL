// src/violation-notice-ui.jsx — Tools · Violation Notice (v22.72).
//
// The screen IS HR's 2026 Violation Notice, ready to fill. Pick the employee (name, job title, PC#
// from Paycor, locked); the supervisor is you; the date is today. Notice type / violation type /
// action are checkboxes (one notice type, any violation types, one action; suspension asks for its
// dates). Description and date of violation are required. The supervisor must sign; the employee
// signs, is marked "refused to sign", or is left blank; the witness is optional (typed name).
// "Save & send" sends first (Drive + the Admin list, violation-notice.mjs), then hands over the
// PDF (src/violation-notice-pdf.mjs). A signature is void if the form changes after it.
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FIN_CSS, FinBanner, finStyles } from './finance-ui.jsx';
import { SignatureModal, toB64, deliverPdf, PdfOpenButton } from './transfer-notice-ui.jsx';
import { FormPreview, FormModal } from './pay-increase-ui.jsx';
import { SignProgress } from './sign-progress-ui.jsx';
import { VnCollect } from './violation-collect-ui.jsx';
import { buildViolationPdf, VIO_FONT, VIO_CHROME, formatVioDate } from './violation-notice-pdf.mjs';
import { NOTICE_TYPES, VIOLATION_TYPES, ACTIONS, DESCRIPTION_MIN, violationValues, violationFingerprint, missingViolationFields } from './violation-notice.mjs';

const { useState, useEffect } = React;
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const call = async (body) => {
  const res = await fetch('/.netlify/functions/violation-notice', {
    method: body ? 'POST' : 'GET', credentials: 'include',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
  return b;
};

let assetsPromise = null;
const fetchB64 = (path) => fetch(path).then(r => { if (!r.ok) throw new Error('load ' + path); return r.arrayBuffer(); }).then(toB64);
const loadAssets = () => assetsPromise || (assetsPromise = Promise.all([fetchB64('/fonts/' + VIO_FONT.regular), fetchB64('/fonts/' + VIO_FONT.bold), fetchB64('/' + VIO_CHROME.watermark.src)])
  .then(([regular, bold, seal]) => ({ fonts: { regular, bold }, watermark: 'data:image/png;base64,' + seal }))
  .catch(e => { assetsPromise = null; throw e; }));

const INK = '#111';
const FILL = '#fdf3ea';
const CSS = `
@font-face { font-family: 'Caladea'; src: url('/fonts/Caladea-Regular.ttf') format('truetype'); font-weight: 400; font-display: swap; }
@font-face { font-family: 'Caladea'; src: url('/fonts/Caladea-Bold.ttf') format('truetype'); font-weight: 700; font-display: swap; }
.vn-paper { font-family: 'Caladea', Cambria, Georgia, serif; color: ${INK}; background: #fff; }
.vn-paper p { margin: 0; }
.vn-h { font-weight: 700; text-decoration: underline; text-underline-offset: 2px; margin: 1.15em 0 0.55em; }
.vn-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.3em 1.2em; }
.vn-f { display: inline-flex; align-items: flex-end; gap: 0.35em; }
.vn-f b { white-space: nowrap; }
.vn-blank { font: inherit; color: ${INK}; border: none; border-bottom: 1px solid ${INK}; border-radius: 0; background: ${FILL}; padding: 0 0.3em; min-height: 1.4em; line-height: 1.4; text-align: center; -webkit-appearance: none; appearance: none; }
.vn-blank::placeholder, .vn-lines::placeholder { color: #9a8f86; font-style: italic; }
.vn-locked { display: inline-block; border-bottom: 1px solid ${INK}; padding: 0 0.3em; text-align: center; line-height: 1.4; min-width: 9em; }
.vn-locked.vn-empty { color: #9a8f86; font-style: italic; }
.vn-check { display: inline-flex; align-items: center; gap: 0.35em; cursor: pointer; margin-right: 1.1em; line-height: 1.9; }
.vn-check input { width: 1.05em; height: 1.05em; accent-color: ${O}; cursor: pointer; }
.vn-lines { font: inherit; width: 100%; box-sizing: border-box; border: none; resize: vertical; padding: 0.15em 0.3em; color: ${INK}; line-height: 1.75em;
  background-color: ${FILL}; background-image: repeating-linear-gradient(transparent 0, transparent calc(1.75em - 1px), #888 calc(1.75em - 1px), #888 1.75em); background-attachment: local; }
.vn-sigline { display: inline-flex; align-items: flex-end; border-bottom: 1px solid ${INK}; height: 2.5em; min-width: 12em; }
.vn-sigbtn { font: inherit; font-family: ${FONTS.body}; font-size: 0.8rem; color: ${O}; font-weight: 700; background: ${FILL}; border: 1px dashed ${O}; border-radius: 6px; padding: 0.25rem 0.65rem; margin: 0 0 0.2rem 0.2rem; cursor: pointer; }
.vn-sigimg { background: none; border: none; padding: 0; cursor: pointer; display: flex; align-items: flex-end; }
.vn-blank:focus-visible, .vn-lines:focus-visible, .vn-sigbtn:focus-visible, .vn-sigimg:focus-visible, .vn-check input:focus-visible { outline: 2px solid ${O}; outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .vn-blank, .vn-sigbtn { transition: none; } }`;

// Approver's view of one waiting notice: the signed PDF, then Approve or Send back (like Pay Increase).
function VnReview({ th, isMobile, form, onClose, canApprove, onEdit }) {
  const S = finStyles(th);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [backing, setBacking] = useState(false);
  const [note, setNote] = useState('');
  const isNew = form.flow === 'v2';
  const [sendTo, setSendTo] = useState({ on: false, email: '', phone: '' });
  const [hrSigning, setHrSigning] = useState(false); // v22.98: HR signs the approval line
  const toOk = !sendTo.on || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sendTo.email.trim()) && (() => { const d = sendTo.phone.replace(/\D/g, ''); return !d || d.length === 10 || (d.length === 11 && d[0] === '1'); })());
  const src = `/.netlify/functions/violation-notice?pdf=${form.id}`;
  const decide = async (action, hrSignature) => {
    setBusy(true); setErr(null);
    try {
      const b = await call({ action, id: form.id, note: note.trim(), hrSignature, sendTo: isNew && sendTo.on ? { email: sendTo.email.trim(), phone: sendTo.phone } : null });
      if (action === 'reject') return onClose(`Sent back to ${form.submittedBy}.`);
      if (isNew) return onClose(`Approved. ${b.sign?.sent ? `${form.employeeName} was emailed a link to sign.` : b.sign?.error ? b.sign.error : `It's under Waiting on signatures until ${form.employeeName} signs (in person or by link).`}`);
      const d = b.drive || {}, a = b.alert || {};
      onClose(`Approved: ${d.saved ? 'filed in Google Drive' : `not saved to Drive (${d.error || 'error'})`}, ${a.error ? `alert failed (${a.error})` : a.recipients ? `the Violation Notice list was alerted (${a.recipients})` : 'no one is on the Violation Notice alert list yet'}. ${form.submittedBy} was told.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div style={{ ...S.panel, padding: '1rem 1.1rem', marginBottom: '1.4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ ...S.panelTitle, fontSize: '1.05rem' }}>{form.employeeName}, {form.storeName}</div>
        <span style={{ color: th.muted, fontSize: '0.88rem' }}>From {form.submittedBy}{form.violationDate ? `, violation on ${formatVioDate(form.violationDate)}` : ''}</span>
      </div>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '0.8rem' }}>
        <FormPreview th={th} id={src} title={`Violation notice for ${form.employeeName}`} thumbWidth={isMobile ? 200 : 260} />
        <p style={{ fontSize: '0.82rem', color: th.muted, margin: 0, maxWidth: '22em' }}>Click the form to see it full size. <a href={src} target="_blank" rel="noreferrer" style={{ color: O }}>Download the PDF</a></p>
      </div>
      {err && <FinBanner th={th} tone="error" style={{ marginTop: '0.8rem' }}>{err}</FinBanner>}
      {isNew && canApprove && !backing && (
        <div style={{ marginTop: '0.9rem', fontFamily: FONTS.body, fontSize: '0.88rem' }}>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={sendTo.on} onChange={e => setSendTo(x => ({ ...x, on: e.target.checked }))} style={{ accentColor: O, width: 18, height: 18 }} />
            Also email {form.employeeName} a link to sign it now <span style={{ color: th.muted }}>(otherwise the supervisor gets it signed, in person or by link)</span>
          </label>
          {sendTo.on && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
              <input type="email" inputMode="email" autoComplete="off" placeholder="Employee email" aria-label="Employee email" value={sendTo.email} onChange={e => setSendTo(x => ({ ...x, email: e.target.value }))} style={{ ...S.input, flex: '1 1 14em', padding: '0.45rem 0.6rem' }} />
              <input type="tel" inputMode="tel" autoComplete="off" placeholder="Cell (optional)" aria-label="Employee cell (optional)" value={sendTo.phone} onChange={e => setSendTo(x => ({ ...x, phone: e.target.value }))} style={{ ...S.input, flex: '1 1 10em', padding: '0.45rem 0.6rem' }} />
            </div>
          )}
        </div>
      )}
      {backing && (
        <div style={{ marginTop: '0.8rem' }}>
          <label htmlFor="vn-note" style={{ display: 'block', fontWeight: 700, marginBottom: '0.3rem', color: th.text }}>Why is it being sent back?</label>
          <textarea id="vn-note" value={note} maxLength={400} rows={3} onChange={e => setNote(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', borderRadius: 8, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, padding: '0.5rem', fontFamily: FONTS.body }} />
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.9rem' }}>
        <button type="button" className="fin-btn" style={S.ghost} onClick={() => onClose(null)} disabled={busy}>Back</button>
        {!canApprove && <span style={{ color: th.muted, fontSize: '0.85rem', alignSelf: 'center' }}>Only the violation notice approver can approve this.</span>}
        {canApprove && (backing
          ? <button type="button" className="fin-btn" style={{ ...S.primary, background: '#b91c1c', opacity: note.trim().length >= 3 && !busy ? 1 : 0.5 }} disabled={note.trim().length < 3 || busy} onClick={() => decide('reject')}>{busy ? 'Sending…' : 'Send back'}</button>
          : <button type="button" className="fin-btn" style={S.ghost} onClick={() => setBacking(true)} disabled={busy}>Send back…</button>)}
        {canApprove && !backing && isNew && onEdit && <button type="button" className="fin-btn" style={S.ghost} disabled={busy} onClick={() => onEdit(form)}>Edit before approving</button>}
        {canApprove && !backing && <button type="button" className="fin-btn" style={{ ...S.primary, opacity: toOk ? 1 : 0.5 }} disabled={busy || !toOk} onClick={() => (isNew ? setHrSigning(true) : decide('approve'))}>{busy ? 'Approving…' : isNew ? 'Sign & approve' : 'Approve & file'}</button>}
      {hrSigning && <SignatureModal th={th} title="Your signature — HR approval" onCancel={() => setHrSigning(false)} onDone={(img) => { setHrSigning(false); decide('approve', img); }} />}
      </div>
    </div>
  );
}

const Locked = ({ value, placeholder = 'from Paycor', w }) => <span className={`vn-locked${value ? '' : ' vn-empty'}`} style={w ? { minWidth: w } : undefined} title="From Paycor — can't be changed here">{value || placeholder}</span>;

export function ViolationNotice({ th, isMobile, onBack }) {
  const S = finStyles(th);
  const [stores, setStores] = useState([]);
  const [employees, setEmployees] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [picked, setPicked] = useState(null); // { id, name, jobTitle, pc } from the roster
  const [supervisor, setSupervisor] = useState('');
  const [supervisorName, setSupervisorName] = useState('');
  const [date] = useState(todayIso()); // the day it was filled in
  const [notice, setNotice] = useState('');
  const [types, setTypes] = useState([]);
  const [action, setAction] = useState('');
  const [suspensionStart, setSuspensionStart] = useState('');
  const [suspensionReturn, setSuspensionReturn] = useState('');
  const [violationDate, setViolationDate] = useState('');
  const [description, setDescription] = useState('');
  const [descTouched, setDescTouched] = useState(false);
  const [improvement, setImprovement] = useState('');
  const [consequences, setConsequences] = useState('');
  const [witnessName, setWitnessName] = useState('');
  const [employeeRefused, setEmployeeRefused] = useState(false);
  // v22.81: employee not there → text them a private link to sign on their phone (violation-sign.mjs).
  // Per role ('employee' | 'witness'): the link goes by email, the text is a no-link nudge.
  const [remote, setRemoteState] = useState({ employee: { on: false, phone: '', email: '' }, witness: { on: false, phone: '', email: '' } });
  const setRemote = (role, patch) => setRemoteState(r => ({ ...r, [role]: { ...r[role], ...patch } }));
  const [sigs, setSigs] = useState({}); // { employee|supervisor|witness: { image, date, fp } }
  const [signing, setSigning] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  // v22.81 approval step: the approver (Sam) and exec / IT see the list first.
  const [listView, setListView] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [lists, setLists] = useState({ pending: [], waiting: [], complete: [] });
  const [view, setView] = useState('list');
  const [listTab, setListTab] = useState('pending');
  const [reviewing, setReviewing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [decided, setDecided] = useState(null);
  // v22.83 Sent back: kept until its maker deletes it or fixes and resends it.
  const [sentBack, setSentBack] = useState([]);
  const [myWaiting, setMyWaiting] = useState([]); // v22.91: the supervisor's own, with link progress
  const [fixing, setFixing] = useState(null); // the sent-back notice being fixed
  const [editing, setEditing] = useState(null); // v22.98: the approver editing a pending notice before approving
  const [approveTo, setApproveTo] = useState({ on: false, email: '', phone: '' });
  const [collecting, setCollecting] = useState(null);
  const [hrSig, setHrSig] = useState(null); // v22.98: HR's signature for an edit-and-approve // v22.98: id of the approved notice whose signatures are being collected
  const [backMsg, setBackMsg] = useState(null);
  const [backBusy, setBackBusy] = useState(null);
  // v22.84 warning-letter upload (Sam / exec / IT).
  const LETTER0 = () => ({ file: null, date: todayIso(), email: '', phone: '', busy: false, error: null, result: null, drag: false });
  const [letter, setLetter] = useState(LETTER0);

  const loadMain = () => call().then(b => {
    setStores(b.stores || []); setEmployees(b.employees || []);
    setSupervisor(s => s || b.myName || ''); setSupervisorName(s => s || b.myName || '');
    if (b.rosterError) setError(b.rosterError);
    setListView(!!b.listView); setCanApprove(!!b.canApprove);
    setLists({ pending: b.pending || [], waiting: b.waiting || [], complete: b.complete || [] });
    setSentBack(b.sentBack || []);
    setMyWaiting(b.myWaiting || []);
    // ?violation=<id> from the approval email opens that notice straight away.
    let open = null; try { open = sessionStorage.getItem('vn_open'); sessionStorage.removeItem('vn_open'); } catch {}
    const hit = open && (b.pending || []).find(x => String(x.id) === String(open));
    if (hit) { setView('list'); setListTab('pending'); setReviewing(hit); }
  }).catch(e => { setError(e.message); setEmployees([]); });
  useEffect(() => { loadMain(); }, []);

  const storeName = (pc) => stores.find(s => s.pc === String(pc))?.name || '';
  const form = { employee: picked, pc: picked?.pc, supervisor, date, notice, types, action, suspensionStart, suspensionReturn, violationDate, description, improvement, consequences, supervisorName, witnessName, employeeRefused };
  const base = violationValues(form);
  const fp = violationFingerprint(base);
  // v22.98: the supervisor's signature stays through later edits (user, 2026-11-13); employee /
  // witness sign only after approval, on the approved PDF.
  const sigOk = (k) => (sigs[k] && (k === 'supervisor' || sigs[k].fp === fp) ? sigs[k] : null);
  const voided = Object.keys(sigs).some(k => sigs[k] && sigs[k].fp !== fp);
  const values = violationValues({ ...form, employeeSig: sigOk('employee'), supervisorSig: sigOk('supervisor'), witnessSig: sigOk('witness') });
  const formMissing = missingViolationFields({ ...base, supervisorSignature: 'x' });
  const canSign = !formMissing.length;
  const remoteOn = (role) => remote[role].on && !sigOk(role) && (role !== 'employee' || !employeeRefused);
  const phoneOk = (p) => { const d = p.replace(/\D/g, ''); return d.length === 10 || (d.length === 11 && d[0] === '1'); };
  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
  const remoteMissing = ['employee', 'witness'].filter(remoteOn).flatMap(role => {
    const who = role === 'employee' ? 'Employee' : 'Witness';
    return [...(role === 'witness' && !witnessName.trim() ? ['Witness name'] : []), ...(!emailOk(remote[role].email) ? [`${who}'s email for the signing link`] : []), ...(!phoneOk(remote[role].phone) ? [`${who}'s cell number`] : [])];
  });
  const missing = [...missingViolationFields(values), ...remoteMissing];
  const ready = !missing.length && !busy;
  useEffect(() => { setSaved(null); }, [fp]);

  const q = query.trim().toLowerCase();
  const matches = q && employees ? employees.filter(e => e.name.toLowerCase().includes(q) || storeName(e.pc).toLowerCase().includes(q) || e.pc.includes(q)).slice(0, 40) : [];
  const pick = (e) => { setPicked(e); setQuery(e.name); setListOpen(false); };
  const toggleType = (k) => setTypes(t => (t.includes(k) ? t.filter(x => x !== k) : [...t, k]));

  const send = async (hrSigArg) => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (!JsPDF) throw new Error('PDF library did not load — refresh the page.');
      const { fonts, watermark } = await loadAssets();
      const doc = buildViolationPdf(JsPDF, fonts, values, { watermark });
      const fileName = `Violation-Notice-${values.employeeName.replace(/[^A-Za-z0-9]+/g, '-')}-${date}.pdf`;
      // Send first, then hand over the PDF (on a phone a download would replace the portal).
      setSaved({ state: 'saving' });
      if (editing) {
        const b = await call({ action: 'approve', id: editing.id, values, pdf: doc.output('datauristring'), hrSignature: hrSigArg || hrSig, sendTo: approveTo.on ? { email: approveTo.email.trim(), phone: approveTo.phone } : null });
        setSaved(null); const who = editing.employeeName; setEditing(null); setView('list'); loadMain();
        setDecided(`Approved${b.edited ? ' with your changes' : ''}. ${b.sign?.sent ? `${who} was emailed a link to sign.` : b.sign?.error ? b.sign.error : `It's under Waiting on signatures until ${who} signs.`}`);
        setBusy(false); return;
      }
      try { const b = await call({ flow: 'v2', values, employeeId: picked.id, pdf: doc.output('datauristring'), replaces: fixing?.id }); setSaved({ state: 'done', ...b, pdfUrl: deliverPdf(doc, fileName) }); if (fixing) { setFixing(null); loadMain(); } }
      catch (e) { setSaved({ state: 'failed', error: e.message, pdfUrl: deliverPdf(doc, fileName) }); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const savedLine = () => {
    if (!saved) return null;
    if (saved.state === 'saving') return <span style={{ color: th.muted }}>Saving and sending…</span>;
    if (saved.state === 'failed') return <span style={{ color: '#dc2626' }}>Not saved: {saved.error}. Press the button again to retry.</span>;
    return (
      <span style={{ color: '#16a34a' }}>
        {saved.status === 'awaiting_signatures' ? 'Saved. Once the signatures below come in, it goes for approval; you\'ll be told when it\'s approved.'
          : saved.status === 'pending' ? `Sent to HR for approval${saved.notified ? '' : ' (no approver is set up yet — ask IT)'}. Once it's approved, get the employee's signature from Waiting on signatures (in person or by emailed link).`
          : saved.status === 'approved' ? 'This notice was already approved and filed.'
          : 'Saved.'}
        {(saved.remoteSign || []).map(r => {
          const who = r.role === 'witness' ? 'witness' : 'employee';
          return (
            <span key={r.role} style={{ display: 'block', marginTop: '0.3rem', color: r.sent ? (r.textNote ? '#d97706' : '#16a34a') : '#dc2626' }}>
              {r.error ? `The ${who}'s signing link was not sent: ${r.error}. Press the button again to retry.`
                : r.already ? `The ${who}'s signing link was just sent.`
                : r.signedAlready ? `The ${who} has already signed.`
                : r.sent ? `Signing link emailed to the ${who} (${r.email})${r.texted ? `, with a reminder text to ${r.phone}` : ''}. It expires ${new Date(r.expiresAt).toLocaleDateString('en-US')}. You'll get an alert when they sign.${r.textNote ? ` ${r.textNote}.` : ''}`
                : `The ${who}'s signing email did not go through. Check the address and press the button again.`}
            </span>
          );
        })}
      </span>
    );
  };

  const empSearch = (
    <span style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
      <input className="vn-blank" style={{ width: isMobile ? '14em' : '15em', maxWidth: '100%' }} value={query} role="combobox" aria-expanded={listOpen && matches.length > 0} aria-controls="vn-emp-list" autoComplete="off"
        aria-label="Employee name" placeholder={employees ? 'Search employee name' : 'Loading from Paycor…'} disabled={!employees}
        onChange={e => { setQuery(e.target.value); setListOpen(true); if (picked) setPicked(null); }}
        onFocus={() => setListOpen(true)} onBlur={() => setTimeout(() => setListOpen(false), 150)}
        onKeyDown={e => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); pick(matches[0]); } if (e.key === 'Escape') setListOpen(false); }} />
      {listOpen && matches.length > 0 && (
        <span id="vn-emp-list" role="listbox" style={{ position: 'absolute', zIndex: 30, left: 0, top: '100%', marginTop: 4, width: 'min(420px, 82vw)', maxHeight: 300, overflowY: 'auto', background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 12, boxShadow: '0 10px 30px rgba(0,0,0,0.15)', textAlign: 'left' }}>
          {matches.map(e => (
            <button key={e.pc + e.id} type="button" role="option" aria-selected="false" className="fin-btn" onMouseDown={ev => ev.preventDefault()} onClick={() => pick(e)}
              style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: '0.8rem', padding: '0.6rem 0.9rem', background: 'none', border: 'none', borderBottom: `1px solid ${th.cardBorder}`, color: th.text, textAlign: 'left', cursor: 'pointer', fontFamily: FONTS.body, fontSize: '0.88rem' }}>
              <span style={{ minWidth: 0 }}>{e.name}{e.jobTitle && <span style={{ color: th.muted }}> — {e.jobTitle}</span>}</span>
              <span style={{ color: th.muted, whiteSpace: 'nowrap' }}>{storeName(e.pc)} · {e.pc}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );

  const check = (checked, onChange, labelText, key) => (
    <label key={key} className="vn-check"><input type="checkbox" checked={checked} onChange={onChange} /> {labelText}</label>
  );
  const dateIn = (value, set, label, opts = {}) => <input type="date" className="vn-blank" style={{ width: '9.5em' }} value={value} min={opts.min} max={opts.notFuture ? todayIso() : undefined} onChange={e => set(e.target.value)} aria-label={label} />;
  const sigBlock = (key, label, name) => {
    const s = sigOk(key);
    const refused = key === 'employee' && !s && employeeRefused;
    // The witness's name is part of what's signed — type it first, then sign.
    const can = canSign && (key !== 'witness' || witnessName.trim());
    return (
      <div className="vn-row" style={{ marginTop: '0.9em' }}>
        <span className="vn-f"><b><u>{label}</u> - Name:</b>{name}</span>
        <span className="vn-f"><b>Signature:</b>
          <span className="vn-sigline">
            {refused ? <span style={{ paddingBottom: '0.2em', paddingLeft: '0.4em' }}>Refused to sign</span>
              : key !== 'supervisor' && remoteOn(key) ? <span style={{ paddingBottom: '0.2em', paddingLeft: '0.4em', color: '#6b6158', fontStyle: 'italic' }}>Will sign by email link</span>
              : s ? <button type="button" className="vn-sigimg" onClick={() => setSigning(key)} title="Sign again"><img src={s.image} alt={`${label} signature`} style={{ maxHeight: '2.3em', maxWidth: '12em', objectFit: 'contain' }} /></button>
              : <button type="button" className="vn-sigbtn" disabled={!can} onClick={() => setSigning(key)} style={{ opacity: can ? 1 : 0.45, cursor: can ? 'pointer' : 'not-allowed' }}>{can ? `Tap to sign — ${label}` : canSign ? 'Type the witness name first' : 'Fill in the form first'}</button>}
          </span>
        </span>
        <span className="vn-f"><b>Date:</b><Locked value={s ? formatVioDate(s.date) : ''} placeholder="on signing" w="6.5em" /></span>
        {key === 'employee' && !s && !remoteOn('employee') && <label className="vn-check" style={{ fontFamily: FONTS.body, fontSize: '0.8rem' }}><input type="checkbox" checked={employeeRefused} onChange={e => { setEmployeeRefused(e.target.checked); if (e.target.checked) setRemote('employee', { on: false }); }} /> Employee refused to sign</label>}
        {key !== 'supervisor' && !s && !refused && <label className="vn-check" style={{ fontFamily: FONTS.body, fontSize: '0.8rem' }}><input type="checkbox" checked={remote[key].on} onChange={e => setRemote(key, { on: e.target.checked })} /> {label} isn't here: email them a link to sign</label>}
        {key !== 'supervisor' && remoteOn(key) && (() => {
          const r = remote[key];
          return (
            <div className="vn-row" style={{ fontFamily: FONTS.body, fontSize: '0.85rem', width: '100%', marginTop: '0.2em' }}>
              <span className="vn-f"><b>{label} email:</b><input className="vn-blank" type="email" inputMode="email" autoComplete="off" style={{ width: '13em', ...(r.email && !emailOk(r.email) ? { boxShadow: 'inset 0 -2px 0 #dc2626' } : {}) }} value={r.email} maxLength={120} onChange={e => setRemote(key, { email: e.target.value })} aria-label={`${label} email`} /></span>
              <span className="vn-f"><b>{label} cell:</b><input className="vn-blank" type="tel" inputMode="tel" autoComplete="off" style={{ width: '9.5em', ...(r.phone && !phoneOk(r.phone) ? { boxShadow: 'inset 0 -2px 0 #dc2626' } : {}) }} value={r.phone} maxLength={20} onChange={e => setRemote(key, { phone: e.target.value })} placeholder="(215) 555-0100" aria-label={`${label} cell number`} /></span>
              <span style={{ color: '#6b6158', fontSize: '0.9em', flexBasis: '100%' }}>On "Save & send" they're emailed a private link (expires in 3 days) and get a text reminding them to check their email. They confirm the last 4 digits of this cell number, read the notice and sign on their phone; the signed copy is filed and you're alerted.</span>
            </div>
          );
        })()}
      </div>
    );
  };

  // ── Sent back ──
  const fixNotice = (item) => {
    const fv = item.formValues || {};
    setPicked({ id: item.employeeId, name: fv.employeeName || item.employeeName, jobTitle: fv.jobTitle || item.jobTitle || '', pc: fv.pc || item.pc });
    setQuery(fv.employeeName || item.employeeName);
    setSupervisor(fv.supervisor || ''); setSupervisorName(fv.supervisorName || '');
    setNotice(fv.notice || ''); setTypes(fv.types || []); setAction(fv.action || '');
    setSuspensionStart(fv.suspensionStart || ''); setSuspensionReturn(fv.suspensionReturn || '');
    setViolationDate(fv.violationDate || ''); setDescription(fv.description || ''); setImprovement(fv.improvement || ''); setConsequences(fv.consequences || '');
    setWitnessName(fv.witnessName || ''); setEmployeeRefused(false);
    // v22.98: the supervisor's signature stays (user, 2026-11-13); the employee signs after approval.
    setSigs(fv.supervisorSignature ? { supervisor: { image: fv.supervisorSignature, date: fv.supervisorSignedDate || todayIso(), fp: '' } } : {}); setRemoteState({ employee: { on: false, phone: '', email: '' }, witness: { on: false, phone: '', email: '' } });
    setSaved(null); setBackMsg(null); setFixing(item); setView('form');
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
  };
  // v22.98: the approver opens a pending new-flow notice in the form, changes anything, and approves.
  const editNotice = (item) => {
    fixNotice(item);
    setFixing(null); setEditing(item); setReviewing(null); setApproveTo({ on: false, email: '', phone: '' });
  };
  const resendAsIs = async (item) => {
    setBackBusy(item.id); setBackMsg(null);
    try { const b = await call({ action: 'resend', id: item.id }); setBackMsg({ tone: 'success', text: `Resent as is: every signature still stands, and it's back with the approver${b.notified ? '' : ' (no approver is set up yet — ask IT)'}.` }); loadMain(); }
    catch (e) { setBackMsg({ tone: 'error', text: e.message }); }
    setBackBusy(null);
  };
  const deleteBack = async (item) => {
    if (!window.confirm(`Delete the sent-back notice for ${item.employeeName}? It will be gone from this screen for good.`)) return;
    setBackBusy(item.id); setBackMsg(null);
    try { await call({ action: 'delete', id: item.id }); setBackMsg({ tone: 'success', text: `Deleted the sent-back notice for ${item.employeeName}.` }); if (fixing?.id === item.id) setFixing(null); loadMain(); }
    catch (e) { setBackMsg({ tone: 'error', text: e.message }); }
    setBackBusy(null);
  };
  const sentBackList = (items, showMaker) => (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      {items.map(f => (
        <div key={f.id} style={{ padding: '0.75rem 0.95rem', borderRadius: 12, border: `1px solid ${th.cardBorder}`, borderLeft: '4px solid #d97706', background: th.card, color: th.text, fontFamily: FONTS.body }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap' }}>
            <span style={{ minWidth: 0 }}><strong>{f.employeeName}</strong> <span style={{ color: th.muted }}>{f.storeName}{showMaker ? `, from ${f.submittedBy}` : ''}</span></span>
            <span style={{ color: th.muted, fontSize: '0.8rem' }}>Sent back by {f.decidedBy || 'the approver'}{f.decidedAt ? `, ${new Date(f.decidedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}</span>
          </div>
          {f.note && <p style={{ margin: '0.35rem 0 0', fontSize: '0.9rem' }}>"{f.note}"</p>}
          <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap', marginTop: '0.55rem', fontSize: '0.85rem', fontWeight: 700 }}>
            {f.hasPdf && <button type="button" className="fin-btn" onClick={() => setViewing(f)} style={{ ...S.link, color: O }}>View form</button>}
            {f.canFix && <button type="button" className="fin-btn" disabled={backBusy === f.id} onClick={() => fixNotice(f)} style={{ ...S.link, color: O }}>Fix and resend</button>}
            {f.canFix && <button type="button" className="fin-btn" disabled={backBusy === f.id} onClick={() => resendAsIs(f)} style={{ ...S.link, color: O }}>{backBusy === f.id ? 'Working…' : 'Resend as is'}</button>}
            {f.canFix && <button type="button" className="fin-btn" disabled={backBusy === f.id} onClick={() => deleteBack(f)} style={{ ...S.link, color: '#b91c1c' }}>Delete</button>}
          </div>
        </div>
      ))}
    </div>
  );
  const myBack = sentBack.filter(f => f.mine);
  const kindTag = (f) => (f.kind === 'letter' ? <span style={{ display: 'inline-block', fontSize: '0.72rem', fontWeight: 700, color: O, border: `1px solid ${O}`, borderRadius: 6, padding: '0 0.35rem', marginRight: '0.45rem' }}>Warning letter</span> : null);
  // Fix email (v22.91): send a new link for one signer to a corrected address.
  const fixEmail = async (item, role, email) => {
    setBackBusy(item.id); setBackMsg(null);
    try {
      const b = await call({ action: 'resendLink', id: item.id, role, email });
      const r = (b.resent || [])[0] || {};
      setBackMsg({ tone: r.sent ? 'success' : 'error', text: r.sent ? `New signing link emailed to ${email}. The old link no longer works.` : 'The signing email did not go through. Check the address.' });
      loadMain();
    } catch (e) { setBackMsg({ tone: 'error', text: e.message }); }
    setBackBusy(null);
  };
  const waitingRow = (f, rowStyle, day, who, showMaker) => (
    <div key={f.id} style={rowStyle}>
      <span style={{ minWidth: 0, flex: '1 1 20em' }}>{kindTag(f)}{who(f)}<span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>{showMaker ? `From ${f.submittedBy}, ` : 'Sent '}{day(f.createdAt)}: {f.kind === 'letter' ? 'waiting on the employee to acknowledge it from their email link'
          : f.status === 'awaiting_employee' ? `approved by ${f.decidedBy || 'HR'}${f.editedBy ? ' (with changes)' : ''}; waiting on the employee's signature` : 'waiting on a signature from an email link'}</span>
        <SignProgress th={th} signing={f.signing} busy={backBusy === f.id} onFix={(role, email) => fixEmail(f, role, email)} /></span>
      <span style={{ display: 'flex', gap: '0.9rem', alignItems: 'center', fontSize: '0.85rem', fontWeight: 700 }}>
        {f.hasPdf && <button type="button" className="fin-btn" onClick={() => setViewing(f)} style={{ ...S.link, color: O }}>View</button>}
        {f.status === 'awaiting_employee' && <button type="button" className="fin-btn" onClick={() => setCollecting(collecting === f.id ? null : f.id)} style={{ ...S.link, color: O }}>{collecting === f.id ? 'Close' : 'Get signatures'}</button>}
        {(f.status !== 'awaiting_employee' || (f.signing || []).some(x => !x.signedAt)) && <button type="button" className="fin-btn" disabled={backBusy === f.id} onClick={() => resendLink(f)} style={{ ...S.link, color: O }}>{backBusy === f.id ? 'Sending…' : 'Resend link'}</button>}
      </span>
      {collecting === f.id && <div style={{ flexBasis: '100%' }}><VnCollect th={th} item={f} call={call} onDone={loadMain} /></div>}
    </div>
  );
  const resendLink = async (item) => {
    setBackBusy(item.id); setBackMsg(null);
    try {
      const b = await call({ action: 'resendLink', id: item.id });
      const r = (b.resent || [])[0] || {};
      setBackMsg({ tone: r.sent ? 'success' : 'error', text: r.sent ? `New signing link emailed to ${item.employeeName}${(b.resent || []).length > 1 ? ' and the witness' : ''}${r.texted ? ', with a reminder text' : ''}. The old link no longer works.` : 'The signing email did not go through.' });
      loadMain();
    } catch (e) { setBackMsg({ tone: 'error', text: e.message }); }
    setBackBusy(null);
  };

  // ── Upload a warning letter (Sam / exec / IT): drag & drop → employee acknowledges → filed ──
  if (listView && view === 'letter') {
    const L = letter;
    const set = (patch) => setLetter(x => ({ ...x, ...patch }));
    const phoneDigits = L.phone.replace(/\D/g, '');
    const okPhone = phoneDigits.length === 10 || (phoneDigits.length === 11 && phoneDigits[0] === '1');
    const okEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(L.email.trim());
    const need = [...(!L.file ? ['the letter'] : []), ...(!picked ? ['the employee'] : []), ...(!L.date ? ['the letter date'] : []), ...(!okEmail ? ["the employee's email"] : []), ...(!okPhone ? ["the employee's cell"] : [])];
    const takeFile = async (file) => {
      if (!file) return;
      if (!/^(application\/pdf|image\/jpeg|image\/png)$/.test(file.type)) { set({ error: 'Upload the letter as a PDF (in Word: File > Save as > PDF), or a JPG / PNG photo of it.' }); return; }
      if (file.size > 4 * 1024 * 1024) { set({ error: 'That file is over 4 MB. Save it as a smaller PDF and try again.' }); return; }
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the file.')); r.readAsDataURL(file); });
      set({ file: { name: file.name, type: file.type, size: file.size, data }, error: null, result: null });
    };
    const sendLetter = async () => {
      if (need.length || L.busy) return;
      set({ busy: true, error: null, result: null });
      try {
        const b = await call({ action: 'uploadLetter', employeeId: picked.id, pc: picked.pc, letterDate: L.date, email: L.email.trim(), phone: L.phone, file: { name: L.file.name, type: L.file.type, data: L.file.data } });
        const s = b.sign || {};
        set({ busy: false, result: b.already ? 'This letter was already sent.' : s.sent ? `Sent. ${picked.name} was emailed the letter with a link to acknowledge it${s.texted ? ', plus a reminder text' : ''}${s.textNote ? ` (${s.textNote.toLowerCase()})` : ''}. Once they sign, it's filed in Google Drive and you'll be told. It's under Waiting on signatures until then.` : 'Saved, but the email to the employee did not go through. Use Resend link under Waiting on signatures.' });
        loadMain();
      } catch (e) { set({ busy: false, error: e.message }); }
    };
    const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    return (
      <div className="fin-root" style={{ maxWidth: 760, margin: '0 auto' }}>
        <style>{FIN_CSS(th) + CSS}</style>
        <button type="button" className="fin-btn" onClick={() => { setView('list'); loadMain(); }} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Violation Notices</button>
        <h2 style={S.title}>Upload a warning letter</h2>
        <p style={S.lede}>Drop in your letter on company letterhead. It's emailed to the employee with a link to read it and sign an acknowledgment page that's added at the end. Once they sign, the letter and their acknowledgment are filed together in the Violation Notices Google Drive under their store.</p>
        {L.error && <FinBanner th={th} tone="error">{L.error}</FinBanner>}
        {L.result && <FinBanner th={th} tone="success">{L.result}</FinBanner>}
        <label onDragOver={e => { e.preventDefault(); if (!L.drag) set({ drag: true }); }} onDragLeave={() => set({ drag: false })}
          onDrop={e => { e.preventDefault(); set({ drag: false }); takeFile(e.dataTransfer.files && e.dataTransfer.files[0]); }}
          style={{ display: 'block', cursor: 'pointer', textAlign: 'center', padding: L.file ? '1.1rem' : '2.4rem 1rem', borderRadius: 14, border: `2px dashed ${L.drag ? O : th.cardBorder}`, background: L.drag ? 'rgba(255,103,31,0.06)' : th.card, color: th.text, marginBottom: '1rem', transition: 'border-color 0.15s, background-color 0.15s' }}>
          <input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" style={S.srOnly} onChange={e => { takeFile(e.target.files && e.target.files[0]); e.target.value = ''; }} />
          {L.file
            ? <span><strong>{L.file.name}</strong> <span style={{ color: th.muted }}>({fmtSize(L.file.size)})</span><span style={{ display: 'block', color: O, fontSize: '0.85rem', marginTop: 4, fontWeight: 700 }}>Drop or click to use a different file</span></span>
            : <span><strong style={{ fontSize: '1.05rem' }}>Drag and drop the letter here</strong><span style={{ display: 'block', color: th.muted, fontSize: '0.88rem', marginTop: 4 }}>or click to choose it. PDF, or a JPG / PNG photo, up to 4 MB</span></span>}
        </label>
        <div style={{ ...S.panel, padding: '1rem 1.1rem', display: 'grid', gap: '0.9rem', gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : 'repeat(2, minmax(0,1fr))', overflow: 'visible' }}>
          <label style={{ ...S.fieldLabel, gridColumn: isMobile ? undefined : '1 / -1' }}>Employee (from Paycor)<span className="vn-paper" style={{ background: 'transparent', fontSize: '0.95rem' }}>{empSearch}</span>
            {picked && <span style={{ color: th.text }}>{picked.name}{picked.jobTitle ? `, ${picked.jobTitle}` : ''} at {storeName(picked.pc)} (PC {picked.pc})</span>}</label>
          <label style={S.fieldLabel}>Date on the letter<input type="date" style={S.input} value={L.date} max={todayIso()} onChange={e => set({ date: e.target.value })} /></label>
          <span />
          <label style={S.fieldLabel}>Employee's email (the letter goes here)<input type="email" inputMode="email" autoComplete="off" style={S.input} value={L.email} maxLength={120} onChange={e => set({ email: e.target.value })} /></label>
          <label style={S.fieldLabel}>Employee's cell (reminder text + sign-in check)<input type="tel" inputMode="tel" autoComplete="off" style={S.input} value={L.phone} maxLength={20} placeholder="(215) 555-0100" onChange={e => set({ phone: e.target.value })} /></label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.9rem', flexWrap: 'wrap', margin: '1rem 0 2rem' }}>
          {need.length > 0 && !L.busy && <span style={{ color: th.muted, fontSize: '0.82rem' }}>Still needed: {need.join(', ')}</span>}
          <button type="button" className="fin-btn" disabled={!!need.length || L.busy} onClick={sendLetter} style={{ ...S.primary, opacity: need.length || L.busy ? 0.5 : 1, cursor: need.length || L.busy ? 'not-allowed' : 'pointer' }}>{L.busy ? 'Sending…' : 'Send to the employee'}</button>
        </div>
      </div>
    );
  }

  if (employees === null && !error) return <div className="fin-root" style={{ maxWidth: 940, margin: '0 auto' }}><style>{FIN_CSS(th)}</style><h2 style={S.title}>Violation Notice</h2><p style={{ color: th.muted }}>Loading…</p></div>;

  // ── approver / exec list: Pending · Waiting on signatures · Complete ──
  if (listView && view === 'list') {
    const day = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', textAlign: 'left', padding: '0.75rem 0.95rem', borderRadius: 12, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, fontFamily: FONTS.body };
    const who = (f) => <><strong>{f.employeeName}</strong> <span style={{ color: th.muted }}>{f.storeName}{f.jobTitle ? `, ${f.jobTitle}` : ''}</span></>;
    // In the order a notice moves through them (user, 2026-11-11): signatures → approval → complete.
    // v22.98 order (new flow): approval → sent back → employee signs → complete.
    const tabs = [['pending', `Pending approval${lists.pending.length ? ` (${lists.pending.length})` : ''}`], ['sentback', `Sent back${sentBack.length ? ` (${sentBack.length})` : ''}`], ['waiting', `Waiting on signatures${lists.waiting.length ? ` (${lists.waiting.length})` : ''}`], ['complete', 'Complete']];
    return (
      <div className="fin-root" style={{ maxWidth: 940, margin: '0 auto' }}>
        <style>{FIN_CSS(th) + CSS}</style>
        {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
        <h2 style={S.title}>Violation Notice</h2>
        <p style={S.lede}>Violation notices from supervisors, signed by them. Approve them as they are, edit them before approving, or send them back. Once approved, the employee signs (in person or by emailed link) and it's filed in Google Drive.</p>
        {decided && <FinBanner th={th} tone="success">{decided}</FinBanner>}
        {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
        {reviewing ? <VnReview th={th} isMobile={isMobile} form={reviewing} canApprove={canApprove} onEdit={editNotice} onClose={(msg) => { setReviewing(null); loadMain(); if (msg) setDecided(msg); }} /> : (<>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div role="tablist" aria-label="Violation notices" style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {tabs.map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={listTab === k} className="fin-btn" onClick={() => setListTab(k)}
                  style={{ ...S.ghost, minHeight: 36, padding: '0.4rem 0.95rem', background: listTab === k ? O : th.card3, color: listTab === k ? '#fff' : th.text }}>{label}</button>
              ))}
            </div>
            <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button type="button" className="fin-btn" style={S.ghost} onClick={() => { setDecided(null); setPicked(null); setQuery(''); setLetter(LETTER0()); setView('letter'); }}>Upload a warning letter</button>
              <button type="button" className="fin-btn" style={S.primary} onClick={() => { setDecided(null); setView('form'); }}>Start a violation notice</button>
            </span>
          </div>
          {listTab === 'waiting' && backMsg && <FinBanner th={th} tone={backMsg.tone}>{backMsg.text}</FinBanner>}
          {listTab === 'pending' && (lists.pending.length ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {lists.pending.map(f => (
                <button key={f.id} type="button" className="fin-btn" onClick={() => setReviewing(f)} style={{ ...rowStyle, border: `1px solid ${canApprove ? O : th.cardBorder}`, cursor: 'pointer' }}>
                  <span style={{ minWidth: 0 }}>{who(f)}<span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>From {f.submittedBy}, {day(f.createdAt)}{f.flow === 'v2' ? '' : ' (signed under the old process)'}</span></span>
                  <span style={{ color: canApprove ? O : th.muted, fontWeight: 700, fontSize: '0.85rem', alignSelf: 'center' }}>{canApprove ? 'Review' : 'View'}</span>
                </button>
              ))}
            </div>
          ) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>Nothing waiting for approval.</p>)}
          {listTab === 'waiting' && (lists.waiting.length ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {lists.waiting.map(f => waitingRow(f, rowStyle, day, who, true))}
            </div>
          ) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>No notices waiting on signatures.</p>)}
          {listTab === 'complete' && (lists.complete.length ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {lists.complete.map(f => (
                <div key={f.id} style={rowStyle}>
                  <span style={{ minWidth: 0 }}>{kindTag(f)}{who(f)}<span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>From {f.submittedBy}{f.kind === 'letter' && f.decidedAt ? `, acknowledged and filed ${day(f.decidedAt)}` : f.decidedBy ? `, approved by ${f.decidedBy} on ${day(f.decidedAt)}` : `, ${day(f.createdAt)}`}</span></span>
                  <span style={{ display: 'flex', gap: '0.9rem', alignItems: 'center', fontSize: '0.85rem', fontWeight: 700 }}>
                    {f.hasPdf && <button type="button" className="fin-btn" onClick={() => setViewing(f)} style={{ ...S.link, color: O }}>View form</button>}
                    {f.driveLink && <a href={f.driveLink} target="_blank" rel="noreferrer" style={{ color: O }}>Open in Google Drive</a>}
                  </span>
                </div>
              ))}
            </div>
          ) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>No approved violation notices yet.</p>)}
          {listTab === 'sentback' && (<>
            {backMsg && <FinBanner th={th} tone={backMsg.tone}>{backMsg.text}</FinBanner>}
            {sentBack.length ? sentBackList(sentBack, true) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>Nothing sent back.</p>}
          </>)}
          {viewing && <FormModal th={th} id={`/.netlify/functions/violation-notice?pdf=${viewing.id}`} title={`Violation notice for ${viewing.employeeName}`} onClose={() => setViewing(null)} />}
        </>)}
      </div>
    );
  }

  return (
    <div className="fin-root" style={{ maxWidth: 940, margin: '0 auto' }}>
      <style>{FIN_CSS(th) + CSS}</style>
      {listView
        ? <button type="button" className="fin-btn" onClick={() => { setView('list'); setEditing(null); loadMain(); }} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Violation Notices</button>
        : onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
      <h2 style={S.title}>Violation Notice</h2>
      <p style={S.lede}>{editing ? `Editing ${editing.employeeName}'s notice from ${editing.submittedBy}. Change anything, then approve. ${editing.submittedBy}'s signature stays, and the notice will say you revised and approved it.`
        : "Fill in the notice: the employee's name, job title and store come straight from Paycor. Check the boxes, describe what happened, then sign. It goes to HR for approval; once approved, the employee signs (here or by emailed link) and it's filed."}</p>

      {!listView && !fixing && myWaiting.length > 0 && (
        <section style={{ ...S.panel, padding: '0.9rem 1rem 1rem', marginBottom: '1.1rem' }} aria-label="Waiting on signatures">
          <h3 style={{ ...S.panelTitle, margin: '0 0 0.6rem', fontSize: '1.05rem' }}>Waiting on signatures ({myWaiting.length})</h3>
          {backMsg && !myBack.length && <FinBanner th={th} tone={backMsg.tone}>{backMsg.text}</FinBanner>}
          <div style={{ display: 'grid', gap: '0.5rem' }}>{myWaiting.map(f => waitingRow(f, { display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', padding: '0.75rem 0.95rem', borderRadius: 12, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, fontFamily: FONTS.body },
            (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), (x) => <><strong>{x.employeeName}</strong> <span style={{ color: th.muted }}>{x.storeName}</span></>, false))}</div>
        </section>
      )}
      {!listView && !fixing && myBack.length > 0 && (
        <section style={{ ...S.panel, padding: '0.9rem 1rem 1rem', marginBottom: '1.1rem' }} aria-label="Sent back">
          <h3 style={{ ...S.panelTitle, margin: '0 0 0.6rem', fontSize: '1.05rem' }}>Sent back ({myBack.length})</h3>
          {backMsg && <FinBanner th={th} tone={backMsg.tone}>{backMsg.text}</FinBanner>}
          {sentBackList(myBack, false)}
        </section>
      )}
      {!listView && !fixing && !myBack.length && backMsg && <FinBanner th={th} tone={backMsg.tone}>{backMsg.text}</FinBanner>}
      {fixing && (
        <FinBanner th={th} tone="warn">
          Fixing the notice for {fixing.employeeName} that {fixing.decidedBy || 'the approver'} sent back{fixing.note ? `: "${fixing.note}"` : ''}. Make the change and send it again; {fixing.formValues?.supervisorSignature ? 'your signature stays' : 'sign it'}, and it goes back to HR.{' '}
          <button type="button" className="fin-btn" onClick={() => { setFixing(null); setView(listView ? 'list' : 'form'); }} style={{ ...S.link, color: 'inherit', textDecoration: 'underline' }}>Cancel</button>
        </FinBanner>
      )}
      {viewing && !listView && <FormModal th={th} id={`/.netlify/functions/violation-notice?pdf=${viewing.id}`} title={`Violation notice for ${viewing.employeeName}`} onClose={() => setViewing(null)} />}
      {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
      {voided && <FinBanner th={th} tone="warn">The notice changed after it was signed, so those signatures no longer count. Sign again.</FinBanner>}
      {employees && !employees.length && !error && <FinBanner th={th} tone="warn">There's no one you can pick yet. If you're a Store Manager, ask IT to link your account to your store.</FinBanner>}

      <div className="vn-paper" style={{ borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 12px 32px rgba(0,0,0,0.08)', padding: isMobile ? '1.2rem 1rem 1.6rem' : '1.8rem 2.6rem 2.4rem', fontSize: isMobile ? '14px' : '14.5px', lineHeight: 1.5, marginBottom: '1.2rem',
        backgroundImage: `url('/${VIO_CHROME.watermark.src}')`, backgroundRepeat: 'no-repeat', backgroundPosition: 'center 45%', backgroundSize: '72%' }}>
        <p style={{ textAlign: 'center', fontWeight: 700, fontSize: '1.65em', textDecoration: 'underline', textUnderlineOffset: 3 }}>Violation Notice</p>

        <p className="vn-h">Employee Information:</p>
        <div className="vn-row">
          <span className="vn-f"><b>Employee Name:</b>{empSearch}</span>
          <span className="vn-f"><b>Job Title:</b><Locked value={picked?.jobTitle || ''} /></span>
          <span className="vn-f"><b>PC#:</b><Locked value={picked?.pc || ''} w="6em" /></span>
        </div>
        <div className="vn-row" style={{ marginTop: '0.6em' }}>
          <span className="vn-f"><b>Supervisor:</b><input className="vn-blank" style={{ width: '14em' }} value={supervisor} maxLength={80} onChange={e => setSupervisor(e.target.value)} aria-label="Supervisor" /></span>
          <span className="vn-f"><b>Date:</b><Locked value={formatVioDate(date)} w="7em" /></span>
        </div>

        <p className="vn-h">Type of Violation Notice:</p>
        <div>{NOTICE_TYPES.map(([k, l]) => check(notice === k, () => setNotice(notice === k ? '' : k), l, k))}</div>

        <p className="vn-h">Type of Violation:</p>
        <div>{VIOLATION_TYPES.map(([k, l]) => check(types.includes(k), () => toggleType(k), l, k))}</div>

        <div className="vn-row" style={{ marginTop: '1.15em', justifyContent: 'space-between' }}>
          <p className="vn-h" style={{ margin: 0 }}>Description of Violation:</p>
          <span className="vn-f"><b style={{ textDecoration: 'underline' }}>Date of Violation:</b>{dateIn(violationDate, setViolationDate, 'Date of violation', { notFuture: true })}</span>
        </div>
        <textarea className="vn-lines" rows={4} value={description} maxLength={900} required aria-required="true" onChange={e => setDescription(e.target.value)} onBlur={() => setDescTouched(true)}
          style={{ marginTop: '0.4em', ...(descTouched && description.trim().length < DESCRIPTION_MIN ? { boxShadow: 'inset 0 0 0 2px #dc2626' } : {}) }}
          placeholder="Required: what happened, when, and where" aria-label="Description of violation (required)" />
        {description.trim().length < DESCRIPTION_MIN && <div style={{ fontSize: '0.78em', color: descTouched ? '#dc2626' : '#8a7f76', fontFamily: FONTS.body }}>Required: write at least a sentence ({description.trim().length}/{DESCRIPTION_MIN} characters).</div>}

        <p className="vn-h">Disciplinary Action Taken:</p>
        <div className="vn-row" style={{ gap: '0 0.2em' }}>
          {ACTIONS.map(([k, l]) => check(action === k, () => setAction(action === k ? '' : k), l, k))}
          {action === 'suspension' && (
            <span className="vn-f" style={{ flexWrap: 'wrap' }}>(Start Date:{dateIn(suspensionStart, setSuspensionStart, 'Suspension start date')} Return to Work Date{' '}
              <input type="date" className="vn-blank" style={{ width: '9.5em' }} value={suspensionReturn} min={suspensionStart || undefined} onChange={e => setSuspensionReturn(e.target.value)} aria-label="Return to work date" />)</span>
          )}
        </div>

        <p className="vn-h">Plans for Improvement (If Applicable):</p>
        <textarea className="vn-lines" rows={2} value={improvement} maxLength={400} onChange={e => setImprovement(e.target.value)} aria-label="Plans for improvement" />

        <p className="vn-h">Consequences of Further Policy Violation:</p>
        <textarea className="vn-lines" rows={1} value={consequences} maxLength={200} onChange={e => setConsequences(e.target.value)} aria-label="Consequences of further policy violation" />

        <p className="vn-h">Acknowledgment:</p>
        <p style={{ fontSize: '0.9em' }}>By signing this form, you confirm that you understand the information on this violation. You also confirm that you and your manager have discussed the violation and plan for improvement. Signing this form does not necessarily indicate that you agree with this violation. If you are provided this notice by email, it is not necessary for the employee to sign the acknowledgement as the email serves as a formal acknowledgment.</p>

        {editing ? (
          <div className="vn-row" style={{ marginTop: '0.9em' }}>
            <span className="vn-f"><b><u>Supervisor</u> - Name:</b><Locked value={supervisorName} w="11em" /></span>
            <span className="vn-f"><b>Signature:</b><span className="vn-sigline">{sigOk('supervisor') && <img src={sigOk('supervisor').image} alt="Supervisor signature" style={{ maxHeight: '2.3em', maxWidth: '12em', objectFit: 'contain' }} />}</span></span>
            <span className="vn-f"><b>Date:</b><Locked value={sigOk('supervisor') ? formatVioDate(sigOk('supervisor').date) : ''} w="6.5em" /></span>
          </div>
        ) : sigBlock('supervisor', 'Supervisor', <input className="vn-blank" style={{ width: '11em' }} value={supervisorName} maxLength={80} onChange={e => setSupervisorName(e.target.value)} aria-label="Supervisor name" />)}
        <p style={{ fontFamily: FONTS.body, fontSize: '0.82rem', color: '#6b6158', marginTop: '0.9em' }}>The employee (and a witness, if there is one) sign after HR approves this notice, here on screen or from an emailed link.</p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.9rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
        {!ready && <span style={{ color: th.muted, fontSize: '0.82rem' }}>{missing.length ? `Still needed: ${missing.join(', ')}` : ''}</span>}
        {editing && (
          <label style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', fontSize: '0.85rem', flexWrap: 'wrap' }}>
            <input type="checkbox" checked={approveTo.on} onChange={e => setApproveTo(x => ({ ...x, on: e.target.checked }))} style={{ accentColor: O, width: 18, height: 18 }} /> Also email the employee a link
            {approveTo.on && <><input type="email" placeholder="Employee email" aria-label="Employee email" value={approveTo.email} onChange={e => setApproveTo(x => ({ ...x, email: e.target.value }))} style={{ ...S.input, width: '13em', padding: '0.4rem 0.55rem' }} />
              <input type="tel" placeholder="Cell (optional)" aria-label="Employee cell (optional)" value={approveTo.phone} onChange={e => setApproveTo(x => ({ ...x, phone: e.target.value }))} style={{ ...S.input, width: '9.5em', padding: '0.4rem 0.55rem' }} /></>}
          </label>
        )}
        <button type="button" className="fin-btn" style={{ ...S.primary, opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed' }} disabled={!ready} onClick={() => (editing ? setSigning('hr') : send())}>{busy ? 'Saving…' : editing ? 'Sign, save changes & approve' : 'Sign & send to HR'}</button>
      </div>
      {saved && <div style={{ textAlign: 'right', fontSize: '0.85rem', marginBottom: '2rem' }}>{savedLine()}{saved.pdfUrl && <div style={{ marginTop: '0.6rem' }}><PdfOpenButton url={saved.pdfUrl} style={{ ...S.ghost }} /></div>}</div>}

      {signing && (
        <SignatureModal th={th} title={signing === 'hr' ? 'Your signature — HR approval' : `${signing === 'employee' ? 'Employee' : signing === 'supervisor' ? 'Supervisor' : 'Witness'} signature — ${picked?.name || ''}`} onCancel={() => setSigning(null)}
          onDone={(image) => { if (signing === 'hr') { setSigning(null); setHrSig(image); send(image); return; } setSigs(x => ({ ...x, [signing]: { image, date: todayIso(), fp } })); if (signing === 'employee') setEmployeeRefused(false); setSigning(null); }} />
      )}
    </div>
  );
}
