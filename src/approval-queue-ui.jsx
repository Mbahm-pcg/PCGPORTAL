// src/approval-queue-ui.jsx — the approval list at the top of Tools · Transfer Notice and Tools · Time
// Off Request (v23.22, user 2026-11-24: "DM or manager → Mike for approval → then to Drive").
//
// The approver (and exec / IT, to look) sees Waiting / Done; tapping a waiting one shows the signed
// PDF with Approve or Send back (with a note), like Pay Rate Change. Everyone else sees their own
// recent ones and where each stands. Refreshes on coming back to the tab and every minute.
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FinBanner, finStyles } from './finance-ui.jsx';
import { FormPreview, FormModal } from './pay-increase-ui.jsx';

const { useState, useEffect, useRef } = React;
const shortDate = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

async function call(fn, qs, body) {
  const res = await fetch(`/.netlify/functions/${fn}${qs || ''}`, {
    method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
  return b;
}

const STATUS = {
  pending: { label: 'Waiting for approval', color: '#d97706' },
  approved: { label: 'Approved', color: '#16a34a' },
  rejected: { label: 'Sent back', color: '#dc2626' },
};

function Review({ th, isMobile, fn, noun, item, canApprove, onClose }) {
  const S = finStyles(th);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [backing, setBacking] = useState(false);
  const [note, setNote] = useState('');
  const decide = async (action) => {
    setBusy(true); setErr(null);
    try {
      const b = await call(fn, '', { action, id: item.id, note: note.trim() });
      if (action === 'reject') return onClose(`Sent back to ${item.by}. They were told why.`);
      const d = b.drive || {}, a = b.alert || {};
      onClose(`Approved. ${d.saved ? 'Filed in Google Drive' : `NOT saved to Drive (${d.error || 'error'}), tell IT`}${a.error ? `; office alert failed: ${a.error}` : a.recipients ? `; ${a.recipients} on the office list alerted` : ''}. ${item.by} was told.`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const pdf = `/.netlify/functions/${fn}?pdf=${item.id}`;
  return (
    <div className="pcg-stagger" style={{ ...S.panel, padding: '1rem 1.1rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ ...S.panelTitle, fontSize: '1.05rem' }}>{item.title}</div>
        <span style={{ color: th.muted, fontSize: '0.88rem' }}>sent by {item.by}, {shortDate(item.at)}</span>
      </div>
      <p style={{ color: th.text, fontSize: '0.92rem', margin: '0.35rem 0 0.8rem' }}>{item.sub}</p>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <FormPreview th={th} id={pdf} title={`${noun} for ${item.title}`} thumbWidth={isMobile ? 200 : 260} />
        <p style={{ fontSize: '0.82rem', color: th.muted, margin: 0, maxWidth: '22em' }}>Click the form to see it full size. <a href={pdf} target="_blank" rel="noreferrer" style={{ color: O }}>Download the PDF</a></p>
      </div>
      {(item.docs || []).length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <div style={{ fontWeight: 700, color: th.text, marginBottom: '0.45rem' }}>Attached {item.docs.length === 1 ? 'document' : `documents (${item.docs.length})`}</div>
          <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap' }}>
            {item.docs.map((d, i) => (
              <a key={i} href={d.url} target="_blank" rel="noopener noreferrer" title={`Open ${d.name} in a new tab`}
                style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', width: 150, padding: '0.45rem', borderRadius: 10, border: `1px solid ${th.cardBorder}`, background: th.card3, color: th.text, textDecoration: 'none', fontSize: '0.8rem' }}>
                {/^image\/(jpeg|png|gif|webp)$/.test(d.type)
                  ? <img src={d.url} alt={d.name} loading="lazy" style={{ width: '100%', height: 96, objectFit: 'cover', borderRadius: 6, background: '#fff' }} />
                  : <span style={{ height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, background: '#fff', color: '#6b6158', fontWeight: 700 }}>{/pdf/.test(d.type) ? 'PDF' : (String(d.name).split('.').pop() || 'FILE').toUpperCase()}</span>}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                <span style={{ color: O, fontWeight: 700 }}>Open in a new tab</span>
              </a>
            ))}
          </div>
          <p style={{ color: th.muted, fontSize: '0.78rem', margin: '0.4rem 0 0' }}>Each link works for 2 hours; reopen this request for a fresh one.</p>
        </div>
      )}
      {err && <FinBanner th={th} tone="error" style={{ marginTop: '0.8rem' }}>{err}</FinBanner>}
      {backing && (
        <div style={{ marginTop: '0.8rem' }}>
          <label htmlFor={`aq-note-${item.id}`} style={{ display: 'block', fontWeight: 700, marginBottom: '0.3rem', color: th.text }}>Why is it being sent back?</label>
          <textarea id={`aq-note-${item.id}`} value={note} maxLength={400} rows={3} onChange={e => setNote(e.target.value)} autoFocus
            style={{ width: '100%', boxSizing: 'border-box', borderRadius: 8, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, padding: '0.5rem', fontFamily: FONTS.body }} />
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.9rem' }}>
        <button type="button" className="fin-btn" style={S.ghost} onClick={() => onClose(null)} disabled={busy}>Back</button>
        {!canApprove && <span style={{ color: th.muted, fontSize: '0.85rem', alignSelf: 'center' }}>Only the {noun.toLowerCase()} approver can approve this.</span>}
        {canApprove && (backing
          ? <button type="button" className="fin-btn" style={{ ...S.primary, background: '#b91c1c', opacity: note.trim().length >= 3 && !busy ? 1 : 0.5 }} disabled={note.trim().length < 3 || busy} onClick={() => decide('reject')}>{busy ? 'Sending...' : 'Send back'}</button>
          : <button type="button" className="fin-btn" style={S.ghost} onClick={() => setBacking(true)} disabled={busy}>Send back...</button>)}
        {canApprove && !backing && <button type="button" className="fin-btn" style={S.primary} disabled={busy} onClick={() => decide('approve')}>{busy ? 'Approving...' : 'Approve & file it'}</button>}
      </div>
    </div>
  );
}

export function ApprovalQueue({ th, isMobile, fn, noun, openKey, refresh }) {
  const S = finStyles(th);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('pending');
  const [open, setOpen] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [msg, setMsg] = useState(null);
  const openRef = useRef(open);
  openRef.current = open;

  const load = () => call(fn, '?queue=1').then(b => {
    setData(b);
    // ?transfer=<id> / ?timeOff=<id> from the approval email opens that one straight away.
    let want = null; try { want = sessionStorage.getItem(openKey); sessionStorage.removeItem(openKey); } catch {}
    const hit = want && (b.pending || []).find(x => String(x.id) === String(want));
    if (hit) { setTab('pending'); setOpen(hit); }
    else if (want && (b.done || []).some(x => String(x.id) === String(want))) setTab('done');
  }).catch(() => {});
  useEffect(() => { load(); }, [refresh]);
  useEffect(() => {
    const again = () => { if (!openRef.current && document.visibilityState === 'visible') load(); };
    const t = setInterval(again, 60000);
    window.addEventListener('focus', again); document.addEventListener('visibilitychange', again);
    return () => { clearInterval(t); window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again); };
  }, []);

  if (!data) return null;
  const pending = data.pending || [], done = data.done || [], mine = data.mine || [];
  const row = (x, onClick, right) => (
    <div key={x.id} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onClick={onClick} onKeyDown={onClick ? (e => { if (e.key === 'Enter') onClick(); }) : undefined}
      style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', flexWrap: 'wrap', padding: '0.7rem 0.9rem', borderRadius: 12, border: `1px solid ${onClick && data.canApprove ? O : th.cardBorder}`, background: th.card, color: th.text, cursor: onClick ? 'pointer' : 'default', fontFamily: FONTS.body }}>
      <span style={{ minWidth: 0 }}><strong>{x.title}</strong> <span style={{ color: th.muted }}>{x.sub}</span>
        <span style={{ display: 'block', fontSize: '0.8rem', marginTop: 2, color: th.muted }}>
          <span style={{ color: STATUS[x.status]?.color || th.muted, fontWeight: 700 }}>{STATUS[x.status]?.label || x.status}</span>
          {x.status === 'pending' ? `, sent by ${x.by} ${shortDate(x.at)}` : x.decidedBy ? ` by ${x.decidedBy} ${shortDate(x.decidedAt)}` : ''}
          {x.status === 'rejected' && x.note ? `: ${x.note}` : ''}</span></span>
      {/* v23.22 fix: only the Done-tab links stop the tap; on a waiting row "Review" opens it (it used to swallow the tap). */}
      <span style={{ display: 'flex', gap: '0.9rem', alignItems: 'center', fontSize: '0.85rem', fontWeight: 700 }} onClick={onClick ? undefined : (e => e.stopPropagation())}>{right}</span>
    </div>
  );
  const links = (x) => (<>
    {x.hasPdf && <button type="button" className="fin-btn" onClick={() => setViewing(x)} style={{ ...S.link, color: O }}>View form</button>}
    {x.driveLink && <a href={x.driveLink} target="_blank" rel="noreferrer" style={{ color: O }}>Open in Google Drive</a>}
  </>);

  return (
    <div style={{ marginBottom: '1.4rem' }}>
      {msg && <FinBanner th={th} tone="success" style={{ marginBottom: '0.8rem' }}>{msg}</FinBanner>}
      {data.canView && (open
        ? <Review th={th} isMobile={isMobile} fn={fn} noun={noun} item={open} canApprove={data.canApprove} onClose={(m) => { setOpen(null); if (m) setMsg(m); load(); }} />
        : (
        <section style={{ ...S.panel, padding: '0.9rem 1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
            <div style={{ ...S.panelTitle, fontSize: '1rem' }}>{data.canApprove ? 'For your approval' : 'Approvals'}</div>
            <div role="tablist" aria-label={`${noun} approvals`} style={{ display: 'flex', gap: '0.35rem' }}>
              {[['pending', `Waiting${pending.length ? ` (${pending.length})` : ''}`], ['done', 'Done']].map(([k, l]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className="fin-btn" onClick={() => setTab(k)}
                  style={{ ...S.ghost, minHeight: 34, padding: '0.3rem 0.85rem', background: tab === k ? O : th.card3, color: tab === k ? '#fff' : th.text, borderColor: tab === k ? O : th.cardBorder }}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'grid', gap: '0.45rem' }}>
            {tab === 'pending' && (pending.length ? pending.map(x => row(x, () => setOpen(x),
              <button type="button" className="fin-btn" onClick={(e) => { e.stopPropagation(); setOpen(x); }}
                style={{ ...S.ghost, minHeight: 34, padding: '0.3rem 0.9rem', color: data.canApprove ? '#fff' : th.text, background: data.canApprove ? O : th.card3, borderColor: data.canApprove ? O : th.cardBorder, userSelect: 'none' }}>{data.canApprove ? 'Review' : 'View'}</button>))
              : <p style={{ color: th.muted, fontSize: '0.9rem', margin: 0 }}>Nothing waiting for approval.</p>)}
            {tab === 'done' && (done.length ? done.slice(0, 20).map(x => row(x, null, links(x)))
              : <p style={{ color: th.muted, fontSize: '0.9rem', margin: 0 }}>Nothing decided yet.</p>)}
          </div>
        </section>
      ))}
      {!data.canView && mine.length > 0 && (
        <section style={{ ...S.panel, padding: '0.9rem 1rem' }}>
          <div style={{ ...S.panelTitle, fontSize: '1rem', marginBottom: '0.6rem' }}>Your recent {noun.toLowerCase()}s</div>
          <div style={{ display: 'grid', gap: '0.45rem' }}>{mine.slice(0, 5).map(x => row(x, null, links(x)))}</div>
        </section>
      )}
      {viewing && <FormModal th={th} id={`/.netlify/functions/${fn}?pdf=${viewing.id}`} title={`${noun} for ${viewing.title}`} onClose={() => setViewing(null)} />}
    </div>
  );
}
