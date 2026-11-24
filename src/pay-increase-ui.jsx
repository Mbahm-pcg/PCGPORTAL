// src/pay-increase-ui.jsx — Tools · Pay Rate Change (v22.55; approval v22.60; v22.62).
//
// The screen IS HR's Pay Rate Change Form, ready to fill the moment it opens. A Store Manager or DM
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
import { SignatureModal, toB64, deliverPdf, PdfOpenButton } from './transfer-notice-ui.jsx';
import { buildPayIncreasePdf, PAY_FONT, PAY_CHROME, formatFormDate } from './pay-increase-pdf.mjs';
import { rateProblem, payFormValues, payFingerprint, missingPayFields, REASON_MIN, payBasisOf, currentPayOf, fmtPay } from './pay-increase.mjs';

const { useState, useEffect, useRef } = React;
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

// v22.69: the signed form drawn with pdf.js (already on the page) instead of the browser's own PDF
// viewer in an <iframe>, which showed nothing for Mike. A small preview; click it for the full page.
const pdfCache = new Map();
// v22.81: id is a pay rate change id, or a full URL ("/...") so the Violation Notice approval view reuses this.
const pdfUrl = (id) => (String(id).startsWith("/") ? String(id) : `/.netlify/functions/pay-increase?pdf=${id}`);
// v23.2: a cached copy is reused for 20 s only (the thumbnail and the full-size view share it). A
// form changes after it's first shown — the office box, signatures added later — and "View form"
// kept showing the copy from before (Roxy's completed pay rate change, 2026-11-23).
const PDF_CACHE_MS = 20000;
function loadPayPdf(id) {
  const hit = pdfCache.get(id);
  if (hit && Date.now() - hit.at > PDF_CACHE_MS) pdfCache.delete(id);
  if (!pdfCache.has(id)) {
    pdfCache.set(id, Object.assign((async () => {
      const lib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
      if (!lib) throw new Error('The PDF viewer did not load — refresh the page.');
      lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const res = await fetch(pdfUrl(id), { credentials: 'include', cache: 'no-store', headers: { ...authHeader() } });
      if (!res.ok) throw new Error(`Could not load the form (${res.status}).`);
      const doc = await lib.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
      return doc.getPage(1);
    })().catch(e => { pdfCache.delete(id); throw e; }), { at: Date.now() }));
  }
  return pdfCache.get(id);
}
function PdfPage({ id, width, onError }) {
  const ref = useRef(null);
  useEffect(() => {
    let live = true;
    loadPayPdf(id).then(page => {
      if (!live || !ref.current) return;
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: (width / base.width) * dpr });
      const c = ref.current;
      c.width = vp.width; c.height = vp.height;
      c.style.width = `${width}px`; c.style.height = `${(vp.height / dpr)}px`;
      page.render({ canvasContext: c.getContext('2d'), viewport: vp });
    }).catch(e => live && onError && onError(e.message));
    return () => { live = false; };
  }, [id, width]);
  return <canvas ref={ref} style={{ display: 'block', background: '#fff' }} />;
}
export function FormModal({ th, id, title, onClose }) {
  const [err, setErr] = useState(null);
  const bigWidth = Math.min(860, (typeof window !== 'undefined' ? window.innerWidth : 900) - 48);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(20,16,12,0.7)', overflowY: 'auto', padding: '56px 16px 24px', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
      <button type="button" className="fin-btn" onClick={onClose} aria-label="Close"
        style={{ position: 'fixed', top: 12, right: 16, width: 40, height: 40, borderRadius: 20, border: 'none', background: '#fff', color: '#111', fontSize: '1.3rem', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.25)' }}>✕</button>
      {err ? <p style={{ color: '#fff' }}>{err} <a href={pdfUrl(id)} target="_blank" rel="noreferrer" style={{ color: '#ffb48a' }}>Open the PDF</a></p>
        : <div style={{ borderRadius: 6, overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}><PdfPage id={id} width={bigWidth} onError={setErr} /></div>}
    </div>
  );
}
export function FormPreview({ th, id, title, thumbWidth = 230 }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(null);
  if (err) return <p style={{ color: th.muted, fontSize: '0.85rem' }}>{err} <a href={pdfUrl(id)} target="_blank" rel="noreferrer" style={{ color: O }}>Open the PDF</a></p>;
  return (
    <>
      <button type="button" className="fin-btn" onClick={() => setOpen(true)} aria-label={`Open ${title} full size`} title="Click to open the full form"
        style={{ padding: 0, border: `1px solid ${th.cardBorder}`, borderRadius: 8, overflow: 'hidden', cursor: 'zoom-in', background: '#fff', boxShadow: '0 2px 10px rgba(0,0,0,0.08)', display: 'inline-block' }}>
        <PdfPage id={id} width={thumbWidth} onError={setErr} />
      </button>
      {open && <FormModal th={th} id={id} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}

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
      const a = b.alert || {};
      onClose(`Approved. It's with the office now to set the effective date (${a.error ? `office alert failed: ${a.error}` : a.recipients ? `${a.recipients} alerted` : 'no one is on the office list yet'}). ${form.submittedBy} was emailed.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div style={{ ...S.panel, padding: '1rem 1.1rem', marginBottom: '1.4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ ...S.panelTitle, fontSize: '1.05rem' }}>{form.employeeName}, {form.storeName}</div>
        <span style={{ color: th.muted, fontSize: '0.88rem' }}>{fmtPay(form.currentRate, form.payBasis)} to {fmtPay(form.newRate, form.payBasis)}, sent by {form.submittedBy}</span>
      </div>
      <p style={{ color: th.text, fontSize: '0.9rem', margin: '0.4rem 0 0.8rem' }}>{form.reason}</p>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <FormPreview th={th} id={form.id} title={`Pay rate change for ${form.employeeName}`} thumbWidth={isMobile ? 200 : 260} />
        <p style={{ fontSize: '0.82rem', color: th.muted, margin: 0, maxWidth: '22em' }}>Click the form to see it full size. <a href={`/.netlify/functions/pay-increase?pdf=${form.id}`} target="_blank" rel="noreferrer" style={{ color: O }}>Download the PDF</a></p>
      </div>
      {err && <FinBanner th={th} tone="error" style={{ marginTop: '0.8rem' }}>{err}</FinBanner>}
      {backing && (
        <div style={{ marginTop: '0.8rem' }}>
          <label htmlFor="pi-note" style={{ display: 'block', fontWeight: 700, marginBottom: '0.3rem', color: th.text }}>Why is it being sent back?</label>
          <textarea id="pi-note" value={note} maxLength={400} rows={3} onChange={e => setNote(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', borderRadius: 8, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, padding: '0.5rem', fontFamily: FONTS.body }} />
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.9rem' }}>
        <button type="button" className="fin-btn" style={S.ghost} onClick={() => onClose(null)} disabled={busy}>Back</button>
        {!canApprove && <span style={{ color: th.muted, fontSize: '0.85rem', alignSelf: 'center' }}>Only the pay rate change approver can approve this.</span>}
        {canApprove && (backing
          ? <button type="button" className="fin-btn" style={{ ...S.primary, background: '#b91c1c', opacity: note.trim().length >= 3 && !busy ? 1 : 0.5 }} disabled={note.trim().length < 3 || busy} onClick={() => decide('reject')}>{busy ? 'Sending…' : 'Send back'}</button>
          : <button type="button" className="fin-btn" style={S.ghost} onClick={() => setBacking(true)} disabled={busy}>Send back…</button>)}
        {canApprove && !backing && <button type="button" className="fin-btn" style={S.primary} disabled={busy} onClick={() => decide('approve')}>{busy ? 'Approving…' : 'Approve & send to the office'}</button>}
      </div>
    </div>
  );
}

// v23.0 the office step: everything above is locked; the office enters the effective date, the
// paycheck date and signs. That files it in Drive and emails the person who made it.
// v23.2: a typed signature (user, 2026-11-23: "hard to do a signature with a mouse") — the name in a
// handwriting font, drawn to a PNG so it's stamped exactly like a drawn one.
function typedSignature(name) {
  const c = document.createElement('canvas');
  c.width = 600; c.height = 140;
  const x = c.getContext('2d');
  let size = 64;
  const font = (n) => `italic ${n}px "Segoe Script", "Lucida Handwriting", "Brush Script MT", "Snell Roundhand", cursive`;
  x.font = font(size);
  while (size > 24 && x.measureText(name).width > 570) { size -= 2; x.font = font(size); }
  x.fillStyle = '#111';
  x.textBaseline = 'middle';
  x.fillText(name, 15, 72);
  return c.toDataURL('image/png');
}

function OfficeComplete({ th, isMobile, form, onClose, payrateWrite, notifyCount }) {
  const S = finStyles(th);
  const [eff, setEff] = useState('');
  const [pay, setPay] = useState('');
  const [sig, setSig] = useState(null); // drawn signature
  const [signing, setSigning] = useState(false);
  const [mode, setMode] = useState('type'); // 'type' (default) | 'draw'
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [after, setAfter] = useState(null); // v23.10 step 2: { msg } once completed, to offer the Paycor update
  const [confirming, setConfirming] = useState(false);
  const typedOk = typed.trim().length >= 2;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(eff) && /^\d{4}-\d{2}-\d{2}$/.test(pay) && (mode === 'type' ? typedOk : !!sig);
  const done = async () => {
    setBusy(true); setErr(null);
    try {
      const b = await call('', { action: 'complete', id: form.id, effectiveDate: eff, paycheckDate: pay, payrollSignature: mode === 'type' ? typedSignature(typed.trim()) : sig });
      const msg = `Completed: ${b.drive?.saved ? 'filed in Google Drive' : `NOT saved to Drive (${b.drive?.error || 'error'}), tell IT`}. ${form.submittedBy} was emailed the effective date.`;
      // v23.10: with Paycor updates switched on, step 2 offers "Update pay in Paycor".
      if (b.paycorReady) { setAfter({ msg }); setBusy(false); } else onClose(msg);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  if (after) return (
    <div className="pcg-stagger" style={{ ...S.panel, padding: '1rem 1.1rem', marginBottom: '1.4rem', display: 'grid', gap: '0.9rem' }}>
      <FinBanner th={th} tone="success">{after.msg}</FinBanner>
      <div style={{ display: 'grid', gap: '0.35rem' }}>
        <div style={{ ...S.panelTitle, fontSize: '1.05rem' }}>Last step: Paycor</div>
        <p style={{ margin: 0, color: th.muted, fontSize: '0.9rem' }}>{form.employeeName}, {form.storeName}: {fmtPay(form.currentRate, form.payBasis)} to {fmtPay(form.newRate, form.payBasis)}, effective {usLong(eff)}.</p>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', flexWrap: 'wrap' }}>
        <button type="button" className="fin-btn" style={S.ghost} onClick={() => onClose(after.msg)}>Not now</button>
        <button type="button" className="fin-btn" style={S.primary} onClick={() => setConfirming(true)}>Update pay in Paycor</button>
      </div>
      <p style={{ margin: 0, color: th.muted, fontSize: '0.8rem', textAlign: 'right' }}>Not now leaves it under Complete, where you can do it later.</p>
      {confirming && <PaycorConfirm th={th} form={form} effectiveDate={eff} notifyCount={notifyCount} onCancel={() => setConfirming(false)} onDone={(m) => onClose(`${after.msg} ${m}`)} />}
    </div>
  );
  return (
    <div style={{ ...S.panel, padding: '1rem 1.1rem', marginBottom: '1.4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ ...S.panelTitle, fontSize: '1.05rem' }}>{form.employeeName}, {form.storeName}</div>
        <span style={{ color: th.muted, fontSize: '0.88rem' }}>{fmtPay(form.currentRate, form.payBasis)} to {fmtPay(form.newRate, form.payBasis)}, approved by {form.approvedBy}</span>
      </div>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '0.8rem' }}>
        <FormPreview th={th} id={form.id} title={`Pay rate change for ${form.employeeName}`} thumbWidth={isMobile ? 200 : 260} />
        <p style={{ fontSize: '0.82rem', color: th.muted, margin: 0, maxWidth: '24em' }}>Everything on the form is locked. Fill in the For Office Use Only box below and sign; that files it in Google Drive and emails {form.submittedBy} when it was completed and when it takes effect.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr)' : 'repeat(3, minmax(0,1fr))', gap: '0.8rem', marginTop: '1rem', alignItems: 'end' }}>
        <label style={S.fieldLabel}>Effective date<input type="date" value={eff} onChange={e => setEff(e.target.value)} style={S.input} /></label>
        <label style={S.fieldLabel}>Effective pay rate paycheck date<input type="date" value={pay} onChange={e => setPay(e.target.value)} style={S.input} /></label>
        <div style={S.fieldLabel}>Payroll Manager signature
          {mode === 'type' ? (<>
            <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="Type your full name to sign" aria-label="Type your full name to sign" maxLength={60} style={S.input} />
            {typedOk && <span style={{ display: 'block', background: '#fff', border: `1px solid ${th.cardBorder}`, borderRadius: 8, padding: '0.15rem 0.6rem', fontFamily: '"Segoe Script", "Lucida Handwriting", "Brush Script MT", cursive', fontStyle: 'italic', fontSize: '1.35rem', color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{typed}</span>}
          </>) : sig ? <button type="button" className="fin-btn" onClick={() => setSigning(true)} title="Sign again" style={{ background: '#fff', border: `1px solid ${th.cardBorder}`, borderRadius: 8, padding: 4, cursor: 'pointer' }}><img src={sig} alt="Your signature" style={{ maxHeight: 38, maxWidth: '100%' }} /></button>
            : <button type="button" className="fin-btn" onClick={() => setSigning(true)} style={{ ...S.ghost, borderStyle: 'dashed', color: O }}>Tap to sign</button>}
          <button type="button" className="fin-btn" onClick={() => setMode(mode === 'type' ? 'draw' : 'type')} style={{ ...S.link, color: O, fontSize: '0.8rem', fontWeight: 700, alignSelf: 'flex-start' }}>{mode === 'type' ? 'Draw it instead' : 'Type it instead'}</button>
        </div>
      </div>
      {err && <FinBanner th={th} tone="error" style={{ marginTop: '0.8rem' }}>{err}</FinBanner>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.9rem' }}>
        <button type="button" className="fin-btn" style={S.ghost} onClick={() => onClose(null)} disabled={busy}>Back</button>
        <button type="button" className="fin-btn" style={{ ...S.primary, opacity: ok && !busy ? 1 : 0.5 }} disabled={!ok || busy} onClick={done}>{busy ? 'Completing…' : 'Complete & file'}</button>
      </div>
      {signing && <SignatureModal th={th} title="Your signature — Payroll Manager" onCancel={() => setSigning(false)} onDone={(img) => { setSig(img); setSigning(false); }} />}
    </div>
  );
}

const usLong = (iso) => (iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

// v23.10 "Update pay in Paycor" -> "This will automatically be updated on Paycor ... Do you want to
// continue?" v23.11: Continue sends it to Paycor now, dated on the effective date (Paycor holds it).
function PaycorConfirm({ th, form, effectiveDate, notifyCount, onCancel, onDone }) {
  const S = finStyles(th);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const now = !!effectiveDate && effectiveDate <= todayIso();
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const b = await call('', { action: 'queuePayRate', id: form.id });
      const told = b.notified ? `; ${b.notified} ${b.notified === 1 ? 'person was' : 'people were'} notified` : '';
      onDone(b.paycor?.status === 'sent'
        ? (b.paycor.future ? `Entered in Paycor: ${form.employeeName}'s new pay takes effect ${usLong(b.effectiveDate || effectiveDate)}${told}.` : `Pay updated in Paycor for ${form.employeeName}${told}.`)
        : `Paycor NOT updated for ${form.employeeName}: ${b.paycor?.error || 'error'}.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const n = notifyCount || 0;
  const people = `${n} ${n === 1 ? 'person' : 'people'}`;
  return (
    <div className="pcg-backdrop" onClick={busy ? undefined : onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="pcg-pop" role="dialog" aria-modal="true" aria-labelledby="pi-paycor-q" onClick={e => e.stopPropagation()} style={{ background: th.card, color: th.text, borderRadius: 16, width: 'min(460px, 100%)', padding: '1.2rem 1.25rem', display: 'grid', gap: '0.8rem' }}>
        <div id="pi-paycor-q" style={{ ...S.panelTitle, fontSize: '1.1rem' }}>Update pay in Paycor?</div>
        <div style={{ padding: '0.75rem 0.9rem', borderRadius: 12, background: th.card3 }}>
          <div style={{ fontWeight: 700 }}>{form.employeeName}, {form.storeName}</div>
          <div style={{ fontSize: '1.05rem', marginTop: 2 }}>{fmtPay(form.currentRate, form.payBasis)} <span style={{ color: th.muted }}>to</span> <b style={{ color: O }}>{fmtPay(form.newRate, form.payBasis)}</b></div>
        </div>
        <p style={{ margin: 0, fontSize: '0.95rem' }}>{now
          ? <>The effective date ({usLong(effectiveDate)}) is today or already past, so this will be updated on Paycor <b>right now</b>.</>
          : <>This will automatically be updated on Paycor, effective <b>{usLong(effectiveDate)}</b>. It goes into Paycor now; Paycor holds it and keeps paying {fmtPay(form.currentRate, form.payBasis)} until then.</>}</p>
        <p style={{ margin: 0, fontSize: '0.84rem', color: th.muted }}>{n
          ? (now ? `The ${people} on the Pay Rate Change Paycor update list will be told how it went.` : `The ${people} on the Pay Rate Change Paycor update list will be notified now, and again on ${usLong(effectiveDate)}.`)
          : 'No one is on the Pay Rate Change Paycor update list yet, so only you will be told how it went.'} If Paycor no longer shows {fmtPay(form.currentRate, form.payBasis)} then, nothing is changed and you are told.</p>
        {err && <FinBanner th={th} tone="error">{err}</FinBanner>}
        <div style={{ fontWeight: 600 }}>Do you want to continue?</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
          <button type="button" className="fin-btn" style={S.ghost} onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="fin-btn" style={{ ...S.primary, opacity: busy ? 0.6 : 1 }} onClick={go} disabled={busy} autoFocus>{busy ? 'Updating Paycor...' : 'Continue'}</button>
        </div>
      </div>
    </div>
  );
}

// v23.9 read-only: what Paycor stores for this employee, and exactly what would be sent.
function PaycorRatesModal({ th, form, onClose }) {
  const S = finStyles(th);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { call('', { action: 'paycorRates', id: form.id }).then(setData).catch(e => setErr(e.message)); }, []);
  const d = (x) => (x ? new Date(x + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  const STATE = { ready: 'Paycor still shows the form\u2019s current pay, so the new pay can be written.', already: 'Paycor already shows the new pay. Nothing to send.', mismatch: 'Paycor shows a different pay than the form. Nothing will be written; check it in Paycor.', none: 'Paycor has no pay rate for this employee.' };
  return (
    <div className="pcg-backdrop" onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="pcg-pop" onClick={e => e.stopPropagation()} style={{ background: th.card, color: th.text, borderRadius: 14, width: 'min(760px, 100%)', maxHeight: '88vh', overflowY: 'auto', padding: '1.1rem 1.2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
          <div style={{ ...S.panelTitle, fontSize: '1.05rem' }}>Paycor pay rates: {form.employeeName}</div>
          <button type="button" className="fin-btn" onClick={onClose} style={S.ghost}>Close</button>
        </div>
        <p style={{ color: th.muted, fontSize: '0.85rem', margin: '0.3rem 0 0.8rem' }}>Read only. Nothing here changes Paycor.</p>
        {err && <FinBanner th={th} tone="error">{err}</FinBanner>}
        {!data && !err && <p style={{ color: th.muted }}>Asking Paycor…</p>}
        {data && (<>
          <FinBanner th={th} tone={data.state === 'ready' ? 'success' : 'warn'}>{STATE[data.state] || data.state}</FinBanner>
          <div style={{ overflowX: 'auto', marginTop: '0.8rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: 520 }}>
              <thead><tr>{['Slot', 'Type', 'Description', 'Rate', 'Yearly', 'Starts', 'Ends'].map(h => <th key={h} style={{ textAlign: 'left', padding: '6px 8px', color: th.muted, borderBottom: `1px solid ${th.cardBorder}` }}>{h}</th>)}</tr></thead>
              <tbody>{data.rates.map((r, i) => (
                <tr key={r.id || i} style={{ background: data.current && r.id === data.current.id ? '#FF671F12' : 'transparent' }}>
                  <td style={{ padding: '6px 8px' }}>{r.sequenceNumber ?? ''}</td><td style={{ padding: '6px 8px' }}>{r.type || ''}</td><td style={{ padding: '6px 8px' }}>{r.description || ''}</td>
                  <td style={{ padding: '6px 8px' }}>{r.payRate != null ? `$${r.payRate.toFixed(2)}` : ''}</td><td style={{ padding: '6px 8px' }}>{r.annualPayRate != null ? `$${Math.round(r.annualPayRate).toLocaleString()}` : ''}</td>
                  <td style={{ padding: '6px 8px' }}>{d(r.effectiveStartDate)}</td><td style={{ padding: '6px 8px' }}>{d(r.effectiveEndDate)}</td>
                </tr>))}</tbody>
            </table>
          </div>
          {data.wouldSend && (<>
            <div style={{ fontWeight: 700, margin: '1rem 0 0.3rem' }}>What the portal would send (new rate)</div>
            <pre style={{ background: th.card3, borderRadius: 8, padding: '0.7rem', fontSize: '0.8rem', overflowX: 'auto', margin: 0 }}>{JSON.stringify(data.wouldSend, null, 2)}</pre>
          </>)}
        </>)}
      </div>
    </div>
  );
}

// v23.9 move a completed raise's effective date (only while it's still in the future).
function ChangeEffective({ th, form, onDone, onCancel }) {
  const S = finStyles(th);
  const [eff, setEff] = useState(form.effectiveDate || '');
  const [pay, setPay] = useState(form.paycheckDate || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(eff) && /^\d{4}-\d{2}-\d{2}$/.test(pay) && reason.trim().length >= 3 && eff !== form.effectiveDate;
  const save = async () => {
    setBusy(true); setErr(null);
    try { const b = await call('', { action: 'changeEffective', id: form.id, effectiveDate: eff, paycheckDate: pay, reason: reason.trim() }); onDone(`Effective date changed to ${new Date(eff + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${b.paycor?.status === 'sent' ? ' (Paycor updated too)' : b.queued ? '; the Paycor update moves with it' : ''}. ${form.submittedBy} was emailed.`); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div style={{ flexBasis: '100%', marginTop: '0.6rem', padding: '0.8rem 0.9rem', borderRadius: 10, background: th.card3, display: 'grid', gap: '0.6rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.6rem' }}>
        <label style={S.fieldLabel}>New effective date<input type="date" value={eff} onChange={e => setEff(e.target.value)} style={S.input} /></label>
        <label style={S.fieldLabel}>New paycheck date<input type="date" value={pay} onChange={e => setPay(e.target.value)} style={S.input} /></label>
      </div>
      <label style={S.fieldLabel}>Why is it changing?<input value={reason} onChange={e => setReason(e.target.value)} maxLength={200} style={S.input} placeholder="e.g. change pushed back one pay period" /></label>
      {err && <FinBanner th={th} tone="error">{err}</FinBanner>}
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button type="button" className="fin-btn" style={S.ghost} onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="fin-btn" style={{ ...S.primary, opacity: ok && !busy ? 1 : 0.5 }} disabled={!ok || busy} onClick={save}>{busy ? 'Saving…' : 'Change date'}</button>
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
  // (approved, to look up) — with "Start a pay rate change" for the form. Everyone else gets the form.
  const [listView, setListView] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [canOffice, setCanOffice] = useState(false); // v23.0 the office step
  const [office, setOffice] = useState([]);
  const [completing, setCompleting] = useState(null);
  const [payrateWrite, setPayrateWrite] = useState(false); // v23.9
  const [canAdmin, setCanAdmin] = useState(false);
  const [today, setToday] = useState('');
  const [ratesFor, setRatesFor] = useState(null);
  const [moving, setMoving] = useState(null);
  const [rowBusy, setRowBusy] = useState(null);
  const [queueFor, setQueueFor] = useState(null); // v23.10 the Complete row being confirmed
  const [notifyCount, setNotifyCount] = useState(0);
  const [complete, setComplete] = useState([]);
  const [view, setView] = useState('list');
  const [listTab, setListTab] = useState('pending');
  const [viewing, setViewing] = useState(null); // Complete tab: the form shown full size
  // v23.12 Complete tab: search, filters, 5 a page.
  const [cq, setCq] = useState('');
  const [cStatus, setCStatus] = useState('all');
  const [cStore, setCStore] = useState('all');
  const [cWhen, setCWhen] = useState('any');
  const [cPage, setCPage] = useState(0);
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
    setPending(b.listView ? (b.pending || []) : null); setComplete(b.complete || []); setCanOffice(!!b.canOffice); setOffice(b.office || []); setPayrateWrite(!!b.payrateWrite); setCanAdmin(!!b.canAdmin); setToday(b.today || ''); setNotifyCount(b.paycorNotifyCount || 0);
    // ?payIncrease=<id> from the approval email / text opens that form straight away.
    let open = null; try { open = sessionStorage.getItem('pi_open'); sessionStorage.removeItem('pi_open'); } catch {}
    const hit = open && (b.pending || []).find(x => String(x.id) === String(open));
    if (hit) { setView('list'); setListTab('pending'); setReviewing(hit); }
    const hitOffice = open && !hit && (b.office || []).find(x => String(x.id) === String(open));
    if (hitOffice) { setView('list'); setListTab('office'); if (b.canOffice) setCompleting(hitOffice); }
    // v23.10: the Paycor-queue emails link to a completed one.
    if (open && !hit && !hitOffice && (b.complete || []).some(x => String(x.id) === String(open))) { setView('list'); setListTab('complete'); }
  }).catch(e => { setError(e.message); setEmployees([]); }).finally(() => setLoaded(true));
  useEffect(() => { loadMain(); }, []);
  // v23.0: keep the lists current (refresh on coming back to the tab and every minute on the list).
  const viewRef = React.useRef(view);
  viewRef.current = view;
  const busyRef = React.useRef(false);
  busyRef.current = !!(reviewing || completing);
  useEffect(() => {
    const tick = () => { if (!document.hidden && viewRef.current === 'list' && !busyRef.current) loadMain(); };
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', tick);
    const t = setInterval(tick, 60000);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', tick); clearInterval(t); };
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
  // v22.74: hourly people by the hour, salaried people (Store Managers) by the year.
  const basis = payBasisOf(employee);
  const hourly = employee && Number(currentPayOf(employee)) > 0; // 'has a usable current pay' (name kept for the code below)
  const base = payFormValues({ employee: hourly ? employee : null, pc: picked?.pc, position, newRate, reason, date, smNa, secondLabel, smName, dmName });
  const fp = payFingerprint(base);
  const sigOk = (k) => (sigs[k] && sigs[k].fp === fp ? sigs[k] : null);
  const voided = Object.keys(sigs).some(k => sigs[k] && sigs[k].fp !== fp);
  const values = payFormValues({ employee: hourly ? employee : null, pc: picked?.pc, position, newRate, reason, date, smNa, secondLabel, smName, dmName, smSig: sigOk('sm'), dmSig: sigOk('dm') });
  const rateErr = hourly && newRate !== '' ? rateProblem(currentPayOf(employee), newRate, basis) : null;
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
      const fileName = `Pay-Increase-${values.employeeName.replace(/[^A-Za-z0-9]+/g, '-')}-${date}.pdf`;
      // v22.70: send FIRST, then hand over the PDF (deliverPdf) — a phone download used to replace
      // the portal before the send happened, so the approver was never told.
      setSaved({ state: 'saving' });
      try { const b = await call('', { values, employeeId: employee.id, pdf: doc.output('datauristring') }); setSaved({ state: 'done', ...b, pdfUrl: deliverPdf(doc, fileName) }); if (pending) loadMain(); }
      catch (e) { setSaved({ state: 'failed', error: e.message, pdfUrl: deliverPdf(doc, fileName) }); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const savedLine = () => {
    if (!saved) return null;
    if (saved.state === 'saving') return <span style={{ color: th.muted }}>Sending for approval…</span>;
    if (saved.state === 'failed') return <span style={{ color: '#dc2626' }}>Not sent: {saved.error}. Press the button again to retry.</span>;
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
        ? <button type="button" className="fin-btn" onClick={() => { setView('list'); loadMain(); }} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Pay Rate Changes</button>
        : onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
      <h2 style={S.title}>Pay Rate Change</h2>

      {!loaded ? <p style={{ color: th.muted }}>Loading…</p> : listView && view === 'list' ? (<>
        <p style={S.lede}>Pay rate changes from Store Managers, DMs and Directors. Pending ones wait for Mike's approval; approved ones go to the office (Office tab) for the effective date and payroll signature, then they're filed in Google Drive and show under Complete.</p>
        {saved && saved.state === 'decided' && <FinBanner th={th} tone="success">{saved.msg}</FinBanner>}
        {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
        {reviewing ? <Review th={th} isMobile={isMobile} form={reviewing} canApprove={canApprove} onClose={(msg) => { setReviewing(null); loadMain(); if (msg) setSaved({ state: 'decided', msg }); }} />
          : completing ? <OfficeComplete th={th} isMobile={isMobile} form={completing} payrateWrite={payrateWrite} notifyCount={notifyCount} onClose={(msg) => { setCompleting(null); loadMain(); if (msg) setSaved({ state: 'decided', msg }); }} /> : (<>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div role="tablist" aria-label="Pay rate changes" style={{ display: 'flex', gap: '0.4rem' }}>
              {[['pending', `Pending${pending && pending.length ? ` (${pending.length})` : ''}`], ['office', `Office${office.length ? ` (${office.length})` : ''}`], ['complete', 'Complete']].map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={listTab === k} className="fin-btn" onClick={() => setListTab(k)}
                  style={{ ...S.ghost, minHeight: 36, padding: '0.4rem 0.95rem', background: listTab === k ? O : th.card3, color: listTab === k ? '#fff' : th.text }}>{label}</button>
              ))}
            </div>
            <span style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
              {canAdmin && (
                <button type="button" className="fin-btn" onClick={async () => { const on = !payrateWrite; if (on && !window.confirm('Switch ON updating pay in Paycor? The office then gets an "Update pay in Paycor" button after completing a pay rate change, and queued ones are sent on their effective date.')) return; try { await call('', { action: 'payrateSwitch', enabled: on }); setPayrateWrite(on); setSaved({ state: 'decided', msg: `Updating pay in Paycor is now ${on ? 'ON' : 'OFF'}.` }); } catch (e) { setError(e.message); } }}
                  style={{ ...S.ghost, minHeight: 36, padding: '0.35rem 0.8rem', fontSize: '0.82rem', borderColor: payrateWrite ? '#16a34a' : th.cardBorder, color: payrateWrite ? '#16a34a' : th.muted }}
                  title="Exec / IT only">Update Paycor: {payrateWrite ? 'ON' : 'OFF'}</button>
              )}
              <button type="button" className="fin-btn" style={S.primary} onClick={() => { setSaved(null); setView('form'); }}>Start a pay rate change</button>
            </span>
          </div>
          {listTab === 'pending' && (pending && pending.length ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {pending.map(f => (
                <button key={f.id} type="button" className="fin-btn" onClick={() => setReviewing(f)}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', textAlign: 'left', padding: '0.75rem 0.95rem', borderRadius: 12, border: `1px solid ${canApprove ? O : th.cardBorder}`, background: th.card, color: th.text, cursor: 'pointer', fontFamily: FONTS.body }}>
                  <span style={{ minWidth: 0 }}><strong>{f.employeeName}</strong> <span style={{ color: th.muted }}>{f.storeName}, {fmtPay(f.currentRate, f.payBasis)} to {fmtPay(f.newRate, f.payBasis)}</span>
                    <span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>Sent by {f.submittedBy}, {new Date(f.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></span>
                  <span style={{ color: canApprove ? O : th.muted, fontWeight: 700, fontSize: '0.85rem', alignSelf: 'center' }}>{canApprove ? 'Review' : 'View'}</span>
                </button>
              ))}
            </div>
          ) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>Nothing waiting for approval.</p>)}
          {listTab === 'office' && (office.length ? (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {office.map(f => (
                <button key={f.id} type="button" className="fin-btn" onClick={() => (canOffice ? setCompleting(f) : setViewing(f))}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', textAlign: 'left', padding: '0.75rem 0.95rem', borderRadius: 12, border: `1px solid ${canOffice ? O : th.cardBorder}`, background: th.card, color: th.text, cursor: 'pointer', fontFamily: FONTS.body }}>
                  <span style={{ minWidth: 0 }}><strong>{f.employeeName}</strong> <span style={{ color: th.muted }}>{f.storeName}, {fmtPay(f.currentRate, f.payBasis)} to {fmtPay(f.newRate, f.payBasis)}</span>
                    <span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>Sent by {f.submittedBy}, approved by {f.approvedBy}{f.approvedAt ? ` on ${new Date(f.approvedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}: waiting on the effective date</span></span>
                  <span style={{ color: canOffice ? O : th.muted, fontWeight: 700, fontSize: '0.85rem', alignSelf: 'center' }}>{canOffice ? 'Complete' : 'View'}</span>
                </button>
              ))}
            </div>
          ) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>Nothing waiting on the office.</p>)}
          {listTab === 'complete' && (complete.length ? (() => {
            // v23.12: search + filters + 5 a page.
            const PER = 5;
            const q = cq.trim().toLowerCase();
            const paycorOf = (f) => f.paycorRateStatus === 'sent' ? 'in' : f.paycorRateStatus === 'failed' || f.paycorRateStatus === 'mismatch' ? 'problem' : f.paycorRateStatus === 'queued' || f.paycorRateStatus === 'sending' ? 'in' : 'not';
            const since = cWhen === '7' ? Date.now() - 7 * 864e5 : cWhen === '30' ? Date.now() - 30 * 864e5 : cWhen === '90' ? Date.now() - 90 * 864e5 : cWhen === 'year' ? new Date(new Date().getFullYear(), 0, 1).getTime() : 0;
            const storeNames = [...new Set(complete.map(f => f.storeName).filter(Boolean))].sort();
            const rows = complete.filter(f => (!q || [f.employeeName, f.storeName, f.submittedBy, f.approvedBy, f.officeBy].some(x => String(x || '').toLowerCase().includes(q)))
              && (cStatus === 'all' || (cStatus === 'starts' ? !!(f.effectiveDate && today && f.effectiveDate > today) : paycorOf(f) === cStatus))
              && (cStore === 'all' || f.storeName === cStore)
              && (!since || Date.parse(f.approvedAt || f.createdAt) >= since));
            const pages = Math.max(1, Math.ceil(rows.length / PER));
            const page = Math.min(cPage, pages - 1);
            const shown = rows.slice(page * PER, page * PER + PER);
            const set = (fn) => (e) => { fn(e.target.value); setCPage(0); };
            const filtered = q || cStatus !== 'all' || cStore !== 'all' || cWhen !== 'any';
            const sel = { ...S.input, width: 'auto', minWidth: 0, flex: '1 1 150px', cursor: 'pointer' };
            return (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
                <input className="fin-input" type="search" value={cq} onChange={set(setCq)} placeholder="Search employee, store or who sent it" aria-label="Search pay rate changes" style={{ ...S.input, flex: '3 1 240px', minWidth: 0 }} />
                <select className="fin-input" value={cStatus} onChange={set(setCStatus)} aria-label="Paycor" style={sel}>
                  <option value="all">Any Paycor status</option><option value="not">Not in Paycor</option><option value="in">In Paycor</option><option value="starts">Starts later</option><option value="problem">Paycor problem</option>
                </select>
                <select className="fin-input" value={cStore} onChange={set(setCStore)} aria-label="Store" style={sel}>
                  <option value="all">All stores</option>{storeNames.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <select className="fin-input" value={cWhen} onChange={set(setCWhen)} aria-label="Approved" style={sel}>
                  <option value="any">Any time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="year">This year</option>
                </select>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', fontSize: '0.82rem', color: th.muted }}>
                <span>{rows.length ? `${page * PER + 1}–${page * PER + shown.length} of ${rows.length}${filtered ? ` (of ${complete.length})` : ''}` : 'No matches'}</span>
                {filtered && <button type="button" className="fin-btn" onClick={() => { setCq(''); setCStatus('all'); setCStore('all'); setCWhen('any'); setCPage(0); }} style={{ ...S.link, color: O, fontWeight: 700 }}>Clear</button>}
              </div>
              {!rows.length && <p style={{ color: th.muted, fontSize: '0.9rem' }}>Nothing matches. Try a different search or filter.</p>}
              {shown.map(f => (
                <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', padding: '0.75rem 0.95rem', borderRadius: 12, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, fontFamily: FONTS.body }}>
                  <span style={{ minWidth: 0 }}><strong>{f.employeeName}</strong> <span style={{ color: th.muted }}>{f.storeName}, {fmtPay(f.currentRate, f.payBasis)} to {fmtPay(f.newRate, f.payBasis)}</span>
                    <span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>Sent by {f.submittedBy}{f.approvedBy ? `, approved by ${f.approvedBy} on ${new Date(f.approvedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : `, ${new Date(f.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}{f.effectiveDate ? `. Effective ${new Date(f.effectiveDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${f.officeBy ? ` (set by ${f.officeBy})` : ''}` : ''}</span></span>
                  {f.effectiveDate && (
                    <span style={{ flexBasis: '100%', fontSize: '0.8rem', fontWeight: 600, color: f.paycorRateStatus === 'sent' ? '#16a34a' : f.paycorRateStatus === 'queued' || f.paycorRateStatus === 'sending' ? O : f.paycorRateStatus === 'failed' || f.paycorRateStatus === 'mismatch' ? '#dc2626' : th.muted }}>
                      {f.paycorRateStatus === 'sent' ? (today && f.effectiveDate > today ? `In Paycor: takes effect ${usLong(f.effectiveDate)}` : 'Pay updated in Paycor')
                        : f.paycorRateStatus === 'queued' ? `Queued: updates in Paycor automatically on ${usLong(f.effectiveDate)}${f.paycorQueuedBy ? ` (queued by ${f.paycorQueuedBy})` : ''}`
                        : f.paycorRateStatus === 'sending' ? 'Sending to Paycor now'
                        : f.paycorRateStatus === 'cancelled' ? 'Paycor update cancelled'
                        : f.paycorRateStatus === 'mismatch' ? `Not written to Paycor: ${f.paycorRateError}` : f.paycorRateStatus === 'failed' ? `Paycor update failed: ${f.paycorRateError}` : 'Not sent to Paycor'}
                      {(f.effectiveChanges || []).length > 0 && <span style={{ color: th.muted, fontWeight: 500 }}> · effective date changed {(f.effectiveChanges || []).length}×</span>}
                    </span>
                  )}
                  <span style={{ display: 'flex', gap: '0.9rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.85rem', fontWeight: 700 }}>
                    {f.hasPdf && <button type="button" className="fin-btn" onClick={() => setViewing(f)} style={{ ...S.link, color: O }}>View form</button>}
                    {f.driveLink && <a href={f.driveLink} target="_blank" rel="noreferrer" style={{ color: O }}>Open in Google Drive</a>}
                    {payrateWrite && canOffice && f.effectiveDate && [null, 'failed', 'mismatch', 'cancelled'].includes(f.paycorRateStatus || null) && <button type="button" className="fin-btn" onClick={() => setQueueFor(f)} style={{ ...S.link, color: O }}>{f.paycorRateStatus === 'failed' || f.paycorRateStatus === 'mismatch' ? 'Try Paycor again' : 'Update pay in Paycor'}</button>}
                    {canOffice && f.paycorRateStatus === 'queued' && <button type="button" className="fin-btn" disabled={rowBusy === f.id} style={{ ...S.link, color: th.muted }}
                      onClick={async () => { if (!window.confirm(`Cancel the Paycor update for ${f.employeeName}? Paycor will not be changed on ${usLong(f.effectiveDate)}.`)) return; setRowBusy(f.id); try { await call('', { action: 'cancelPayRate', id: f.id }); setSaved({ state: 'decided', msg: `Paycor update cancelled for ${f.employeeName}.` }); loadMain(); } catch (e) { setError(e.message); } setRowBusy(null); }}>{rowBusy === f.id ? 'Cancelling...' : 'Cancel Paycor update'}</button>}
                    {canOffice && f.effectiveDate && today && f.effectiveDate > today && <button type="button" className="fin-btn" onClick={() => setMoving(moving === f.id ? null : f.id)} style={{ ...S.link, color: O }}>Change effective date</button>}
                    {canAdmin && <button type="button" className="fin-btn" onClick={() => setRatesFor(f)} style={{ ...S.link, color: th.muted }}>See Paycor pay rates</button>}
                  </span>
                  {moving === f.id && <ChangeEffective th={th} form={f} onCancel={() => setMoving(null)} onDone={(m) => { setMoving(null); setSaved({ state: 'decided', msg: m }); loadMain(); }} />}
                </div>
              ))}
              {pages > 1 && (
                <nav aria-label="Pages" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                  <button type="button" className="fin-btn" disabled={page === 0} onClick={() => setCPage(page - 1)} style={{ ...S.ghost, minHeight: 36, padding: '0.3rem 0.8rem', opacity: page === 0 ? 0.45 : 1 }}>Previous</button>
                  {Array.from({ length: pages }, (_, i) => i).filter(i => pages <= 7 || i === 0 || i === pages - 1 || Math.abs(i - page) <= 1).map((i, k, arr) => (
                    <React.Fragment key={i}>
                      {k > 0 && i - arr[k - 1] > 1 && <span style={{ color: th.muted }}>…</span>}
                      <button type="button" className="fin-btn" aria-current={i === page ? 'page' : undefined} onClick={() => setCPage(i)}
                        style={{ ...S.ghost, minHeight: 36, minWidth: 36, padding: '0.3rem 0.6rem', background: i === page ? O : th.card3, color: i === page ? '#fff' : th.text, borderColor: i === page ? O : th.cardBorder }}>{i + 1}</button>
                    </React.Fragment>
                  ))}
                  <button type="button" className="fin-btn" disabled={page >= pages - 1} onClick={() => setCPage(page + 1)} style={{ ...S.ghost, minHeight: 36, padding: '0.3rem 0.8rem', opacity: page >= pages - 1 ? 0.45 : 1 }}>Next</button>
                </nav>
              )}
            </div>
            );
          })() : <p style={{ color: th.muted, fontSize: '0.9rem' }}>No approved pay rate changes yet.</p>)}
          {viewing && <FormModal th={th} id={viewing.id} title={`Pay rate change for ${viewing.employeeName}`} onClose={() => setViewing(null)} />}
          {ratesFor && <PaycorRatesModal th={th} form={ratesFor} onClose={() => setRatesFor(null)} />}
          {queueFor && <PaycorConfirm th={th} form={queueFor} effectiveDate={queueFor.effectiveDate} notifyCount={notifyCount} onCancel={() => setQueueFor(null)} onDone={(m) => { setQueueFor(null); setSaved({ state: 'decided', msg: m }); loadMain(); }} />}
        </>)}
      </>) : (<>
      <p style={S.lede}>Fill in the form: the employee's name, position, store and current rate come straight from Paycor. Enter the new rate and the reason, then sign. A Store Manager signs with their District Manager. It goes to Mike for approval, then to the office to set the effective date; you're emailed when it's approved and again when it's complete.</p>
      {role === 'office_staff' && <FinBanner th={th} tone="warn">Pay rate changes show here once IT adds you by name to Admin · Notifications · Pay Rate Change (office).</FinBanner>}
      {role === 'manager' && employees && !employees.length && !error && <FinBanner th={th} tone="warn">Your account isn't linked to a store yet, so there's no one to pick. Ask IT to assign your store.</FinBanner>}
      {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
      {employee && !hourly && <FinBanner th={th} tone="warn">Paycor has no current {basis === 'year' ? 'salary' : 'hourly rate'} for {employee.name}{employee.payType ? ` (pay type: ${employee.payType})` : ''}, so this form can't be made. Fix it in Paycor first.</FinBanner>}
      {voided && <FinBanner th={th} tone="warn">The form changed after it was signed, so those signatures no longer count. Sign again.</FinBanner>}

      <div className="pi-paper" style={{ borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 12px 32px rgba(0,0,0,0.08)', padding: isMobile ? '1.2rem 1rem 1.6rem' : '1.6rem 4.2rem 2.4rem', fontSize: isMobile ? '15px' : '16px', lineHeight: 1.5, marginBottom: '1.2rem',
        backgroundImage: `url('/${PAY_CHROME.watermark.src}')`, backgroundRepeat: 'no-repeat', backgroundPosition: 'center 62%', backgroundSize: '77%' }}>
        <div style={{ textAlign: 'center' }}><img src={'/' + PAY_CHROME.logo.src} alt="People Capital Group" style={{ width: isMobile ? 110 : 144, height: 'auto' }} /></div>
        <p style={{ fontWeight: 700, fontSize: '1.09em', marginTop: '1.3em' }}>PAY RATE CHANGE FORM</p>

        <div style={{ display: 'flex', gap: isMobile ? '0.4em 1.5em' : '0 4.5em', flexWrap: 'wrap', marginTop: '0.5em' }}>
          <div className="pi-row"><span>Date:</span><input type="date" className="pi-blank" style={{ width: '9.5em' }} value={date} onChange={e => setDate(e.target.value)} aria-label="Form date" /></div>
          <div className="pi-row"><span>PC #:</span><Locked value={employee ? picked.pc : ''} placeholder={loadingEmp ? '…' : 'from Paycor'} w="8em" /></div>
        </div>
        <div style={{ marginTop: '1.4em' }}>
          {row('Employee Name:', empSearch)}
          {row('Employee Position:', employee && !employee.jobTitle
            ? <input className="pi-blank" style={{ width: '11em' }} list="pi-positions" value={position} onChange={e => setPosition(e.target.value)} placeholder="position" aria-label="Employee position" title="Paycor has no job title for this employee — fill it in" />
            : <Locked value={employee?.jobTitle || ''} placeholder={loadingEmp ? '…' : 'from Paycor'} />)}
          {row('Current Pay Rate:', <Locked value={hourly ? fmtPay(currentPayOf(employee), basis) : ''} placeholder={loadingEmp ? '…' : 'from Paycor'} />)}
          {row('New Pay Rate:', <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: '0.3em' }}>$<input type="number" inputMode="decimal" step={basis === 'year' ? '100' : '0.05'} min="0" className="pi-blank" style={{ width: basis === 'year' ? '8.5em' : '6.5em' }} value={newRate} onChange={e => setNewRate(e.target.value)} placeholder={basis === 'year' ? '00,000' : '0.00'} aria-label={basis === 'year' ? 'New yearly salary' : 'New pay rate per hour'} />{employee && <span style={{ fontSize: '0.9em' }}>{basis === 'year' ? '/ year' : '/ hour'}</span>}</span>)}
        </div>
        <datalist id="pi-positions">{POSITIONS.map(p => <option key={p} value={p} />)}</datalist>

        <div className="pi-box" style={{ marginTop: '1.6em' }}>
          <div className="pi-boxhead">Reason for Pay Change / Evaluation:</div>
          <textarea className="pi-reason" value={reason} maxLength={600} required aria-required="true" onChange={e => setReason(e.target.value)} onBlur={() => setReasonTouched(true)}
            aria-invalid={reasonTouched && reason.trim().length < REASON_MIN} aria-describedby="pi-reason-hint"
            style={reasonTouched && reason.trim().length < REASON_MIN ? { boxShadow: 'inset 0 0 0 2px #dc2626' } : undefined}
            placeholder="Required: why the pay is changing (evaluation, new responsibilities, moved district…)" aria-label="Reason for pay change / evaluation (required)" />
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
      {saved && saved.state !== 'decided' && <div style={{ textAlign: 'right', fontSize: '0.85rem', marginBottom: '2rem' }}>{savedLine()}{saved.pdfUrl && <div style={{ marginTop: '0.6rem' }}><PdfOpenButton url={saved.pdfUrl} style={{ ...S.ghost }} /></div>}</div>}
      </>)}

      {signing && (
        <SignatureModal th={th} title={`${LABEL[signing]} signature — ${employee?.name || ''}`} onCancel={() => setSigning(null)}
          onDone={(image) => { setSigs(s => ({ ...s, [signing]: { image, fp } })); setSigning(null); }} />
      )}
    </div>
  );
}
