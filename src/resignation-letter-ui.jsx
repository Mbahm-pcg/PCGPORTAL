// src/resignation-letter-ui.jsx — Tools · Resignation Letter (v22.87).
//
// The screen IS HR's Resignation Letter on PCG letterhead, ready to fill. Pick the employee (name,
// position, PC# from Paycor, locked); the store address is filled from the store list (editable);
// enter the last day. The employee signs here, or from an emailed link when they aren't there; the
// supervisor signs "Acknowledged by". No approval: once the employee has signed it's filed in Google
// Drive (store → employee) and HR is alerted (resignation-letter.mjs). A signature is void if the
// letter changes after it. Everyone sees their own letters; exec / IT / office see all.
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FIN_CSS, FinBanner, finStyles } from './finance-ui.jsx';
import { SignatureModal, toB64, deliverPdf, PdfOpenButton } from './transfer-notice-ui.jsx';
import { FormModal } from './pay-increase-ui.jsx';
import { SignProgress } from './sign-progress-ui.jsx';
import { buildResignationPdf, RES_FONT, RES_CHROME } from './resignation-letter-pdf.mjs';
import { resignationValues, resignationFingerprint, missingResignationFields, usDate } from './resignation-letter.mjs';

const { useState, useEffect } = React;
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const FN = '/.netlify/functions/resignation-letter';

const call = async (body) => {
  const res = await fetch(FN, { method: body ? 'POST' : 'GET', credentials: 'include', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeader() }, body: body ? JSON.stringify(body) : undefined });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
  return b;
};

let assetsPromise = null;
const fetchB64 = (path) => fetch(path).then(r => { if (!r.ok) throw new Error('load ' + path); return r.arrayBuffer(); }).then(toB64);
const loadAssets = () => assetsPromise || (assetsPromise = Promise.all([fetchB64('/fonts/' + RES_FONT.regular), fetchB64('/fonts/' + RES_FONT.bold), fetchB64('/' + RES_CHROME.watermark.src), fetchB64('/' + RES_CHROME.logo.src)])
  .then(([regular, bold, seal, logo]) => ({ fonts: { regular, bold }, watermark: 'data:image/png;base64,' + seal, logo: 'data:image/jpeg;base64,' + logo }))
  .catch(e => { assetsPromise = null; throw e; }));

const INK = '#111', FILL = '#fdf3ea';
const CSS = `
@font-face { font-family: 'Caladea'; src: url('/fonts/Caladea-Regular.ttf') format('truetype'); font-weight: 400; font-display: swap; }
@font-face { font-family: 'Caladea'; src: url('/fonts/Caladea-Bold.ttf') format('truetype'); font-weight: 700; font-display: swap; }
.rl-paper { font-family: 'Caladea', Cambria, Georgia, serif; color: ${INK}; background: #fff; }
.rl-paper p { margin: 0; }
.rl-blank { font: inherit; color: ${INK}; border: none; border-bottom: 1px solid ${INK}; border-radius: 0; background: ${FILL}; padding: 0 0.3em; min-height: 1.4em; line-height: 1.4; text-align: center; -webkit-appearance: none; appearance: none; max-width: 100%; }
.rl-blank::placeholder { color: #9a8f86; font-style: italic; }
.rl-locked { display: inline-block; border-bottom: 1px solid ${INK}; padding: 0 0.3em; text-align: center; line-height: 1.4; min-width: 8em; }
.rl-locked.rl-empty { color: #9a8f86; font-style: italic; }
.rl-when { color: #9a8f86; font-style: italic; font-size: 0.85em; }
.rl-sig { display: grid; grid-template-columns: minmax(0, 22em) minmax(0, 8em); gap: 0.4em 2.4em; align-items: end; margin-top: 1.6em; }
.rl-line { border-bottom: 1px solid ${INK}; min-height: 2.5em; display: flex; align-items: flex-end; }
.rl-cap { font-size: 0.92em; }
.rl-sigbtn { white-space: nowrap; font: inherit; font-family: ${FONTS.body}; font-size: 0.8rem; color: ${O}; font-weight: 700; background: ${FILL}; border: 1px dashed ${O}; border-radius: 6px; padding: 0.25rem 0.65rem; margin: 0 0 0.2rem 0.2rem; cursor: pointer; }
.rl-sigimg { background: none; border: none; padding: 0; cursor: pointer; display: flex; align-items: flex-end; }
.rl-check { display: inline-flex; align-items: center; gap: 0.35em; cursor: pointer; font-family: ${FONTS.body}; font-size: 0.82rem; }
.rl-check input { width: 1.05em; height: 1.05em; accent-color: ${O}; cursor: pointer; }
.rl-blank:focus-visible, .rl-sigbtn:focus-visible, .rl-sigimg:focus-visible, .rl-check input:focus-visible { outline: 2px solid ${O}; outline-offset: 1px; }`;

const Locked = ({ value, placeholder = 'from Paycor', w }) => <span className={`rl-locked${value ? '' : ' rl-empty'}`} style={w ? { minWidth: w } : undefined} title="From Paycor — can't be changed here">{value || placeholder}</span>;

export function ResignationLetter({ th, isMobile, onBack, storeAddresses = {} }) {
  const S = finStyles(th);
  const [stores, setStores] = useState([]);
  const [employees, setEmployees] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [picked, setPicked] = useState(null);
  const [storeAddress, setStoreAddress] = useState('');
  const [lastDay, setLastDay] = useState('');
  const [date] = useState(todayIso());
  const [supervisorName, setSupervisorName] = useState('');
  const [supervisorTitle, setSupervisorTitle] = useState('');
  const [remote, setRemoteState] = useState({ on: false, phone: '', email: '' });
  const setRemote = (patch) => setRemoteState(r => ({ ...r, ...patch }));
  const [sigs, setSigs] = useState({});
  const [signing, setSigning] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [lists, setLists] = useState({ waiting: [], complete: [] });
  const [seeAll, setSeeAll] = useState(false);
  const [view, setView] = useState('list');
  const [listTab, setListTab] = useState('waiting');
  const [viewing, setViewing] = useState(null);
  const [msg, setMsg] = useState(null);
  const [rowBusy, setRowBusy] = useState(null);

  const loadMain = () => call().then(b => {
    setStores(b.stores || []); setEmployees(b.employees || []);
    setSupervisorName(s => s || b.myName || ''); setSupervisorTitle(s => s || b.myTitle || '');
    if (b.rosterError) setError(b.rosterError);
    setSeeAll(!!b.seeAll); setLists({ waiting: b.waiting || [], complete: b.complete || [] });
  }).catch(e => { setError(e.message); setEmployees([]); });
  useEffect(() => { loadMain(); }, []);
  // v22.99: keep the lists current — a signature from an emailed link (another device) or someone
  // else's approval used to show only after a manual reload. Refresh on coming back to the tab and
  // every minute while the list is on screen (not while a form is open).
  const viewRef = React.useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const tick = () => { if (!document.hidden && viewRef.current === 'list') loadMain(); };
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', tick);
    const t = setInterval(tick, 60000);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', tick); clearInterval(t); };
  }, []);

  const storeName = (pc) => stores.find(s => s.pc === String(pc))?.name || '';
  const form = { employee: picked, pc: picked?.pc, storeAddress, lastDay, date, supervisorName, supervisorTitle };
  const base = resignationValues(form);
  const fp = resignationFingerprint(base);
  const sigOk = (k) => (sigs[k] && sigs[k].fp === fp ? sigs[k] : null);
  const voided = Object.keys(sigs).some(k => sigs[k] && sigs[k].fp !== fp);
  const values = resignationValues({ ...form, employeeSig: sigOk('employee'), supervisorSig: sigOk('supervisor') });
  const canSign = !missingResignationFields({ ...base, supervisorSignature: 'x' }).length;
  const remoteOn = remote.on && !sigOk('employee');
  const phoneOk = (p) => { const d = p.replace(/\D/g, ''); return d.length === 10 || (d.length === 11 && d[0] === '1'); };
  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
  const missing = [...missingResignationFields(values),
    ...(!values.employeeSignature && !remoteOn ? ['Employee signature (or email them a link)'] : []),
    ...(remoteOn && !emailOk(remote.email) ? ["Employee's email for the signing link"] : []),
    ...(remoteOn && !phoneOk(remote.phone) ? ["Employee's cell number"] : [])];
  const ready = !missing.length && !busy;
  useEffect(() => { setSaved(null); }, [fp]);

  const q = query.trim().toLowerCase();
  const matches = q && employees ? employees.filter(e => e.name.toLowerCase().includes(q) || storeName(e.pc).toLowerCase().includes(q) || e.pc.includes(q)).slice(0, 40) : [];
  const pick = (e) => { setPicked(e); setQuery(e.name); setListOpen(false); setStoreAddress(storeAddresses[String(e.pc)] || ''); };

  const reset = () => { setPicked(null); setQuery(''); setStoreAddress(''); setLastDay(''); setSigs({}); setRemoteState({ on: false, phone: '', email: '' }); setSaved(null); };

  const send = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (!JsPDF) throw new Error('PDF library did not load — refresh the page.');
      const assets = await loadAssets();
      const doc = buildResignationPdf(JsPDF, assets.fonts, values, { watermark: assets.watermark, logo: assets.logo });
      const fileName = `Resignation-Letter-${values.employeeName.replace(/[^A-Za-z0-9]+/g, '-')}-${date}.pdf`;
      setSaved({ state: 'saving' });
      try {
        const b = await call({ values, employeeId: picked.id, pdf: doc.output('datauristring'), remoteSign: remoteOn ? { phone: remote.phone, email: remote.email.trim() } : null });
        setSaved({ state: 'done', ...b, pdfUrl: deliverPdf(doc, fileName) }); loadMain();
      } catch (e) { setSaved({ state: 'failed', error: e.message, pdfUrl: deliverPdf(doc, fileName) }); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const savedLine = () => {
    if (!saved) return null;
    if (saved.state === 'saving') return <span style={{ color: th.muted }}>Saving and sending…</span>;
    if (saved.state === 'failed') return <span style={{ color: '#dc2626' }}>Not saved: {saved.error}. Press the button again to retry.</span>;
    if (saved.status === 'signed') {
      const d = saved.drive || {}, a = saved.alert || {};
      return <span style={{ color: d.saved ? '#16a34a' : '#d97706' }}>{d.saved ? 'Signed and filed in Google Drive' : `Signed, but not filed in Google Drive yet (${d.error || 'error'}). Retry it from Complete`}{a.recipients ? '; HR was alerted.' : '.'}</span>;
    }
    const s = saved.sign || {};
    return <span style={{ color: s.sent ? (s.textNote ? '#d97706' : '#16a34a') : '#dc2626' }}>
      {s.error ? `Saved, but the signing link was not sent: ${s.error}. Use Resend link under Waiting on signature.`
        : s.already ? 'The signing link was just sent.'
        : s.sent ? `Saved. Signing link emailed to ${picked?.name || 'the employee'} (${s.email})${s.texted ? `, with a reminder text to ${s.phone}` : ''}. It expires ${new Date(s.expiresAt).toLocaleDateString('en-US')}. Once they sign it's filed and you're told.${s.textNote ? ` ${s.textNote}.` : ''}`
        : 'Saved, but the signing email did not go through. Use Resend link under Waiting on signature.'}
    </span>;
  };

  const rowAction = async (item, action, extra = {}) => {
    setRowBusy(item.id); setMsg(null);
    try {
      const b = await call({ action, id: item.id, ...extra });
      if (action === 'resendLink') setMsg({ tone: b.sign?.sent ? 'success' : 'error', text: b.sign?.sent ? `New signing link emailed to ${extra.email || item.employeeName}${b.sign.texted ? ', with a reminder text' : ''}. The old link no longer works.` : 'The signing email did not go through.' });
      else setMsg({ tone: b.ok ? 'success' : 'error', text: b.ok ? `Filed ${item.employeeName}'s letter in Google Drive.` : `Still could not file it: ${b.drive?.error || 'error'}.` });
      loadMain();
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    setRowBusy(null);
  };

  if (employees === null && !error) return <div className="fin-root" style={{ maxWidth: 940, margin: '0 auto' }}><style>{FIN_CSS(th)}</style><h2 style={S.title}>Resignation Letter</h2><p style={{ color: th.muted }}>Loading…</p></div>;

  // ── list: Waiting on signature · Complete ──
  if (view === 'list') {
    const day = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', textAlign: 'left', padding: '0.75rem 0.95rem', borderRadius: 12, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, fontFamily: FONTS.body };
    const who = (f) => <><strong>{f.employeeName}</strong> <span style={{ color: th.muted }}>{f.storeName}{f.position ? `, ${f.position}` : ''}</span></>;
    const items = listTab === 'waiting' ? lists.waiting : lists.complete;
    return (
      <div className="fin-root" style={{ maxWidth: 940, margin: '0 auto' }}>
        <style>{FIN_CSS(th) + CSS}</style>
        {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
        <h2 style={S.title}>Resignation Letter</h2>
        <p style={S.lede}>HR's resignation letter, filled in from Paycor. The employee signs here or from an emailed link, you sign as acknowledged, and it's filed in Google Drive under their store and name. {seeAll ? 'You see every letter.' : 'You see the letters you sent.'}</p>
        {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
        {msg && <FinBanner th={th} tone={msg.tone}>{msg.text}</FinBanner>}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <div role="tablist" aria-label="Resignation letters" style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {[['waiting', `Waiting on signature${lists.waiting.length ? ` (${lists.waiting.length})` : ''}`], ['complete', 'Complete']].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={listTab === k} className="fin-btn" onClick={() => setListTab(k)}
                style={{ ...S.ghost, minHeight: 36, padding: '0.4rem 0.95rem', background: listTab === k ? O : th.card3, color: listTab === k ? '#fff' : th.text }}>{label}</button>
            ))}
          </div>
          <button type="button" className="fin-btn" style={S.primary} onClick={() => { reset(); setMsg(null); setView('form'); }}>Start a resignation letter</button>
        </div>
        {items.length ? (
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {items.map(f => (
              <div key={f.id} style={rowStyle}>
                <span style={{ minWidth: 0 }}>{who(f)}<span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>
                  Last day {usDate(f.lastDay)}. {seeAll ? `From ${f.submittedBy}, ` : 'Sent '}{day(f.createdAt)}{listTab === 'waiting' ? ': waiting on the employee to sign from their email link' : f.driveError && !f.driveLink ? ': signed, NOT filed in Google Drive yet' : f.signedAt ? `: signed ${day(f.signedAt)}` : ''}</span>
                  {listTab === 'waiting' && <SignProgress th={th} signing={f.signing} busy={rowBusy === f.id} onFix={(role, email) => rowAction(f, 'resendLink', { email })} />}</span>
                <span style={{ display: 'flex', gap: '0.9rem', alignItems: 'center', fontSize: '0.85rem', fontWeight: 700 }}>
                  {f.hasPdf && <button type="button" className="fin-btn" onClick={() => setViewing(f)} style={{ ...S.link, color: O }}>View</button>}
                  {listTab === 'waiting' && <button type="button" className="fin-btn" disabled={rowBusy === f.id} onClick={() => rowAction(f, 'resendLink')} style={{ ...S.link, color: O }}>{rowBusy === f.id ? 'Sending…' : 'Resend link'}</button>}
                  {listTab === 'complete' && f.driveLink && <a href={f.driveLink} target="_blank" rel="noreferrer" style={{ color: O }}>Open in Google Drive</a>}
                  {listTab === 'complete' && !f.driveLink && <button type="button" className="fin-btn" disabled={rowBusy === f.id} onClick={() => rowAction(f, 'refile')} style={{ ...S.link, color: O }}>{rowBusy === f.id ? 'Filing…' : 'Retry filing'}</button>}
                </span>
              </div>
            ))}
          </div>
        ) : <p style={{ color: th.muted, fontSize: '0.9rem' }}>{listTab === 'waiting' ? 'Nothing waiting on a signature.' : 'No signed resignation letters yet.'}</p>}
        {viewing && <FormModal th={th} id={`${FN}?pdf=${viewing.id}`} title={`Resignation letter for ${viewing.employeeName}`} onClose={() => setViewing(null)} />}
      </div>
    );
  }

  const empSearch = (
    <span style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
      <input className="rl-blank" style={{ width: isMobile ? '14em' : '16em' }} value={query} role="combobox" aria-expanded={listOpen && matches.length > 0} aria-controls="rl-emp-list" autoComplete="off"
        aria-label="Employee name" placeholder={employees ? 'Search employee name' : 'Loading from Paycor…'} disabled={!employees}
        onChange={e => { setQuery(e.target.value); setListOpen(true); if (picked) setPicked(null); }}
        onFocus={() => setListOpen(true)} onBlur={() => setTimeout(() => setListOpen(false), 150)}
        onKeyDown={e => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); pick(matches[0]); } if (e.key === 'Escape') setListOpen(false); }} />
      {listOpen && matches.length > 0 && (
        <span id="rl-emp-list" role="listbox" style={{ position: 'absolute', zIndex: 30, left: 0, top: '100%', marginTop: 4, width: 'min(420px, 82vw)', maxHeight: 300, overflowY: 'auto', background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 12, boxShadow: '0 10px 30px rgba(0,0,0,0.15)', textAlign: 'left' }}>
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

  const sigLine = (key, label) => {
    const s = sigOk(key);
    if (key === 'employee' && remoteOn) return <span style={{ paddingBottom: '0.2em', paddingLeft: '0.4em', color: '#6b6158', fontStyle: 'italic' }}>Will sign by email link</span>;
    if (s) return <button type="button" className="rl-sigimg" onClick={() => setSigning(key)} title="Sign again"><img src={s.image} alt={`${label} signature`} style={{ maxHeight: '2.3em', maxWidth: '12em', objectFit: 'contain' }} /></button>;
    return <button type="button" className="rl-sigbtn" disabled={!canSign} onClick={() => setSigning(key)} style={{ opacity: canSign ? 1 : 0.45, cursor: canSign ? 'pointer' : 'not-allowed' }}>{canSign ? `Tap to sign — ${label}` : 'Fill in the letter first'}</button>;
  };

  return (
    <div className="fin-root" style={{ maxWidth: 820, margin: '0 auto' }}>
      <style>{FIN_CSS(th) + CSS}</style>
      <button type="button" className="fin-btn" onClick={() => { setView('list'); loadMain(); }} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Resignation Letters</button>
      <h2 style={S.title}>Resignation Letter</h2>
      <p style={S.lede}>Pick the employee (their position and PC# come from Paycor), check the store address and enter their last day. They sign here, or from an emailed link if they aren't there, and you sign as acknowledged. Once they've signed it's filed in Google Drive.</p>
      {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
      {voided && <FinBanner th={th} tone="warn">The letter changed after it was signed, so those signatures no longer count. Sign again.</FinBanner>}
      {employees && !employees.length && !error && <FinBanner th={th} tone="warn">There's no one you can pick yet. If you're a Store Manager, ask IT to link your account to your store.</FinBanner>}
      <div style={{ ...S.panel, padding: '0.9rem 1.1rem', marginBottom: '1rem', overflow: 'visible' }}>
        <label style={S.fieldLabel}>Employee who is resigning (from Paycor)<span className="rl-paper" style={{ background: 'transparent', fontSize: '0.95rem' }}>{empSearch}</span>
          {picked && <span style={{ color: th.text }}>{picked.name}{picked.jobTitle ? `, ${picked.jobTitle}` : ''} at {storeName(picked.pc)} (PC {picked.pc})</span>}</label>
      </div>

      <div className="rl-paper" style={{ borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 12px 32px rgba(0,0,0,0.08)', padding: isMobile ? '1.2rem 1rem 1.6rem' : '2rem 3.2rem 2.6rem', fontSize: isMobile ? '14.5px' : '15.5px', lineHeight: 1.6, marginBottom: '1.2rem',
        backgroundImage: `url('/${RES_CHROME.watermark.src}')`, backgroundRepeat: 'no-repeat', backgroundPosition: 'center 45%', backgroundSize: '72%' }}>
        <img src={`/${RES_CHROME.logo.src}`} alt="People Capital Group" style={{ display: 'block', height: 64, margin: '0 auto 1.4em' }} />
        <p>People Capital Group LLC</p>
        <p>Human Resources Department</p>
        <p>2200 Michener St STE 4 Philadelphia, PA 19115</p>
        <p style={{ margin: '1.6em 0 1.2em' }}>Dear HR Administrator:</p>
        <p style={{ lineHeight: 2.1 }}>
          Please accept this letter as a formal notification that I am voluntarily resigning from my position as a Dunkin' Donuts{' '}
          <Locked value={picked?.jobTitle || ''} placeholder="position" /> (position) at PC# <Locked value={picked?.pc || ''} w="5.5em" />, located at{' '}
          <input className="rl-blank" style={{ width: isMobile ? '100%' : '24em' }} value={storeAddress} maxLength={160} onChange={e => setStoreAddress(e.target.value)} placeholder="store address" aria-label="Store address" />{' '}
          (store address). I understand that two weeks' notice is standard. I would appreciate it if you release me from my employment with the Company effective{' '}
          <input type="date" className="rl-blank" style={{ width: '9.5em' }} value={lastDay} onChange={e => setLastDay(e.target.value)} aria-label="Last day of employment" /> (last day of employment).
        </p>
        <p style={{ marginTop: '1.6em' }}>Sincerely,</p>
        <div className="rl-sig">
          <span className="rl-line">{sigLine('employee', 'Employee')}</span>
          <span className="rl-line" style={{ justifyContent: 'center', paddingBottom: '0.15em' }}>{sigOk('employee') ? usDate(sigOk('employee').date) : <span className="rl-when">{remoteOn ? 'when they sign' : 'on signing'}</span>}</span>
          <span className="rl-cap">(Signature)</span><span className="rl-cap">(Date)</span>
        </div>
        <div style={{ marginTop: '0.9em', maxWidth: '18em' }}><div className="rl-line" style={{ minHeight: '1.8em', paddingLeft: '0.3em' }}>{picked?.name || <span style={{ color: '#9a8f86', fontStyle: 'italic' }}>pick the employee above</span>}</div><span className="rl-cap">(Print Name)</span></div>
        {!sigOk('employee') && (
          <div style={{ marginTop: '0.7em', fontFamily: FONTS.body, fontSize: '0.85rem' }}>
            <label className="rl-check"><input type="checkbox" checked={remote.on} onChange={e => setRemote({ on: e.target.checked })} /> Employee isn't here: email them a link to sign</label>
            {remote.on && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5em 1.2em', marginTop: '0.4em', alignItems: 'flex-end' }}>
                <label style={{ display: 'inline-flex', gap: '0.35em', alignItems: 'flex-end' }}><b>Employee email:</b><input className="rl-blank" type="email" inputMode="email" autoComplete="off" style={{ width: '13em', ...(remote.email && !emailOk(remote.email) ? { boxShadow: 'inset 0 -2px 0 #dc2626' } : {}) }} value={remote.email} maxLength={120} onChange={e => setRemote({ email: e.target.value })} /></label>
                <label style={{ display: 'inline-flex', gap: '0.35em', alignItems: 'flex-end' }}><b>Employee cell:</b><input className="rl-blank" type="tel" inputMode="tel" autoComplete="off" style={{ width: '9.5em', ...(remote.phone && !phoneOk(remote.phone) ? { boxShadow: 'inset 0 -2px 0 #dc2626' } : {}) }} value={remote.phone} maxLength={20} placeholder="(215) 555-0100" onChange={e => setRemote({ phone: e.target.value })} /></label>
                <span style={{ color: '#6b6158', flexBasis: '100%' }}>On "Save & send" they're emailed a private link (expires in 3 days) and get a text telling them to check their email. They confirm the last 4 digits of this cell number, read the letter and sign; then it's filed and you're told.</span>
              </div>
            )}
          </div>
        )}

        <p style={{ marginTop: '2em' }}>Acknowledged by:</p>
        <div className="rl-sig" style={{ marginTop: '0.6em' }}>
          <span className="rl-line" style={{ justifyContent: 'space-between' }}>{sigLine('supervisor', 'Supervisor')}<span style={{ paddingBottom: '0.15em', fontSize: '0.85em' }}>/ <input className="rl-blank" style={{ width: '11.5em', fontSize: '1em' }} value={supervisorTitle} maxLength={60} onChange={e => setSupervisorTitle(e.target.value)} placeholder="your title" aria-label="Supervisor title" /></span></span>
          <span className="rl-line" style={{ justifyContent: 'center', paddingBottom: '0.15em' }}>{sigOk('supervisor') ? usDate(sigOk('supervisor').date) : <span className="rl-when">on signing</span>}</span>
          <span className="rl-cap">(Supervisor Signature / Title)</span><span className="rl-cap">(Date)</span>
        </div>
        <div style={{ marginTop: '0.9em', maxWidth: '18em' }}><input className="rl-blank" style={{ width: '100%', textAlign: 'left', background: FILL }} value={supervisorName} maxLength={80} onChange={e => setSupervisorName(e.target.value)} aria-label="Supervisor print name" /><span className="rl-cap">(Supervisor - Print Name)</span></div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.9rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
        {!ready && missing.length > 0 && <span style={{ color: th.muted, fontSize: '0.82rem' }}>Still needed: {missing.join(', ')}</span>}
        <button type="button" className="fin-btn" style={{ ...S.primary, opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed' }} disabled={!ready} onClick={send}>{busy ? 'Saving…' : 'Save & send'}</button>
      </div>
      {saved && <div style={{ textAlign: 'right', fontSize: '0.85rem', marginBottom: '2rem' }}>{savedLine()}{saved.pdfUrl && <div style={{ marginTop: '0.6rem' }}><PdfOpenButton url={saved.pdfUrl} style={{ ...S.ghost }} /></div>}</div>}

      {signing && (
        <SignatureModal th={th} title={`${signing === 'employee' ? 'Employee' : 'Supervisor'} signature — ${signing === 'employee' ? picked?.name || '' : supervisorName}`} onCancel={() => setSigning(null)}
          onDone={(image) => { setSigs(x => ({ ...x, [signing]: { image, date: todayIso(), fp } })); if (signing === 'employee') setRemote({ on: false }); setSigning(null); }} />
      )}
    </div>
  );
}
