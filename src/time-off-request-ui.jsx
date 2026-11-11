// src/time-off-request-ui.jsx — Tools · Time Off Request (v22.80). Replaces HR's Google Form.
//
// A Store Manager, DM, Director or exec requests their OWN time off. Name comes from their account
// (locked); email, phone, position and location are filled in and can be corrected; their Paycor
// time-off balances show beside the request. Everything the Google Form asked is required; up to 5
// supporting documents are optional. They sign, then "Send to HR" sends first (Drive + the Admin ·
// Notifications · Time Off Request list, time-off-request.mjs) and then hands over the PDF.
// Straight to HR — no approval step. A signature is void if the form changes after it.
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FIN_CSS, FinBanner, finStyles } from './finance-ui.jsx';
import { SignatureModal, toB64, deliverPdf, PdfOpenButton } from './transfer-notice-ui.jsx';
import { buildTimeOffPdf, TOR_FONT, TOR_CHROME } from './time-off-request-pdf.mjs';
import { POSITIONS, LEAVE_TYPES, timeOffValues, timeOffFingerprint, missingTimeOffFields, timeOffProblem, timeOffFileName, usDate } from './time-off-request.mjs';

const { useState, useEffect } = React;
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const MAX_DOCS = 5, MAX_DOC_BYTES = 3.5 * 1024 * 1024; // all documents together — the request body tops out near 6 MB

const call = async (body) => {
  const res = await fetch('/.netlify/functions/time-off-request', {
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
const loadAssets = () => assetsPromise || (assetsPromise = Promise.all([fetchB64('/fonts/' + TOR_FONT.regular), fetchB64('/fonts/' + TOR_FONT.bold), fetchB64('/' + TOR_CHROME.logo.src), fetchB64('/' + TOR_CHROME.watermark.src)])
  .then(([regular, bold, logo, seal]) => ({ fonts: { regular, bold }, logo: 'data:image/jpeg;base64,' + logo, watermark: 'data:image/png;base64,' + seal }))
  .catch(e => { assetsPromise = null; throw e; }));

const readDataUrl = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error(`Couldn't read ${file.name}`)); r.readAsDataURL(file); });
// Phone photos are 3–6 MB; shrink them to a readable 1600 px JPEG so five fit in one send.
async function prepareDoc(file) {
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) {
    try {
      const url = await readDataUrl(file);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL('image/jpeg', 0.82);
      return { name: file.name.replace(/\.(png|webp)$/i, '.jpg'), type: 'image/jpeg', data, size: Math.round((data.length - data.indexOf(',') - 1) * 0.75) };
    } catch { /* fall through to the original file */ }
  }
  const data = await readDataUrl(file);
  return { name: file.name, type: file.type || 'application/octet-stream', data, size: file.size };
}
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtHrs = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));

export function TimeOffRequest({ th, isMobile, onBack }) {
  const S = finStyles(th);
  const [info, setInfo] = useState(null); // GET result
  const [error, setError] = useState(null);
  const [f, setF] = useState({ email: '', employeeName: '', address: '', phone: '', ecName: '', ecPhone: '', ecEmail: '', ecAuthorized: null, position: '', location: '', locationOther: '',
    startDate: '', startTime: '', returnDate: '', returnTime: '', totalHours: '', leaveType: '', leaveOther: '', lastWorked: '' });
  const [docs, setDocs] = useState([]);
  const [sig, setSig] = useState(null); // { image, date, fp }
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [touched, setTouched] = useState(false);
  const set = (k) => (e) => { const val = e && e.target ? e.target.value : e; setF(x => ({ ...x, [k]: val })); };

  useEffect(() => {
    call().then(b => {
      setInfo(b);
      setF(x => ({ ...x, employeeName: b.me.name, email: x.email || b.me.email, phone: x.phone || b.me.phone, position: x.position || b.me.position, location: x.location || b.me.location }));
    }).catch(e => { setError(e.message); setInfo({ me: null, balances: [], linked: false }); });
  }, []);

  const location = f.location === 'Other' ? (f.locationOther.trim() ? `Other: ${f.locationOther.trim()}` : '') : f.location;
  const form = { ...f, location, date: todayIso(), documents: docs };
  const base = timeOffValues(form);
  const fp = timeOffFingerprint(base);
  const sigOk = sig && sig.fp === fp ? sig : null;
  const values = { ...timeOffValues({ ...form, sig: sigOk }), balances: (info?.balances || []).map(b => ({ type: b.type, current: b.current })) };
  const formMissing = missingTimeOffFields({ ...base, signature: 'x' });
  const problem = timeOffProblem(base);
  const canSign = !formMissing.length && !problem;
  const missing = missingTimeOffFields(values);
  const ready = !missing.length && !problem && !busy && !!info?.me;
  useEffect(() => { setSaved(null); }, [fp]);

  const docBytes = docs.reduce((n, d) => n + d.size, 0);
  const addFiles = async (list) => {
    const files = [...list].slice(0, MAX_DOCS - docs.length);
    if (!files.length) return;
    try {
      const prepared = await Promise.all(files.map(prepareDoc));
      const next = [...docs, ...prepared];
      if (next.reduce((n, d) => n + d.size, 0) > MAX_DOC_BYTES) { setError('Those documents are too large together (3.5 MB max). Send fewer or smaller files.'); return; }
      setError(null); setDocs(next);
    } catch (e) { setError(e.message); }
  };

  const send = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (!JsPDF) throw new Error('PDF library did not load — refresh the page.');
      const { fonts, logo, watermark } = await loadAssets();
      const doc = buildTimeOffPdf(JsPDF, fonts, values, { logo, watermark });
      const fileName = timeOffFileName(values);
      // Send first, then hand over the PDF (on a phone a download would replace the portal).
      setSaved({ state: 'saving' });
      try {
        const b = await call({ values, pdf: doc.output('datauristring'), documents: docs.map(d => ({ name: d.name, type: d.type, data: d.data })) });
        setSaved({ state: 'done', ...b, pdfUrl: deliverPdf(doc, fileName) });
      } catch (e) { setSaved({ state: 'failed', error: e.message, pdfUrl: deliverPdf(doc, fileName) }); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const savedLine = () => {
    if (!saved) return null;
    if (saved.state === 'saving') return <span style={{ color: th.muted }}>Sending to HR…</span>;
    if (saved.state === 'failed') return <span style={{ color: '#dc2626' }}>Not sent: {saved.error}. Press the button again to retry.</span>;
    const d = saved.drive || {}, a = saved.alert || {};
    return (
      <span style={{ color: d.saved && !a.error ? '#16a34a' : '#d97706' }}>
        {d.saved ? <>Sent to HR and saved to Google Drive{d.link ? <> (<a href={d.link} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>open</a>)</> : ''}.</> : `Not saved to Drive: ${d.error || 'unknown error'}. Press the button again to retry.`}
        {' '}{a.error ? `Alert failed: ${a.error}.` : a.recipients === 0 ? 'No one is on the Time Off Request alert list yet.' : ''}
      </span>
    );
  };

  // ── field pieces ──
  const bad = (cond) => (touched && cond ? { boxShadow: 'inset 0 0 0 2px #dc2626' } : {});
  const field = (label, control, wide) => (
    <label style={{ ...S.fieldLabel, gridColumn: wide && !isMobile ? '1 / -1' : undefined, minWidth: 0 }}><span>{label} <span style={{ color: O }} aria-hidden="true">*</span></span>{control}</label>
  );
  const text = (k, opts = {}) => <input style={{ ...S.input, ...bad(!String(f[k]).trim()) }} value={f[k]} onChange={set(k)} maxLength={opts.max || 120} type={opts.type || 'text'} inputMode={opts.inputMode} autoComplete={opts.ac || 'off'} placeholder={opts.ph} aria-required="true" onBlur={() => setTouched(true)} />;
  const sel = (k, options, ph) => (
    <select style={{ ...S.input, ...bad(!f[k]) }} value={f[k]} onChange={set(k)} aria-required="true">
      <option value="">{ph}</option>{options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
  const grid = { display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: '0.9rem 1rem', padding: '1rem 1.1rem 1.2rem' };
  const section = (title, children, extra) => (
    <section style={{ ...S.panel, marginBottom: '1rem' }}>
      <div style={{ padding: '0.9rem 1.1rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.8rem', flexWrap: 'wrap' }}>
        <h3 style={{ ...S.panelTitle, margin: 0 }}>{title}</h3>{extra}
      </div>
      <div style={grid}>{children}</div>
    </section>
  );
  const radio = (checked, onChange, label) => (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', color: th.text, fontSize: '0.9rem', cursor: 'pointer', lineHeight: 1.4 }}>
      <input type="radio" checked={checked} onChange={onChange} style={{ accentColor: O, marginTop: '0.2rem', width: 16, height: 16 }} /> {label}
    </label>
  );

  if (!info) return <div className="fin-root" style={{ maxWidth: 860, margin: '0 auto' }}><style>{FIN_CSS(th)}</style><p style={{ color: th.muted }}>Loading your details…</p></div>;

  const balances = info.balances || [];
  return (
    <div className="fin-root" style={{ maxWidth: 860, margin: '0 auto' }}>
      <style>{FIN_CSS(th)}</style>
      {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
      <h2 style={S.title}>Time Off Request</h2>
      <p style={S.lede}>Request your own time off. Your name, contact details, position and location are filled in from your account. Every field is required; supporting documents are optional. It goes straight to HR. Please allow 24–48 hours for HR to confirm your request.</p>

      {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
      {sig && !sigOk && <FinBanner th={th} tone="warn">The request changed after you signed it, so the signature no longer counts. Sign again.</FinBanner>}

      {section('Your information', <>
        {field('Employee name', <div style={{ ...S.input, background: th.card2, color: th.text }} title="From your account">{f.employeeName || '—'}</div>)}
        {field('Email', text('email', { type: 'email', ac: 'email', inputMode: 'email' }))}
        {field('Phone number', text('phone', { type: 'tel', ac: 'tel', inputMode: 'tel', max: 30 }))}
        {field('Job position', sel('position', POSITIONS, 'Pick your position'))}
        {field('Address', text('address', { ac: 'street-address', max: 200, ph: 'Street, city, state, ZIP' }), true)}
        {field('Location', sel('location', [...(info.me?.locations || []), 'Other'], 'Pick your location'))}
        {f.location === 'Other' && field('Other location', text('locationOther'))}
      </>)}

      {section('Emergency contact', <>
        {field('Name and relation', text('ecName', { ph: 'e.g. Jane Doe, spouse' }))}
        {field('Phone number', text('ecPhone', { type: 'tel', inputMode: 'tel', max: 30 }))}
        {field('Email address', text('ecEmail', { type: 'email', inputMode: 'email' }))}
        <div style={{ gridColumn: isMobile ? undefined : '1 / -1', display: 'grid', gap: '0.45rem' }} role="radiogroup" aria-label="Emergency contact authorization">
          <span style={{ fontSize: '0.8rem', color: th.muted }}>May HR contact your emergency contact? <span style={{ color: O }} aria-hidden="true">*</span></span>
          {radio(f.ecAuthorized === true, () => set('ecAuthorized')(true), 'Yes, I authorize my emergency contact to be contacted via phone, text, or email')}
          {radio(f.ecAuthorized === false, () => set('ecAuthorized')(false), 'No, I do not authorize my emergency contact to be contacted')}
        </div>
      </>)}

      {section('Time off', <>
        {field('Start date', <input type="date" style={{ ...S.input, ...bad(!f.startDate) }} value={f.startDate} onChange={set('startDate')} aria-required="true" />)}
        {field('Start time', <input type="time" style={{ ...S.input, ...bad(!f.startTime) }} value={f.startTime} onChange={set('startTime')} aria-required="true" />)}
        {field('Back to work date', <input type="date" style={{ ...S.input, ...bad(!f.returnDate) }} value={f.returnDate} min={f.startDate || undefined} onChange={set('returnDate')} aria-required="true" />)}
        {field('Back to work start time', <input type="time" style={{ ...S.input, ...bad(!f.returnTime) }} value={f.returnTime} onChange={set('returnTime')} aria-required="true" />)}
        {field('Total hours requested', <input type="number" min="0.25" max="2000" step="0.25" inputMode="decimal" style={{ ...S.input, ...bad(!(Number(f.totalHours) > 0)) }} value={f.totalHours} onChange={set('totalHours')} aria-required="true" />)}
        {field('Last date worked', <input type="date" style={{ ...S.input, ...bad(!f.lastWorked) }} value={f.lastWorked} max={f.startDate || undefined} onChange={set('lastWorked')} aria-required="true" />)}
        {field('Type of leave', sel('leaveType', LEAVE_TYPES, 'Pick the type of leave'), !isMobile && f.leaveType !== 'Other')}
        {f.leaveType === 'Other' && field('Other type of leave', text('leaveOther'))}
      </>, balances.length ? (
        <span style={{ fontSize: '0.8rem', color: th.muted, fontVariantNumeric: 'lining-nums tabular-nums' }}>
          Paycor balance: {balances.map((b, i) => <span key={b.type + i} style={{ marginLeft: i ? '0.8rem' : '0.3rem', color: th.text }}><b>{fmtHrs(b.current)} h</b> {b.type}</span>)}
        </span>
      ) : info.linked === false ? <span style={{ fontSize: '0.8rem', color: th.muted }}>Your account isn't linked to Paycor, so your balance can't be shown.</span> : null)}
      {problem && <FinBanner th={th} tone="warn">{problem}</FinBanner>}

      <section style={{ ...S.panel, marginBottom: '1rem' }}>
        <div style={{ padding: '0.9rem 1.1rem 0' }}><h3 style={{ ...S.panelTitle, margin: 0 }}>Supporting documents <span style={{ fontFamily: FONTS.body, fontWeight: 400, fontSize: '0.82rem', color: th.muted }}>optional, up to 5</span></h3></div>
        <div style={{ padding: '0.8rem 1.1rem 1.1rem', display: 'grid', gap: '0.5rem' }}>
          {docs.map((d, i) => (
            <div key={d.name + i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.8rem', fontSize: '0.88rem', color: th.text, padding: '0.45rem 0.7rem', background: th.card2, borderRadius: 8 }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name} <span style={{ color: th.muted }}>({fmtSize(d.size)})</span></span>
              <button type="button" className="fin-btn" style={{ ...S.link, color: th.muted }} onClick={() => setDocs(x => x.filter((_, j) => j !== i))} aria-label={`Remove ${d.name}`}>Remove</button>
            </div>
          ))}
          {docs.length < MAX_DOCS && (
            <label className="fin-btn" style={{ ...S.ghost, display: 'inline-flex', alignItems: 'center', justifySelf: 'start', cursor: 'pointer' }}>
              Add a document
              <input type="file" multiple accept="application/pdf,image/*,.doc,.docx,.txt" style={S.srOnly} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
          )}
          <span style={{ fontSize: '0.78rem', color: th.muted }}>PDFs, photos, Word or text files. {docs.length ? `${fmtSize(docBytes)} of 3.5 MB used.` : ''}</span>
        </div>
      </section>

      <section style={{ ...S.panel, marginBottom: '1rem' }}>
        <div style={{ padding: '1rem 1.1rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, color: th.text, fontSize: '0.92rem' }}>Your signature <span style={{ color: O }} aria-hidden="true">*</span></span>
          {sigOk ? (
            <button type="button" onClick={() => setSigning(true)} title="Sign again" style={{ background: '#fff', border: `1px solid ${th.cardBorder}`, borderRadius: 8, padding: '0.2rem 0.6rem', cursor: 'pointer' }}>
              <img src={sigOk.image} alt="Your signature" style={{ maxHeight: 44, maxWidth: 220, objectFit: 'contain', display: 'block' }} />
            </button>
          ) : (
            <button type="button" className="fin-btn" disabled={!canSign} onClick={() => setSigning(true)} style={{ ...S.ghost, border: `1px dashed ${O}`, color: O, opacity: canSign ? 1 : 0.5, cursor: canSign ? 'pointer' : 'not-allowed' }}>
              {canSign ? 'Tap to sign' : 'Fill in the form first'}
            </button>
          )}
          {sigOk && <span style={{ fontSize: '0.85rem', color: th.muted }}>Signed {usDate(sigOk.date)}</span>}
        </div>
      </section>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.9rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
        {!ready && !busy && <span style={{ color: th.muted, fontSize: '0.82rem' }}>{missing.length ? `Still needed: ${missing.join(', ')}` : ''}</span>}
        <button type="button" className="fin-btn" style={{ ...S.primary, opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed' }} disabled={!ready} onClick={send} onMouseEnter={() => setTouched(true)}>{busy ? 'Sending…' : 'Send to HR'}</button>
      </div>
      {saved && <div style={{ textAlign: 'right', fontSize: '0.85rem', marginBottom: '2rem' }}>{savedLine()}{saved.pdfUrl && <div style={{ marginTop: '0.6rem' }}><PdfOpenButton url={saved.pdfUrl} style={{ ...S.ghost }} /></div>}</div>}

      {signing && (
        <SignatureModal th={th} title={`Your signature — ${f.employeeName}`} onCancel={() => setSigning(false)}
          onDone={(image) => { setSig({ image, date: todayIso(), fp }); setSigning(false); }} />
      )}
    </div>
  );
}
