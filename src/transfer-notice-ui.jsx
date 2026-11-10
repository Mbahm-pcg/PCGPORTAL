// src/transfer-notice-ui.jsx — Tools · Transfer Notice (v22.50).
//
// The screen IS HR's Employee Transfer letter: same wording, same order, the blanks filled
// in place. The DM fills it in with the employee present: picks the employee in the first
// blank (search by name or store) — their name, current position, current PC# and hourly
// wage then come only from Paycor and are locked — fills the rest in the sentences, and
// both sign on the signature lines (finger, stylus or mouse). A signature is void if the
// letter changes after it was given. The signed PDF matches the template
// (src/transfer-notice-pdf.mjs). Data from transfer-notice.mjs, scoped server-side.
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FIN_CSS, FinBanner, finStyles, finMoney } from './finance-ui.jsx';
import { buildTransferNoticePdf, TRANSFER_FONT, TRANSFER_CHROME, formatLetterDate } from './transfer-notice-pdf.mjs';
import { transferLetterValues, missingTransferFields, letterFingerprint } from './transfer-notice.mjs';

const { useState, useEffect, useRef } = React;

const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const POSITIONS = ['Crew Member', 'Shift Leader', 'Assistant Manager', 'Store Manager'];

const api = async (qs = '') => {
  const res = await fetch('/.netlify/functions/transfer-notice' + qs, { credentials: 'include', headers: { ...authHeader() } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
};

// The letter's font, fetched once per page load (for the PDF; the page uses @font-face).
let fontsPromise = null;
// v22.70: never download before sending. On an iPhone (especially the home-screen app) a download
// replaces the portal with the PDF, so the page was gone before the form was ever sent, and the
// sessionStorage login went with it — confirmed with a Director's Pay Increase, 2026-11-10. On
// phones we don't auto-download at all: after the send, a button opens the PDF in its own tab.
export const isPhoneLike = () => {
  try {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true
      || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  } catch { return false; }
};
// After a successful send: computers download as before; phones get a URL for the "Open the signed PDF" button.
export function deliverPdf(doc, fileName) {
  if (!isPhoneLike()) { doc.save(fileName); return null; }
  return URL.createObjectURL(doc.output('blob'));
}
export function PdfOpenButton({ url, style }) {
  if (!url) return null;
  return <a href={url} target="_blank" rel="noopener" className="fin-btn" style={{ display: 'inline-block', textDecoration: 'none', ...style }}>Open the signed PDF</a>;
}

export const toB64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const loadFonts = () => fontsPromise || (fontsPromise = Promise.all([TRANSFER_FONT.regular, TRANSFER_FONT.italic].map(f =>
  fetch('/fonts/' + f).then(r => { if (!r.ok) throw new Error('font ' + f); return r.arrayBuffer(); }).then(toB64)))
  .then(([regular, italic]) => ({ regular, italic }))
  .catch(e => { fontsPromise = null; throw e; }));
let sealPromise = null;
const loadSeal = () => sealPromise || (sealPromise = fetch('/' + TRANSFER_CHROME.watermark.src)
  .then(r => { if (!r.ok) throw new Error('watermark'); return r.arrayBuffer(); })
  .then(b => 'data:image/png;base64,' + toB64(b))
  .catch(e => { sealPromise = null; throw e; }));

// Paper is always paper: these don't follow the dark theme.
const INK = '#111';
const FILL = '#fdf3ea';
const LETTER_CSS = `
@font-face { font-family: 'Caladea'; src: url('/fonts/Caladea-Regular.ttf') format('truetype'); font-style: normal; font-display: swap; }
@font-face { font-family: 'Caladea'; src: url('/fonts/Caladea-Italic.ttf') format('truetype'); font-style: italic; font-display: swap; }
.tn-paper { font-family: 'Caladea', Cambria, Georgia, serif; color: ${INK}; background: #fff; }
.tn-paper p { margin: 0; }
.tn-blank { font: inherit; color: ${INK}; border: none; border-bottom: 1px solid ${INK}; border-radius: 0; background: ${FILL}; padding: 0 0.25em; margin: 0 0.1em; min-height: 1.35em; line-height: 1.35; vertical-align: baseline; text-align: center; -webkit-appearance: none; appearance: none; }
.tn-blank:focus-visible { outline: 2px solid ${O}; outline-offset: 1px; }
.tn-blank::placeholder { color: #9a8f86; font-style: italic; }
.tn-locked { display: inline-block; border-bottom: 1px solid ${INK}; padding: 0 0.3em; margin: 0 0.1em; text-align: center; line-height: 1.35; }
.tn-locked.tn-empty { color: #9a8f86; font-style: italic; }
select.tn-blank { cursor: pointer; text-align-last: center; }
.tn-sigline { display: inline-flex; align-items: flex-end; justify-content: flex-start; border-bottom: 1px solid ${INK}; height: 3.2em; vertical-align: bottom; margin-left: 0.3em; }
.tn-sigbtn { font: inherit; font-family: ${FONTS.body}; font-size: 0.85rem; color: ${O}; font-weight: 700; background: ${FILL}; border: 1px dashed ${O}; border-radius: 6px; padding: 0.35rem 0.8rem; margin: 0 0 0.3rem 0.2rem; cursor: pointer; }
.tn-sigbtn:focus-visible, .tn-sigimg:focus-visible { outline: 2px solid ${O}; outline-offset: 2px; }
.tn-sigimg { background: none; border: none; padding: 0; cursor: pointer; height: 100%; display: flex; align-items: flex-end; }
@media (prefers-reduced-motion: reduce) { .tn-blank, .tn-sigbtn { transition: none; } }`;

// Signature capture: high-DPI canvas, pointer events (finger, stylus, mouse). Returns a
// cropped PNG data URL of just the ink.
export function SignatureModal({ th, title, onDone, onCancel }) {
  const S = finStyles(th);
  const ref = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  const [inked, setInked] = useState(false);

  useEffect(() => {
    const c = ref.current;
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr); g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = INK; g.lineWidth = 2.4;
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pt = (e) => { const r = ref.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e) => { ref.current.setPointerCapture(e.pointerId); drawing.current = true; last.current = pt(e); const g = ref.current.getContext('2d'); g.beginPath(); g.arc(last.current.x, last.current.y, 1.1, 0, Math.PI * 2); g.fillStyle = INK; g.fill(); setInked(true); };
  const move = (e) => {
    if (!drawing.current) return;
    const g = ref.current.getContext('2d'); const p = pt(e);
    g.beginPath(); g.moveTo(last.current.x, last.current.y); g.lineTo(p.x, p.y); g.stroke();
    last.current = p;
  };
  const up = () => { drawing.current = false; };
  const clear = () => { const c = ref.current; c.getContext('2d').clearRect(0, 0, c.width, c.height); setInked(false); };
  const done = () => {
    const c = ref.current; const g = c.getContext('2d');
    const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return;
    const pad = 6, out = document.createElement('canvas');
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    onDone(out.toDataURL('image/png'));
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(20,16,12,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ ...S.panel, width: 'min(640px, 100%)', padding: '1.1rem' }}>
        <div style={{ ...S.panelTitle, marginBottom: '0.3rem' }}>{title}</div>
        <div style={{ color: th.muted, fontSize: '0.85rem', marginBottom: '0.8rem' }}>Sign in the box with your finger, a stylus or the mouse.</div>
        <canvas ref={ref} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          style={{ width: '100%', height: 200, display: 'block', background: '#fff', border: `1px solid ${th.cardBorder}`, borderRadius: 10, touchAction: 'none', cursor: 'crosshair', backgroundImage: `linear-gradient(transparent 150px, #d9d2cb 150px, #d9d2cb 151px, transparent 151px)` }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', marginTop: '0.9rem', flexWrap: 'wrap' }}>
          <button type="button" className="fin-btn" style={S.ghost} onClick={clear} disabled={!inked}>Clear</button>
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button type="button" className="fin-btn" style={S.ghost} onClick={onCancel}>Cancel</button>
            <button type="button" className="fin-btn" style={{ ...S.primary, opacity: inked ? 1 : 0.5 }} onClick={done} disabled={!inked}>Use this signature</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TransferNotice({ th, isMobile, onBack }) {
  const S = finStyles(th);
  const [stores, setStores] = useState([]);
  const [employees, setEmployees] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [picked, setPicked] = useState(null); // { id, name, jobTitle, pc } from the roster
  const [employee, setEmployee] = useState(null); // live Paycor detail
  const [loadingEmp, setLoadingEmp] = useState(false);
  const [toPC, setToPC] = useState('');
  const [toTitle, setToTitle] = useState('');
  const [employmentType, setEmploymentType] = useState('');
  const [fromTitle, setFromTitle] = useState(''); // only used when Paycor has no job title
  const [effectiveDate, setEffectiveDate] = useState('');
  const [supervisorName, setSupervisorName] = useState('');
  const [supervisorTitle, setSupervisorTitle] = useState('Store Manager');
  const [dmName, setDmName] = useState('');
  const [date, setDate] = useState(todayIso());
  const [employeeSig, setEmployeeSig] = useState(null); // { image, date, fp }
  const [dmSig, setDmSig] = useState(null);
  const [signing, setSigning] = useState(null); // 'employee' | 'dm'
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null); // v22.54: Drive save + alert result for the last download

  useEffect(() => {
    api().then(b => { setStores(b.stores || []); setEmployees(b.employees || []); })
      .catch(e => { setError(e.message); setEmployees([]); });
  }, []);

  useEffect(() => {
    setEmployee(null);
    if (!picked) return;
    let live = true;
    setLoadingEmp(true); setError(null);
    api(`?pc=${encodeURIComponent(picked.pc)}&employeeId=${encodeURIComponent(picked.id)}`)
      .then(b => { if (!live) return; setEmployee(b.employee); setEmploymentType(b.employee?.employmentType || ''); })
      .catch(e => live && setError(e.message))
      .finally(() => live && setLoadingEmp(false));
    return () => { live = false; };
  }, [picked]);

  useEffect(() => {
    if (!toPC) return;
    let live = true;
    api(`?dest=${encodeURIComponent(toPC)}`).then(b => { if (!live) return; setSupervisorName(b.manager || ''); setDmName(b.dm || ''); }).catch(() => {});
    return () => { live = false; };
  }, [toPC]);

  const storeName = (pc) => stores.find(s => s.pc === String(pc))?.name || '';
  const fromPC = picked?.pc || '';
  const hourly = employee && /hour/i.test(employee.payType || 'Hourly') && employee.payRate > 0;
  const base = transferLetterValues({ employee, fromTitle, fromPC, toPC, toTitle, employmentType, effectiveDate, supervisorName, supervisorTitle, dmName, date });
  const fp = letterFingerprint(base);
  useEffect(() => { setSaved(null); }, [fp]); // a different letter → the last save status no longer applies
  // A signature only counts for the exact letter it was given on.
  const empSigOk = employeeSig && employeeSig.fp === fp ? employeeSig : null;
  const dmSigOk = dmSig && dmSig.fp === fp ? dmSig : null;
  const voided = (employeeSig && !empSigOk) || (dmSig && !dmSigOk);
  const values = transferLetterValues({ employee, fromTitle, fromPC, toPC, toTitle, employmentType, effectiveDate, supervisorName, supervisorTitle, dmName, date, employeeSig: empSigOk, dmSig: dmSigOk });
  const missing = missingTransferFields(values);
  const sameStore = fromPC && toPC && fromPC === toPC;
  const letterMissing = missingTransferFields(base).filter(m => !/signature/i.test(m));
  const canSign = !letterMissing.length && hourly && !sameStore && !loadingEmp;
  const ready = !missing.length && hourly && !sameStore && !busy && !loadingEmp;

  const q = query.trim().toLowerCase();
  const matches = q && employees ? employees.filter(e => e.name.toLowerCase().includes(q) || storeName(e.pc).toLowerCase().includes(q) || e.pc.includes(q)).slice(0, 40) : [];
  const pick = (e) => { setPicked(e); setFromTitle(''); setQuery(e.name); setListOpen(false); if (toPC === e.pc) setToPC(''); };

  const download = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (!JsPDF) throw new Error('PDF library did not load — refresh the page.');
      const [fonts, watermark] = await Promise.all([loadFonts(), loadSeal()]);
      const doc = buildTransferNoticePdf(JsPDF, fonts, values, { watermark });
      const fileName = `Transfer-Notice-${values.employeeName.replace(/[^A-Za-z0-9]+/g, '-')}-${date}.pdf`;
      // v22.54: file it in Google Drive + alert the Admin · Notifications list.
      // v22.70: send FIRST, then hand over the PDF (see deliverPdf) — even if the send fails, the
      // signed letter is still offered, so it's never lost.
      setSaved({ state: 'saving' });
      try {
        const res = await fetch('/.netlify/functions/transfer-notice', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ values, employeeId: employee?.id, pdf: doc.output('datauristring') }),
        });
        const b = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
        setSaved({ state: 'done', ...b, pdfUrl: deliverPdf(doc, fileName) });
      } catch (e) { setSaved({ state: 'failed', error: e.message, pdfUrl: deliverPdf(doc, fileName) }); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const savedLine = () => {
    if (!saved) return null;
    if (saved.state === 'saving') return <span style={{ color: th.muted }}>Saving to Google Drive and sending the alert…</span>;
    if (saved.state === 'failed') return <span style={{ color: '#dc2626' }}>Not saved to Drive: {saved.error}. Press the button again to retry.</span>;
    const d = saved.drive || {}, a = saved.alert || {};
    return (
      <span style={{ color: d.saved && !a.error ? '#16a34a' : '#d97706' }}>
        {d.saved ? <>Saved to Google Drive{d.link ? <> — <a href={d.link} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>open</a></> : ''}.</> : `Not saved to Drive: ${d.error || 'unknown error'}. Press the button again to retry.`}
        {' '}{a.error ? `Alert failed: ${a.error}.` : a.recipients ? `Alert sent to ${a.recipients} recipient${a.recipients === 1 ? '' : 's'}.` : a.recipients === 0 ? 'No one is on the Transfer Notice alert list yet.' : ''}
      </span>
    );
  };

  // ── letter pieces ──
  const w = (ch) => ({ width: `${ch}ch`, maxWidth: '100%' });
  const locked = (value, placeholder, ch) => (
    <span className={`tn-locked${value ? '' : ' tn-empty'}`} style={{ minWidth: `${ch}ch` }} title="From Paycor — can't be changed here">{value || (loadingEmp ? '…' : placeholder)}</span>
  );
  const text = (value, set, ch, placeholder, extra = {}) => (
    <input className="tn-blank" style={w(ch)} value={value} onChange={e => set(e.target.value)} placeholder={placeholder} aria-label={placeholder} {...extra} />
  );
  const dateBlank = (value, set, label) => (
    <input type="date" className="tn-blank" style={{ width: isMobile ? '14ch' : '13.5ch' }} value={value} onChange={e => set(e.target.value)} aria-label={label} />
  );
  const sigLine = (who, sig, label) => (
    <span className="tn-sigline" style={{ width: isMobile ? '60%' : '22em' }}>
      {sig ? (
        <button type="button" className="tn-sigimg" onClick={() => setSigning(who)} title="Sign again">
          <img src={sig.image} alt={`${label} signature`} style={{ maxHeight: '2.9em', maxWidth: '100%', objectFit: 'contain' }} />
        </button>
      ) : (
        <button type="button" className="tn-sigbtn" onClick={() => setSigning(who)} disabled={!canSign} style={{ opacity: canSign ? 1 : 0.45, cursor: canSign ? 'pointer' : 'not-allowed' }}>
          {canSign ? `Tap to sign — ${label}` : 'Fill in the letter first'}
        </button>
      )}
    </span>
  );
  const signedDate = (sig) => <span className={`tn-locked${sig ? '' : ' tn-empty'}`} style={{ minWidth: '10ch' }}>{sig ? formatLetterDate(sig.date) : 'on signing'}</span>;
  const row = { marginTop: '1.15em' };

  const empSearch = (
    <span style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
      <input className="tn-blank" style={w(isMobile ? 18 : 26)} value={query} role="combobox" aria-expanded={listOpen && matches.length > 0} aria-controls="tn-emp-list" autoComplete="off"
        aria-label="Employee name" placeholder={employees ? 'Search employee name' : 'Loading from Paycor…'} disabled={!employees}
        onChange={e => { setQuery(e.target.value); setListOpen(true); if (picked) setPicked(null); }}
        onFocus={() => setListOpen(true)} onBlur={() => setTimeout(() => setListOpen(false), 150)}
        onKeyDown={e => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); pick(matches[0]); } if (e.key === 'Escape') setListOpen(false); }} />
      {listOpen && matches.length > 0 && (
        <span id="tn-emp-list" role="listbox" style={{ position: 'absolute', zIndex: 30, left: 0, top: '100%', marginTop: 4, width: 'min(420px, 82vw)', maxHeight: 300, overflowY: 'auto', background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 12, boxShadow: '0 10px 30px rgba(0,0,0,0.15)', textAlign: 'left' }}>
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

  return (
    <div className="fin-root" style={{ maxWidth: 900, margin: '0 auto' }}>
      <style>{FIN_CSS(th) + LETTER_CSS}</style>
      {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
      <h2 style={S.title}>Transfer Notice</h2>
      <p style={S.lede}>Fill in the letter with the employee. The tinted blanks are yours; the employee's name, current position, store and hourly wage come straight from Paycor. Then the employee and the DM each sign on their line.</p>

      {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
      {employee && !hourly && <FinBanner th={th} tone="warn">Paycor has no hourly rate for {employee.name}{employee.payType ? ` (pay type: ${employee.payType})` : ''}, so this letter can't be made. Fix the rate in Paycor first.</FinBanner>}
      {voided && <FinBanner th={th} tone="warn">The letter changed after it was signed, so that signature no longer counts. Sign again.</FinBanner>}

      <div className="tn-paper" style={{ borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 12px 32px rgba(0,0,0,0.08)', padding: isMobile ? '1.4rem 1.1rem' : '2.6rem 4.5rem 2rem', fontSize: isMobile ? '15px' : '16.5px', lineHeight: 1.85, marginBottom: '1.2rem',
        backgroundImage: `url('/${TRANSFER_CHROME.watermark.src}')`, backgroundRepeat: 'no-repeat', backgroundPosition: 'center 58%', backgroundSize: '77%' }}>
        <div style={{ textAlign: 'center', fontFamily: 'Times New Roman, Times, serif', lineHeight: 1.25 }}>
          <div style={{ fontWeight: 700, fontSize: '1.17em', color: '#111' }}>PEOPLE CAPITAL GROUP LLC</div>
          <div style={{ fontStyle: 'italic', fontSize: '0.83em', color: '#6b7280' }}>CONFIDENTIAL — INTERNAL USE ONLY</div>
        </div>
        <div style={{ borderTop: '1px solid #9aa5b1', margin: '0.9em -0.6em 2em' }} />
        <p>Date: {dateBlank(date, setDate, 'Letter date')}</p>

        <p style={{ marginTop: '1.6em', lineHeight: 1.4 }}>People Capital Group LLC<br />ATTN: Human Resources Department<br />Subject: Employee Transfer</p>

        <p style={{ marginTop: '2.4em', textAlign: isMobile ? 'left' : 'justify' }}>
          I, {empSearch}(<i>Employee Name</i>), am requesting to resign from my current position as a {employee && !employee.jobTitle ? text(fromTitle, setFromTitle, 14, 'current position', { list: 'tn-positions', title: 'Paycor has no job title for this employee — fill it in' }) : locked(employee?.jobTitle, 'from Paycor', 14)}(<i>position title</i>), located at PC# {locked(employee ? fromPC : '', 'from Paycor', 8)}, in order to voluntarily transfer to a better opportunity within the company located at PC#{' '}
          <select className="tn-blank" style={{ width: isMobile ? '14ch' : '9.5ch' }} value={toPC} onChange={e => setToPC(e.target.value)} aria-label="New store PC#" title={toPC ? storeName(toPC) : 'New store'}>
            <option value="">choose</option>
            {stores.filter(s => s.pc !== fromPC).map(s => <option key={s.pc} value={s.pc}>{s.pc} · {s.name}</option>)}
          </select>{' '}
          as a {text(toTitle, setToTitle, 14, 'new position', { list: 'tn-positions' })}(<i>position title</i>). I request that my{' '}
          <select className="tn-blank" style={{ width: '10ch' }} value={employmentType} onChange={e => setEmploymentType(e.target.value)} aria-label="Full or part time">
            <option value="">choose</option>
            <option>Full time</option>
            <option>Part time</option>
          </select>{' '}
          (<i>full/part time</i>) employment is effective starting {dateBlank(effectiveDate, setEffectiveDate, 'Effective date')}(<i>effective date</i>).
        </p>
        <datalist id="tn-positions">{POSITIONS.map(p => <option key={p} value={p} />)}</datalist>

        <p style={{ marginTop: '1.6em', textAlign: isMobile ? 'left' : 'justify' }}>
          I acknowledge that I will now report to {text(supervisorName, setSupervisorName, 16, 'supervisor name')}(<i>supervisor name</i>)/ {text(supervisorTitle, setSupervisorTitle, 14, 'supervisor title')}(<i>supervisor title</i>). I also acknowledge that I will be compensated at an hourly wage of {locked(hourly ? finMoney.format(employee.payRate) : '', 'from Paycor', 8)} per hour and paid on a biweekly basis.
        </p>

        <p style={{ marginTop: '1.6em', lineHeight: 1.4 }}>I ACCEPT THE ABOVE CONDITIONS AND AM INDICATING MY ACCEPTANCE BY SIGNING THIS LETTER AND RETURNING IT VIA EMAIL TO THE HUMAN RESOURCES DEPARTMENT.</p>

        <p style={row}>Employee Name: {locked(employee?.name, 'from Paycor', 22)}</p>
        <p style={row}>Employee Signature:{sigLine('employee', empSigOk, 'employee')}</p>
        <p style={row}>Date: {signedDate(empSigOk)}</p>

        <p style={{ marginTop: '2.2em' }}>ACCEPTED AND APPROVED BY:</p>
        <p style={row}>District Manager Name: {text(dmName, setDmName, 22, 'District Manager name')}</p>
        <p style={row}>District Manager Signature:{sigLine('dm', dmSigOk, 'District Manager')}</p>
        <p style={row}>Date: {signedDate(dmSigOk)}</p>
        <div style={{ textAlign: 'right', fontFamily: 'Times New Roman, Times, serif', fontSize: '0.75em', lineHeight: 1.3, color: '#111', marginTop: '2.4em' }}>
          {TRANSFER_CHROME.footer.map(f => <div key={f.text}>{f.text}</div>)}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.9rem', flexWrap: 'wrap', marginBottom: '2rem' }}>
        {!ready && <span style={{ color: th.muted, fontSize: '0.82rem' }}>{sameStore ? 'The new store must be different.' : missing.length ? `Still needed: ${missing.join(', ')}` : ''}</span>}
        <button type="button" className="fin-btn" style={{ ...S.primary, opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed' }} disabled={!ready} onClick={download}>
          {busy ? 'Saving…' : 'Save & download signed PDF'}
        </button>
      </div>
      {saved && <div style={{ textAlign: 'right', fontSize: '0.85rem', marginTop: '-1.4rem', marginBottom: '2rem' }}>{savedLine()}{saved.pdfUrl && <div style={{ marginTop: '0.6rem' }}><PdfOpenButton url={saved.pdfUrl} style={{ ...S.ghost }} /></div>}</div>}

      {signing && (
        <SignatureModal th={th} title={signing === 'employee' ? `Employee signature — ${employee?.name || ''}` : `District Manager signature — ${dmName}`}
          onCancel={() => setSigning(null)}
          onDone={(image) => { const sig = { image, date: todayIso(), fp }; (signing === 'employee' ? setEmployeeSig : setDmSig)(sig); setSigning(null); }} />
      )}
    </div>
  );
}
