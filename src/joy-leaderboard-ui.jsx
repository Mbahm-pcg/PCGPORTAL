// src/joy-leaderboard-ui.jsx — Joy in Childhood leaderboard card for the dashboard (v22.75).
// One day's $1 Joy donations (Pulse service charge #1010) per store, highest first, from joy.mjs.
// Opens on today; ‹ › step a day back or forward (never past today) — nothing to set up
// (user, 2026-11-11). joy.mjs decides who sees what: a Store Manager their own store, a DM /
// Director their districts' stores, exec / IT / office every store (top 5, then "Show all").
import { O, card } from './theme.js';
import { authHeader } from './portal-auth.mjs';

const { useState, useEffect } = React;
const FONT_H = "'Raleway'", FONT_B = "'Source Sans 3'";
const NUM = { fontVariantNumeric: 'lining-nums tabular-nums' };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayLabel = (iso, today) => (iso === today ? 'Today' : iso === addDays(today, -1) ? 'Yesterday'
  : new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const monthLabel = (ym, thisMonth) => (ym === thisMonth ? 'This month' : new Date(ym + '-15T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
const ago = (iso) => { if (!iso) return ''; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

const HeartIcon = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20s-7-4.4-9.2-8.6C1.3 8.4 3.2 5 6.6 5c2 0 3.4 1.1 4.4 2.6C12 6.1 13.4 5 15.4 5c3.4 0 5.3 3.4 3.8 6.4C17 15.6 12 20 12 20Z" />
  </svg>
);
const Chevron = ({ dir, color }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={dir === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
  </svg>
);

export function JoyLeaderboard({ th, isMobile }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [date, setDate] = useState(null); // null = today
  const [mode, setMode] = useState('day'); // 'day' | 'month' — the whole month added up (v22.75)
  const [month, setMonth] = useState(null); // null = this month
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => {
      setLoading(true);
      const qs = mode === 'month' ? `?month=${month || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 7)}` : (date ? `?date=${date}` : '');
      fetch('/.netlify/functions/joy' + qs, { credentials: 'include', headers: { ...authHeader() } })
        .then(r => r.json().then(b => { if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`); return b; }))
        .then(b => { if (live) { setData(b); setErr(null); } })
        .catch(e => live && setErr(e.message))
        .finally(() => live && setLoading(false));
    };
    load();
    const current = mode === 'month' ? !month : !date;
    const t = current ? setInterval(load, 10 * 60 * 1000) : null; // today / this month keep updating while open
    return () => { live = false; if (t) clearInterval(t); };
  }, [date, mode, month]);

  if (!data && !err) return null;
  if (data && data.scope === 'none') return null;

  const cardStyle = { ...card(th), padding: isMobile ? '1rem' : '1.1rem 1.25rem', marginBottom: '1.1rem' };
  const linkBtn = (label, onClick) => <button type="button" onClick={onClick} style={{ background: 'none', border: 'none', padding: 0, color: O, fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', fontFamily: FONT_B }}>{label}</button>;
  const today = data?.today;
  const isMonth = mode === 'month' && data?.month;
  const shown = data?.date || today;
  const shownMonth = data?.month || data?.thisMonth;
  const canBack = data && (isMonth ? shownMonth > data.earliestMonth : shown > data.earliest);
  const canFwd = data && (isMonth ? shownMonth < data.thisMonth : shown < today);
  const step = (n) => {
    setShowAll(false);
    if (isMonth) { const m = addMonths(shownMonth, n); setMonth(m >= data.thisMonth ? null : m); }
    else { const d = addDays(shown, n); setDate(d >= today ? null : d); }
  };
  const seg = (k, label) => (
    <button type="button" aria-pressed={mode === k} onClick={() => { setMode(k); setShowAll(false); }}
      style={{ border: 'none', borderRadius: 999, padding: '0.25rem 0.7rem', fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer', fontFamily: FONT_B,
        background: mode === k ? O : 'transparent', color: mode === k ? '#fff' : th.muted }}>{label}</button>
  );
  const arrow = (dir, enabled, onClick, label) => (
    <button type="button" onClick={onClick} disabled={!enabled} aria-label={label} title={label}
      style={{ width: 30, height: 30, borderRadius: 999, border: `1px solid ${th.cardBorder}`, background: 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.35 }}>
      <Chevron dir={dir} color={th.text} />
    </button>
  );

  const rows = data?.rows || [];
  const isStore = data?.scope === 'store';
  const limit = data?.scope === 'all' && !showAll ? 5 : rows.length;
  const max = Math.max(1, ...rows.map(r => r.cnt));

  return (
    <section style={cardStyle} aria-label="Joy in Childhood leaderboard">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
          <HeartIcon color={O} />
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontFamily: FONT_H, fontWeight: 800, fontSize: '1.02rem', color: th.text }}>Joy in Childhood</h3>
            {data?.updatedAt && <div style={{ fontSize: '0.75rem', color: th.muted, fontFamily: FONT_B }}>Updated {ago(data.updatedAt)}</div>}
          </div>
        </div>
        {data && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontFamily: FONT_B, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span role="group" aria-label="Show one day or the whole month" style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 999, border: `1px solid ${th.cardBorder}` }}>{seg('day', 'Day')}{seg('month', 'Month')}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
              {arrow('left', canBack, () => step(-1), isMonth ? 'Previous month' : 'Previous day')}
              <span aria-live="polite" style={{ minWidth: '7.5em', textAlign: 'center', fontWeight: 700, color: th.text, fontSize: '0.9rem', opacity: loading ? 0.6 : 1 }}>{isMonth ? monthLabel(shownMonth, data.thisMonth) : dayLabel(shown, today)}</span>
              {arrow('right', canFwd, () => step(1), isMonth ? 'Next month' : 'Next day')}
            </span>
          </div>
        )}
      </div>

      {err && <div style={{ fontSize: '0.85rem', color: '#dc2626', fontFamily: FONT_B, padding: '0.3rem 0' }}>{err}</div>}

      {data && isStore && rows[0] && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', padding: '0.4rem 0.2rem', fontFamily: FONT_B, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: FONT_H, fontWeight: 900, fontSize: '2.4rem', color: O, lineHeight: 1, ...NUM }}>{rows[0].noData ? '—' : rows[0].cnt.toLocaleString()}</span>
          <span style={{ color: th.text, fontWeight: 600 }}>{rows[0].noData ? `no data yet for ${rows[0].name}` : `donation${rows[0].cnt === 1 ? '' : 's'} at ${rows[0].name}`}</span>
          {!rows[0].noData && rows[0].ttl > 0 && <span style={{ color: th.muted, fontSize: '0.88rem' }}>${rows[0].ttl.toLocaleString(undefined, { maximumFractionDigits: 2 })} raised for Joy in Childhood</span>}
        </div>
      )}
      {data && isStore && !rows[0] && <div style={{ fontSize: '0.85rem', color: th.muted, fontFamily: FONT_B }}>Your account isn't linked to a store yet.</div>}

      {data && !isStore && (
        <>
          {rows.length > 1 && <div style={{ fontSize: '0.8rem', color: th.muted, fontFamily: FONT_B, marginBottom: '0.3rem' }}>{data.total.toLocaleString()} donations across {rows.filter(r => !r.noData).length} stores</div>}
          {rows.every(r => r.noData) && <div style={{ fontSize: '0.85rem', color: th.muted, fontFamily: FONT_B, padding: '0.4rem 0.2rem' }}>No numbers for this {isMonth ? 'month' : 'day'} yet. They fill in every hour.</div>}
          {!rows.every(r => r.noData) && (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {rows.slice(0, limit).map(r => (
                <li key={r.pc} style={{ display: 'grid', gridTemplateColumns: isMobile ? '1.6rem minmax(0, 1.7fr) minmax(0, 1fr) 3rem' : '2rem minmax(0, 1fr) minmax(0, 1.4fr) 3.5rem', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.2rem', borderTop: `1px solid ${th.cardBorder}`, fontFamily: FONT_B }}>
                  <span style={{ fontFamily: FONT_H, fontWeight: 900, color: r.rank && r.rank <= 3 ? O : th.muted, fontSize: '0.95rem', ...NUM }}>{r.rank || ''}</span>
                  <span style={{ fontWeight: 700, color: th.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}{!isMobile && <span style={{ fontWeight: 400, color: th.muted, fontSize: '0.78rem' }}> D{r.district}</span>}</span>
                  <span aria-hidden="true" style={{ height: 8, borderRadius: 4, background: th.cardBorder, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: `${r.noData ? 0 : Math.max(2, (r.cnt / max) * 100)}%`, background: O, borderRadius: 4 }} />
                  </span>
                  <span style={{ textAlign: 'right', fontWeight: 800, color: th.text, ...NUM }}>{r.noData ? '—' : r.cnt.toLocaleString()}</span>
                </li>
              ))}
            </ol>
          )}
          {data.scope === 'all' && rows.length > 5 && !rows.every(r => r.noData) && (
            <div style={{ paddingTop: '0.55rem', textAlign: 'center' }}>{linkBtn(showAll ? 'Show top 5' : `Show all ${rows.length} stores`, () => setShowAll(v => !v))}</div>
          )}
        </>
      )}
    </section>
  );
}

// Manager phone view ("My Store" mode, ManagerEmbeddableView) — a compact tile in that screen's own
// style: today's and this month's Joy donations for the manager's store, side by side (v22.75).
// The parent passes its style tokens so the tile matches the cards around it.
export function JoyMobileTile({ cardStyle, mono, display, muted, secondary }) {
  const [today, setToday] = useState(null);
  const [month, setMonth] = useState(null);
  useEffect(() => {
    let live = true;
    const get = (qs) => fetch('/.netlify/functions/joy' + qs, { credentials: 'include', headers: { ...authHeader() } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    const load = () => Promise.all([get(''), get(`?month=${new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 7)}`)])
      .then(([d, m]) => { if (!live) return; setToday(d); setMonth(m); });
    load();
    const t = setInterval(load, 10 * 60 * 1000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const row = (b) => (b && b.scope === 'store' ? b.rows?.[0] : null);
  const t = row(today), m = row(month);
  if (!t && !m) return null; // not a store account, or nothing loaded
  const lbl = { fontFamily: mono, fontSize: '9px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: muted };
  const big = (r) => <div style={{ fontFamily: display, fontWeight: 800, fontSize: '2.1rem', lineHeight: 1, color: O, marginTop: '0.35rem', ...NUM }}>{!r || r.noData ? '—' : r.cnt.toLocaleString()}</div>;
  return (
    <div style={{ ...cardStyle, padding: '1rem 1.05rem' }} aria-label="Joy in Childhood donations">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.6rem' }}>
        <HeartIcon color={O} />
        <span style={{ ...lbl, fontSize: '10px' }}>Joy in Childhood</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.8rem' }}>
        <div><span style={lbl}>Today</span>{big(t)}</div>
        <div><span style={lbl}>This month</span>{big(m)}</div>
      </div>
      {m && !m.noData && m.ttl > 0 && <div style={{ fontFamily: mono, fontSize: '9px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: secondary, marginTop: '0.55rem' }}>${m.ttl.toLocaleString(undefined, { maximumFractionDigits: 0 })} raised this month</div>}
    </div>
  );
}
