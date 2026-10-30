// src/terminations-ui.jsx — Tools · Terminations (v22.33).
//
// Who left, by store, for a calendar quarter or half year. Data comes from
// terminations-report.mjs (a synced copy of each store's Paycor roster — never a live
// Paycor call from here), already scoped server-side: a DM gets their own district, a
// manager their own store, everyone else the whole network.
//
// The chart is a Bklit-style unit bar: each store is a hatched ghost track with one
// rounded square per person. Solid = stayed 90+ days, ring = left inside 90 days, so
// early turnover reads at a glance without a second hue.
import { O, card, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FIN_CSS, FinFigure, FinFigures, FinBanner, FinSkeleton, FinTabs, FinRefreshIcon, finStyles } from './finance-ui.jsx';
import { periodContaining, shiftPeriod, groupByStore, countIn } from './terminations.mjs';

const { useState, useEffect, useRef } = React;

const EARLY_DAYS = 90;
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const fmtDate = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown');
const tenureDays = (p) => (p.hireDate ? Math.round((Date.parse(p.terminationDate) - Date.parse(p.hireDate)) / 86400000) : null);
const isEarly = (p) => { const d = tenureDays(p); return d != null && d >= 0 && d < EARLY_DAYS; };
const tenureText = (p) => {
  const d = tenureDays(p);
  if (d == null || d < 0) return 'Hire date unknown';
  if (d < 60) return `${d} day${d === 1 ? '' : 's'}`;
  const m = Math.round(d / 30.4);
  return m < 24 ? `${m} months` : `${(d / 365).toFixed(1)} years`;
};

const TERM_CSS = (th) => `
.term-track { background-color: ${th.card2}; background-image: repeating-linear-gradient(135deg, ${th.cardBorder} 0 1px, transparent 1px 7px); }
.term-block { animation: termBlockIn 320ms cubic-bezier(.2,.8,.2,1) both; }
@keyframes termBlockIn { from { opacity: 0; transform: scale(0.4); } to { opacity: 1; transform: none; } }
.term-chev { transition: transform 220ms cubic-bezier(.2,.8,.2,1); }
.term-rowbtn[aria-expanded="true"] .term-chev { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .term-block { animation: none; } .term-chev { transition: none; } }`;

export function TerminationsReport({ th, user, isMobile, onBack }) {
  const S = finStyles(th);
  const isAdmin = user?.userType === 'executive' || user?.userType === 'it';
  const [kind, setKind] = useState('quarter');
  const [period, setPeriod] = useState(() => periodContaining('quarter', todayIso()));
  const [district, setDistrict] = useState('all');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [syncing, setSyncing] = useState(false);
  const pollRef = useRef(null);

  const load = async () => {
    try {
      const res = await fetch('/.netlify/functions/terminations-report', { credentials: 'include', headers: { ...authHeader() } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body); setError(null);
      return body;
    } catch (e) { setError(e.message); return null; }
  };
  useEffect(() => { load(); return () => clearInterval(pollRef.current); }, []);

  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    const before = data?.syncedAt || null;
    try {
      await fetch('/.netlify/functions/terminations-sync-background', { method: 'POST', credentials: 'include', headers: { ...authHeader() } });
    } catch { /* the poll below reports the outcome */ }
    let tries = 0;
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      tries++;
      const b = await load();
      if ((b && b.syncedAt && b.syncedAt !== before) || tries >= 60) { clearInterval(pollRef.current); setSyncing(false); }
    }, 5000);
  };

  const today = todayIso();
  const current = periodContaining(kind, today);
  const atLatest = period.start >= current.start;
  const switchKind = (k) => {
    setKind(k);
    setPeriod(periodContaining(k, period.end < today ? period.end : today));
    setOpen(new Set());
  };
  const step = (d) => { setPeriod(p => shiftPeriod(p, d)); setOpen(new Set()); };

  const allStores = data?.stores || [];
  const districts = [...new Set(allStores.map(s => s.district).filter(d => d != null))].sort((a, b) => a - b);
  const stores = district === 'all' ? allStores : allStores.filter(s => String(s.district) === String(district));
  const pcs = new Set(stores.map(s => s.pc));
  const rows = (data?.rows || []).filter(r => pcs.has(String(r.pc)));
  const groups = groupByStore(rows, period, stores);
  const total = countIn(rows, period);
  const prevTotal = countIn(rows, shiftPeriod(period, -1));
  const early = groups.reduce((n, g) => n + g.people.filter(isEarly).length, 0);
  const delta = total - prevTotal;
  const maxCount = Math.max(1, ...groups.map(g => g.count));
  const block = maxCount <= 12 ? 18 : maxCount <= 24 ? 14 : 10;
  const periodText = atLatest ? `${period.label} so far` : period.label;

  const toggle = (pc) => setOpen(prev => { const n = new Set(prev); if (n.has(pc)) n.delete(pc); else n.add(pc); return n; });

  const failed = (data?.sync?.stores || []).filter(s => !s.ok);
  const noDates = isAdmin && data?.syncedAt && (data?.rows || []).length === 0 && (data?.sync?.stores || []).some(s => s.inactiveNoDate > 0);

  return (
    <div className="fin-root" style={{ maxWidth: 1100, margin: '0 auto' }}>
      <style>{FIN_CSS(th) + TERM_CSS(th)}</style>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
          <h2 style={S.title}>Terminations</h2>
          <p style={{ ...S.lede, marginBottom: 0 }}>
            People who left, by store, from Paycor.{data?.scope === 'district' ? ' Your district only.' : data?.scope === 'store' ? ' Your store only.' : ''}
          </p>
        </div>
        {isAdmin && (
          <button type="button" className="fin-btn" onClick={syncNow} disabled={syncing} style={{ ...S.ghost, display: 'inline-flex', alignItems: 'center', gap: '0.45rem', opacity: syncing ? 0.7 : 1 }}>
            <FinRefreshIcon color={th.text} spinning={syncing} />{syncing ? 'Syncing from Paycor' : 'Sync now'}
          </button>
        )}
      </div>

      {error && <FinBanner th={th} tone="error" style={{ marginBottom: '1rem' }}>Couldn’t load the report: {error}</FinBanner>}
      {!data && !error && <FinSkeleton th={th} rows={6} figures={3} />}

      {data && !data.syncedAt && (
        <FinBanner th={th} tone="info" style={{ marginBottom: '1rem' }}>
          {isAdmin ? 'No sync has run yet. Press Sync now to pull every store from Paycor; it takes a minute or two.' : 'This report has not been synced from Paycor yet. Check back tomorrow morning.'}
        </FinBanner>
      )}
      {isAdmin && failed.length > 0 && (
        <FinBanner th={th} tone="warn" style={{ marginBottom: '1rem' }}>
          {failed.length} store{failed.length === 1 ? '' : 's'} couldn’t be read from Paycor in the last sync, so the previous sync’s people are shown for them: {failed.map(f => allStores.find(s => s.pc === f.pc)?.name || f.pc).join(', ')}.
        </FinBanner>
      )}
      {noDates && (
        <FinBanner th={th} tone="warn" style={{ marginBottom: '1rem' }}>
          Paycor returned former employees but no termination date the report recognises. Fields seen: {(data.sync.fieldKeys || []).join(', ') || 'none'}.
        </FinBanner>
      )}

      {data && data.syncedAt && (
        <div style={{ ...S.panel }}>
          <div style={S.panelHead}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <FinTabs th={th} label="Report length" options={[['quarter', 'Quarter'], ['half', 'Half year']]} value={kind} onChange={switchKind} />
              <div role="group" aria-label="Period" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                <button type="button" className="fin-btn" aria-label="Previous period" onClick={() => step(-1)} style={{ ...S.ghost, minHeight: 36, width: 36, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={th.text} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <span aria-live="polite" style={{ minWidth: 150, textAlign: 'center', fontFamily: FONTS.head, fontWeight: 800, color: th.text, fontSize: '1rem' }}>{periodText}</span>
                <button type="button" className="fin-btn" aria-label="Next period" onClick={() => step(1)} disabled={atLatest} style={{ ...S.ghost, minHeight: 36, width: 36, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: atLatest ? 0.4 : 1 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={th.text} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
                </button>
              </div>
              {data.scope === 'all' && districts.length > 1 && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.84rem', color: th.muted, marginLeft: isMobile ? 0 : 'auto' }}>
                  District
                  <select className="fin-input" value={district} onChange={e => { setDistrict(e.target.value); setOpen(new Set()); }} style={{ ...S.input, width: 'auto', minHeight: 36, padding: '0.35rem 0.6rem' }}>
                    <option value="all">All districts</option>
                    {districts.map(d => <option key={d} value={String(d)}>District {d}</option>)}
                  </select>
                </label>
              )}
            </div>
            <FinFigures>
              <FinFigure th={th} label="People who left" value={total} format={n => String(Math.round(n))} note={`${period.start.slice(5).replace('-', '/')} to ${period.end.slice(5).replace('-', '/')}`} />
              <FinFigure th={th} label={`Left within ${EARLY_DAYS} days`} value={early} format={n => String(Math.round(n))} note={total ? `${Math.round((early / total) * 100)}% of everyone who left` : 'Nobody this period'} />
              <FinFigure th={th} label={`Change from ${shiftPeriod(period, -1).short}`} value={delta === 0 ? 'No change' : `${delta > 0 ? '+' : ''}${delta}`} tone={delta > 0 ? 'bad' : delta < 0 ? 'good' : undefined} note={`${prevTotal} that period`} />
              <FinFigure th={th} label="Stores affected" value={groups.length} format={n => String(Math.round(n))} note={`of ${stores.length}`} />
            </FinFigures>
          </div>

          {groups.length === 0 ? (
            <div style={{ padding: '2.2rem 1.1rem', borderTop: `1px solid ${th.cardBorder}`, textAlign: 'center', color: th.muted, fontSize: '0.92rem' }}>
              Nobody left in {periodText}{district !== 'all' ? ` in District ${district}` : ''}.
            </div>
          ) : (
            <div key={`${period.short}|${district}`} style={{ borderTop: `1px solid ${th.cardBorder}` }}>
              <div style={{ display: 'flex', gap: '1.1rem', flexWrap: 'wrap', padding: '0.7rem 1.1rem', fontSize: '0.8rem', color: th.muted }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}><span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 4, background: O }} />Stayed {EARLY_DAYS} days or more</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}><span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 4, boxShadow: `inset 0 0 0 2px ${O}` }} />Left within {EARLY_DAYS} days</span>
              </div>
              {groups.map((g, ri) => {
                const isOpen = open.has(g.pc);
                const people = [...g.people].sort((a, b) => Number(isEarly(a)) - Number(isEarly(b)));
                return (
                  <div key={g.pc} style={{ borderTop: `1px solid ${th.cardBorder}` }}>
                    <button type="button" className="fin-rowbtn term-rowbtn" aria-expanded={isOpen} onClick={() => toggle(g.pc)}
                      style={{ width: '100%', display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr) auto' : 'minmax(0,190px) minmax(0,1fr) 3rem', alignItems: 'center', gap: isMobile ? '0.5rem 0.75rem' : '1rem', padding: '0.75rem 1.1rem', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: th.text, fontFamily: FONTS.body }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', minWidth: 0 }}>
                        <svg className="term-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={th.muted} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M9 18l6-6-6-6" /></svg>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block', fontWeight: 700, fontSize: '0.92rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
                          {g.district != null && <span style={{ display: 'block', fontSize: '0.76rem', color: th.muted }}>District {g.district}</span>}
                        </span>
                      </span>
                      {isMobile && <span className="fin-num" style={{ fontFamily: FONTS.head, fontWeight: 800, fontSize: '1.05rem' }}>{g.count}</span>}
                      <span className="term-track" aria-hidden="true"
                        style={{ gridColumn: isMobile ? '1 / -1' : 'auto', display: 'grid', gridTemplateColumns: `repeat(${maxCount}, minmax(0, ${block}px))`, gap: block >= 14 ? 4 : 3, padding: 5, borderRadius: 8, minWidth: 0 }}>
                        {people.map((p, i) => (
                          <span key={p.id + p.terminationDate} className="term-block"
                            style={{ aspectRatio: '1 / 1', borderRadius: Math.max(3, Math.round(block * 0.3)), background: isEarly(p) ? th.card : O, boxShadow: isEarly(p) ? `inset 0 0 0 2px ${O}` : 'none', animationDelay: `${Math.min(ri * 40 + i * 22, 900)}ms` }} />
                        ))}
                      </span>
                      {!isMobile && <span className="fin-num" style={{ fontFamily: FONTS.head, fontWeight: 800, fontSize: '1.05rem', textAlign: 'right' }}>{g.count}</span>}
                      <span style={S.srOnly}>{g.count} left, {g.people.filter(isEarly).length} within {EARLY_DAYS} days</span>
                    </button>
                    <div className="fin-disclose" data-open={isOpen ? 'true' : 'false'} aria-hidden={!isOpen}>
                      <div>
                        {(
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th style={S.headCell}>Name</th>
                                {!isMobile && <th style={S.headCell}>Job title</th>}
                                {!isMobile && <th style={S.headCell}>Hired</th>}
                                <th style={S.headCell}>Left</th>
                                <th style={S.headCell}>Time there</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.people.map(p => (
                                <tr key={p.id + p.terminationDate} className="fin-row">
                                  <td style={{ ...S.cell, fontWeight: 600 }}>{p.name}</td>
                                  {!isMobile && <td style={{ ...S.cell, color: th.muted }}>{p.jobTitle || 'Not listed'}</td>}
                                  {!isMobile && <td style={S.cell}>{fmtDate(p.hireDate)}</td>}
                                  <td style={S.cell}>{fmtDate(p.terminationDate)}</td>
                                  <td style={{ ...S.cell, color: isEarly(p) ? O : th.text, fontWeight: isEarly(p) ? 700 : 400 }}>{tenureText(p)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ ...S.footer, justifyContent: 'flex-start', color: th.muted, fontSize: '0.8rem' }}>
            Last synced from Paycor {new Date(data.syncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. Syncs every morning.
          </div>
        </div>
      )}
    </div>
  );
}
