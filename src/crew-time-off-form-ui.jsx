// src/crew-time-off-form-ui.jsx — the crew member's Time Off Request (v23.30). No sign-in: opened from
// a private link (?crew=<token>) or a store's QR poster (?crewStore=<pc>.<key>). Phone-first.
// It builds HR's same Time Off Request PDF (time-off-request-pdf.mjs) and sends it to the manager.
import { O, FONTS, getTheme } from './theme.js';
import { FinBanner, finStyles, FIN_CSS } from './finance-ui.jsx';
import { InlineSign } from './transfer-notice-ui.jsx';
import { buildTimeOffPdf } from './time-off-request-pdf.mjs';
import { loadAssets, prepareDoc } from './time-off-request-ui.jsx';
import { CREW_LEAVE_TYPES, CREW_POSITIONS, crewValues, missingCrewFields, crewProblem, crewFingerprint, balanceFor } from './crew-time-off.mjs';

const { useState, useEffect } = React;
const MAX_DOCS = 3, MAX_DOC_BYTES = 3.5 * 1024 * 1024;
const api = async (qs, body) => {
  const res = await fetch('/.netlify/functions/crew-time-off-form' + (qs || ''), {
    method: body ? 'POST' : 'GET', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
  return b;
};
const fmtH = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

export function CrewTimeOffForm({ token, store }) {
  const th = getTheme(false);
  const S = finStyles(th);
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);
  const [f, setF] = useState({ ecAuthorized: null });
  const [empId, setEmpId] = useState('');
  const [sig, setSig] = useState(null);
  const [docs, setDocs] = useState([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [pc, key] = String(store || '').split('.');
  // v23.30 poster: who are you? name + badge ID, checked on the server → a 2-hour pass
  const [who, setWho] = useState({ q: '', pick: null, badge: '', pass: null, busy: false, err: null });

  useEffect(() => {
    api(token ? `?t=${encodeURIComponent(token)}` : `?s=${encodeURIComponent(pc)}&k=${encodeURIComponent(key || '')}`)
      .then(b => { setInfo(b); if (b.mode) setF(x => ({ ...x, phone: b.phone || '', email: b.email || '', position: b.position || 'Crew Member', employeeName: b.employee || '' })); })
      .catch(e => setErr(e.message));
  }, []);
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }));
  const today = info?.today || new Date().toISOString().slice(0, 10);
  const values = crewValues({ ...f, location: info?.location || '', date: today, documents: docs, sig: null });
  const fp = crewFingerprint(values);
  const sigOk = sig && sig.fp === fp ? sig : null;
  const full = crewValues({ ...f, location: info?.location || '', date: today, documents: docs, sig: sigOk ? { image: sigOk.image, date: today } : null });
  const missing = missingCrewFields(full);
  const problem = crewProblem(full, today);
  const canSign = !missingCrewFields({ ...full, signature: 'x' }).length && !problem && consent;
  const bal = (info?.mode === 'link' || who.pass) ? balanceFor(full.leaveType, info.balances) : null;
  const over = bal && Number(full.totalHours) > Number(bal.current || 0);

  const addDocs = async (files) => {
    try {
      const prepared = await Promise.all([...files].slice(0, MAX_DOCS - docs.length).map(prepareDoc));
      const next = [...docs, ...prepared];
      if (next.reduce((n, d) => n + d.size, 0) > MAX_DOC_BYTES) return setErr('Those files are too large together. Take smaller photos or send fewer.');
      setErr(null); setDocs(next);
    } catch (e) { setErr(e.message); }
  };

  const send = async () => {
    if (missing.length || problem || busy) return;
    setBusy(true); setErr(null);
    try {
      const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (!JsPDF) throw new Error('The page did not load fully — refresh it.');
      const { fonts, logo, watermark } = await loadAssets();
      const doc = buildTimeOffPdf(JsPDF, fonts, full, { logo, watermark });
      await api('', { t: token || undefined, s: token ? undefined : pc, k: token ? undefined : key, employeeId: token ? undefined : empId, pass: token ? undefined : who.pass, values: { ...full, sig: { image: sigOk.image, date: today } },
        pdf: doc.output('datauristring'), documents: docs.map(d => ({ name: d.name, type: d.type, data: d.data })) });
      setSent(true);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const field = (label, input, hint) => (
    <label style={{ display: 'grid', gap: '0.3rem', fontWeight: 700, fontSize: '0.92rem', color: th.text }}>{label}{input}{hint && <span style={{ fontWeight: 400, color: th.muted, fontSize: '0.8rem' }}>{hint}</span>}</label>);
  const inp = { ...S.input, fontSize: '1rem', minHeight: 44 };
  const shell = (children) => (
    <div style={{ minHeight: '100vh', background: '#f7f2ec', fontFamily: FONTS.body, color: th.text }}>
      <style>{FIN_CSS(th)}</style>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '1.2rem 1rem 3rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '1rem' }}><img src="/pcg-logo-form.jpg" alt="People Capital Group" style={{ height: 56 }} /></div>
        {children}
        <p style={{ textAlign: 'center', marginTop: '2rem', fontSize: '0.78rem' }}><a href="/terms.html" target="_blank" rel="noreferrer" style={{ color: th.muted }}>Terms of Use</a>{'  ·  '}<a href="/privacy-policy.html" target="_blank" rel="noreferrer" style={{ color: th.muted }}>Privacy Policy</a></p>
      </div>
    </div>);

  if (err && !info) return shell(<FinBanner th={th} tone="error">{err}</FinBanner>);
  if (!info) return shell(<p style={{ textAlign: 'center', color: th.muted }}>Loading…</p>);
  if (info.state === 'sent') return shell(<FinBanner th={th} tone="success">This form was already sent{info.employee ? ` for ${info.employee}` : ''}. Your manager has it.</FinBanner>);
  if (info.state === 'expired') return shell(<FinBanner th={th} tone="warn">This link has expired. Ask your manager to send you a new one.</FinBanner>);
  if (info.state === 'unknown' || !info.mode) return shell(<FinBanner th={th} tone="error">This link isn't valid. Ask your manager for a new one.</FinBanner>);
  if (sent) return shell(<div className="pcg-pop" style={{ ...S.panel, padding: '1.4rem', textAlign: 'center' }}>
    <div style={{ fontSize: '1.3rem', fontWeight: 800 }}>Sent to your manager</div>
    <p style={{ color: th.muted }}>You'll get a text{full.email ? ' and an email' : ''} when it's approved, or if anything needs changing.</p></div>);

  if (info.mode === 'poster' && !who.pass) {
    const q = who.q.trim().toLowerCase();
    const matches = q.length >= 2 ? info.employees.filter(e => e.name.toLowerCase().includes(q)).slice(0, 8) : [];
    const verify = async () => {
      setWho(w => ({ ...w, busy: true, err: null }));
      try {
        const b = await api('', { action: 'verify', s: pc, k: key, employeeId: who.pick.id, badge: who.badge });
        setEmpId(who.pick.id);
        setInfo(x => ({ ...x, balances: b.balances || [] }));
        setF(x => ({ ...x, employeeName: b.employee, position: b.position || x.position || 'Crew Member' }));
        setWho(w => ({ ...w, busy: false, pass: b.pass }));
      } catch (e) { setWho(w => ({ ...w, busy: false, err: e.message })); }
    };
    return shell(<>
      <h1 style={{ ...S.title, textAlign: 'center', marginBottom: '0.2rem' }}>Time Off Request</h1>
      <p style={{ textAlign: 'center', color: th.muted, marginTop: 0 }}>{info.store}</p>
      <div className="pcg-pop" style={{ ...S.panel, padding: '1rem', display: 'grid', gap: '0.9rem' }}>
        {!who.pick ? (<>
          {field('Your name', <input className="fin-input" autoFocus autoComplete="off" value={who.q} onChange={e => setWho(w => ({ ...w, q: e.target.value, err: null }))} placeholder="Start typing your name" style={inp} />,
            who.q.trim().length < 2 ? 'Type at least 2 letters.' : !matches.length ? 'No one by that name at this store. Ask your manager.' : null)}
          {matches.map(e => <button key={e.id} type="button" className="fin-btn" onClick={() => setWho(w => ({ ...w, pick: e, badge: '', err: null }))}
            style={{ ...S.ghost, minHeight: 46, justifyContent: 'flex-start', textAlign: 'left', fontSize: '1rem' }}>{e.name}</button>)}
        </>) : (<>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
            <b style={{ fontSize: '1.05rem' }}>{who.pick.name}</b>
            <button type="button" className="fin-btn" onClick={() => setWho(w => ({ ...w, pick: null, badge: '', err: null }))} style={{ ...S.link, color: O }}>Not you?</button>
          </div>
          {field('Your badge ID', <input className="fin-input" autoFocus inputMode="numeric" autoComplete="off" value={who.badge} onChange={e => setWho(w => ({ ...w, badge: e.target.value, err: null }))}
            onKeyDown={e => { if (e.key === 'Enter' && who.badge.trim()) verify(); }} placeholder="The number you clock in with" style={inp} />, 'The number you clock in with. It is only checked, never shown.')}
          {who.err && <FinBanner th={th} tone="error">{who.err}</FinBanner>}
          <button type="button" className="fin-btn" disabled={!who.badge.trim() || who.busy} onClick={verify}
            style={{ ...S.primary, minHeight: 48, opacity: who.badge.trim() && !who.busy ? 1 : 0.5 }}>{who.busy ? 'Checking…' : 'Continue'}</button>
        </>)}
      </div>
    </>);
  }

  return shell(<>
    <h1 style={{ ...S.title, textAlign: 'center', marginBottom: '0.2rem' }}>Time Off Request</h1>
    <p style={{ textAlign: 'center', color: th.muted, marginTop: 0 }}>For <b style={{ color: th.text }}>{info.mode === 'link' ? info.employee : f.employeeName}</b>, {info.store}</p>
    <div style={{ ...S.panel, padding: '1rem', display: 'grid', gap: '0.9rem' }}>
      {field('Job position', <select className="fin-input" value={f.position || ''} onChange={set('position')} style={inp}>{CREW_POSITIONS.map(p => <option key={p}>{p}</option>)}</select>)}
      {field('Your cell number', <input className="fin-input" type="tel" autoComplete="tel" value={f.phone || ''} onChange={set('phone')} style={inp} />, "We'll text you when it's approved.")}
      {field('Your email (optional)', <input className="fin-input" type="email" autoComplete="email" value={f.email || ''} onChange={set('email')} style={inp} />)}
      {field('Your address (optional)', <input className="fin-input" autoComplete="street-address" value={f.address || ''} onChange={set('address')} style={inp} />)}

      <div style={{ fontWeight: 800, marginTop: '0.4rem' }}>Time off</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.7rem' }}>
        {field('Start date', <input className="fin-input" type="date" value={f.startDate || ''} onChange={set('startDate')} style={inp} />)}
        {field('Start time', <input className="fin-input" type="time" value={f.startTime || ''} onChange={set('startTime')} style={inp} />)}
        {field('Back to work', <input className="fin-input" type="date" value={f.returnDate || ''} onChange={set('returnDate')} style={inp} />)}
        {field('Back at (time)', <input className="fin-input" type="time" value={f.returnTime || ''} onChange={set('returnTime')} style={inp} />)}
        {field('Total hours', <input className="fin-input" type="number" inputMode="decimal" min="0" step="0.25" value={f.totalHours ?? ''} onChange={set('totalHours')} style={inp} />)}
        {field('Last day worked', <input className="fin-input" type="date" value={f.lastWorked || ''} onChange={set('lastWorked')} style={inp} />)}
      </div>
      {field('Type of leave', <select className="fin-input" value={f.leaveType || ''} onChange={set('leaveType')} style={inp}><option value="">Pick one</option>{CREW_LEAVE_TYPES.map(t => <option key={t}>{t}</option>)}</select>,
        bal ? <span style={{ color: over ? '#dc2626' : '#16a34a', fontWeight: 700 }}>{bal.type}: {fmtH(bal.current)} h available in Paycor{over ? ` (you asked for ${fmtH(full.totalHours)} h)` : ''}</span> : null)}
      {f.leaveType === 'Other' && field('What kind?', <input className="fin-input" value={f.leaveOther || ''} onChange={set('leaveOther')} style={inp} />)}

      <div style={{ fontWeight: 800, marginTop: '0.4rem' }}>Emergency contact</div>
      {field('Name and relation', <input className="fin-input" value={f.ecName || ''} onChange={set('ecName')} placeholder="e.g. Maria Doe, mother" style={inp} />)}
      {field('Their phone', <input className="fin-input" type="tel" value={f.ecPhone || ''} onChange={set('ecPhone')} style={inp} />)}
      {field('Their email (optional)', <input className="fin-input" type="email" value={f.ecEmail || ''} onChange={set('ecEmail')} style={inp} />)}
      <div style={{ display: 'grid', gap: '0.35rem', fontSize: '0.92rem' }}>
        <b>May PCG talk to them about your leave if needed?</b>
        <div style={{ display: 'flex', gap: '0.6rem' }}>{[['Yes', true], ['No', false]].map(([l, val]) => (
          <button key={l} type="button" className="fin-btn" onClick={() => setF(x => ({ ...x, ecAuthorized: val }))}
            style={{ ...S.ghost, minHeight: 42, flex: 1, background: f.ecAuthorized === val ? O : th.card3, color: f.ecAuthorized === val ? '#fff' : th.text, borderColor: f.ecAuthorized === val ? O : th.cardBorder }}>{l}</button>))}</div>
      </div>

      <div style={{ fontWeight: 800, marginTop: '0.4rem' }}>Documents (optional)</div>
      <input type="file" accept="image/*,application/pdf" multiple disabled={docs.length >= MAX_DOCS} onChange={e => { addDocs(e.target.files); e.target.value = ''; }} />
      {docs.map((d, i) => <span key={i} style={{ fontSize: '0.85rem' }}>{d.name} <button type="button" className="fin-btn" onClick={() => setDocs(x => x.filter((_, j) => j !== i))} style={{ ...S.link, color: '#dc2626' }}>remove</button></span>)}

      <label style={{ display: 'flex', gap: '0.55rem', alignItems: 'flex-start', fontSize: '0.88rem', marginTop: '0.4rem' }}>
        <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} style={{ accentColor: O, width: 20, height: 20, marginTop: 2, flexShrink: 0 }} />
        I agree to sign this request electronically, and that what I wrote is true.
      </label>
      <div style={{ display: 'grid', gap: '0.35rem' }}>
        <b style={{ fontSize: '0.92rem' }}>Your signature</b>
        <span style={{ borderBottom: '1px solid #111', minHeight: '2.6em', display: 'flex', alignItems: 'flex-end' }}>
          {sigOk ? <img src={sigOk.image} alt="Your signature" onClick={() => setSig(null)} style={{ maxHeight: '2.5em', maxWidth: '100%', cursor: 'pointer' }} />
            : <InlineSign th={th} can={canSign} blockedText={!consent && !missingCrewFields({ ...full, signature: 'x' }).length ? 'Tick the box above first' : 'Fill in the form first'} label="Your" onSign={(image) => setSig({ image, fp })} />}
        </span>
        {sigOk && <span style={{ color: th.muted, fontSize: '0.78rem' }}>Tap your signature to sign again.</span>}
      </div>

      {problem && <FinBanner th={th} tone="warn">{problem}</FinBanner>}
      {err && <FinBanner th={th} tone="error">{err}</FinBanner>}
      {!sigOk && missing.length > 0 && missing.length < 6 && <span style={{ color: th.muted, fontSize: '0.82rem' }}>Still needed: {missing.join(', ')}</span>}
      <button type="button" className="fin-btn" disabled={!!missing.length || !!problem || busy} onClick={send}
        style={{ ...S.primary, minHeight: 50, fontSize: '1.05rem', opacity: !missing.length && !problem && !busy ? 1 : 0.5 }}>{busy ? 'Sending…' : 'Send to my manager'}</button>
    </div>
  </>);
}
