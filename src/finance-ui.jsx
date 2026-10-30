// src/finance-ui.jsx — the shared Finance UI kit (Hallmark redesign, v22.30).
// Every Finance tab (P&L, NDCP, Cash, Reconciliation, Expense Log, Tips Report,
// Tips Editor, Labor) builds from these so the section reads as one product.
// The rules are in design.md at the project root. React is the CDN global.
import { O, W, FONTS, btn, inp, card } from './theme.js';

// One style block per screen: tokens, focus, controls, motion, reduced motion.
// Render <style>{FIN_CSS(th)}</style> once at the top of a Finance screen.
export const FIN_CSS = (th) => `/* Hallmark · redesign: full · shape: app screen · scope: app · theme: brand (PCG orange, Raleway + Source Sans 3) · motion: brisk · system: design.md (Finance) */
/* critique: Finance screens were plain forms and grey tables with tracked-caps labels and repeated figures; the system gives each tab one object, ticking figures and quiet state-only motion */
/* answered: tokens live in src/theme.js (th.*, FONTS, O) — the portal styles inline, so this block holds only states, motion and focus */
:root { --fin-accent: ${O}; --fin-text: ${th.text}; --fin-hover: ${th.card3}; --fin-row: ${th.card2}; --fin-font: ${FONTS.body}; --fin-flash: ${th.success}22; }
.fin-root { font-family: var(--fin-font); color: var(--fin-text); }
.fin-root * { box-sizing: border-box; }
.fin-focus:focus-visible, .fin-btn:focus-visible, .fin-tab:focus-visible, .fin-pick:focus-visible, .fin-rowbtn:focus-visible { outline: 2px solid var(--fin-accent) !important; outline-offset: 2px; }
.fin-input:focus-visible { outline: 2px solid var(--fin-accent) !important; outline-offset: -1px; }
.fin-btn { transition: background-color 220ms cubic-bezier(.2,.8,.2,1), color 220ms cubic-bezier(.2,.8,.2,1), transform 120ms cubic-bezier(.2,.8,.2,1), opacity 220ms ease !important; }
.fin-btn:active:not(:disabled) { transform: translateY(1px); }
.fin-btn:disabled, .fin-input:disabled { cursor: not-allowed; }
.fin-tab-ind { transition: transform 220ms cubic-bezier(.2,.8,.2,1); }
.fin-tab { transition: color 220ms ease; }
.fin-bar { transition: transform 420ms cubic-bezier(.2,.8,.2,1), opacity 220ms ease; transform-origin: left center; }
.fin-row { animation: finRowIn 220ms cubic-bezier(.2,.8,.2,1) both; }
.fin-row-leaving { animation: finRowOut 150ms cubic-bezier(.4,0,1,1) both; }
.fin-hoverrow { transition: background-color 220ms ease; }
.fin-hoverrow:hover { background: var(--fin-row); }
.fin-disclose { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 220ms cubic-bezier(.2,.8,.2,1); }
.fin-disclose[data-open="true"] { grid-template-rows: 1fr; }
.fin-disclose > div { overflow: hidden; min-height: 0; }
.fin-pick, .fin-rowbtn { transition: background-color 120ms ease; }
.fin-pick:hover, .fin-rowbtn:hover { background: var(--fin-hover); }
.fin-skel { animation: finBreathe 1.2s ease-in-out infinite; background: var(--fin-hover); border-radius: 0.4rem; }
.fin-num { font-variant-numeric: tabular-nums; }
.fin-spin { animation: finSpin 0.9s linear infinite; transform-origin: 50% 50%; }
.fin-col { transition: transform 420ms cubic-bezier(.2,.8,.2,1); transform-origin: bottom center; }
@keyframes finSpin { to { transform: rotate(360deg); } }
.fin-panel-in { animation: finPanelIn 260ms cubic-bezier(.2,.8,.2,1) both; }
@keyframes finPanelIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.fin-uline { transition: transform 260ms cubic-bezier(.2,.8,.2,1); transform-origin: left center; }
.fin-overlay { animation: finFade 220ms ease-out both; }
.fin-drawer { animation: finDrawerIn 300ms cubic-bezier(.2,.8,.2,1) both; }
.fin-flash { position: relative; }
.fin-flash::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: var(--fin-flash); animation: finFlash 1.6s ease-out forwards; border-radius: inherit; }
.fin-lift { transition: transform 160ms cubic-bezier(.2,.8,.2,1), background-color 160ms ease; }
.fin-lift:hover:not(:disabled) { transform: translateY(-1px); }
@keyframes finFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes finDrawerIn { from { opacity: 0; transform: translateX(32px); } to { opacity: 1; transform: none; } }
@keyframes finFlash { 0% { opacity: 1; } 100% { opacity: 0; } }
.fin-tabstrip { scrollbar-width: none; }
.fin-tabstrip::-webkit-scrollbar { display: none; }
.fin-tabbtn { transition: color 160ms ease, background-color 160ms ease; }
.fin-tabbtn:hover { background: var(--fin-hover); }
.fin-tabbtn:focus-visible { outline: 2px solid var(--fin-accent) !important; outline-offset: -2px; }
@keyframes finRowIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
@keyframes finRowOut { to { opacity: 0; transform: translateX(14px); } }
@keyframes finBreathe { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .fin-row, .fin-row-leaving, .fin-skel, .fin-spin, .fin-panel-in, .fin-overlay, .fin-drawer { animation: none; }
  .fin-flash::after { animation: finFlash 150ms linear forwards; }
  .fin-lift:hover:not(:disabled) { transform: none; }
  .fin-bar, .fin-tab-ind, .fin-disclose, .fin-col, .fin-uline { transition: opacity 150ms linear; }
}`;

export const finReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const finMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const finMoney0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const finHours = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const finInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const finPct = (v, d = 1) => `${(Number(v) || 0).toFixed(d)}%`;

// Counts from the previous value to the new one (ease-out, ~500ms); an interrupted
// count continues from where it is. Reduced motion: the final value at once.
export function useTickedNumber(value, ms = 500) {
  const target = Number(value) || 0;
  const [shown, setShown] = React.useState(target);
  const fromRef = React.useRef(target);
  React.useEffect(() => {
    const from = fromRef.current;
    if (finReducedMotion() || Math.abs(from - target) < 0.005) { fromRef.current = target; setShown(target); return undefined; }
    let raf = 0, start = null;
    const step = (t) => {
      if (start == null) start = t;
      const p = Math.min(1, (t - start) / ms);
      const v = from + (target - from) * (1 - Math.pow(1 - p, 3));
      fromRef.current = v; setShown(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return shown;
}

export function FinTicker({ value, format, style }) {
  const v = useTickedNumber(value);
  return <span className="fin-num" style={style}>{format(v)}</span>;
}

// A figure: label (sentence case, body face), the number in the display face, an
// optional note. `tone` colours the number only when it carries state.
export function FinFigure({ th, label, value, format, note, tone }) {
  const color = tone === 'good' ? th.success : tone === 'bad' ? th.danger : tone === 'warn' ? th.warn : th.text;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: '0.8rem', color: th.muted }}>{label}</div>
      {typeof value === 'number'
        ? <FinTicker value={value} format={format} style={{ display: 'block', fontFamily: FONTS.head, fontWeight: 800, fontSize: '1.35rem', color, lineHeight: 1.2 }} />
        : <span className="fin-num" style={{ display: 'block', fontFamily: FONTS.head, fontWeight: 800, fontSize: '1.35rem', color, lineHeight: 1.2 }}>{value ?? 'None'}</span>}
      {note && <div style={{ fontSize: '0.75rem', color: th.muted, marginTop: '0.1rem' }}>{note}</div>}
    </div>
  );
}

// A row of figures that wraps on narrow screens.
export function FinFigures({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem' }}>{children}</div>;
}

// Error / success / warning / info line. Errors are alerts; the rest are status.
export function FinBanner({ th, tone = 'info', children, style }) {
  const color = tone === 'error' ? th.danger : tone === 'success' ? th.success : tone === 'warn' ? th.warn : th.muted;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} style={{ ...card(th), padding: '0.8rem 1rem', borderLeft: `3px solid ${color}`, color: tone === 'info' ? th.text : color, fontSize: '0.86rem', marginBottom: '1rem', ...style }}>
      {children}
    </div>
  );
}

// Loading placeholder in the shape of what is coming.
export function FinSkeleton({ th, rows = 4, figures = 3 }) {
  return (
    <div aria-hidden="true" style={{ ...card(th), padding: '1.2rem 1.1rem', display: 'grid', gap: '0.8rem' }}>
      <div className="fin-skel" style={{ height: 22, width: '40%' }} />
      {figures > 0 && <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>{Array.from({ length: figures }, (_, i) => <div key={i} className="fin-skel" style={{ height: 38, width: 110 }} />)}</div>}
      {Array.from({ length: rows }, (_, i) => <div key={i} className="fin-skel" style={{ height: 36 }} />)}
    </div>
  );
}

// Segmented switch with a sliding indicator (transform only). options: [[value, label]].
export function FinTabs({ th, options, value, onChange, label }) {
  const idx = Math.max(0, options.findIndex(([v]) => v === value));
  const n = options.length;
  return (
    <div role="tablist" aria-label={label} style={{ position: 'relative', display: 'inline-grid', gridTemplateColumns: `repeat(${n}, 1fr)`, padding: 4, background: th.card2, border: `1px solid ${th.cardBorder}`, borderRadius: 999, maxWidth: '100%', overflowX: 'auto' }}>
      <span aria-hidden="true" className="fin-tab-ind" style={{ position: 'absolute', top: 4, bottom: 4, left: 4, width: `calc((100% - 8px) / ${n})`, borderRadius: 999, background: O, transform: `translateX(${idx * 100}%)` }} />
      {options.map(([v, l]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} onClick={() => onChange(v)} className="fin-tab"
          style={{ position: 'relative', padding: '0.45rem 1.1rem', minHeight: 36, borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: '0.86rem', fontWeight: 700, fontFamily: FONTS.body, background: 'transparent', color: value === v ? W : th.muted, whiteSpace: 'nowrap' }}>
          {l}
        </button>
      ))}
    </div>
  );
}

// Underline tab strip (v22.32, Admin shell): one row that scrolls sideways, an accent
// underline that slides + resizes to the active tab by transform only (a 100px bar
// scaled), arrow keys move between tabs. tabs: [{ id, label, icon, badge }].
export function FinTabStrip({ th, tabs, value, onChange, label }) {
  const refs = React.useRef({});
  const [geo, setGeo] = React.useState(null); // { x, w }
  const measure = React.useCallback(() => {
    const el = refs.current[value];
    if (el) setGeo({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value]);
  React.useLayoutEffect(() => { measure(); }, [measure, tabs.length]);
  React.useEffect(() => {
    window.addEventListener('resize', measure);
    const el = refs.current[value];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return () => window.removeEventListener('resize', measure);
  }, [measure, value]);
  const onKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex(t => t.id === value);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    e.preventDefault(); onChange(next.id); refs.current[next.id]?.focus();
  };
  return (
    <div style={{ position: 'relative', borderBottom: `1px solid ${th.cardBorder}`, marginBottom: '1.1rem' }}>
      <div role="tablist" aria-label={label} onKeyDown={onKey} className="fin-tabstrip" style={{ display: 'flex', gap: '0.15rem', overflowX: 'auto', position: 'relative' }}>
        {tabs.map(t => {
          const on = t.id === value;
          return (
            <button key={t.id} ref={el => { refs.current[t.id] = el; }} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1}
              onClick={() => onChange(t.id)} className="fin-tabbtn"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', padding: '0.7rem 0.95rem 0.8rem', minHeight: 44, border: 'none', borderRadius: '0.55rem 0.55rem 0 0', background: 'transparent', cursor: 'pointer', fontFamily: FONTS.body, fontSize: '0.9rem', fontWeight: on ? 700 : 600, color: on ? th.text : th.muted, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {t.icon && <span style={{ display: 'flex' }}>{t.icon(on ? O : th.muted)}</span>}
              {t.label}
              {t.badge != null && t.badge > 0 && (
                <span title={t.badgeTitle || ''} style={{ minWidth: 18, height: 18, padding: '0 6px', borderRadius: 999, background: th.danger, color: W, fontSize: '0.7rem', fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  <FinTicker value={t.badge} format={v => Math.round(v)} />
                </span>
              )}
            </button>
          );
        })}
        {geo && <span aria-hidden="true" className="fin-uline" style={{ position: 'absolute', left: 0, bottom: 0, height: 3, width: 100, borderRadius: 3, background: O, transform: `translateX(${geo.x}px) scaleX(${(geo.w / 100).toFixed(4)})` }} />}
      </div>
    </div>
  );
}

// A horizontal bar that grows by transform (scaleX), never width. frac 0..1.
export function FinBar({ th, frac, color, height = 8, track = true, title }) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  return (
    <div title={title} style={{ position: 'relative', height, borderRadius: 999, overflow: 'hidden', background: track ? th.card3 : 'transparent' }}>
      <div className="fin-bar" style={{ position: 'absolute', inset: 0, background: color || O, transform: `scaleX(${f})` }} />
    </div>
  );
}

// Status icons (SVG, never emoji/glyphs). status: ok | error | blocked | skipped | pending | warn
export function FinStatusIcon({ th, status, size = 16 }) {
  const c = status === 'ok' ? th.success : status === 'error' || status === 'blocked' ? th.danger : status === 'warn' ? th.warn : th.muted;
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: c, strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { flexShrink: 0 } };
  if (status === 'ok') return <svg aria-hidden="true" {...common}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.7 2.7L16 10" /></svg>;
  if (status === 'error') return <svg aria-hidden="true" {...common}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>;
  if (status === 'blocked' || status === 'warn') return <svg aria-hidden="true" {...common}><path d="M12 3 2.5 20h19Z" /><path d="M12 10v4M12 17h.01" /></svg>;
  if (status === 'pending') return <svg aria-hidden="true" {...common} className="fin-spin"><path d="M12 3a9 9 0 1 1-9 9" /></svg>;
  return <svg aria-hidden="true" {...common}><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></svg>;
}
export const FinRefreshIcon = ({ color, size = 14, spinning }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={spinning ? 'fin-spin' : undefined}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" />
  </svg>
);

// Shared style objects (inline, token-based).
export function finStyles(th) {
  return {
    title: { fontFamily: FONTS.head, fontWeight: 800, color: th.text, margin: '0 0 0.3rem', fontSize: '1.5rem', overflowWrap: 'break-word', minWidth: 0 },
    lede: { color: th.muted, fontSize: '0.88rem', marginTop: 0, marginBottom: '1.1rem', maxWidth: 760, lineHeight: 1.5 },
    panelTitle: { fontFamily: FONTS.head, fontWeight: 800, fontSize: '1.15rem', color: th.text, overflowWrap: 'break-word', minWidth: 0 },
    panel: { ...card(th), padding: 0, overflow: 'hidden' },
    panelHead: { padding: '1.1rem 1.1rem 1rem', display: 'grid', gap: '1rem' },
    fieldLabel: { display: 'flex', flexDirection: 'column', gap: '0.3rem', fontSize: '0.8rem', color: th.muted },
    input: { ...inp(th), padding: '0.55rem 0.8rem', fontSize: '0.92rem' },
    headCell: { textAlign: 'left', padding: '0.6rem 0.9rem', color: th.muted, fontSize: '0.8rem', fontWeight: 600, background: th.card2, whiteSpace: 'nowrap' },
    cell: { padding: '0.6rem 0.9rem', borderTop: `1px solid ${th.cardBorder}`, fontSize: '0.88rem', color: th.text, verticalAlign: 'middle' },
    primary: btn(th, { padding: '0.6rem 1.2rem', fontSize: '0.92rem', minHeight: 40 }),
    ghost: btn(th, { background: th.card3, color: th.text, padding: '0.55rem 1rem', fontSize: '0.88rem', minHeight: 38 }),
    link: { background: 'none', border: 'none', padding: 0, color: O, fontWeight: 700, cursor: 'pointer', fontSize: 'inherit', fontFamily: FONTS.body },
    footer: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.9rem', padding: '0.85rem 1.1rem', borderTop: `1px solid ${th.cardBorder}`, background: th.card2, flexWrap: 'wrap' },
    srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
  };
}
