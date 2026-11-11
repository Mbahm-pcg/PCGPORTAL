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
function VnReview({ th, isMobile, form, onClose, canApprove }) {
  const S = finStyles(th);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [backing, setBacking] = useState(false);
  const [note, setNote] = useState('');
  const src = `/.netlify/functions/violation-notice?pdf=${form.id}`;
  const decide = async (action) => {
    setBusy(true); setErr(null);
    try {
      const b = await call({ action, id: form.id, note: note.trim() });
      if (action === 'reject') return onClose(`Sent back to ${form.submittedBy}.`);
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
        {canApprove && !backing && <button type="button" className="fin-btn" style={S.primary} disabled={busy} onClick={() => decide('approve')}>{busy ? 'Approving…' : 'Approve & file'}</button>}
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

  const loadMain = () => call().then(b => {
    setStores(b.stores || []); setEmployees(b.employees || []);
    setSupervisor(s => s || b.myName || ''); setSupervisorName(s => s || b.myName || '');
    if (b.rosterError) setError(b.rosterError);
    setListView(!!b.listView); setCanApprove(!!b.canApprove);
    setLists({ pending: b.pending || [], waiting: b.waiting || [], complete: b.complete || [] });
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
  const sigOk = (k) => (sigs[k] && sigs[k].fp === fp ? sigs[k] : null);
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

  const send = async () => {
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
      try { const b = await call({ values, employeeId: picked.id, pdf: doc.output('datauristring'), remoteSign: Object.fromEntries(['employee', 'witness'].filter(remoteOn).map(role => [role, { phone: remote[role].phone, email: remote[role].email.trim() }])) }); setSaved({ state: 'done', ...b, pdfUrl: deliverPdf(doc, fileName) }); }
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
          : saved.status === 'pending' ? `Sent for approval${saved.notified ? '' : ' (no approver is set up yet — ask IT)'}. Once it's approved it's filed in Google Drive and you'll be told.`
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

  if (employees === null && !error) return <div className="fin-root" style={{ maxWidth: 940, margin: '0 auto' }}><style>{FIN_CSS(th)}</style><h2 style={S.title}>Violation Notice</h2><p style={{ color: th.muted }}>Loading…</p></div>;

  // ── approver / exec list: Pending · Waiting on signatures · Complete ──
  if (listView && view === 'list') {
    const day = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', textAlign: 'left', padding: '0.75rem 0.95rem', borderRadius: 12, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, fontFamily: FONTS.body };
    const who = (f) => <><strong>{f.employeeName}</strong> <span style={{ color: th.muted }}>{f.storeName}{f.jobTitle ? `, ${f.jobTitle}` : ''}</span></>;
    // In the order a notice moves through them (user, 2026-11-11): signatures → approval → complete.
    const tabs = [['waiting', `Waiting on signatures${lists.waiting.length ? ` (${lists.waiting.length})` : ''}`], ['pending', `Pending approval${lists.pending.length ? ` (${lists.pending.length})` : ''}`], ['complete', 'Complete']];
    return (
      <div className="fin-root" style={{ maxWidth: 940, margin: '0 auto' }}>
        <style>{FIN_CSS(th) + CSS}</style>
        {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
        <h2 style={S.title}>Violation Notice</h2>
        <p style={S.lede}>Violation notices from supervisors. Once everyone has signed they wait for approval; approved ones are filed in Google Drive and show under Complete.</p>
        {decided && <FinBanner th={th} tone="success">{decided}</FinBanner>}
        {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
        {reviewing ? <VnReview th={th} isMobile={isMobile} form={reviewing} canApprove={canApprove} onClose={(msg) => { setReviewing(null); loadMain(); if (msg) setDecided(msg); }} /> : (<>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div role="tablist" aria-label="Violation notices" style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {tabs.map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={listTab === k} className="fin-btn" onClick={() => setListTab(k)}
                  style={{ ...S.ghost, minHeight: 36, padding: '0.4rem 0.95rem', background: listTab === k ? O : th.card3, color: listTab === k ? '#fff' : th.text }}>{label}</button>
              ))}
            </div>
            <button type="button" className="fin-btn" style={S.primary} onClick={() => { setDecided(null); setView('form'); }}>Start a violation notice</button>
          </div>
          {listTab === 'pending' && (lists.pending.length ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {lists.pending.map(f => (
                <button key={f.id} type="button" className="fin-btn" onClick={() => setReviewing(f)} style={{ ...rowStyle, border: `1px solid ${canApprove ? O : th.cardBorder}`, cursor: 'pointer' }}>
                  <span style={{ minWidth: 0 }}>{who(f)}<span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>From {f.submittedBy}, {day(f.createdAt)}</span></span>
                  <span style={{ color: canApprove ? O : th.muted, fontWeight: 700, fontSize: '0.85rem', alignSelf: 'center' }}>{canApprove ? 'Review' : 'View'}</span>
                </button>
              ))}
            </div>
          ) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>Nothing waiting for approval.</p>)}
          {listTab === 'waiting' && (lists.waiting.length ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {lists.waiting.map(f => (
                <div key={f.id} style={rowStyle}>
                  <span style={{ minWidth: 0 }}>{who(f)}<span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>From {f.submittedBy}, {day(f.createdAt)}: waiting on the employee or witness to sign from their email link</span></span>
                  {f.hasPdf && <button type="button" className="fin-btn" onClick={() => setViewing(f)} style={{ ...S.link, color: O, fontSize: '0.85rem' }}>View form</button>}
                </div>
              ))}
            </div>
          ) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>No notices waiting on signatures.</p>)}
          {listTab === 'complete' && (lists.complete.length ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {lists.complete.map(f => (
                <div key={f.id} style={rowStyle}>
                  <span style={{ minWidth: 0 }}>{who(f)}<span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>From {f.submittedBy}{f.decidedBy ? `, approved by ${f.decidedBy} on ${day(f.decidedAt)}` : `, ${day(f.createdAt)}`}</span></span>
                  <span style={{ display: 'flex', gap: '0.9rem', alignItems: 'center', fontSize: '0.85rem', fontWeight: 700 }}>
                    {f.hasPdf && <button type="button" className="fin-btn" onClick={() => setViewing(f)} style={{ ...S.link, color: O }}>View form</button>}
                    {f.driveLink && <a href={f.driveLink} target="_blank" rel="noreferrer" style={{ color: O }}>Open in Google Drive</a>}
                  </span>
                </div>
              ))}
            </div>
          ) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>No approved violation notices yet.</p>)}
          {viewing && <FormModal th={th} id={`/.netlify/functions/violation-notice?pdf=${viewing.id}`} title={`Violation notice for ${viewing.employeeName}`} onClose={() => setViewing(null)} />}
        </>)}
      </div>
    );
  }

  return (
    <div className="fin-root" style={{ maxWidth: 940, margin: '0 auto' }}>
      <style>{FIN_CSS(th) + CSS}</style>
      {listView
        ? <button type="button" className="fin-btn" onClick={() => { setView('list'); loadMain(); }} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Violation Notices</button>
        : onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
      <h2 style={S.title}>Violation Notice</h2>
      <p style={S.lede}>Fill in the notice: the employee's name, job title and store come straight from Paycor. Check the boxes, describe what happened, then sign. The employee and a witness sign here, or from an emailed link if they aren't there. Once everyone has signed it goes for approval, then it's filed.</p>

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

        {sigBlock('employee', 'Employee', <Locked value={picked?.name || ''} placeholder="employee" w="11em" />)}
        {sigBlock('supervisor', 'Supervisor', <input className="vn-blank" style={{ width: '11em' }} value={supervisorName} maxLength={80} onChange={e => setSupervisorName(e.target.value)} aria-label="Supervisor name" />)}
        {sigBlock('witness', 'Witness', <input className="vn-blank" style={{ width: '11em' }} value={witnessName} maxLength={80} onChange={e => setWitnessName(e.target.value)} placeholder="witness name" aria-label="Witness name" />)}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.9rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
        {!ready && <span style={{ color: th.muted, fontSize: '0.82rem' }}>{missing.length ? `Still needed: ${missing.join(', ')}` : ''}</span>}
        <button type="button" className="fin-btn" style={{ ...S.primary, opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed' }} disabled={!ready} onClick={send}>{busy ? 'Saving…' : 'Save & send'}</button>
      </div>
      {saved && <div style={{ textAlign: 'right', fontSize: '0.85rem', marginBottom: '2rem' }}>{savedLine()}{saved.pdfUrl && <div style={{ marginTop: '0.6rem' }}><PdfOpenButton url={saved.pdfUrl} style={{ ...S.ghost }} /></div>}</div>}

      {signing && (
        <SignatureModal th={th} title={`${signing === 'employee' ? 'Employee' : signing === 'supervisor' ? 'Supervisor' : 'Witness'} signature — ${picked?.name || ''}`} onCancel={() => setSigning(null)}
          onDone={(image) => { setSigs(x => ({ ...x, [signing]: { image, date: todayIso(), fp } })); if (signing === 'employee') setEmployeeRefused(false); setSigning(null); }} />
      )}
    </div>
  );
}
