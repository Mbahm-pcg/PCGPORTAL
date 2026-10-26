// src/executive-view.jsx — the Executive view (v22.18, 2026-10-25).
//
// One page, five tabs, one blob-backed read per tab (analyst.mjs action 'exec' →
// exec-lib/exec-data.mjs, the same builders the MCP get_exec_* tools use). No live
// POS or Paycor calls from here. House rule for every sales figure: current, then vs
// last week, then vs last year, compared like for like.
import { O, card, pageTitle, sectionTitle, microLabel, thCell, tdCell, pill } from './theme.js';
import { authHeader } from './portal-auth.mjs';

const GOOD = '#22c55e', BAD = '#ef4444', WARN = '#f59e0b', INFO = '#3b82f6';
const VIEWS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'districts', label: 'Districts & DMs' },
  { id: 'development', label: 'Development & supply' },
  { id: 'health', label: 'Data health' },
];

const usd0 = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString());
const usd2 = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const usdK = (n) => (n == null ? '—' : Math.abs(n) >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e4 ? '$' + Math.round(n / 1000) + 'K' : usd0(n));
const num = (n) => (n == null ? '—' : Math.round(n).toLocaleString());
const pct1 = (n) => (n == null ? '—' : Number(n).toFixed(1) + '%');
const spct = (n) => (n == null ? '—' : (n > 0 ? '+' : '') + Number(n).toFixed(1) + '%');
const dateShort = (ymd) => (ymd ? new Date(String(ymd).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
const timeShort = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—');
const hr12 = (h) => (h == null ? '' : `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`);
const upGood = (v) => (v == null ? null : v > 0 ? GOOD : v < 0 ? BAD : null);
const laborColor = (v, thr = 23) => (v == null ? null : v >= 30 ? BAD : v >= thr ? WARN : null);

// ── data hook ──────────────────────────────────────────────────────────────────
function useExecView(view, user, extra = {}) {
  const [state, setState] = React.useState({ loading: true, data: null, error: null, builtAt: null, buildMs: null });
  const key = JSON.stringify(extra);
  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch('/.netlify/functions/analyst', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ action: 'exec', view, userId: user?.id, userRole: user?.userType, ...extra }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      if (json?.data?.error) throw new Error(json.data.error);
      setState({ loading: false, data: json.data, error: null, builtAt: json.builtAt, buildMs: json.buildMs });
    } catch (e) {
      setState({ loading: false, data: null, error: e.message || 'Failed to load', builtAt: null, buildMs: null });
    }
  }, [view, user?.id, key]);
  React.useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

// ── atoms ──────────────────────────────────────────────────────────────────────
function Tile({ th, label, value, sub, color, accent }) {
  return (
    <div style={{ ...card(th), padding: '1rem 1.15rem', borderTop: `3px solid ${accent || th.cardBorder}`, minHeight: '6.6rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <div style={microLabel(th)}>{label}</div>
      <div style={{ fontFamily: "'Raleway'", fontWeight: 800, fontSize: '1.55rem', lineHeight: 1.1, color: color || th.text }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: '0.74rem', color: th.muted, lineHeight: 1.35 }}>{sub}</div>}
    </div>
  );
}
function Delta({ v, label }) {
  const c = upGood(v);
  return <span style={{ color: c || 'inherit', fontWeight: 700 }}>{spct(v)}{label ? <span style={{ fontWeight: 500 }}> {label}</span> : null}</span>;
}
function Card({ th, title, note, children, style }) {
  return (
    <div style={{ ...card(th), padding: '1rem 1.15rem', minWidth: 0, ...style }}>
      {title && <div style={sectionTitle(th)}>{title}</div>}
      {note && <div style={{ fontSize: '0.74rem', color: th.muted, margin: '0.2rem 0 0.75rem' }}>{note}</div>}
      {children}
    </div>
  );
}
function Bar({ value, max, color, width = 90 }) {
  const w = max > 0 ? Math.max(2, Math.round((Math.abs(value) / max) * width)) : 0;
  return <span style={{ display: 'inline-block', width: w, height: 8, borderRadius: 4, background: color || INFO, marginRight: 6, verticalAlign: 'middle', opacity: 0.85 }} />;
}
function Empty({ th, children }) { return <div style={{ color: th.muted, fontSize: '0.8rem', padding: '0.5rem 0' }}>{children}</div>; }
function Loading({ th, error, reload }) {
  return (
    <div style={{ padding: '2rem', textAlign: 'center', color: error ? BAD : th.muted, fontSize: '0.85rem' }}>
      {error ? <>⚠️ {error} <button onClick={reload} style={{ marginLeft: 8, background: 'none', border: `1px solid ${th.cardBorder}`, color: th.text, borderRadius: 6, padding: '0.2rem 0.6rem', cursor: 'pointer' }}>Retry</button></> : 'Loading…'}
    </div>
  );
}

// Sortable table. cols: { key, label, fmt?, num?, color?(v,row), bar?, barMax?, width? }
function Table({ th, cols, rows, defaultSort, defaultDir = -1, keyField, maxHeight = 420, filter }) {
  const [sortKey, setSortKey] = React.useState(defaultSort || null);
  const [dir, setDir] = React.useState(defaultDir);
  const [q, setQ] = React.useState('');
  const sorted = React.useMemo(() => {
    let r = [...(rows || [])];
    if (filter && q) { const s = q.toLowerCase(); r = r.filter((row) => cols.some((c) => String(row[c.key] ?? '').toLowerCase().includes(s))); }
    if (sortKey) {
      const col = cols.find((c) => c.key === sortKey);
      r.sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        if (col?.num) { const an = av == null ? -Infinity : Number(av), bn = bv == null ? -Infinity : Number(bv); return dir * (bn - an); }
        return dir * String(bv ?? '').localeCompare(String(av ?? ''), undefined, { numeric: true });
      });
    }
    return r;
  }, [rows, sortKey, dir, q]);
  const maxes = React.useMemo(() => Object.fromEntries(cols.filter((c) => c.bar).map((c) => [c.key, Math.max(...(rows || []).map((r) => Math.abs(Number(r[c.key]) || 0)), 0)])), [rows]);
  return (
    <div>
      {filter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" style={{ background: th.inputBg, border: `1px solid ${th.inputBorder}`, borderRadius: 6, padding: '0.35rem 0.6rem', color: th.text, fontSize: '0.78rem', minWidth: 180 }} />
          <span style={{ fontSize: '0.72rem', color: th.muted }}>{sorted.length} of {(rows || []).length}</span>
        </div>
      )}
      <div style={{ overflow: 'auto', maxHeight }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead>
            <tr>{cols.map((c) => (
              <th key={c.key} onClick={() => { if (sortKey === c.key) setDir((d) => -d); else { setSortKey(c.key); setDir(c.num ? -1 : 1); } }}
                style={{ ...thCell(th, { textAlign: c.num ? 'right' : 'left', cursor: 'pointer', position: 'sticky', top: 0, background: th.card, borderBottom: `1px solid ${th.cardBorder}`, color: sortKey === c.key ? O : th.muted }) }}>
                {c.label}{sortKey === c.key ? (dir < 0 ? ' ↓' : ' ↑') : ''}
              </th>))}</tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr key={keyField ? row[keyField] : i} style={{ borderBottom: `1px solid ${th.cardBorder}` }}>
                {cols.map((c) => {
                  const v = row[c.key];
                  const color = c.color ? c.color(v, row) : null;
                  return (
                    <td key={c.key} style={{ ...tdCell(th, { textAlign: c.num ? 'right' : 'left', whiteSpace: c.wrap ? 'normal' : 'nowrap', color: color || th.text, fontWeight: color ? 700 : 400 }) }}>
                      {c.bar && <Bar value={Number(v) || 0} max={c.barMax || maxes[c.key]} color={c.barColor || INFO} />}
                      {c.fmt ? c.fmt(v, row) : (v ?? '—')}
                    </td>);
                })}
              </tr>))}
            {!sorted.length && <tr><td colSpan={cols.length} style={tdCell(th, { color: th.muted })}>Nothing to show.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const grid = (min = 220) => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: '0.75rem', marginBottom: '1rem' });
const two = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: '0.75rem', marginBottom: '1rem' };

// ── Today ──────────────────────────────────────────────────────────────────────
function TodayView({ th, user, go }) {
  const { loading, data, error, reload, builtAt } = useExecView('today', user);
  const att = useExecView('attention', user);
  if (loading || error) return <Loading th={th} error={error} reload={reload} />;
  const n = data.network; const st = n.sameTimeLastWeek; const wtd = n.wtd;
  const dc = data.districts.map((d) => ({ ...d, label: `District ${d.district}` }));
  return (
    <div>
      <div style={{ fontSize: '0.78rem', color: th.muted, marginBottom: '0.75rem' }}>
        Business date {data.busDt} · labor feed {timeShort(data.asOf)} · sales cache {data.todayDataAsOf ? timeShort(data.todayDataAsOf) : 'not refreshed today'} · built {timeShort(builtAt)}
      </div>
      <div style={grid(200)}>
        <Tile th={th} accent={INFO} label="Net sales today" value={usd0(n.sales)}
          sub={st ? <>vs same time last week <Delta v={st.pct} /> ({usd0(st.lastWeek)} through {hr12(st.throughHour + 1)})</> : 'Same-time comparison needs the hourly cache (available after 6 AM)'} />
        <Tile th={th} accent={INFO} label={`Week to date (from Sun ${dateShort(wtd.weekStart)})`} value={usd0(wtd.sales)}
          sub={wtd.pct != null ? <>vs same days last week <Delta v={wtd.pct} /> ({usd0(wtd.lastWeekSameDays)})</> : 'Last week not in history yet'} />
        <Tile th={th} accent={laborColor(n.laborPct, data.laborThresholdPct) || GOOD} color={laborColor(n.laborPct, data.laborThresholdPct)} label="Labor today" value={pct1(n.laborPct)}
          sub={<>{usd0(n.laborDollars)} · threshold {data.laborThresholdPct}% · {n.scheduledNow} scheduled now · {n.overtime} in OT</>} />
        <Tile th={th} accent={INFO} label="Guests today" value={num(n.guests)} sub={<>avg check {usd2(n.avgCheck)} · discounts {usd0(n.discounts)}</>} />
        <Tile th={th} accent={INFO} label="Stores reporting" value={n.storesReporting} sub={<>{data.laborWatch.length} at or over {data.laborThresholdPct}% labor</>} />
      </div>
      <div style={two}>
        <Card th={th} title="Needs attention" note="Grouped from the same feeds the home page reads.">
          {att.loading ? <Empty th={th}>Loading…</Empty> : att.error ? <Empty th={th}>{att.error}</Empty> : !att.data?.items?.length ? <Empty th={th}>Nothing flagged right now.</Empty> : (
            att.data.items.map((it) => (
              <div key={it.key} style={{ display: 'grid', gridTemplateColumns: '3.2rem 1fr', gap: '0.6rem', padding: '0.45rem 0', borderBottom: `1px solid ${th.cardBorder}`, alignItems: 'baseline' }}>
                <div style={{ fontFamily: "'Raleway'", fontWeight: 800, fontSize: '1.2rem', color: it.severity === 'High' ? BAD : it.severity === 'Medium' ? WARN : th.text }}>{num(it.count)}</div>
                <div><div style={{ fontSize: '0.82rem', fontWeight: 600, color: th.text }}>{it.title}</div><div style={{ fontSize: '0.72rem', color: th.muted }}>{it.area} · {it.severity}{it.detail ? ` · ${it.detail}` : ''}</div></div>
              </div>))
          )}
        </Card>
        <Card th={th} title="Districts today" note="Sales-weighted labor %. WTD is Sunday-start vs the same days last week.">
          <Table th={th} keyField="district" rows={dc} defaultSort="district" defaultDir={1} maxHeight={360} cols={[
            { key: 'label', label: 'District' }, { key: 'dmName', label: 'DM' }, { key: 'stores', label: 'Stores', num: true },
            { key: 'sales', label: 'Net sales', num: true, fmt: usd0, bar: true },
            { key: 'laborPct', label: 'Labor %', num: true, fmt: pct1, color: (v) => laborColor(v, data.laborThresholdPct) },
            { key: 'guests', label: 'Guests', num: true, fmt: num }, { key: 'avgCheck', label: 'Avg check', num: true, fmt: usd2 },
            { key: 'vsLastWeekWtdPct', label: 'WTD vs LW', num: true, fmt: spct, color: upGood },
            { key: 'overThreshold', label: `Over ${data.laborThresholdPct}%`, num: true, color: (v) => (v > 0 ? BAD : null) },
          ]} />
        </Card>
      </div>
      <Card th={th} title={`Stores at or over ${data.laborThresholdPct}% labor today`} note="Highest first. Click a column to sort." style={{ marginBottom: '1rem' }}>
        <Table th={th} keyField="pc" rows={data.laborWatch} defaultSort="laborPct" cols={[
          { key: 'name', label: 'Store' }, { key: 'dmName', label: 'DM' }, { key: 'sales', label: 'Net sales', num: true, fmt: usd0 },
          { key: 'laborPct', label: 'Labor %', num: true, fmt: pct1, color: (v) => laborColor(v, data.laborThresholdPct), bar: true, barColor: WARN },
          { key: 'laborDollars', label: 'Labor $', num: true, fmt: usd0 }, { key: 'guests', label: 'Guests', num: true, fmt: num },
          { key: 'scheduledNow', label: 'On now', num: true }, { key: 'overtime', label: 'OT', num: true, color: (v) => (v > 0 ? WARN : null) },
        ]} />
      </Card>
      <Card th={th} title="All stores today" note="Today's net sales from the labor feed; guests and discounts from the Pulse cache.">
        <Table th={th} keyField="pc" rows={data.stores} defaultSort="sales" filter maxHeight={520} cols={[
          { key: 'name', label: 'Store' }, { key: 'city', label: 'City' }, { key: 'district', label: 'Dist', num: true, fmt: (v) => (v ? 'D' + v : '—') },
          { key: 'sales', label: 'Net sales', num: true, fmt: usd0, bar: true },
          { key: 'laborPct', label: 'Labor %', num: true, fmt: pct1, color: (v) => laborColor(v, data.laborThresholdPct) },
          { key: 'guests', label: 'Guests', num: true, fmt: num }, { key: 'avgCheck', label: 'Avg check', num: true, fmt: usd2 },
          { key: 'wtdSales', label: 'WTD', num: true, fmt: usd0 },
          { key: 'wtdLastWeekSameDays', label: 'LW same days', num: true, fmt: usd0 },
          { key: 'discounts', label: 'Discounts', num: true, fmt: usd0 },
        ]} />
      </Card>
    </div>
  );
}

// ── Week ───────────────────────────────────────────────────────────────────────
function WeekView({ th, user }) {
  const [weekIndex, setWeekIndex] = React.useState(0);
  const { loading, data, error, reload } = useExecView('week', user, { weekIndex });
  if (loading || error) return <Loading th={th} error={error} reload={reload} />;
  const n = data.network;
  const dc = data.districts.map((d) => ({ ...d, label: `District ${d.district}` }));
  const ly = data.stores.filter((s) => s.vsLastYearPct != null).sort((a, b) => b.vsLastYearPct - a.vsLastYearPct);
  const lyMax = Math.max(...ly.map((s) => Math.abs(s.vsLastYearPct)), 1);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '0.78rem', color: th.muted }}>Uploaded weekly report · week #{data.weekNum} ending {data.weekEnd}{data.isDraft ? ' (draft)' : ''}</div>
        {data.weeksAvailable.length > 1 && (
          <select value={weekIndex} onChange={(e) => setWeekIndex(Number(e.target.value))} style={{ background: th.inputBg, border: `1px solid ${th.inputBorder}`, color: th.text, borderRadius: 6, padding: '0.25rem 0.5rem', fontSize: '0.78rem' }}>
            {data.weeksAvailable.map((w) => <option key={w.index} value={w.index}>Wk #{w.weekNum} — {w.weekEnd}</option>)}
          </select>)}
      </div>
      <div style={grid(200)}>
        <Tile th={th} accent={INFO} label="Net sales" value={usdK(n.sales)} sub={<>vs prior week <Delta v={n.vsPriorWeekPct} /> ({(n.vsPriorWeekDollars >= 0 ? '+' : '-') + usd0(Math.abs(n.vsPriorWeekDollars))}) · vs last year <Delta v={n.vsLastYearPct} /> ({n.storesWithLastYear} of {n.stores} stores comparable)</>} />
        <Tile th={th} accent={INFO} label="Guests" value={num(n.guests)} sub={<>vs prior week <Delta v={n.vsPriorWeekGuestsPct} /> · {usd0(n.perStoreSales)} per store</>} />
        <Tile th={th} accent={laborColor(n.laborPct) || GOOD} color={laborColor(n.laborPct)} label="Labor %" value={pct1(n.laborPct)} sub="network average for the week" />
        <Tile th={th} accent={INFO} label="Food cost %" value={pct1(n.foodCostPct)} sub={<>bakery {pct1(n.bakeryPct)}</>} />
        <Tile th={th} accent={n.totalCostPct >= 50 ? WARN : GOOD} label="Total cost % (labor + food)" value={pct1(n.totalCostPct)} sub={<>next week forecast {usdK(n.forecastNextWeek)}</>} />
      </div>
      <div style={two}>
        <Card th={th} title="Districts" note="Same columns as the store table. Total % is labor + food.">
          <Table th={th} keyField="district" rows={dc} defaultSort="district" defaultDir={1} maxHeight={360} cols={[
            { key: 'label', label: 'District' }, { key: 'dmName', label: 'DM' }, { key: 'stores', label: 'Stores', num: true },
            { key: 'sales', label: 'Net sales', num: true, fmt: usd0, bar: true },
            { key: 'vsPriorWeekPct', label: 'vs PW', num: true, fmt: spct, color: upGood }, { key: 'vsLastYearPct', label: 'vs LY', num: true, fmt: spct, color: upGood },
            { key: 'guests', label: 'Guests', num: true, fmt: num }, { key: 'laborPct', label: 'Labor %', num: true, fmt: pct1, color: (v) => laborColor(v) },
            { key: 'foodCostPct', label: 'Food %', num: true, fmt: pct1 }, { key: 'totalCostPct', label: 'Total %', num: true, fmt: pct1, color: (v) => (v >= 50 ? BAD : null) },
          ]} />
        </Card>
        <Card th={th} title="Flagged for review" note={`Total cost at or above ${data.thresholds.flagTotalCostPct}% or labor at or above ${data.thresholds.flagLaborPct}% for the week.`}>
          {data.flagged.length ? (
            <Table th={th} keyField="pc" rows={data.flagged} defaultSort="totalCostPct" maxHeight={360} cols={[
              { key: 'name', label: 'Store' }, { key: 'dmName', label: 'DM' }, { key: 'sales', label: 'Net sales', num: true, fmt: usd0 },
              { key: 'vsPriorWeekPct', label: 'vs PW', num: true, fmt: spct, color: upGood },
              { key: 'laborPct', label: 'Labor %', num: true, fmt: pct1, color: (v) => (v >= 30 ? BAD : null) },
              { key: 'totalCostPct', label: 'Total %', num: true, fmt: pct1, color: (v) => (v >= 58 ? BAD : null) },
            ]} />) : <Empty th={th}>No store over the flag thresholds this week.</Empty>}
        </Card>
      </div>
      <Card th={th} title="Every store vs the same week last year" note="Best to worst. Stores without a last-year week are listed in the table as “new”." style={{ marginBottom: '1rem' }}>
        {ly.length ? ly.map((s) => (
          <div key={s.pc} style={{ display: 'grid', gridTemplateColumns: '9rem 1fr 4.5rem', alignItems: 'center', gap: '0.5rem', fontSize: '0.76rem', padding: '1px 0' }}>
            <span style={{ color: th.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            <div style={{ position: 'relative', height: 10 }}>
              <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: th.cardBorder }} />
              <div style={{ position: 'absolute', top: 1, height: 8, borderRadius: 4, background: s.vsLastYearPct >= 0 ? GOOD : BAD, opacity: 0.85,
                left: s.vsLastYearPct >= 0 ? '50%' : `${50 - (Math.abs(s.vsLastYearPct) / lyMax) * 50}%`, width: `${(Math.abs(s.vsLastYearPct) / lyMax) * 50}%` }} />
            </div>
            <span style={{ textAlign: 'right', color: upGood(s.vsLastYearPct) || th.text, fontWeight: 700 }}>{spct(s.vsLastYearPct)}</span>
          </div>)) : <Empty th={th}>No last-year comparison in this week's report.</Empty>}
      </Card>
      <Card th={th} title="All stores" note="Click a column to sort; type to filter. Target is the store's labor + food target.">
        <Table th={th} keyField="pc" rows={data.stores} defaultSort="sales" filter maxHeight={560} cols={[
          { key: 'name', label: 'Store' }, { key: 'city', label: 'City' }, { key: 'district', label: 'Dist', num: true, fmt: (v) => (v ? 'D' + v : '—') },
          { key: 'sales', label: 'Net sales', num: true, fmt: usd0, bar: true },
          { key: 'vsPriorWeekPct', label: 'vs PW', num: true, fmt: spct, color: upGood },
          { key: 'vsLastYearPct', label: 'vs LY', num: true, fmt: (v) => (v == null ? 'new' : spct(v)), color: upGood },
          { key: 'guests', label: 'Guests', num: true, fmt: num }, { key: 'dcpPct', label: 'DCP %', num: true, fmt: pct1 }, { key: 'bakeryPct', label: 'Bakery %', num: true, fmt: pct1 },
          { key: 'laborPct', label: 'Labor %', num: true, fmt: pct1, color: (v) => laborColor(v) }, { key: 'totalCostPct', label: 'Total %', num: true, fmt: pct1, color: (v) => (v >= 55 ? BAD : null) },
          { key: 'targetPct', label: 'Target', num: true, fmt: (v) => (v ? Math.round(v) + '%' : '—') }, { key: 'forecast', label: 'Forecast', num: true, fmt: usd0 },
        ]} />
      </Card>
    </div>
  );
}

// ── Districts & DMs ─────────────────────────────────────────────────────────────
function DistrictsView({ th, user, stores }) {
  const { loading, data, error, reload } = useExecView('districts', user);
  const [complaints, setComplaints] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    fetch('/.netlify/functions/case-watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ networkSummary: true }) })
      .then((r) => r.json()).then((j) => { if (alive) setComplaints(Array.isArray(j?.leaderboard) ? j.leaderboard : []); }).catch(() => { if (alive) setComplaints([]); });
    return () => { alive = false; };
  }, []);
  if (loading || error) return <Loading th={th} error={error} reload={reload} />;
  const sc = data.scorecard;
  const storeName = (pc) => (stores || []).find((s) => String(s.pc) === String(pc))?.name || `PC ${pc}`;
  const scoreColor = (v) => (v == null ? null : v >= sc?.bands?.strong ? GOOD : v >= sc?.bands?.watch ? WARN : BAD);
  return (
    <div>
      <Card th={th} title={sc ? `DM scorecard · week of ${dateShort(sc.weekOf)}` : 'DM scorecard'} style={{ marginBottom: '1rem' }}
        note={sc ? `Computed ${timeShort(sc.computedAt)} · labor 25%, sales 25%, DCP 20%, response 15%, tickets 15% · ${sc.bands.strong}+ strong, ${sc.bands.watch}-${sc.bands.strong - 1} watch · sales growth: ${sc.basis?.sales || 'last complete week vs the week before'} · DCP: ${sc.basis?.dcp || 'current week'}` : 'The analyst run has not written a scorecard yet.'}>
        {sc ? (
          <Table th={th} keyField="district" rows={sc.rows} defaultSort="rank" defaultDir={1} maxHeight={420} cols={[
            { key: 'rank', label: '#', num: true }, { key: 'dmName', label: 'DM' }, { key: 'district', label: 'Dist', num: true, fmt: (v) => 'D' + v },
            { key: 'score', label: 'Score', num: true, bar: true, barMax: 100, color: scoreColor },
            { key: 'scoreChange', label: 'Change', num: true, fmt: (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v), color: upGood },
            { key: 'laborPct', label: 'Labor %', num: true, fmt: pct1, color: (v) => laborColor(v) },
            { key: 'salesGrowthPct', label: 'Sales growth', num: true, fmt: spct, color: upGood },
            { key: 'dcpPct', label: 'DCP %', num: true, fmt: pct1 }, { key: 'openTickets', label: 'Open tickets', num: true },
            { key: 'responseMinutes', label: 'Response (min)', num: true, fmt: (v) => (v == null ? 'n/a' : num(v)) },
          ]} />) : <Empty th={th}>No scorecard yet.</Empty>}
      </Card>
      <div style={two}>
        <Card th={th} title="Top complaint stores this month" note="From Case Watch (current calendar month).">
          {complaints == null ? <Empty th={th}>Loading…</Empty> : !complaints.length ? <Empty th={th}>No complaints this month.</Empty> : (
            complaints.slice(0, 8).map((row, i) => (
              <div key={row.store_pc || i} style={{ display: 'grid', gridTemplateColumns: '1.4rem 1fr auto', gap: '0.5rem', alignItems: 'center', padding: '0.4rem 0', borderBottom: `1px solid ${th.cardBorder}`, fontSize: '0.8rem' }}>
                <span style={{ color: th.muted }}>{i + 1}</span>
                <span><span style={{ fontWeight: 600, color: th.text }}>{storeName(row.store_pc)}</span>{row.topCategory ? <span style={{ color: th.muted }}> · mostly {row.topCategory}</span> : null}{row.worstCount ? <span style={{ color: BAD }}> · {row.worstCount} worst-tier</span> : null}</span>
                <span style={{ fontFamily: "'Raleway'", fontWeight: 800, color: BAD }}>{row.count ?? '—'}</span>
              </div>))
          )}
        </Card>
        <Card th={th} title="Open Orion cases" note="Untouched cases close themselves when the condition clears; the rest stay until someone acts.">
          {data.openCases.length ? (
            <Table th={th} keyField="id" rows={data.openCases} defaultSort="createdAt" maxHeight={360} cols={[
              { key: 'severity', label: 'Sev', fmt: (v) => <span style={pill(v === 'high' ? BAD : v === 'medium' ? WARN : th.muted)}>{v}</span> },
              { key: 'title', label: 'Case', wrap: true }, { key: 'storeName', label: 'Store' }, { key: 'status', label: 'Status' },
              { key: 'seenCount', label: 'Seen', num: true }, { key: 'createdAt', label: 'Opened', fmt: (v) => dateShort(v) },
            ]} />) : <Empty th={th}>No open cases.</Empty>}
        </Card>
      </div>
    </div>
  );
}

// ── Development & supply ────────────────────────────────────────────────────────
function DevelopmentView({ th, user, go }) {
  const { loading, data, error, reload } = useExecView('development', user);
  if (loading || error) return <Loading th={th} error={error} reload={reload} />;
  const p = data.projects, nd = data.ndcp, pf = data.portfolio;
  const ndMax = Math.max(...(nd.weeks || []).map((w) => w.spend), 1);
  const typeRows = Object.entries(p.byType).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  return (
    <div>
      <div style={grid(190)}>
        <Tile th={th} accent={INFO} label="Locations" value={pf.locations} sub={<>{pf.open} open · {pf.remodel} remodel · {pf.tempClosed} temp closed · {pf.comingSoon} coming soon</>} />
        <Tile th={th} accent={INFO} label="Next-Gen stores" value={pf.nextGen} sub={<>{pf.locations - pf.permanentlyClosed ? Math.round((pf.nextGen / (pf.locations - pf.permanentlyClosed)) * 100) : 0}% of the portfolio · {pf.bridge} Bridge · {pf.districts} districts</>} />
        <Tile th={th} accent={p.counts.overdue ? BAD : GOOD} label="Active projects" value={p.counts.active} color={null} sub={<><span style={{ color: p.counts.overdue ? BAD : th.muted, fontWeight: 700 }}>{p.counts.overdue} past due</span> · {p.counts.noDueDate} without a due date · {p.counts.complete} complete</>} />
        <Tile th={th} accent={INFO} label="NDCP spend, avg full week" value={usdK(nd.totals?.avgFullWeekSpend)} sub={nd.totals ? <>over {nd.totals.fullWeeks} complete weeks</> : nd.error || 'No NDCP data'} />
        <Tile th={th} accent={INFO} label="NDCP spend, last 13 weeks" value={usdK(nd.totals?.spend)} sub={nd.totals ? <>{num(nd.totals.orders)} orders · {num(nd.totals.revisedOrders)} revised at least once</> : ''} />
      </div>
      <div style={two}>
        <Card th={th} title="NDCP weekly spend" note={nd.totals?.basis || ''}>
          {nd.weeks?.length ? nd.weeks.map((w, i) => {
            const partial = i === nd.weeks.length - 1;
            return (
              <div key={w.weekOf} style={{ display: 'grid', gridTemplateColumns: '4.5rem 1fr 5.5rem', gap: '0.5rem', alignItems: 'center', fontSize: '0.76rem', padding: '1px 0' }}>
                <span style={{ color: th.muted }}>{dateShort(w.weekOf)}</span>
                <div style={{ height: 10 }}><div style={{ height: 8, borderRadius: 4, background: partial ? th.cardBorder : INFO, opacity: 0.85, width: `${(w.spend / ndMax) * 100}%` }} /></div>
                <span style={{ textAlign: 'right', color: th.text }}>{usdK(w.spend)}{partial ? <span style={{ color: th.muted }}> partial</span> : ''}</span>
              </div>);
          }) : <Empty th={th}>{nd.error || 'No NDCP orders in the last 13 weeks.'}</Empty>}
        </Card>
        <Card th={th} title="Projects by type" note="Counts exclude records named “test”.">
          {typeRows.map((r) => (
            <div key={r.type} style={{ display: 'grid', gridTemplateColumns: '8rem 1fr 2rem', gap: '0.5rem', alignItems: 'center', fontSize: '0.78rem', padding: '2px 0' }}>
              <span style={{ color: th.text }}>{r.type}</span>
              <div style={{ height: 10 }}><div style={{ height: 8, borderRadius: 4, background: INFO, opacity: 0.85, width: `${(r.count / Math.max(...typeRows.map((x) => x.count), 1)) * 100}%` }} /></div>
              <span style={{ textAlign: 'right', color: th.text }}>{r.count}</span>
            </div>))}
          <div style={{ marginTop: '0.75rem' }}><button onClick={() => go && go('projects')} style={{ background: 'none', border: `1px solid ${th.cardBorder}`, color: O, borderRadius: 6, padding: '0.3rem 0.7rem', cursor: 'pointer', fontSize: '0.76rem', fontWeight: 700 }}>Open Projects →</button></div>
        </Card>
      </div>
      <Card th={th} title="Construction and remodel projects" note="Past due = not complete and past its due date. A project with no due date can never be overdue, which is why it is called out.">
        <Table th={th} keyField="id" rows={p.rows} defaultSort="overdue" filter maxHeight={520} cols={[
          { key: 'name', label: 'Project' }, { key: 'address', label: 'Address' }, { key: 'type', label: 'Type' }, { key: 'pc', label: 'PC#' },
          { key: 'dueDate', label: 'Due', fmt: (v) => (v ? dateShort(v) + ', ' + String(v).slice(0, 4) : 'not set'), color: (v, r) => (!v && !r.complete ? WARN : null) },
          { key: 'overdue', label: 'Status', fmt: (v, r) => <span style={pill(r.complete ? GOOD : v ? BAD : INFO)}>{r.complete ? 'Complete' : v ? 'Overdue' : 'Active'}</span> },
          { key: 'dmName', label: 'DM', fmt: (v) => v || '—' },
        ]} />
      </Card>
    </div>
  );
}

// ── Data health ─────────────────────────────────────────────────────────────────
function HealthView({ th, user }) {
  const { loading, data, error, reload } = useExecView('health', user);
  if (loading || error) return <Loading th={th} error={error} reload={reload} />;
  const feeds = data.systemHealth?.feeds || [];
  const count = (s) => feeds.filter((f) => f.status === s).length;
  const pass = data.checks.filter((c) => c.status === 'pass').length, fail = data.checks.filter((c) => c.status === 'fail').length;
  const statusColor = (s) => (s === 'OK' || s === 'pass' ? GOOD : s === 'DOWN' || s === 'fail' ? BAD : s === 'unknown' ? th.muted : WARN);
  return (
    <div>
      <div style={grid(170)}>
        <Tile th={th} accent={GOOD} label="Feeds OK" value={count('OK')} sub={<>of {feeds.length} tracked · as of {data.systemHealth ? timeShort(new Date(data.systemHealth.asOf).toISOString()) : '—'}</>} />
        <Tile th={th} accent={count('DOWN') ? BAD : GOOD} color={count('DOWN') ? BAD : null} label="Down" value={count('DOWN')} />
        <Tile th={th} accent={count('STALE') ? WARN : GOOD} color={count('STALE') ? WARN : null} label="Stale" value={count('STALE')} />
        <Tile th={th} accent={fail ? BAD : GOOD} color={fail ? BAD : null} label="Reconciliation checks" value={`${pass} / ${data.checks.length}`} sub={fail ? `${fail} failing` : 'all passing'} />
      </div>
      <div style={two}>
        <Card th={th} title="Numbers that must agree" note="Recomputed on every open from the same blobs the modules read.">
          {data.checks.map((c) => (
            <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '4.5rem 1fr', gap: '0.6rem', padding: '0.45rem 0', borderBottom: `1px solid ${th.cardBorder}`, alignItems: 'start' }}>
              <span style={pill(statusColor(c.status))}>{c.status}</span>
              <div><div style={{ fontSize: '0.8rem', fontWeight: 600, color: th.text }}>{c.label}</div><div style={{ fontSize: '0.72rem', color: th.muted }}>{c.detail}</div></div>
            </div>))}
        </Card>
        <Card th={th} title="Feed status" note="From System Health; critical feeds page the on-call list when they change state.">
          {feeds.length ? (
            <Table th={th} keyField="key" rows={feeds} defaultSort="status" defaultDir={1} maxHeight={420} cols={[
              { key: 'category', label: 'Group' }, { key: 'label', label: 'Feed' },
              { key: 'status', label: 'Status', fmt: (v) => <span style={pill(statusColor(v))}>{v}</span> },
              { key: 'critical', label: 'Critical', fmt: (v) => (v ? 'yes' : '') },
              { key: 'error', label: 'Note', wrap: true, fmt: (v, r) => v || r.beat?.error || '' },
            ]} />) : <Empty th={th}>System Health has not written a snapshot yet.</Empty>}
        </Card>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────────
export function ExecutiveView({ th, user, stores, isMobile, go }) {
  const [view, setView] = React.useState(() => { try { return sessionStorage.getItem('pcg_exec_view') || 'today'; } catch { return 'today'; } });
  const pick = (id) => { setView(id); try { sessionStorage.setItem('pcg_exec_view', id); } catch {} };
  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <div>
          <div style={pageTitle(th)}>Executive</div>
          <div style={{ fontSize: '0.8rem', color: th.muted }}>Every number here is the portal's own; sales read current, then vs last week, then vs last year.</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '0.25rem', borderBottom: `1px solid ${th.cardBorder}`, marginBottom: '1rem', overflowX: 'auto' }}>
        {VIEWS.map((v) => (
          <button key={v.id} onClick={() => pick(v.id)} style={{ background: 'none', border: 'none', borderBottom: `2px solid ${view === v.id ? O : 'transparent'}`, color: view === v.id ? th.text : th.muted, fontFamily: "'Raleway'", fontWeight: 700, fontSize: isMobile ? '0.8rem' : '0.88rem', padding: '0.5rem 0.8rem', cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: -1 }}>
            {v.label}
          </button>))}
      </div>
      {view === 'today' && <TodayView th={th} user={user} go={go} />}
      {view === 'week' && <WeekView th={th} user={user} />}
      {view === 'districts' && <DistrictsView th={th} user={user} stores={stores} />}
      {view === 'development' && <DevelopmentView th={th} user={user} go={go} />}
      {view === 'health' && <HealthView th={th} user={user} />}
    </div>
  );
}
