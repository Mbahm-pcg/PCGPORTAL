// src/pay-increase-ui.jsx — Tools · Pay Increase (v22.55).
//
// The screen IS HR's Pay Increase Form, ready to fill the moment it opens. The DM picks the
// employee (name, position, store and current rate come from Paycor, locked), types the new
// rate and the reason, and the Store Manager, the DM and the Director of Operations each sign
// their line on this screen. "Send to the office" downloads the signed PDF, files it in Google
// Drive and alerts the office (pay-increase.mjs) — the office then makes the change in Paycor,
// so the "For Office Use Only" box stays blank here. A signature is void if the form changes.
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FIN_CSS, FinBanner, finStyles, finMoney } from './finance-ui.jsx';
import { SignatureModal, toB64 } from './transfer-notice-ui.jsx';
import { buildPayIncreasePdf, PAY_FONT, PAY_CHROME, formatFormDate } from './pay-increase-pdf.mjs';
import { rateProblem, payFormValues, payFingerprint, missingPayFields } from './pay-increase.mjs';

const { useState, useEffect } = React;
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const POSITIONS = ['Crew Member', 'Shift Leader', 'Assistant Manager', 'Store Manager'];

const call = async (qs = '', body) => {
  const res = await fetch('/.netlify/functions/pay-increase' + qs, {
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
const loadAssets = () => assetsPromise || (assetsPromise = Promise.all([
  fetchB64('/fonts/' + PAY_FONT.regular), fetchB64('/fonts/' + PAY_FONT.bold), fetchB64('/fonts/' + PAY_FONT.boldItalic),
  fetchB64('/' + PAY_CHROME.logo.src), fetchB64('/' + PAY_CHROME.watermark.src),
]).then(([regular, bold, boldItalic, logo, seal]) => ({ fonts: { regular, bold, boldItalic }, images: { logo: 'data:image/jpeg;base64,' + logo, watermark: 'data:image/png;base64,' + seal } }))
  .catch(e => { assetsPromise = null; throw e; }));

const INK = '#111';
const FILL = '#fdf3ea';
const PAPER_CSS = `
@font-face { font-family: 'Caladea'; src: url('/fonts/Caladea-Regular.ttf') format('truetype'); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: 'Caladea'; src: url('/fonts/Caladea-Bold.ttf') format('truetype'); font-weight: 700; font-style: normal; font-display: swap; }
@font-face { font-family: 'Caladea'; src: url('/fonts/Caladea-BoldItalic.ttf') format('truetype'); font-weight: 700; font-style: italic; font-display: swap; }
.pi-paper { font-family: 'Caladea', Cambria, Georgia, serif; color: ${INK}; background: #fff; }
.pi-paper p { margin: 0; }
.pi-row { display: flex; align-items: flex-end; gap: 0.6em; margin-top: 0.85em; flex-wrap: wrap; }
.pi-label { min-width: 9.2em; }
.pi-blank { font: inherit; color: ${INK}; border: none; border-bottom: 1px solid ${INK}; border-radius: 0; background: ${FILL}; padding: 0 0.3em; min-height: 1.4em; line-height: 1.4; text-align: center; -webkit-appearance: none; appearance: none; }
.pi-blank:focus-visible, .pi-sigbtn:focus-visible, .pi-reason:focus-visible, .pi-sigimg:focus-visible { outline: 2px solid ${O}; outline-offset: 1px; }
.pi-blank::placeholder, .pi-reason::placeholder { color: #9a8f86; font-style: italic; }
.pi-locked { display: inline-block; border-bottom: 1px solid ${INK}; padding: 0 0.3em; text-align: center; line-height: 1.4; min-width: 11em; }
.pi-locked.pi-empty { color: #9a8f86; font-style: italic; }
.pi-box { border: 1px solid ${INK}; }
.pi-boxhead { text-align: center; font-weight: 700; font-size: 0.82em; padding: 0.25em; border-bottom: 1px solid #ccc; }
.pi-reason { font: inherit; font-size: 0.9em; width: 100%; box-sizing: border-box; border: none; resize: vertical; min-height: 4.8em; padding: 0.3em 0.5em; color: ${INK}; line-height: 1.6;
  background-color: ${FILL}; background-image: repeating-linear-gradient(transparent 0, transparent calc(1.6em - 1px), #ccc calc(1.6em - 1px), #ccc 1.6em); background-attachment: local; }
.pi-sigline { display: inline-flex; align-items: flex-end; border-bottom: 1px solid ${INK}; height: 2.7em; min-width: 13em; }
.pi-sigbtn { font: inherit; font-family: ${FONTS.body}; font-size: 0.82rem; color: ${O}; font-weight: 700; background: ${FILL}; border: 1px dashed ${O}; border-radius: 6px; padding: 0.3rem 0.75rem; margin: 0 0 0.25rem 0.2rem; cursor: pointer; }
.pi-sigimg { background: none; border: none; padding: 0; cursor: pointer; display: flex; align-items: flex-end; }
.pi-office { width: 100%; border-collapse: collapse; font-size: 0.82em; }
.pi-office td { border-top: 1px solid #b7b7b7; padding: 0.3em 0.5em; text-align: center; height: 1.9em; }
.pi-office td + td { border-left: 1px solid #b7b7b7; color: #9a8f86; font-style: italic; }
@media (prefers-reduced-motion: reduce) { .pi-blank, .pi-sigbtn { transition: none; } }`;

const Locked = ({ value, placeholder = 'from Paycor', w }) => <span className={`pi-locked${value ? '' : ' pi-empty'}`} style={w ? { minWidth: w } : undefined} title="From Paycor — can't be changed here">{value || placeholder}</span>;

export function PayIncrease({ th, isMobile, onBack }) {
  const S = finStyles(th);
  const [stores, setStores] = useState([]);
  const [employees, setEmployees] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [picked, setPicked] = useState(null);
  const [employee, setEmployee] = useState(null);
  const [loadingEmp, setLoadingEmp] = useState(false);
  const [position, setPosition] = useState(''); // only when Paycor has no job title
  const [newRate, setNewRate] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayIso());
  const [sigs, setSigs] = useState({}); // { sm|dm|director: { image, fp } }
  const [signing, setSigning] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    call().then(b => { setStores(b.stores || []); setEmployees(b.employees || []); }).catch(e => { setError(e.message); setEmployees([]); });
  }, []);
  useEffect(() => {
    setEmployee(null);
    if (!picked) return;
    let live = true; setLoadingEmp(true); setError(null);
    call(`?pc=${encodeURIComponent(picked.pc)}&employeeId=${encodeURIComponent(picked.id)}`)
      .then(b => live && setEmployee(b.employee)).catch(e => live && setError(e.message)).finally(() => live && setLoadingEmp(false));
    return () => { live = false; };
  }, [picked]);

  const storeName = (pc) => stores.find(s => s.pc === String(pc))?.name || '';
  const hourly = employee && /hour/i.test(employee.payType || 'Hourly') && employee.payRate > 0;
  const base = payFormValues({ employee: hourly ? employee : null, pc: picked?.pc, position, newRate, reason, date });
  const fp = payFingerprint(base);
  const sigOk = (k) => (sigs[k] && sigs[k].fp === fp ? sigs[k] : null);
  const voided = Object.keys(sigs).some(k => sigs[k] && sigs[k].fp !== fp);
  const values = payFormValues({ employee: hourly ? employee : null, pc: picked?.pc, position, newRate, reason, date, smSig: sigOk('sm'), dmSig: sigOk('dm'), directorSig: sigOk('director') });
  const rateErr = hourly && newRate !== '' ? rateProblem(employee.payRate, newRate) : null;
  const formMissing = missingPayFields(base).filter(m => !/signature/i.test(m));
  const canSign = hourly && !rateErr && !formMissing.length && !loadingEmp;
  const missing = missingPayFields(values);
  const ready = canSign && !missing.length && !busy;
  useEffect(() => { setSaved(null); }, [fp]);

  const q = query.trim().toLowerCase();
  const matches = q && employees ? employees.filter(e => e.name.toLowerCase().includes(q) || storeName(e.pc).toLowerCase().includes(q) || e.pc.includes(q)).slice(0, 40) : [];
  const pick = (e) => { setPicked(e); setPosition(''); setQuery(e.name); setListOpen(false); };

  const send = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (!JsPDF) throw new Error('PDF library did not load — refresh the page.');
      const { fonts, images } = await loadAssets();
      const doc = buildPayIncreasePdf(JsPDF, fonts, values, images);
      doc.save(`Pay-Increase-${values.employeeName.replace(/[^A-Za-z0-9]+/g, '-')}-${date}.pdf`);
      setSaved({ state: 'saving' });
      try { setSaved({ state: 'done', ...(await call('', { values, employeeId: employee.id, pdf: doc.output('datauristring') })) }); }
      catch (e) { setSaved({ state: 'failed', error: e.message }); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const savedLine = () => {
    if (!saved) return null;
    if (saved.state === 'saving') return <span style={{ color: th.muted }}>Sending to the office…</span>;
    if (saved.state === 'failed') return <span style={{ color: '#dc2626' }}>Downloaded, but not sent: {saved.error}. Press the button again to retry.</span>;
    const d = saved.drive || {}, a = saved.alert || {};
    return (
      <span style={{ color: d.saved && !a.error ? '#16a34a' : '#d97706' }}>
        {d.saved ? <>Sent — saved to Google Drive{d.link ? <> (<a href={d.link} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>open</a>)</> : ''}.</> : `Not saved to Drive: ${d.error || 'unknown error'}. Press the button again to retry.`}
        {' '}{a.error ? `Alert failed: ${a.error}.` : a.recipients ? `The office was alerted (${a.recipients} recipient${a.recipients === 1 ? '' : 's'}).` : a.recipients === 0 ? 'No one is on the Pay Increase alert list yet.' : ''}
      </span>
    );
  };

  const empSearch = (
    <span style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
      <input className="pi-blank" style={{ width: isMobile ? '15em' : '16em', maxWidth: '100%' }} value={query} role="combobox" aria-expanded={listOpen && matches.length > 0} aria-controls="pi-emp-list" autoComplete="off"
        aria-label="Employee name" placeholder={employees ? 'Search employee name' : 'Loading from Paycor…'} disabled={!employees}
        onChange={e => { setQuery(e.target.value); setListOpen(true); if (picked) setPicked(null); }}
        onFocus={() => setListOpen(true)} onBlur={() => setTimeout(() => setListOpen(false), 150)}
        onKeyDown={e => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); pick(matches[0]); } if (e.key === 'Escape') setListOpen(false); }} />
      {listOpen && matches.length > 0 && (
        <span id="pi-emp-list" role="listbox" style={{ position: 'absolute', zIndex: 30, left: 0, top: '100%', marginTop: 4, width: 'min(420px, 82vw)', maxHeight: 300, overflowY: 'auto', background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 12, boxShadow: '0 10px 30px rgba(0,0,0,0.15)', textAlign: 'left' }}>
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

  const row = (label, content) => <div className="pi-row"><span className="pi-label">{label}</span>{content}</div>;
  const sigRow = (key, label) => {
    const s = sigOk(key);
    // DM and Director: one of the two is enough — once one signs, the other line isn't needed.
    const other = key === 'dm' ? 'director' : key === 'director' ? 'dm' : null;
    const notNeeded = !s && other && sigOk(other);
    return (
      <div className="pi-row" style={{ marginTop: '0.7em' }}><span>{label} Signature:</span>
        <span className="pi-sigline">
          {notNeeded ? <span style={{ color: '#9a8f86', fontStyle: 'italic', fontSize: '0.85em', paddingBottom: '0.2em' }}>not needed — signed by the {LABEL[other]}</span>
            : s ? <button type="button" className="pi-sigimg" onClick={() => setSigning(key)} title="Sign again"><img src={s.image} alt={`${label} signature`} style={{ maxHeight: '2.5em', maxWidth: '13em', objectFit: 'contain' }} /></button>
            : <button type="button" className="pi-sigbtn" onClick={() => setSigning(key)} disabled={!canSign} style={{ opacity: canSign ? 1 : 0.45, cursor: canSign ? 'pointer' : 'not-allowed' }}>{canSign ? `Tap to sign — ${label}` : 'Fill in the form first'}</button>}
        </span>
      </div>
    );
  };
  const LABEL = { sm: 'Store Manager', dm: 'District Manager', director: 'Director of Operations' };

  return (
    <div className="fin-root" style={{ maxWidth: 900, margin: '0 auto' }}>
      <style>{FIN_CSS(th) + PAPER_CSS}</style>
      {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
      <h2 style={S.title}>Pay Increase</h2>
      <p style={S.lede}>Fill in the form: the employee's name, position, store and current rate come straight from Paycor. Enter the new rate and the reason, then the Store Manager signs, and either you (the DM) or the Director of Operations. It goes to the office, who make the change in Paycor.</p>

      {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
      {employee && !hourly && <FinBanner th={th} tone="warn">Paycor has no hourly rate for {employee.name}{employee.payType ? ` (pay type: ${employee.payType})` : ''}, so this form can't be made. Fix the rate in Paycor first.</FinBanner>}
      {voided && <FinBanner th={th} tone="warn">The form changed after it was signed, so those signatures no longer count. Sign again.</FinBanner>}

      <div className="pi-paper" style={{ borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 12px 32px rgba(0,0,0,0.08)', padding: isMobile ? '1.2rem 1rem 1.6rem' : '1.6rem 4.2rem 2.4rem', fontSize: isMobile ? '15px' : '16px', lineHeight: 1.5, marginBottom: '1.2rem',
        backgroundImage: `url('/${PAY_CHROME.watermark.src}')`, backgroundRepeat: 'no-repeat', backgroundPosition: 'center 62%', backgroundSize: '77%' }}>
        <div style={{ textAlign: 'center' }}><img src={'/' + PAY_CHROME.logo.src} alt="People Capital Group" style={{ width: isMobile ? 110 : 144, height: 'auto' }} /></div>
        <p style={{ fontWeight: 700, fontSize: '1.09em', marginTop: '1.3em' }}>PAY INCREASE FORM</p>

        <div style={{ display: 'flex', gap: isMobile ? '0.4em 1.5em' : '0 4.5em', flexWrap: 'wrap', marginTop: '0.5em' }}>
          <div className="pi-row"><span>Date:</span><input type="date" className="pi-blank" style={{ width: '9.5em' }} value={date} onChange={e => setDate(e.target.value)} aria-label="Form date" /></div>
          <div className="pi-row"><span>PC #:</span><Locked value={employee ? picked.pc : ''} placeholder={loadingEmp ? '…' : 'from Paycor'} w="8em" /></div>
        </div>
        <div style={{ marginTop: '1.4em' }}>
          {row('Employee Name:', empSearch)}
          {row('Employee Position:', employee && !employee.jobTitle
            ? <input className="pi-blank" style={{ width: '11em' }} list="pi-positions" value={position} onChange={e => setPosition(e.target.value)} placeholder="position" aria-label="Employee position" title="Paycor has no job title for this employee — fill it in" />
            : <Locked value={employee?.jobTitle || ''} placeholder={loadingEmp ? '…' : 'from Paycor'} />)}
          {row('Current Pay Rate:', <Locked value={hourly ? finMoney.format(employee.payRate) : ''} placeholder={loadingEmp ? '…' : 'from Paycor'} />)}
          {row('New Pay Rate:', <span style={{ display: 'inline-flex', alignItems: 'flex-end' }}>$<input type="number" inputMode="decimal" step="0.05" min="0" className="pi-blank" style={{ width: '6.5em' }} value={newRate} onChange={e => setNewRate(e.target.value)} placeholder="0.00" aria-label="New pay rate" /></span>)}
        </div>
        <datalist id="pi-positions">{POSITIONS.map(p => <option key={p} value={p} />)}</datalist>

        <div className="pi-box" style={{ marginTop: '1.6em' }}>
          <div className="pi-boxhead">Reason for Pay Change / Evaluation:</div>
          <textarea className="pi-reason" value={reason} maxLength={600} onChange={e => setReason(e.target.value)} placeholder="Why this raise — the evaluation, new responsibilities…" aria-label="Reason for pay change / evaluation" />
        </div>

        <div style={{ marginTop: '2.2em' }}>
          {sigRow('sm', LABEL.sm)}
          {sigRow('dm', LABEL.dm)}
          {sigRow('director', LABEL.director)}
        </div>

        <div className="pi-box" style={{ marginTop: '2.4em' }}>
          <div className="pi-boxhead" style={{ fontStyle: 'italic', borderBottom: 'none' }}>For Office Use Only</div>
          <table className="pi-office"><tbody>
            <tr><td style={{ width: '49%' }}>Effective Date:</td><td>office</td></tr>
            <tr><td>Effective Pay Rate Paycheck Date:</td><td>office</td></tr>
            <tr><td>Payroll Manager Signature:</td><td>office</td></tr>
          </tbody></table>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.9rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
        {!ready && <span style={{ color: rateErr ? '#dc2626' : th.muted, fontSize: '0.82rem' }}>{rateErr || (missing.length ? `Still needed: ${missing.join(', ')}` : '')}</span>}
        <button type="button" className="fin-btn" style={{ ...S.primary, opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed' }} disabled={!ready} onClick={send}>
          {busy ? 'Sending…' : 'Send to the office & download'}
        </button>
      </div>
      {saved && <div style={{ textAlign: 'right', fontSize: '0.85rem', marginBottom: '2rem' }}>{savedLine()}</div>}

      {signing && (
        <SignatureModal th={th} title={`${LABEL[signing]} signature — ${employee?.name || ''}`} onCancel={() => setSigning(null)}
          onDone={(image) => { setSigs(s => ({ ...s, [signing]: { image, fp } })); setSigning(null); }} />
      )}
    </div>
  );
}
