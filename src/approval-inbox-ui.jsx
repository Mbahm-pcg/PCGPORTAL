// src/approval-inbox-ui.jsx — the "Waiting for your approval" popup after sign-in (v23.35).
// Shows once per sign-in, only when something is waiting for THIS person. Tap an item → straight to
// it (the tool opens on that request); "Go to dashboard" closes it — nothing to sign or accept.
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';

const { useState, useEffect } = React;
const KIND = {
  pay: { label: 'Pay Rate Change', tab: 'pay-increase', key: 'pi_open', color: '#16a34a' },
  transfer: { label: 'Transfer Notice', tab: 'transfer-notice', key: 'tn_open', color: '#2563eb' },
  timeoff: { label: 'Time Off', tab: 'time-off-request', key: 'to_open', color: '#9333ea' },
  payoffice: { label: 'Pay Rate Change (office)', tab: 'pay-increase', key: 'pi_open', color: '#15803d' },
  violation: { label: 'Violation Notice', tab: 'violation-notice', key: 'vn_open', color: '#dc2626' },
  missing: { label: 'Missing Hours', tab: 'missing-hours', key: 'mh_open', color: '#d97706' },
  // Crew Time Off opens on the right tab (its screen reads cto_tab); the request is at the top of it
  crewmgr: { label: 'Crew Time Off', tab: 'crew-time-off', key: 'cto_tab', value: 'manager', color: '#0891b2' },
  crewoffice: { label: 'Crew Time Off (office)', tab: 'crew-time-off', key: 'cto_tab', value: 'office', color: '#0e7490' },
};
const ago = (ts) => {
  const h = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 3600e3));
  return h < 1 ? 'just now' : h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

export function ApprovalInbox({ th, user, onOpen }) {
  const [items, setItems] = useState(null);
  const [open, setOpen] = useState(false);
  const flag = `pcg_inbox_shown_${user?.id}`;
  useEffect(() => {
    if (!user?.id) return;
    let seen = false; try { seen = sessionStorage.getItem(flag) === '1'; } catch {}
    if (seen) return;
    fetch('/.netlify/functions/approval-inbox', { credentials: 'include', cache: 'no-store', headers: { ...authHeader() } })
      .then(r => (r.ok ? r.json() : null)).then(b => {
        const list = b?.items || [];
        setItems(list);
        // v23.35 fix: NOT marked as seen here — the screen can be drawn again during sign-in, and the
        // copy that asked would mark it "shown" without anyone seeing it. Seen = closed or an item tapped.
        if (list.length) setOpen(true);
      }).catch(() => {});
  }, [user?.id]);
  if (!open || !items?.length) return null;
  const seen = () => { try { sessionStorage.setItem(flag, '1'); } catch {} };
  const close = () => { seen(); setOpen(false); };
  const go = (it) => {
    seen();
    const k = KIND[it.kind];
    try { sessionStorage.setItem(k.key, k.value || String(it.id)); } catch {}
    setOpen(false);
    onOpen && onOpen(k.tab);
  };
  // v23.35 fix: drawn straight onto <body> (a portal) — inside the page's fade-in container, "fixed"
  // was measured against the whole long page, so the popup landed off-screen and was never seen.
  return ReactDOM.createPortal(
    <div className="pcg-backdrop" role="dialog" aria-modal="true" aria-labelledby="inbox-title" onClick={close}
      style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(15,12,10,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: FONTS.body }}>
      <div className="pcg-pop" onClick={e => e.stopPropagation()}
        style={{ background: th.card, color: th.text, borderRadius: 18, width: 'min(520px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}>
        <div style={{ padding: '1.1rem 1.2rem 0.6rem' }}>
          <div id="inbox-title" style={{ fontFamily: "'Raleway'", fontWeight: 900, fontSize: '1.25rem' }}>Waiting for your approval</div>
          <div style={{ color: th.muted, fontSize: '0.88rem', marginTop: 2 }}>{items.length} {items.length === 1 ? 'request is' : 'requests are'} waiting. Tap one to open it.</div>
        </div>
        <div style={{ overflowY: 'auto', padding: '0.3rem 0.8rem', display: 'grid', gap: '0.45rem' }}>
          {items.map(it => {
            const k = KIND[it.kind];
            return (
              <button key={it.kind + it.id} type="button" onClick={() => go(it)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', textAlign: 'left', padding: '0.75rem 0.85rem', borderRadius: 12, border: `1px solid ${th.cardBorder}`, background: th.card3 || th.bg, color: th.text, cursor: 'pointer', fontFamily: FONTS.body }}>
                <span style={{ width: 8, alignSelf: 'stretch', borderRadius: 99, background: k.color, flexShrink: 0 }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontWeight: 800, fontSize: '0.98rem' }}>{it.title}</span>
                  <span style={{ display: 'block', color: th.muted, fontSize: '0.8rem', marginTop: 2, lineHeight: 1.35 }}>{it.sub}</span>
                </span>
                <span style={{ color: O, fontWeight: 800, fontSize: '0.82rem', whiteSpace: 'nowrap' }}>Review →<span style={{ display: 'block', color: th.muted, fontWeight: 500, fontSize: '0.72rem', textAlign: 'right' }}>{ago(it.at)}</span></span>
              </button>
            );
          })}
        </div>
        <div style={{ padding: '0.8rem 1.2rem 1.1rem', display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" onClick={close} autoFocus
            style={{ background: 'none', border: `1px solid ${th.cardBorder}`, color: th.text, borderRadius: 12, padding: '0.6rem 1.2rem', fontWeight: 700, cursor: 'pointer', fontFamily: FONTS.body }}>Go to dashboard</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
