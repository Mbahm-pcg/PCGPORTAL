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
  const [sigs, setSigs] = useState({}); // { employee|supervisor|witness: { image, date, fp } }
  const [signing, setSigning] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    call().then(b => {
      setStores(b.stores || []); setEmployees(b.employees || []);
      setSupervisor(s => s || b.myName || ''); setSupervisorName(s => s || b.myName || '');
      if (b.rosterError) setError(b.rosterError);
    }).catch(e => { setError(e.message); setEmployees([]); });
  }, []);

  const storeName = (pc) => stores.find(s => s.pc === String(pc))?.name || '';
  const form = { employee: picked, pc: picked?.pc, supervisor, date, notice, types, action, suspensionStart, suspensionReturn, violationDate, description, improvement, consequences, supervisorName, witnessName, employeeRefused };
  const base = violationValues(form);
  const fp = violationFingerprint(base);
  const sigOk = (k) => (sigs[k] && sigs[k].fp === fp ? sigs[k] : null);
  const voided = Object.keys(sigs).some(k => sigs[k] && sigs[k].fp !== fp);
  const values = violationValues({ ...form, employeeSig: sigOk('employee'), supervisorSig: sigOk('supervisor'), witnessSig: sigOk('witness') });
  const formMissing = missingViolationFields({ ...base, supervisorSignature: 'x' });
  const canSign = !formMissing.length;
  const missing = missingViolationFields(values);
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
      try { const b = await call({ values, employeeId: picked.id, pdf: doc.output('datauristring') }); setSaved({ state: 'done', ...b, pdfUrl: deliverPdf(doc, fileName) }); }
      catch (e) { setSaved({ state: 'failed', error: e.message, pdfUrl: deliverPdf(doc, fileName) }); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const savedLine = () => {
    if (!saved) return null;
    if (saved.state === 'saving') return <span style={{ color: th.muted }}>Saving and sending…</span>;
    if (saved.state === 'failed') return <span style={{ color: '#dc2626' }}>Not saved: {saved.error}. Press the button again to retry.</span>;
    const d = saved.drive || {}, a = saved.alert || {};
    return (
      <span style={{ color: d.saved && !a.error ? '#16a34a' : '#d97706' }}>
        {d.saved ? <>Saved to Google Drive{d.link ? <> (<a href={d.link} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>open</a>)</> : ''}.</> : `Not saved to Drive: ${d.error || 'unknown error'}. Press the button again to retry.`}
        {' '}{a.error ? `Alert failed: ${a.error}.` : a.recipients ? `Sent to ${a.recipients} recipient${a.recipients === 1 ? '' : 's'}.` : a.recipients === 0 ? 'No one is on the Violation Notice alert list yet.' : ''}
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
              : s ? <button type="button" className="vn-sigimg" onClick={() => setSigning(key)} title="Sign again"><img src={s.image} alt={`${label} signature`} style={{ maxHeight: '2.3em', maxWidth: '12em', objectFit: 'contain' }} /></button>
              : <button type="button" className="vn-sigbtn" disabled={!can} onClick={() => setSigning(key)} style={{ opacity: can ? 1 : 0.45, cursor: can ? 'pointer' : 'not-allowed' }}>{can ? `Tap to sign — ${label}` : canSign ? 'Type the witness name first' : 'Fill in the form first'}</button>}
          </span>
        </span>
        <span className="vn-f"><b>Date:</b><Locked value={s ? formatVioDate(s.date) : ''} placeholder="on signing" w="6.5em" /></span>
        {key === 'employee' && !s && <label className="vn-check" style={{ fontFamily: FONTS.body, fontSize: '0.8rem' }}><input type="checkbox" checked={employeeRefused} onChange={e => setEmployeeRefused(e.target.checked)} /> Employee refused to sign</label>}
      </div>
    );
  };

  return (
    <div className="fin-root" style={{ maxWidth: 940, margin: '0 auto' }}>
      <style>{FIN_CSS(th) + CSS}</style>
      {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
      <h2 style={S.title}>Violation Notice</h2>
      <p style={S.lede}>Fill in the notice: the employee's name, job title and store come straight from Paycor. Check the boxes, describe what happened, then sign. The employee and a witness sign too if they're there.</p>

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
