// src/missing-hours-ui.jsx — Tools · Missing Hours (v22.89).
//
// The screen IS HR's "Employee Missing Hours" form with the PCG seal behind it. Pick the employee
// (name, PC# from Paycor), fill in each missed day (date, clock in, clock out — the hours, total and
// pay period fill themselves in), sign, and send. It goes to the approver (Ella); once approved the
// hours are added to the employee's Paycor payroll grid and you're told (missing-hours.mjs).
// Managers pick from their store, DMs and Directors from their districts (scoped server-side).
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FIN_CSS, FinBanner, finStyles } from './finance-ui.jsx';
import { SignatureModal, toB64, deliverPdf, PdfOpenButton } from './transfer-notice-ui.jsx';
import { FormPreview, FormModal } from './pay-increase-ui.jsx';
import { buildMissingHoursPdf, MH_CHROME } from './missing-hours-pdf.mjs';
import { secondLineLabel } from './pay-increase.mjs';
import { missingHoursValues, missingHoursFingerprint, missingHoursProblems, usDate, fmtHours, MH_MAX_ROWS } from './missing-hours.mjs';

const { useState, useEffect } = React;
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const FN = '/.netlify/functions/missing-hours';
const call = async (body) => {
  const res = await fetch(FN, { method: body ? 'POST' : 'GET', credentials: 'include', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeader() }, body: body ? JSON.stringify(body) : undefined });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
  return b;
};
let sealPromise = null;
const loadSeal = () => sealPromise || (sealPromise = fetch('/' + MH_CHROME.watermark.src).then(r => { if (!r.ok) throw new Error('load seal'); return r.arrayBuffer(); }).then(toB64).then(b => 'data:image/png;base64,' + b).catch(e => { sealPromise = null; throw e; }));

const EMPTY_ROW = () => ({ date: '', clockIn: '', clockOut: '' });
const ROWS0 = () => Array.from({ length: 5 }, EMPTY_ROW);
const CSS = `
.mh-paper { font-family: Calibri, Carlito, 'Segoe UI', Arial, sans-serif; color: #111; background: #fff; }
.mh-paper p { margin: 0; }
.mh-blank { font: inherit; color: #111; border: none; border-bottom: 1px solid #111; border-radius: 0; background: #fdf3ea; padding: 0.1em 0.35em; min-height: 1.6em; -webkit-appearance: none; appearance: none; max-width: 100%; box-sizing: border-box; }
.mh-locked { display: inline-block; border-bottom: 1px solid #111; padding: 0.1em 0.35em; min-width: 12em; font-weight: 700; }
.mh-locked.mh-empty { color: #9a8f86; font-style: italic; font-weight: 400; }
.mh-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.mh-table th, .mh-table td { border: 1px solid #111; text-align: center; padding: 0.25em 0.3em; height: 2em; }
.mh-table th { font-weight: 700; }
.mh-table td input { width: 100%; border: none; background: #fdf3ea; font: inherit; text-align: center; color: #111; padding: 0.15em 0; box-sizing: border-box; }
.mh-x { background: none; border: none; color: #b91c1c; cursor: pointer; font-size: 0.8em; font-weight: 700; padding: 0 0.3em; }
.mh-sigbtn { white-space: nowrap; font: inherit; font-family: ${FONTS.body}; font-size: 0.8rem; color: ${O}; font-weight: 700; background: #fdf3ea; border: 1px dashed ${O}; border-radius: 6px; padding: 0.25rem 0.65rem; margin: 0 0 0.2rem 0.2rem; cursor: pointer; }
.mh-sigimg { background: none; border: none; padding: 0; cursor: pointer; display: flex; align-items: flex-end; }
.mh-blank:focus-visible, .mh-table td input:focus-visible, .mh-sigbtn:focus-visible, .mh-sigimg:focus-visible, .mh-x:focus-visible { outline: 2px solid ${O}; outline-offset: 1px; }`;

function MhReview({ th, isMobile, form, canApprove, onClose }) {
  const S = finStyles(th);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [backing, setBacking] = useState(false);
  const [note, setNote] = useState('');
  const src = `${FN}?pdf=${form.id}`;
  const decide = async (action) => {
    setBusy(true); setErr(null);
    try {
      const b = await call({ action, id: form.id, note: note.trim() });
      if (action === 'reject') return onClose(`Sent back to ${form.submittedBy}.`);
      const p = b.paycor || {}, d = b.drive || {};
      onClose(`Approved. ${p.ok ? `${fmtHours(form.totalHours)} hours were added to ${form.employeeName}'s Paycor payroll grid` : `The hours could NOT be added to Paycor yet (${p.error || 'error'}); use Retry under Complete`}. ${d.saved ? 'Filed in Google Drive.' : `Not filed in Drive (${d.error || 'error'}).`} ${form.submittedBy} was told.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div style={{ ...S.panel, padding: '1rem 1.1rem', marginBottom: '1.4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ ...S.panelTitle, fontSize: '1.05rem' }}>{form.employeeName}, {form.storeName}: {fmtHours(form.totalHours)} hours</div>
        <span style={{ color: th.muted, fontSize: '0.88rem' }}>From {form.submittedBy}, pay period {usDate(form.periodStart)} - {usDate(form.periodEnd)}</span>
      </div>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '0.8rem' }}>
        <FormPreview th={th} id={src} title={`Missing hours for ${form.employeeName}`} thumbWidth={isMobile ? 200 : 260} />
        <p style={{ fontSize: '0.82rem', color: th.muted, margin: 0, maxWidth: '24em' }}>Click the form to see it full size. Approving adds these hours to {form.employeeName}'s Paycor payroll grid (as regular hours, one line per day); payroll still reviews them before submitting.</p>
      </div>
      {err && <FinBanner th={th} tone="error" style={{ marginTop: '0.8rem' }}>{err}</FinBanner>}
      {backing && (
        <div style={{ marginTop: '0.8rem' }}>
          <label htmlFor="mh-note" style={{ display: 'block', fontWeight: 700, marginBottom: '0.3rem', color: th.text }}>Why is it being sent back?</label>
          <textarea id="mh-note" value={note} maxLength={400} rows={3} onChange={e => setNote(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', borderRadius: 8, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, padding: '0.5rem', fontFamily: FONTS.body }} />
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.9rem' }}>
        <button type="button" className="fin-btn" style={S.ghost} onClick={() => onClose(null)} disabled={busy}>Back</button>
        {!canApprove && <span style={{ color: th.muted, fontSize: '0.85rem', alignSelf: 'center' }}>Only the missing hours approver can approve this.</span>}
        {canApprove && (backing
          ? <button type="button" className="fin-btn" style={{ ...S.primary, background: '#b91c1c', opacity: note.trim().length >= 3 && !busy ? 1 : 0.5 }} disabled={note.trim().length < 3 || busy} onClick={() => decide('reject')}>{busy ? 'Sending…' : 'Send back'}</button>
          : <button type="button" className="fin-btn" style={S.ghost} onClick={() => setBacking(true)} disabled={busy}>Send back…</button>)}
        {canApprove && !backing && <button type="button" className="fin-btn" style={S.primary} disabled={busy} onClick={() => decide('approve')}>{busy ? 'Approving and sending to Paycor…' : 'Approve & send to Paycor'}</button>}
      </div>
    </div>
  );
}

export function MissingHours({ th, isMobile, onBack, userType, username }) {
  const S = finStyles(th);
  const [stores, setStores] = useState([]);
  const [employees, setEmployees] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [picked, setPicked] = useState(null);
  const [rows, setRows] = useState(ROWS0);
  const [reason, setReason] = useState('');
  const [signerName, setSignerName] = useState('');
  const [sig, setSig] = useState(null);
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [canApprove, setCanApprove] = useState(false);
  const [seeAll, setSeeAll] = useState(false);
  const [lists, setLists] = useState({ pending: [], sentBack: [], complete: [] });
  const [view, setView] = useState('list');
  const [listTab, setListTab] = useState('pending');
  const [reviewing, setReviewing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [msg, setMsg] = useState(null);
  const [rowBusy, setRowBusy] = useState(null);
  const [fixing, setFixing] = useState(null);
  const today = todayIso();

  const loadMain = () => call().then(b => {
    setStores(b.stores || []); setEmployees(b.employees || []);
    setSignerName(s => s || b.myName || '');
    if (b.rosterError) setError(b.rosterError);
    setCanApprove(!!b.canApprove); setSeeAll(!!b.seeAll);
    setLists({ pending: b.pending || [], sentBack: b.sentBack || [], complete: b.complete || [] });
    let open = null; try { open = sessionStorage.getItem('mh_open'); sessionStorage.removeItem('mh_open'); } catch {}
    const hit = open && (b.pending || []).find(x => String(x.id) === String(open));
    if (hit) { setView('list'); setListTab('pending'); setReviewing(hit); }
  }).catch(e => { setError(e.message); setEmployees([]); });
  useEffect(() => { loadMain(); }, []);

  const storeName = (pc) => stores.find(s => s.pc === String(pc))?.name || '';
  const form = { employee: picked, pc: picked?.pc, rows, reason, signerName, date: today };
  const base = missingHoursValues(form);
  const fp = missingHoursFingerprint(base);
  const sigOk = sig && sig.fp === fp ? sig : null;
  const voided = !!sig && !sigOk;
  const values = missingHoursValues({ ...form, sig: sigOk });
  const formProblems = missingHoursProblems({ ...base, signature: 'x' }, today);
  const canSign = !formProblems.length;
  const problems = missingHoursProblems(values, today);
  const ready = !problems.length && !busy;
  useEffect(() => { setSaved(null); }, [fp]);
  // Titled by who signs it, like the Pay Increase form (user, 2026-11-11).
  const signTitle = userType === 'manager' ? 'Store Manager' : userType === 'it' ? 'HR / IT Administrator' : secondLineLabel(userType, username);
  const signLabel = `${signTitle} Signature:`;

  const q = query.trim().toLowerCase();
  const matches = q && employees ? employees.filter(e => e.name.toLowerCase().includes(q) || storeName(e.pc).toLowerCase().includes(q) || e.pc.includes(q)).slice(0, 40) : [];
  const pick = (e) => { setPicked(e); setQuery(e.name); setListOpen(false); };
  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const reset = () => { setPicked(null); setQuery(''); setRows(ROWS0()); setReason(''); setSig(null); setSaved(null); setFixing(null); };

  const send = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (!JsPDF) throw new Error('PDF library did not load — refresh the page.');
      const doc = buildMissingHoursPdf(JsPDF, values, { watermark: await loadSeal(), signLabel });
      const fileName = `Missing-Hours-${values.employeeName.replace(/[^A-Za-z0-9]+/g, '-')}-${today}.pdf`;
      setSaved({ state: 'saving' });
      try {
        const b = await call({ values, employeeId: picked.id, pdf: doc.output('datauristring'), replaces: fixing?.id });
        setSaved({ state: 'done', ...b, pdfUrl: deliverPdf(doc, fileName) }); setFixing(null); loadMain();
      } catch (e) { setSaved({ state: 'failed', error: e.message, pdfUrl: deliverPdf(doc, fileName) }); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const fix = (item) => {
    const fv = item.formValues || {};
    reset();
    setPicked({ id: item.employeeId, name: fv.employeeName || item.employeeName, jobTitle: fv.jobTitle || item.jobTitle || '', pc: fv.pc || item.pc });
    setQuery(fv.employeeName || item.employeeName);
    const rs = (fv.rows || []).map(r => ({ date: r.date, clockIn: r.clockIn, clockOut: r.clockOut }));
    setRows(rs.length >= 5 ? rs : [...rs, ...Array.from({ length: 5 - rs.length }, EMPTY_ROW)]);
    setReason(fv.reason || ''); setFixing(item); setView('form');
  };
  const rowAction = async (item, action, okText) => {
    if (action === 'delete' && !window.confirm(`Delete the sent-back missing hours for ${item.employeeName}?`)) return;
    setRowBusy(item.id); setMsg(null);
    try {
      const b = await call({ action, id: item.id });
      setMsg({ tone: b.ok === false ? 'error' : 'success', text: b.ok === false ? `Still could not add the hours to Paycor: ${b.paycor?.error || 'error'}.` : okText });
      loadMain();
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    setRowBusy(null);
  };

  if (employees === null && !error) return <div className="fin-root" style={{ maxWidth: 940, margin: '0 auto' }}><style>{FIN_CSS(th)}</style><h2 style={S.title}>Missing Hours</h2><p style={{ color: th.muted }}>Loading…</p></div>;

  if (view === 'list') {
    const day = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', textAlign: 'left', padding: '0.75rem 0.95rem', borderRadius: 12, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, fontFamily: FONTS.body };
    const who = (f) => <><strong>{f.employeeName}</strong> <span style={{ color: th.muted }}>{f.storeName}: {fmtHours(f.totalHours)} h over {f.days} day{f.days === 1 ? '' : 's'}</span></>;
    const sub = (f, extra) => <span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2 }}>Pay period {usDate(f.periodStart)} - {usDate(f.periodEnd)}. {seeAll || !f.mine ? `From ${f.submittedBy}, ` : 'Sent '}{day(f.createdAt)}{extra}</span>;
    const tabs = [['pending', `Pending approval${lists.pending.length ? ` (${lists.pending.length})` : ''}`], ['sentback', `Sent back${lists.sentBack.length ? ` (${lists.sentBack.length})` : ''}`], ['complete', 'Complete']];
    const link = ({ danger, ...props }, text) => <button type="button" className="fin-btn" {...props} style={{ ...S.link, color: danger ? '#b91c1c' : O }}>{text}</button>;
    return (
      <div className="fin-root" style={{ maxWidth: 940, margin: '0 auto' }}>
        <style>{FIN_CSS(th) + CSS}</style>
        {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
        <h2 style={S.title}>Missing Hours</h2>
        <p style={S.lede}>Hours an employee worked but didn't get on their timecard. Fill in the days, sign and send; once it's approved the hours are added to their Paycor payroll grid and you're told.</p>
        {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
        {msg && <FinBanner th={th} tone={msg.tone}>{msg.text}</FinBanner>}
        {reviewing ? <MhReview th={th} isMobile={isMobile} form={reviewing} canApprove={canApprove} onClose={(m) => { setReviewing(null); loadMain(); if (m) setMsg({ tone: 'success', text: m }); }} /> : (<>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div role="tablist" aria-label="Missing hours" style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {tabs.map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={listTab === k} className="fin-btn" onClick={() => setListTab(k)}
                  style={{ ...S.ghost, minHeight: 36, padding: '0.4rem 0.95rem', background: listTab === k ? O : th.card3, color: listTab === k ? '#fff' : th.text }}>{label}</button>
              ))}
            </div>
            <button type="button" className="fin-btn" style={S.primary} onClick={() => { reset(); setMsg(null); setView('form'); }}>Fill in missing hours</button>
          </div>
          {listTab === 'pending' && (lists.pending.length ? <div style={{ display: 'grid', gap: '0.5rem' }}>{lists.pending.map(f => (
            <button key={f.id} type="button" className="fin-btn" onClick={() => setReviewing(f)} style={{ ...rowStyle, border: `1px solid ${canApprove ? O : th.cardBorder}`, cursor: 'pointer' }}>
              <span style={{ minWidth: 0 }}>{who(f)}{sub(f, '')}</span>
              <span style={{ color: canApprove ? O : th.muted, fontWeight: 700, fontSize: '0.85rem', alignSelf: 'center' }}>{canApprove ? 'Review' : 'View'}</span>
            </button>))}</div> : <p style={{ color: th.muted, fontSize: '0.9rem' }}>Nothing waiting for approval.</p>)}
          {listTab === 'sentback' && (lists.sentBack.length ? <div style={{ display: 'grid', gap: '0.5rem' }}>{lists.sentBack.map(f => (
            <div key={f.id} style={{ ...rowStyle, borderLeft: '4px solid #d97706' }}>
              <span style={{ minWidth: 0 }}>{who(f)}{sub(f, `. Sent back by ${f.decidedBy || 'the approver'}`)}{f.note && <span style={{ display: 'block', marginTop: 4, fontSize: '0.9rem' }}>"{f.note}"</span>}</span>
              <span style={{ display: 'flex', gap: '0.9rem', alignItems: 'center', fontSize: '0.85rem', fontWeight: 700 }}>
                {f.hasPdf && link({ onClick: () => setViewing(f) }, 'View')}
                {f.canFix && link({ disabled: rowBusy === f.id, onClick: () => fix(f) }, 'Fix and resend')}
                {f.canFix && link({ disabled: rowBusy === f.id, danger: 1, onClick: () => rowAction(f, 'delete', `Deleted the sent-back form for ${f.employeeName}.`) }, 'Delete')}
              </span>
            </div>))}</div> : <p style={{ color: th.muted, fontSize: '0.9rem' }}>Nothing sent back.</p>)}
          {listTab === 'complete' && (lists.complete.length ? <div style={{ display: 'grid', gap: '0.5rem' }}>{lists.complete.map(f => (
            <div key={f.id} style={rowStyle}>
              <span style={{ minWidth: 0 }}>{who(f)}{sub(f, `. Approved by ${f.decidedBy}${f.decidedAt ? ` on ${day(f.decidedAt)}` : ''}`)}
                <span style={{ display: 'block', fontSize: '0.8rem', marginTop: 2, color: f.paycorStatus === 'sent' ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{f.paycorStatus === 'sent' ? 'In Paycor' : `Not in Paycor yet${f.paycorError ? `: ${f.paycorError}` : ''}`}</span></span>
              <span style={{ display: 'flex', gap: '0.9rem', alignItems: 'center', fontSize: '0.85rem', fontWeight: 700 }}>
                {f.hasPdf && link({ onClick: () => setViewing(f) }, 'View')}
                {f.driveLink && <a href={f.driveLink} target="_blank" rel="noreferrer" style={{ color: O }}>Open in Google Drive</a>}
                {(f.paycorStatus !== 'sent' || !f.driveLink) && (canApprove || ['executive', 'it'].includes(userType)) && link({ disabled: rowBusy === f.id, onClick: () => rowAction(f, 'retry', `Done: ${f.employeeName}'s hours are in Paycor.`) }, rowBusy === f.id ? 'Retrying…' : 'Retry')}
              </span>
            </div>))}</div> : <p style={{ color: th.muted, fontSize: '0.9rem' }}>Nothing approved yet.</p>)}
          {viewing && <FormModal th={th} id={`${FN}?pdf=${viewing.id}`} title={`Missing hours for ${viewing.employeeName}`} onClose={() => setViewing(null)} />}
        </>)}
      </div>
    );
  }

  const empSearch = (
    <span style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
      <input className="mh-blank" style={{ width: isMobile ? '14em' : '18em' }} value={query} role="combobox" aria-expanded={listOpen && matches.length > 0} aria-controls="mh-emp-list" autoComplete="off"
        aria-label="Employee name" placeholder={employees ? 'Search employee name' : 'Loading from Paycor…'} disabled={!employees}
        onChange={e => { setQuery(e.target.value); setListOpen(true); if (picked) setPicked(null); }}
        onFocus={() => setListOpen(true)} onBlur={() => setTimeout(() => setListOpen(false), 150)}
        onKeyDown={e => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); pick(matches[0]); } if (e.key === 'Escape') setListOpen(false); }} />
      {listOpen && matches.length > 0 && (
        <span id="mh-emp-list" role="listbox" style={{ position: 'absolute', zIndex: 30, left: 0, top: '100%', marginTop: 4, width: 'min(420px, 82vw)', maxHeight: 300, overflowY: 'auto', background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 12, boxShadow: '0 10px 30px rgba(0,0,0,0.15)', textAlign: 'left' }}>
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
    <div className="fin-root" style={{ maxWidth: 860, margin: '0 auto' }}>
      <style>{FIN_CSS(th) + CSS}</style>
      <button type="button" className="fin-btn" onClick={() => { setView('list'); setFixing(null); loadMain(); }} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Missing Hours</button>
      <h2 style={S.title}>Missing Hours</h2>
      <p style={S.lede}>Pick the employee, fill in each day they worked but didn't get on their timecard, then sign. The hours and pay period fill themselves in. It goes for approval; once approved the hours are added to their Paycor payroll grid.</p>
      {fixing && <FinBanner th={th} tone="warn">Fixing the form {fixing.decidedBy || 'the approver'} sent back{fixing.note ? `: "${fixing.note}"` : ''}. Make the change, sign again and send.</FinBanner>}
      {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
      {voided && <FinBanner th={th} tone="warn">The form changed after you signed, so sign again.</FinBanner>}
      {employees && !employees.length && !error && <FinBanner th={th} tone="warn">There's no one you can pick yet. If you're a Store Manager, ask IT to link your account to your store.</FinBanner>}

      <div className="mh-paper" style={{ borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 12px 32px rgba(0,0,0,0.08)', padding: isMobile ? '1.2rem 0.9rem 1.6rem' : '2rem 3rem 2.4rem', fontSize: isMobile ? '14px' : '15px', lineHeight: 1.5, marginBottom: '1.2rem',
        backgroundImage: `url('/${MH_CHROME.watermark.src}')`, backgroundRepeat: 'no-repeat', backgroundPosition: 'center 50%', backgroundSize: '72%' }}>
        <p style={{ textAlign: 'center', fontWeight: 700, fontSize: '1.45em', marginBottom: '1.4em' }}>EMPLOYEE MISSING HOURS</p>
        <div style={{ display: 'grid', gap: '0.9em', marginBottom: '1.6em' }}>
          <span>Employee Name: {empSearch}</span>
          <span>PC #: <span className={`mh-locked${picked ? '' : ' mh-empty'}`}>{picked ? `${picked.pc} (${storeName(picked.pc)})` : 'from Paycor'}</span></span>
          <span>Pay Period/Pay Date: <span className={`mh-locked${values.periodStart ? '' : ' mh-empty'}`}>{values.periodStart ? `${usDate(values.periodStart)} - ${usDate(values.periodEnd)}` : 'fills in from the dates'}</span></span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="mh-table" style={{ minWidth: 460 }}>
            <thead><tr><th>DATE</th><th>CLOCK IN</th><th>CLOCK OUT</th><th>TOTAL HOURS</th><th style={{ width: '2.2em', border: 'none' }} aria-label="Remove" /></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const h = missingHoursValues({ rows: [r] }).rows[0];
                return (
                  <tr key={i}>
                    <td><input type="date" value={r.date} max={today} onChange={e => setRow(i, { date: e.target.value })} aria-label={`Row ${i + 1} date`} /></td>
                    <td><input type="time" value={r.clockIn} onChange={e => setRow(i, { clockIn: e.target.value })} aria-label={`Row ${i + 1} clock in`} /></td>
                    <td><input type="time" value={r.clockOut} onChange={e => setRow(i, { clockOut: e.target.value })} aria-label={`Row ${i + 1} clock out`} /></td>
                    <td style={{ fontWeight: 700 }}>{h && h.hours ? fmtHours(h.hours) : ''}</td>
                    <td style={{ border: 'none' }}>{(r.date || r.clockIn || r.clockOut || rows.length > 1) && <button type="button" className="mh-x" onClick={() => setRows(rs => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [EMPTY_ROW()]))} aria-label={`Remove row ${i + 1}`}>✕</button>}</td>
                  </tr>
                );
              })}
              <tr><td colSpan={3} style={{ fontWeight: 700 }}>TOTAL HOURS:</td><td style={{ fontWeight: 700 }}>{values.rows.length ? fmtHours(values.total) : ''}</td><td style={{ border: 'none' }} /></tr>
            </tbody>
          </table>
        </div>
        {rows.length < MH_MAX_ROWS && <button type="button" className="fin-btn" onClick={() => setRows(rs => [...rs, EMPTY_ROW()])} style={{ ...S.link, color: O, fontFamily: FONTS.body, fontSize: '0.85rem', fontWeight: 700, marginTop: '0.5em' }}>Add a day</button>}
        <label style={{ display: 'block', marginTop: '1.2em' }}>Notes (optional): <input className="mh-blank" style={{ width: '100%' }} value={reason} maxLength={300} onChange={e => setReason(e.target.value)} placeholder="e.g. the clock was down; forgot to clock out" aria-label="Notes" /></label>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1em 2.5em', alignItems: 'flex-end', marginTop: '2.2em' }}>
          <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: '0.4em' }}>{signLabel}
            <span style={{ display: 'inline-flex', alignItems: 'flex-end', borderBottom: '1px solid #111', minWidth: '13em', minHeight: '2.4em' }}>
              {sigOk ? <button type="button" className="mh-sigimg" onClick={() => setSigning(true)} title="Sign again"><img src={sigOk.image} alt="Your signature" style={{ maxHeight: '2.3em', maxWidth: '12em', objectFit: 'contain' }} /></button>
                : <button type="button" className="mh-sigbtn" disabled={!canSign} onClick={() => setSigning(true)} style={{ opacity: canSign ? 1 : 0.45, cursor: canSign ? 'pointer' : 'not-allowed' }}>{canSign ? 'Tap to sign' : 'Fill in the form first'}</button>}
            </span></span>
          <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: '0.4em' }}>Date: <span style={{ borderBottom: '1px solid #111', minWidth: '8em', textAlign: 'center', color: sigOk ? '#111' : '#9a8f86', fontStyle: sigOk ? 'normal' : 'italic' }}>{sigOk ? usDate(sigOk.date) : 'on signing'}</span></span>
        </div>
        <label style={{ display: 'block', marginTop: '0.7em', fontSize: '0.9em' }}>Your name: <input className="mh-blank" style={{ width: '14em' }} value={signerName} maxLength={80} onChange={e => setSignerName(e.target.value)} aria-label="Your name" /></label>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.9rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
        {!ready && problems.length > 0 && <span style={{ color: th.muted, fontSize: '0.82rem' }}>Still needed: {problems.join(', ')}</span>}
        <button type="button" className="fin-btn" style={{ ...S.primary, opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed' }} disabled={!ready} onClick={send}>{busy ? 'Sending…' : 'Send for approval'}</button>
      </div>
      {saved && <div style={{ textAlign: 'right', fontSize: '0.85rem', marginBottom: '2rem' }}>
        {saved.state === 'saving' ? <span style={{ color: th.muted }}>Sending…</span>
          : saved.state === 'failed' ? <span style={{ color: '#dc2626' }}>Not sent: {saved.error}. Press the button again to retry.</span>
          : <span style={{ color: '#16a34a' }}>{saved.already ? 'This form was already sent.' : `Sent for approval${saved.notified ? '' : ' (no approver is set up yet — ask IT)'}. You'll be told when it's approved and the hours are in Paycor.`}</span>}
        {saved.pdfUrl && <div style={{ marginTop: '0.6rem' }}><PdfOpenButton url={saved.pdfUrl} style={{ ...S.ghost }} /></div>}
      </div>}

      {signing && <SignatureModal th={th} title={`Your signature — ${signerName}`} onCancel={() => setSigning(false)} onDone={(image) => { setSig({ image, date: today, fp }); setSigning(false); }} />}
    </div>
  );
}
