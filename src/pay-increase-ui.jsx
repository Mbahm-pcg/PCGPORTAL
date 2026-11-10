// src/pay-increase-ui.jsx — Tools · Pay Increase (v22.55; approval v22.60; v22.62).
//
// The screen IS HR's Pay Increase Form, ready to fill the moment it opens. A Store Manager or DM
// picks the employee (name, position, store and current rate come from Paycor, locked), types the
// new rate and the reason, and signs. A Store Manager signs with their District Manager on the
// same screen; anyone else has the Store Manager line N/A and signs the second line, titled by who
// they are: District Manager / Director of Operations / Vice President (Mike) / Executive (v22.64).
// "Send for approval" downloads the signed PDF and sends it to the approver (Mike); once approved
// it goes to Drive and the office (pay-increase.mjs). Execs / IT open on a Pending / Complete list.
// The "For Office Use Only" box stays blank. A signature is void if the form changes.
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FIN_CSS, FinBanner, finStyles, finMoney } from './finance-ui.jsx';
import { SignatureModal, toB64 } from './transfer-notice-ui.jsx';
import { buildPayIncreasePdf, PAY_FONT, PAY_CHROME, formatFormDate } from './pay-increase-pdf.mjs';
import { rateProblem, payFormValues, payFingerprint, missingPayFields, REASON_MIN } from './pay-increase.mjs';

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

// Approver's view of one waiting form: the signed PDF, then Approve or Send back.
function Review({ th, isMobile, form, onClose, canApprove = true }) {
  const S = finStyles(th);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [backing, setBacking] = useState(false);
  const [note, setNote] = useState('');
  const decide = async (action) => {
    setBusy(true); setErr(null);
    try {
      const b = await call('', { action, id: form.id, note: note.trim() });
      if (action === 'reject') return onClose(`Sent back to ${form.submittedBy}.`);
      const d = b.drive || {}, a = b.alert || {};
      onClose(`Approved: ${d.saved ? 'saved to Google Drive' : `not saved to Drive (${d.error || 'error'})`}, ${a.error ? `office alert failed (${a.error})` : a.recipients ? `the office was alerted (${a.recipients})` : 'no one is on the office list yet'}. ${form.submittedBy} was told.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div style={{ ...S.panel, padding: '1rem 1.1rem', marginBottom: '1.4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ ...S.panelTitle, fontSize: '1.05rem' }}>{form.employeeName}, {form.storeName}</div>
        <span style={{ color: th.muted, fontSize: '0.88rem' }}>{finMoney.format(form.currentRate)} to {finMoney.format(form.newRate)}, sent by {form.submittedBy}</span>
      </div>
      <p style={{ color: th.text, fontSize: '0.9rem', margin: '0.4rem 0 0.8rem' }}>{form.reason}</p>
      <iframe title={`Pay increase for ${form.employeeName}`} src={`/.netlify/functions/pay-increase?pdf=${form.id}`} style={{ width: '100%', height: isMobile ? 420 : 640, border: `1px solid ${th.cardBorder}`, borderRadius: 8, background: '#fff' }} />
      <p style={{ fontSize: '0.82rem', color: th.muted, margin: '0.4rem 0 0' }}>Form not showing? <a href={`/.netlify/functions/pay-increase?pdf=${form.id}`} target="_blank" rel="noreferrer" style={{ color: O }}>Open the PDF</a>.</p>
      {err && <FinBanner th={th} tone="error" style={{ marginTop: '0.8rem' }}>{err}</FinBanner>}
      {backing && (
        <div style={{ marginTop: '0.8rem' }}>
          <label htmlFor="pi-note" style={{ display: 'block', fontWeight: 700, marginBottom: '0.3rem', color: th.text }}>Why is it being sent back?</label>
          <textarea id="pi-note" value={note} maxLength={400} rows={3} onChange={e => setNote(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', borderRadius: 8, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, padding: '0.5rem', fontFamily: FONTS.body }} />
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.9rem' }}>
        <button type="button" className="fin-btn" style={S.ghost} onClick={() => onClose(null)} disabled={busy}>Back</button>
        {!canApprove && <span style={{ color: th.muted, fontSize: '0.85rem', alignSelf: 'center' }}>Only the pay increase approver can approve this.</span>}
        {canApprove && (backing
          ? <button type="button" className="fin-btn" style={{ ...S.primary, background: '#b91c1c', opacity: note.trim().length >= 3 && !busy ? 1 : 0.5 }} disabled={note.trim().length < 3 || busy} onClick={() => decide('reject')}>{busy ? 'Sending…' : 'Send back'}</button>
          : <button type="button" className="fin-btn" style={S.ghost} onClick={() => setBacking(true)} disabled={busy}>Send back…</button>)}
        {canApprove && !backing && <button type="button" className="fin-btn" style={S.primary} disabled={busy} onClick={() => decide('approve')}>{busy ? 'Approving…' : 'Approve & send to the office'}</button>}
      </div>
    </div>
  );
}

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
  const [reasonTouched, setReasonTouched] = useState(false);
  const [date, setDate] = useState(todayIso());
  const [sigs, setSigs] = useState({}); // { sm|dm: { image, fp } }
  // v22.64: decided by who is signed in (server): the second line's title, and whether the Store
  // Manager line is N/A (everyone but a Store Manager).
  const [secondLabel, setSecondLabel] = useState('District Manager');
  const [smNa, setSmNa] = useState(false);
  const [smName, setSmName] = useState(''); // v22.66: printed name next to each signature
  const [dmName, setDmName] = useState('');
  const [signing, setSigning] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [role, setRole] = useState(null);
  const [pending, setPending] = useState(null); // list screen: forms waiting for approval
  const [reviewing, setReviewing] = useState(null);
  // v22.63: executives / IT (and approvers) open on a list — Pending (to approve) and Complete
  // (approved, to look up) — with "Start a pay increase" for the form. Everyone else gets the form.
  const [listView, setListView] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [complete, setComplete] = useState([]);
  const [view, setView] = useState('list');
  const [listTab, setListTab] = useState('pending');
  // v22.68: nothing until the first load says which screen this person gets — otherwise an exec
  // saw the form flash up for a second before the Pending / Complete list replaced it.
  const [loaded, setLoaded] = useState(false);

  const loadMain = () => call().then(b => {
    setStores(b.stores || []); setEmployees(b.employees || []); setRole(b.role || null);
    setSecondLabel(b.secondLabel || 'District Manager'); setSmNa(!!b.smNa);
    // Pre-fill: your own line gets your name; a Store Manager's District Manager line gets the store's DM.
    if (b.role === 'manager') { setSmName(n => n || b.myName || ''); setDmName(n => n || b.dmNameGuess || ''); }
    else setDmName(n => n || b.myName || '');
    setListView(!!b.listView); setCanApprove(!!b.canApprove); if (b.rosterError) setError(b.rosterError);
    setPending(b.listView ? (b.pending || []) : null); setComplete(b.complete || []);
    // ?payIncrease=<id> from the approval email / text opens that form straight away.
    let open = null; try { open = sessionStorage.getItem('pi_open'); sessionStorage.removeItem('pi_open'); } catch {}
    const hit = open && (b.pending || []).find(x => String(x.id) === String(open));
    if (hit) { setView('list'); setListTab('pending'); setReviewing(hit); }
  }).catch(e => { setError(e.message); setEmployees([]); }).finally(() => setLoaded(true));
  useEffect(() => { loadMain(); }, []);
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
  const base = payFormValues({ employee: hourly ? employee : null, pc: picked?.pc, position, newRate, reason, date, smNa, secondLabel, smName, dmName });
  const fp = payFingerprint(base);
  const sigOk = (k) => (sigs[k] && sigs[k].fp === fp ? sigs[k] : null);
  const voided = Object.keys(sigs).some(k => sigs[k] && sigs[k].fp !== fp);
  const values = payFormValues({ employee: hourly ? employee : null, pc: picked?.pc, position, newRate, reason, date, smNa, secondLabel, smName, dmName, smSig: sigOk('sm'), dmSig: sigOk('dm') });
  const rateErr = hourly && newRate !== '' ? rateProblem(employee.payRate, newRate) : null;
  const formMissing = missingPayFields(base, role || 'dm').filter(m => !/signature/i.test(m));
  const canSign = hourly && !rateErr && !formMissing.length && !loadingEmp;
  const missing = missingPayFields(values, role || 'dm');
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
      try { setSaved({ state: 'done', ...(await call('', { values, employeeId: employee.id, pdf: doc.output('datauristring') })) }); if (pending) loadMain(); }
      catch (e) { setSaved({ state: 'failed', error: e.message }); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const savedLine = () => {
    if (!saved) return null;
    if (saved.state === 'saving') return <span style={{ color: th.muted }}>Sending for approval…</span>;
    if (saved.state === 'failed') return <span style={{ color: '#dc2626' }}>Downloaded, but not sent: {saved.error}. Press the button again to retry.</span>;
    if (saved.already) return <span style={{ color: '#16a34a' }}>This form was already sent, so there's nothing more to do.</span>;
    return <span style={{ color: '#16a34a' }}>Sent for approval. Once it's approved, it goes to the office{saved.notified ? '' : ' (no approver is set up yet, tell IT)'}. You'll get a notification either way.</span>;
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
  // A Store Manager makes it → they and their District Manager both sign here. Anyone else →
  // the Store Manager line is N/A and they sign the second line, titled by who they are.
  const isManager = role === 'manager';
  const sigButton = (key, label) => {
    const s = sigOk(key);
    return s
      ? <button type="button" className="pi-sigimg" onClick={() => setSigning(key)} title="Sign again"><img src={s.image} alt={`${label} signature`} style={{ maxHeight: '2.5em', maxWidth: '13em', objectFit: 'contain' }} /></button>
      : <button type="button" className="pi-sigbtn" onClick={() => setSigning(key)} disabled={!canSign} style={{ opacity: canSign ? 1 : 0.45, cursor: canSign ? 'pointer' : 'not-allowed' }}>{canSign ? `Tap to sign — ${label}` : 'Fill in the form first'}</button>;
  };
  const sigRow = (key, label) => {
    const content = key === 'sm' && !isManager
      ? <span style={{ paddingBottom: '0.15em', paddingLeft: '0.4em' }}>N/A</span>
      : sigButton(key, label);
    const na = key === 'sm' && !isManager;
    const [nm, setNm] = key === 'sm' ? [smName, setSmName] : [dmName, setDmName];
    return (
      <div className="pi-row" style={{ marginTop: '0.7em' }}><span>{label} Signature:</span>
        <span className="pi-sigline">{content}</span>
        <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: '0.4em', marginLeft: '0.8em' }}>Name:
          {na ? <span className="pi-locked pi-empty" style={{ minWidth: '10em' }}>N/A</span>
            : <input className="pi-blank" style={{ width: isMobile ? '11em' : '12em' }} value={nm} maxLength={80} onChange={e => setNm(e.target.value)} placeholder={`${label} name`} aria-label={`${label} name`} />}
        </span>
      </div>
    );
  };
  const LABEL = { sm: 'Store Manager', dm: secondLabel };

  return (
    <div className="fin-root" style={{ maxWidth: 900, margin: '0 auto' }}>
      <style>{FIN_CSS(th) + PAPER_CSS}</style>
      {listView && view === 'form'
        ? <button type="button" className="fin-btn" onClick={() => { setView('list'); loadMain(); }} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Pay Increases</button>
        : onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
      <h2 style={S.title}>Pay Increase</h2>

      {!loaded ? <p style={{ color: th.muted }}>Loading…</p> : listView && view === 'list' ? (<>
        <p style={S.lede}>Pay increases sent by Store Managers and DMs. Pending ones wait for approval; once approved they go to the office and show under Complete.</p>
        {saved && saved.state === 'decided' && <FinBanner th={th} tone="success">{saved.msg}</FinBanner>}
        {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
        {reviewing ? <Review th={th} isMobile={isMobile} form={reviewing} canApprove={canApprove} onClose={(msg) => { setReviewing(null); loadMain(); if (msg) setSaved({ state: 'decided', msg }); }} /> : (<>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div role="tablist" aria-label="Pay increases" style={{ display: 'flex', gap: '0.4rem' }}>
              {[['pending', `Pending${pending && pending.length ? ` (${pending.length})` : ''}`], ['complete', 'Complete']].map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={listTab === k} className="fin-btn" onClick={() => setListTab(k)}
                  style={{ ...S.ghost, minHeight: 36, padding: '0.4rem 0.95rem', background: listTab === k ? O : th.card3, color: listTab === k ? '#fff' : th.text }}>{label}</button>
              ))}
            </div>
            <button type="button" className="fin-btn" style={S.primary} onClick={() => { setSaved(null); setView('form'); }}>Start a pay increase</button>
          </div>
          {listTab === 'pending' && (pending && pending.length ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {pending.map(f => (
                <button key={f.id} type="button" className="fin-btn" onClick={() => setReviewing(f)}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', textAlign: 'left', padding: '0.75rem 0.95rem', borderRadius: 12, border: `1px solid ${canApprove ? O : th.cardBorder}`, background: th.card, color: th.text, cursor: 'pointer', fontFamily: FONTS.body }}>
                  <span style={{ minWidth: 0 }}><strong>{f.employeeName}</strong> <span style={{ color: th.muted }}>{f.storeName}, {finMoney.format(f.currentRate)} to {finMoney.format(f.newRate)}</span>
                    <span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>Sent by {f.submittedBy}, {new Date(f.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></span>
                  <span style={{ color: canApprove ? O : th.muted, fontWeight: 700, fontSize: '0.85rem', alignSelf: 'center' }}>{canApprove ? 'Review' : 'View'}</span>
                </button>
              ))}
            </div>
          ) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>Nothing waiting for approval.</p>)}
          {listTab === 'complete' && (complete.length ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {complete.map(f => (
                <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', padding: '0.75rem 0.95rem', borderRadius: 12, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, fontFamily: FONTS.body }}>
                  <span style={{ minWidth: 0 }}><strong>{f.employeeName}</strong> <span style={{ color: th.muted }}>{f.storeName}, {finMoney.format(f.currentRate)} to {finMoney.format(f.newRate)}</span>
                    <span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>Sent by {f.submittedBy}{f.approvedBy ? `, approved by ${f.approvedBy} on ${new Date(f.approvedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : `, ${new Date(f.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}</span></span>
                  <span style={{ display: 'flex', gap: '0.9rem', alignItems: 'center', fontSize: '0.85rem', fontWeight: 700 }}>
                    {f.hasPdf && <a href={`/.netlify/functions/pay-increase?pdf=${f.id}`} target="_blank" rel="noreferrer" style={{ color: O }}>View PDF</a>}
                    {f.driveLink && <a href={f.driveLink} target="_blank" rel="noreferrer" style={{ color: O }}>Open in Google Drive</a>}
                  </span>
                </div>
              ))}
            </div>
          ) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>No approved pay increases yet.</p>)}
        </>)}
      </>) : (<>
      <p style={S.lede}>Fill in the form: the employee's name, position, store and current rate come straight from Paycor. Enter the new rate and the reason, then sign. A Store Manager signs with their District Manager. It goes to Mike for approval, and once he approves it, to the office to be entered in Paycor.</p>
      {role === 'manager' && employees && !employees.length && !error && <FinBanner th={th} tone="warn">Your account isn't linked to a store yet, so there's no one to pick. Ask IT to assign your store.</FinBanner>}
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
          <textarea className="pi-reason" value={reason} maxLength={600} required aria-required="true" onChange={e => setReason(e.target.value)} onBlur={() => setReasonTouched(true)}
            aria-invalid={reasonTouched && reason.trim().length < REASON_MIN} aria-describedby="pi-reason-hint"
            style={reasonTouched && reason.trim().length < REASON_MIN ? { boxShadow: 'inset 0 0 0 2px #dc2626' } : undefined}
            placeholder="Required: why this raise (the evaluation, new responsibilities…)" aria-label="Reason for pay change / evaluation (required)" />
          {reason.trim().length < REASON_MIN && <div id="pi-reason-hint" style={{ fontSize: '0.78em', padding: '0.15em 0.5em 0.3em', color: reasonTouched ? '#dc2626' : '#8a7f76', fontFamily: FONTS.body }}>Required: write at least a sentence ({reason.trim().length}/{REASON_MIN} characters).</div>}
        </div>

        <div style={{ marginTop: '2.2em' }}>
          {sigRow('sm', LABEL.sm)}
          {sigRow('dm', LABEL.dm)}
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
          {busy ? 'Sending…' : 'Send for approval & download'}
        </button>
      </div>
      {saved && saved.state !== 'decided' && <div style={{ textAlign: 'right', fontSize: '0.85rem', marginBottom: '2rem' }}>{savedLine()}</div>}
      </>)}

      {signing && (
        <SignatureModal th={th} title={`${LABEL[signing]} signature — ${employee?.name || ''}`} onCancel={() => setSigning(null)}
          onDone={(image) => { setSigs(s => ({ ...s, [signing]: { image, fp } })); setSigning(null); }} />
      )}
    </div>
  );
}
