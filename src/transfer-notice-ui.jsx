// src/transfer-notice-ui.jsx — Tools · Transfer Notice (v22.49).
//
// Fills HR's Employee Transfer letter from Paycor and downloads it as a PDF that matches
// the template (src/transfer-notice-pdf.mjs). The whole form shows at once: search any
// employee the caller may transfer (by name or store); their name, current position,
// current PC# and hourly wage then come only from Paycor and can't be edited here. The
// destination, new position, full/part time and dates are filled on the form. Data comes
// from transfer-notice.mjs, scoped server-side (DM → district, manager → own store).
import { FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FIN_CSS, FinBanner, finStyles, finMoney } from './finance-ui.jsx';
import { buildTransferNoticePdf, TRANSFER_FONT } from './transfer-notice-pdf.mjs';
import { transferLetterValues, missingTransferFields } from './transfer-notice.mjs';

const { useState, useEffect } = React;

const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const POSITIONS = ['Crew Member', 'Shift Leader', 'Assistant Manager', 'Store Manager'];

const api = async (qs = '') => {
  const res = await fetch('/.netlify/functions/transfer-notice' + qs, { credentials: 'include', headers: { ...authHeader() } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
};

// The letter's font, fetched once per page load.
let fontsPromise = null;
const toB64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const loadFonts = () => fontsPromise || (fontsPromise = Promise.all([TRANSFER_FONT.regular, TRANSFER_FONT.italic].map(f =>
  fetch('/fonts/' + f).then(r => { if (!r.ok) throw new Error('font ' + f); return r.arrayBuffer(); }).then(toB64)))
  .then(([regular, italic]) => ({ regular, italic }))
  .catch(e => { fontsPromise = null; throw e; }));

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
  const [effectiveDate, setEffectiveDate] = useState('');
  const [supervisorName, setSupervisorName] = useState('');
  const [supervisorTitle, setSupervisorTitle] = useState('Store Manager');
  const [dmName, setDmName] = useState('');
  const [date, setDate] = useState(todayIso());
  const [busy, setBusy] = useState(false);

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
  const values = transferLetterValues({ employee, fromPC, toPC, toTitle, employmentType, effectiveDate, supervisorName, supervisorTitle, dmName, date });
  const missing = missingTransferFields(values);
  const sameStore = fromPC && toPC && fromPC === toPC;
  const ready = !missing.length && hourly && !sameStore && !busy && !loadingEmp;

  const q = query.trim().toLowerCase();
  const matches = q && employees ? employees.filter(e => e.name.toLowerCase().includes(q) || storeName(e.pc).toLowerCase().includes(q) || e.pc.includes(q)).slice(0, 40) : [];
  const pick = (e) => { setPicked(e); setQuery(e.name); setListOpen(false); if (toPC === e.pc) setToPC(''); };

  const download = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (!JsPDF) throw new Error('PDF library did not load — refresh the page.');
      const doc = buildTransferNoticePdf(JsPDF, await loadFonts(), values);
      doc.save(`Transfer-Notice-${values.employeeName.replace(/[^A-Za-z0-9]+/g, '-')}-${date}.pdf`);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const field = (label, control, note) => (
    <label style={S.fieldLabel}>
      <span>{label}</span>
      {control}
      {note && <span style={{ fontSize: '0.75rem', color: th.muted }}>{note}</span>}
    </label>
  );
  const locked = (label, value) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.8rem', color: th.muted, minWidth: 0 }}>
      <span>{label}</span>
      <div style={{ ...S.input, background: th.card2, color: value ? th.text : th.muted, cursor: 'default', overflowWrap: 'anywhere' }} aria-readonly="true">{value || (loadingEmp ? 'Reading Paycor…' : 'From Paycor')}</div>
    </div>
  );
  const grid = { display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: '0.9rem' };
  const section = (title, children) => (
    <div style={{ ...S.panel, marginBottom: '1rem', overflow: 'visible' }}>
      <div style={S.panelHead}>
        <div style={S.panelTitle}>{title}</div>
        {children}
      </div>
    </div>
  );

  return (
    <div className="fin-root" style={{ maxWidth: 860, margin: '0 auto' }}>
      <style>{FIN_CSS(th)}</style>
      {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
      <h2 style={S.title}>Transfer Notice</h2>
      <p style={S.lede}>Find the employee, then fill in where they're going. Their name, current position, store and hourly wage come straight from Paycor; the PDF matches HR's Employee Transfer letter, ready to sign.</p>

      {error && <FinBanner th={th} tone="error" style={{ marginBottom: '1rem' }}>{error}</FinBanner>}

      {section('Employee', <>
        <div style={{ position: 'relative' }}>
          {field('Employee',
            <input className="fin-input" style={S.input} value={query} role="combobox" aria-expanded={listOpen && matches.length > 0} aria-controls="tn-emp-list" autoComplete="off"
              placeholder={employees ? 'Type a name or store…' : 'Loading employees from Paycor…'} disabled={!employees}
              onChange={e => { setQuery(e.target.value); setListOpen(true); if (picked) setPicked(null); }}
              onFocus={() => setListOpen(true)} onBlur={() => setTimeout(() => setListOpen(false), 150)}
              onKeyDown={e => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); pick(matches[0]); } if (e.key === 'Escape') setListOpen(false); }} />)}
          {listOpen && matches.length > 0 && (
            <div id="tn-emp-list" role="listbox" style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, top: '100%', marginTop: 4, maxHeight: 300, overflowY: 'auto', background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 12, boxShadow: '0 10px 30px rgba(0,0,0,0.12)' }}>
              {matches.map(e => (
                <button key={e.pc + e.id} type="button" role="option" aria-selected="false" className="fin-btn" onMouseDown={ev => ev.preventDefault()} onClick={() => pick(e)}
                  style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: '0.8rem', padding: '0.6rem 0.9rem', background: 'none', border: 'none', borderBottom: `1px solid ${th.cardBorder}`, color: th.text, textAlign: 'left', cursor: 'pointer', fontFamily: FONTS.body, fontSize: '0.9rem' }}>
                  <span style={{ minWidth: 0 }}>{e.name}{e.jobTitle && <span style={{ color: th.muted }}> — {e.jobTitle}</span>}</span>
                  <span style={{ color: th.muted, whiteSpace: 'nowrap' }}>{storeName(e.pc)} · {e.pc}</span>
                </button>
              ))}
            </div>
          )}
          {listOpen && q && employees && !picked && matches.length === 0 && <div style={{ fontSize: '0.8rem', color: th.muted, marginTop: '0.3rem' }}>No active employee matches “{query.trim()}”.</div>}
        </div>
        <div style={grid}>
          {locked('Employee name', employee?.name)}
          {locked('Current position', employee?.jobTitle)}
          {locked('Current PC#', employee ? `${fromPC}${storeName(fromPC) ? ` · ${storeName(fromPC)}` : ''}` : '')}
          {locked('Hourly wage', hourly ? finMoney.format(employee.payRate) : '')}
        </div>
        {employee && !hourly && <FinBanner th={th} tone="warn" style={{ marginBottom: 0 }}>Paycor has no hourly rate for {employee.name}{employee.payType ? ` (pay type: ${employee.payType})` : ''}, so this letter can't be made. Fix the rate in Paycor first.</FinBanner>}
      </>)}

      {section('Transfer', (
        <div style={grid}>
          {field('New store',
            <select className="fin-input" style={S.input} value={toPC} onChange={e => setToPC(e.target.value)}>
              <option value="">Choose a store…</option>
              {stores.filter(s => s.pc !== fromPC).map(s => <option key={s.pc} value={s.pc}>{s.name} · PC# {s.pc}</option>)}
            </select>)}
          {field('New position',
            <><input className="fin-input" style={S.input} list="tn-positions" value={toTitle} onChange={e => setToTitle(e.target.value)} placeholder="e.g. Shift Leader" />
              <datalist id="tn-positions">{POSITIONS.map(p => <option key={p} value={p} />)}</datalist></>)}
          {field('Full or part time',
            <select className="fin-input" style={S.input} value={employmentType} onChange={e => setEmploymentType(e.target.value)}>
              <option value="">Choose…</option>
              <option>Full time</option>
              <option>Part time</option>
            </select>, employee?.employmentType ? 'From Paycor' : null)}
          {field('Effective date', <input type="date" className="fin-input" style={S.input} value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} />)}
          {field('Reports to (supervisor name)', <input className="fin-input" style={S.input} value={supervisorName} onChange={e => setSupervisorName(e.target.value)} />, toPC ? "The new store's manager in the portal" : null)}
          {field('Supervisor title', <input className="fin-input" style={S.input} value={supervisorTitle} onChange={e => setSupervisorTitle(e.target.value)} />)}
          {field('District Manager', <input className="fin-input" style={S.input} value={dmName} onChange={e => setDmName(e.target.value)} />, toPC ? "The new store's district DM" : null)}
          {field('Letter date', <input type="date" className="fin-input" style={S.input} value={date} onChange={e => setDate(e.target.value)} />)}
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.9rem', flexWrap: 'wrap' }}>
        {(missing.length > 0 || sameStore || (employee && !hourly)) && <span style={{ color: th.muted, fontSize: '0.82rem' }}>{sameStore ? 'The new store must be different.' : missing.length ? `Still needed: ${missing.join(', ')}` : 'No hourly wage in Paycor.'}</span>}
        <button type="button" className="fin-btn" style={{ ...S.primary, opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed' }} disabled={!ready} onClick={download}>
          {busy ? 'Making PDF…' : 'Download PDF'}
        </button>
      </div>
    </div>
  );
}
