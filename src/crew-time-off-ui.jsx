// src/crew-time-off-ui.jsx — Tools · Crew Time Off, the staff side (v23.30).
// Send a crew member their private form (email / text / a QR shown on this screen), approve as their
// manager, approve as the office (Roxy), and print each store's QR poster.
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FinBanner, finStyles } from './finance-ui.jsx';
import { FormPreview, FormModal } from './pay-increase-ui.jsx';

const { useState, useEffect, useRef } = React;
const when = (ts) => (ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const FN = '/.netlify/functions/crew-time-off';

async function call(qs, body) {
  const res = await fetch(FN + (qs || ''), { method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeader() }, body: body ? JSON.stringify(body) : undefined });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
  return b;
}

// QR as SVG (qrcode-generator, loaded in index.html).
export function qrSvg(text, cellSize = 6) {
  if (!window.qrcode) return null;
  const q = window.qrcode(0, 'M');
  q.addData(String(text));
  q.make();
  return q.createSvgTag({ cellSize, margin: 2, scalable: true });
}
const Qr = ({ text, size = 220 }) => {
  const svg = qrSvg(text);
  return svg ? <div style={{ width: size, height: size, background: '#fff', padding: 6, borderRadius: 10 }} dangerouslySetInnerHTML={{ __html: svg }} />
    : <p style={{ fontSize: '0.8rem' }}>QR code didn't load. Refresh the page.</p>;
};

function printPoster(storeName, url) {
  const store = String(storeName || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const svg = qrSvg(url, 10) || '';
  const w = window.open('', '_blank');
  if (!w) return alert('Allow pop-ups to print the poster.');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Time Off Request - ${store}</title>
<style>body{font-family:Arial,sans-serif;text-align:center;margin:0;padding:48px 32px;color:#111}h1{font-size:44px;margin:16px 0 6px}h2{font-size:26px;font-weight:normal;margin:0 0 28px;color:#444}
.qr{width:420px;height:420px;margin:0 auto}.qr svg{width:100%;height:100%}ol{display:inline-block;text-align:left;font-size:22px;line-height:1.6;margin:28px auto 0}small{display:block;margin-top:28px;color:#666;font-size:15px}
@media print{@page{size:letter;margin:0.5in}}</style></head><body>
<img src="${location.origin}/pcg-logo-form.jpg" style="height:90px" alt=""><h1>Need time off?</h1><h2>${store} crew: scan to request it</h2>
<div class="qr">${svg}</div><ol><li>Scan this code with your phone camera</li><li>Pick your name and fill in the form</li><li>Sign it and send it to your manager</li></ol>
<small>You'll get a text when it's approved. Questions? Ask your manager.</small><script>window.onload=()=>setTimeout(()=>window.print(),400)</script></body></html>`);
  w.document.close();
}

function Review({ th, isMobile, item, step, canAct, onClose }) {
  const S = finStyles(th);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [backing, setBacking] = useState(false);
  const [note, setNote] = useState('');
  const decide = async (decision) => {
    setBusy(true); setErr(null);
    try {
      const b = await call('', { action: step, id: item.id, decision, note: note.trim() });
      if (decision === 'reject') return onClose(`Sent back. ${item.name} was told why.`);
      if (step === 'manager') return onClose(`Approved. It's with the office now; ${item.name} was told.`);
      const d = b.drive || {}, a = b.alert || {};
      onClose(`Approved. ${d.saved ? 'Filed in Google Drive' : `NOT saved to Drive (${d.error || 'error'}), tell IT`}${a.error ? `; HR alert failed: ${a.error}` : ''}. ${item.name} was told.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const pdf = `${FN}?pdf=${item.id}`;
  return (
    <div className="pcg-stagger" style={{ ...S.panel, padding: '1rem 1.1rem', marginBottom: '1rem' }}>
      <div style={{ ...S.panelTitle, fontSize: '1.05rem' }}>{item.name}, {item.store}</div>
      <p style={{ margin: '0.3rem 0 0.8rem' }}>{item.summary}{item.values?.phone ? ` · ${item.values.phone}` : ''}{item.via === 'poster' ? ' · started from the store QR poster' : ''}</p>
      {item.managerBy && <p style={{ color: th.muted, fontSize: '0.85rem', marginTop: 0 }}>Manager: approved by {item.managerBy}, {when(item.managerAt)}</p>}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <FormPreview th={th} id={pdf} title={`Time off for ${item.name}`} thumbWidth={isMobile ? 200 : 260} />
        <p style={{ fontSize: '0.82rem', color: th.muted, margin: 0, maxWidth: '22em' }}>Click the form to see it full size. <a href={pdf} target="_blank" rel="noreferrer" style={{ color: O }}>Download the PDF</a></p>
      </div>
      {(item.docs || []).length > 0 && (
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.8rem' }}>
          {item.docs.map((d, i) => <a key={i} href={d.url} target="_blank" rel="noopener noreferrer" style={{ ...S.ghost, textDecoration: 'none', color: O, fontWeight: 700, fontSize: '0.85rem' }}>Open {d.name}</a>)}
        </div>
      )}
      {err && <FinBanner th={th} tone="error" style={{ marginTop: '0.8rem' }}>{err}</FinBanner>}
      {backing && <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={400} rows={3} autoFocus placeholder="Why is it being sent back?"
        style={{ width: '100%', boxSizing: 'border-box', marginTop: '0.8rem', borderRadius: 8, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, padding: '0.5rem', fontFamily: FONTS.body }} />}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.9rem' }}>
        <button type="button" className="fin-btn" style={S.ghost} onClick={() => onClose(null)} disabled={busy}>Back</button>
        {!canAct && <span style={{ color: th.muted, fontSize: '0.85rem', alignSelf: 'center' }}>{step === 'office' ? 'Only the office can approve this step.' : 'Only their manager can approve this.'}</span>}
        {canAct && (backing
          ? <button type="button" className="fin-btn" disabled={note.trim().length < 3 || busy} onClick={() => decide('reject')} style={{ ...S.primary, background: '#b91c1c', opacity: note.trim().length >= 3 && !busy ? 1 : 0.5 }}>{busy ? 'Sending…' : 'Send back'}</button>
          : <button type="button" className="fin-btn" style={S.ghost} onClick={() => setBacking(true)} disabled={busy}>Send back…</button>)}
        {canAct && !backing && <button type="button" className="fin-btn" style={S.primary} disabled={busy} onClick={() => decide('approve')}>{busy ? 'Approving…' : step === 'office' ? 'Approve & file it' : 'Approve'}</button>}
      </div>
    </div>
  );
}

export function CrewTimeOff({ th, isMobile, onBack }) {
  const S = finStyles(th);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  // v23.32: opened from the phone home (or with requests waiting) → straight to "For approval"
  const [tab, setTab] = useState(() => { try { const t = sessionStorage.getItem('cto_tab'); sessionStorage.removeItem('cto_tab'); return t || 'send'; } catch { return 'send'; } });
  const firstLoad = useRef(true);
  const [open, setOpen] = useState(null);
  const [viewing, setViewing] = useState(null);
  // send
  const [pc, setPc] = useState('');
  const [q, setQ] = useState('');
  const [emp, setEmp] = useState(null);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const [fromPaycor, setFromPaycor] = useState(null); // v23.32: null | 'loading' | { phone, email }
  // posters
  const [poster, setPoster] = useState(null);
  const [bd, setBd] = useState({ q: '', emp: null }); // unlock a badge ID
  const openRef = useRef(open); openRef.current = open;

  const load = () => call().then(b => { setData(b); setErr(null); if (!pc && b.stores?.length === 1) setPc(b.stores[0].pc);
    if (firstLoad.current) { firstLoad.current = false; if ((b.lists?.manager || []).length) setTab(t => (t === 'send' ? 'manager' : t)); } }).catch(e => setErr(e.message));
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!openRef.current && document.visibilityState === 'visible') load(); }, 60000);
    return () => clearInterval(t);
  }, []);
  if (!data) return <div style={{ maxWidth: 920, margin: '0 auto' }}>{err ? <FinBanner th={th} tone="error">{err}</FinBanner> : <p style={{ color: th.muted }}>Loading…</p>}</div>;
  const L = data.lists || {};
  const tabs = [['send', 'Send a form'], ['manager', `For approval${L.manager?.length ? ` (${L.manager.length})` : ''}`], ['office', `Office${L.office?.length ? ` (${L.office.length})` : ''}`],
    ['invited', `Links sent${L.invited?.length ? ` (${L.invited.length})` : ''}`], ['done', 'Done'], ['posters', 'QR posters']];
  const employees = (data.employees || []).filter(e => (!pc || e.pc === pc) && (!q.trim() || e.name.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 30);

  const send = async () => {
    setBusy(true); setErr(null);
    try { const b = await call('', { action: 'invite', pc: emp.pc, employeeId: emp.id, phone, email }); setSent({ ...b, name: emp.name }); load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const row = (x, right, onClick) => (
    <div key={x.id} onClick={onClick} role={onClick ? 'button' : undefined} style={{ ...S.panel, padding: '0.75rem 0.95rem', display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', cursor: onClick ? 'pointer' : 'default' }}>
      <span style={{ minWidth: 0 }}><b>{x.name}</b> <span style={{ color: th.muted }}>{x.store}</span>
        <span style={{ display: 'block', fontSize: '0.82rem', color: th.muted, marginTop: 2 }}>{x.summary || (x.status === 'invited' ? `Link sent by ${x.invitedBy}, ${when(x.createdAt)}${x.invitePhone ? ` to ${x.invitePhone}` : ''}${x.inviteEmail ? ` · ${x.inviteEmail}` : ''}` : '')}
          {x.status === 'approved' && ` · approved by ${x.managerBy} and ${x.officeBy}`}{x.status === 'rejected' && <span style={{ color: '#dc2626' }}> · sent back by {x.rejectedBy}: {x.note}</span>}</span></span>
      <span onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: '0.8rem', alignItems: 'center', fontSize: '0.85rem', fontWeight: 700 }}>{right}</span>
    </div>);

  return (
    <div style={{ maxWidth: 920, margin: '0 auto', fontFamily: FONTS.body }}>
      {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
      <h2 style={S.title}>Crew Time Off</h2>
      <p style={S.lede}>Crew members request time off on their own phone, no login: send them their private form, or put up the store's QR poster. Their manager approves, then the office, then it's filed in Google Drive and HR has it.</p>
      {msg && <FinBanner th={th} tone="success">{msg}</FinBanner>}
      {err && <FinBanner th={th} tone="error">{err}</FinBanner>}
      <div role="tablist" style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', margin: '0.6rem 0 1rem' }}>
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className="fin-btn" onClick={() => { setTab(k); setOpen(null); }}
          style={{ ...S.ghost, minHeight: 36, padding: '0.35rem 0.9rem', background: tab === k ? O : th.card3, color: tab === k ? '#fff' : th.text, borderColor: tab === k ? O : th.cardBorder }}>{l}</button>)}
      </div>

      {tab === 'send' && (sent ? (
        <div className="pcg-pop" style={{ ...S.panel, padding: '1.1rem', display: 'grid', gap: '0.8rem', justifyItems: 'center', textAlign: 'center' }}>
          <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>Form sent to {sent.name}</div>
          <div style={{ color: th.muted, fontSize: '0.9rem' }}>{sent.emailed ? 'Emailed the link. ' : ''}{sent.texted ? 'Texted them. ' : ''}If they're with you, they can scan this with their phone camera:</div>
          <Qr text={sent.link} />
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button type="button" className="fin-btn" style={S.ghost} onClick={() => { navigator.clipboard?.writeText(sent.link); setMsg('Link copied.'); }}>Copy the link</button>
            <button type="button" className="fin-btn" style={S.primary} onClick={() => { setSent(null); setEmp(null); setQ(''); setPhone(''); setEmail(''); setFromPaycor(null); }}>Send another</button>
          </div>
          <span style={{ color: th.muted, fontSize: '0.78rem' }}>The link is only for {sent.name} and works for 14 days.</span>
        </div>
      ) : (
        <div style={{ ...S.panel, padding: '1rem', display: 'grid', gap: '0.8rem' }}>
          {data.stores.length > 1 && <label style={S.fieldLabel}>Store<select className="fin-input" value={pc} onChange={e => { setPc(e.target.value); setEmp(null); }} style={S.input}><option value="">All my stores</option>{data.stores.map(s => <option key={s.pc} value={s.pc}>{s.name}</option>)}</select></label>}
          <label style={S.fieldLabel}>Crew member<input className="fin-input" value={emp ? emp.name : q} onChange={e => { if (emp) { setPhone(''); setEmail(''); setFromPaycor(null); } setEmp(null); setQ(e.target.value); }} placeholder="Type a name" style={S.input} /></label>
          {!emp && q.trim() && <div style={{ display: 'grid', gap: '0.3rem', maxHeight: 260, overflowY: 'auto' }}>{employees.map(e => (
            <button key={e.pc + e.id} type="button" className="fin-btn" onClick={() => { setEmp(e); setFromPaycor('loading'); call(`?contact=${encodeURIComponent(e.id)}&pc=${e.pc}`).then(b => { setFromPaycor(b); if (b.phone) setPhone(p => p || b.phone); if (b.email) setEmail(m => m || b.email); }).catch(() => setFromPaycor({})); }} style={{ ...S.ghost, justifyContent: 'space-between', display: 'flex', textAlign: 'left' }}>
              <span>{e.name} <span style={{ color: th.muted }}>{e.jobTitle}</span></span><span style={{ color: th.muted }}>{(data.stores.find(s => s.pc === e.pc) || {}).name}</span></button>))}
            {!employees.length && <span style={{ color: th.muted }}>No one by that name.</span>}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0.8rem' }}>
            <label style={S.fieldLabel}>Their email<input className="fin-input" type="email" value={email} onChange={e => setEmail(e.target.value)} style={S.input} /></label>
            <label style={S.fieldLabel}>Their cell number (optional)<input className="fin-input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} style={S.input} /></label>
          </div>
          {emp && fromPaycor === 'loading' && <span style={{ color: th.muted, fontSize: '0.8rem' }}>Getting their cell and email from Paycor…</span>}
          {emp && fromPaycor && fromPaycor !== 'loading' && <span style={{ color: th.muted, fontSize: '0.8rem' }}>{fromPaycor.phone || fromPaycor.email ? `Filled in from Paycor${!fromPaycor.phone ? ' (no cell on file)' : !fromPaycor.email ? ' (no email on file)' : ''}. Check them before you send.` : "Paycor has no cell or email for them. Type them in."}</span>}
          <button type="button" className="fin-btn" disabled={!emp || !email.trim() || busy} onClick={send}
            style={{ ...S.primary, justifySelf: 'end', opacity: emp && email.trim() && !busy ? 1 : 0.5 }}>{busy ? 'Sending…' : 'Send the form'}</button>
        </div>
      ))}

      {(tab === 'manager' || tab === 'office') && (open
        ? <Review th={th} isMobile={isMobile} item={open} step={tab} canAct={tab === 'manager' || data.canOffice} onClose={(m) => { setOpen(null); if (m) setMsg(m); load(); }} />
        : <div style={{ display: 'grid', gap: '0.5rem' }}>{(L[tab] || []).length ? L[tab].map(x => row(x, <button type="button" className="fin-btn" onClick={() => setOpen(x)} style={{ ...S.ghost, minHeight: 34, color: '#fff', background: O, borderColor: O }}>Review</button>, () => setOpen(x)))
          : <p style={{ color: th.muted }}>{tab === 'office' ? 'Nothing waiting on the office.' : 'Nothing waiting for your approval.'}</p>}</div>)}

      {tab === 'invited' && <div style={{ display: 'grid', gap: '0.5rem' }}>{(L.invited || []).length ? L.invited.map(x => row(x,
        <button type="button" className="fin-btn" style={{ ...S.link, color: '#dc2626' }} onClick={async () => { if (!window.confirm(`Withdraw ${x.name}'s link?`)) return; try { await call('', { action: 'cancel', id: x.id }); load(); } catch (e) { setErr(e.message); } }}>Withdraw</button>))
        : <p style={{ color: th.muted }}>No unused links.</p>}</div>}

      {tab === 'done' && <div style={{ display: 'grid', gap: '0.5rem' }}>{(L.done || []).length ? L.done.map(x => row(x, <>
        {x.hasPdf && <button type="button" className="fin-btn" onClick={() => setViewing(x)} style={{ ...S.link, color: O }}>View form</button>}
        {x.driveLink && <a href={x.driveLink} target="_blank" rel="noreferrer" style={{ color: O }}>Open in Google Drive</a>}
        {x.status === 'approved' && !x.driveLink && data.canOffice && <button type="button" className="fin-btn" style={{ ...S.link, color: '#dc2626' }} onClick={async () => { try { const b = await call('', { action: 'office', id: x.id, decision: 'approve' }); setMsg(b.drive?.saved ? `Filed: ${x.name}.` : `Still not filed: ${b.drive?.error || 'error'}.`); load(); } catch (e) { setErr(e.message); } }}>Not filed: file it again</button>}
      </>)) : <p style={{ color: th.muted }}>Nothing yet.</p>}</div>}

      {tab === 'posters' && (
        <div style={{ ...S.panel, padding: '1rem', display: 'grid', gap: '0.8rem' }}>
          <p style={{ margin: 0, color: th.muted, fontSize: '0.88rem' }}>Print a poster for the crew room. Scanning it opens the form for that store; they pick their name and fill it in. It shows names only, never anyone's balance, and their manager approves every request.</p>
          <label style={S.fieldLabel}>Store<select className="fin-input" value={poster?.pc || ''} onChange={async e => { const p = e.target.value; if (!p) return setPoster(null); try { const b = await call(`?poster=${p}`); setPoster({ pc: p, ...b }); } catch (er) { setErr(er.message); } }} style={S.input}>
            <option value="">Pick a store</option>{data.stores.map(s => <option key={s.pc} value={s.pc}>{s.name}</option>)}</select></label>
          {poster && <div style={{ display: 'grid', justifyItems: 'center', gap: '0.6rem' }}><Qr text={poster.url} size={240} />
            <button type="button" className="fin-btn" style={S.primary} onClick={() => printPoster(poster.store, poster.url)}>Print the poster</button></div>}
        </div>
      )}
      {tab === 'posters' && (data.role === 'executive' || data.role === 'it') && (
        <div style={{ ...S.panel, padding: '1rem', display: 'grid', gap: '0.6rem', marginTop: '1rem' }}>
          <b>Unlock a badge ID</b>
          <span style={{ color: th.muted, fontSize: '0.85rem' }}>After 5 wrong badge IDs on the poster, that name is locked for 30 minutes. Unlock it here so they can try again.</span>
          <input className="fin-input" value={bd.emp ? bd.emp.name : bd.q} onChange={e => setBd({ q: e.target.value, emp: null })} placeholder="Crew member's name" style={S.input} />
          {!bd.emp && bd.q.trim().length > 1 && (data.employees || []).filter(e => e.name.toLowerCase().includes(bd.q.trim().toLowerCase())).slice(0, 8).map(e => (
            <button key={e.pc + e.id} type="button" className="fin-btn" onClick={() => setBd(x => ({ ...x, emp: e }))} style={{ ...S.ghost, textAlign: 'left' }}>{e.name} · {(data.stores.find(s2 => s2.pc === e.pc) || {}).name}</button>))}
          <button type="button" className="fin-btn" disabled={!bd.emp} style={{ ...S.ghost, justifySelf: 'start' }}
            onClick={async () => { try { const b = await call('', { action: 'unlockBadge', pc: bd.emp.pc, employeeId: bd.emp.id }); setMsg(b.unlocked ? `Unlocked ${bd.emp.name}: they can try their badge ID again.` : `${bd.emp.name} wasn't locked.`); setBd({ q: '', emp: null }); } catch (e) { setErr(e.message); } }}>Unlock</button>
        </div>
      )}
      {viewing && <FormModal th={th} id={`${FN}?pdf=${viewing.id}`} title={`Time off for ${viewing.name}`} onClose={() => setViewing(null)} />}
    </div>
  );
}
