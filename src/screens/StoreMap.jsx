// src/screens/StoreMap.jsx — moved out of app.jsx unchanged (v23.36, scripts/extract-screen.mjs).
import { btn } from '../theme.js';
import { STORE_COORDS, WEATHER_EMOJI, cloudLoad, fmtDollars, storeMgrName } from '../../app.jsx';

export function StoreMap({ stores, th, setTab, users, height }) {
  const O = '#FF671F';
  const [selectedStore,    setSelectedStore]    = React.useState(null);
  const [laborData,        setLaborData]        = React.useState(null);
  const [allTickets,       setAllTickets]       = React.useState([]);
  const [weatherData,      setWeatherData]      = React.useState(null);
  const [filterPerf,       setFilterPerf]       = React.useState(null);
  const [storeEmps,        setStoreEmps]        = React.useState(null);
  const [storeEmpsLoading, setStoreEmpsLoading] = React.useState(false);
  const [teamExpanded,     setTeamExpanded]     = React.useState(false);
  const [storeHourly,        setStoreHourly]        = React.useState(null);
  const [storeHourlyLoading, setStoreHourlyLoading] = React.useState(false);
  const [storeSched,         setStoreSched]         = React.useState(null);  // Paycor shifts for selected store (this week)
  const [peerHourly,         setPeerHourly]         = React.useState(null);  // district mates' 7-day hourly histories
  const [liveHeat,           setLiveHeat]           = React.useState({});   // pc → [24] sales by ET hour, today
  const [heatLoading,        setHeatLoading]        = React.useState(true);
  const containerRef  = React.useRef(null);
  const mapRef        = React.useRef(null);
  const markersRef    = React.useRef([]);
  const heatRef       = React.useRef([]);
  // Confirmed real bug (2026-10-05, full-app audit): callers pass `stores`
  // as a freshly-filtered/mapped array on every one of THEIR renders (e.g.
  // `stores.filter(...)` built inline in the tab router) — a brand-new
  // reference even when the actual content hasn't changed. Both effects
  // below depended on that raw array, so they tore down and rebuilt the
  // live-heat poll and every map marker on every unrelated app re-render
  // (chat poll, notifications poll, etc.), not just on a real store-data
  // change. A cheap content fingerprint lets React's dependency check
  // correctly treat "same stores, new reference" as unchanged.
  const storesFingerprint = React.useMemo(() => stores.map(s => `${s.pc}:${s.status}`).join('|'), [stores]);
  const tileRef       = React.useRef(null);
  const selectRef     = React.useRef(null);
  const tileSwapReady = React.useRef(false);
  selectRef.current   = setSelectedStore;

  // Clear selection when filter changes
  React.useEffect(() => { setSelectedStore(null); }, [filterPerf]);

  // Load live data once on mount
  React.useEffect(() => {
    cloudLoad('pcg_labor_v1').then(d => { if (d?.stores) setLaborData(d.stores); }).catch(() => {});
    cloudLoad('pcg_weather_forecast').then(d => { if (d) setWeatherData(d); }).catch(() => {});
    cloudLoad('pcg_tickets_v1').then(tix => { if (Array.isArray(tix)) setAllTickets(tix); }).catch(() => {});
  }, []);

  // Load per-store employee data when a pin is selected
  React.useEffect(() => {
    if (!selectedStore) { setStoreEmps(null); return; }
    setStoreEmps(null);
    setTeamExpanded(false);
    setStoreEmpsLoading(true);
    const todayStr = new Date().toISOString().slice(0, 10);
    cloudLoad(`pcg_labor_store_${selectedStore.pc}`).then(d => {
      if (d?.daily?.length) {
        const entry = d.daily.find(e => e.date === todayStr) || d.daily[0];
        setStoreEmps(entry?.employees || []);
      } else setStoreEmps([]);
      setStoreEmpsLoading(false);
    }).catch(() => { setStoreEmps([]); setStoreEmpsLoading(false); });
  }, [selectedStore?.pc]);

  // Live heat clouds — today's sales by hour, fetched from Pulse POS per store,
  // refreshed every 15 minutes while the map is open
  React.useEffect(() => {
    let cancelled = false;
    const fetchLiveHeat = async () => {
      const now = new Date();
      const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const today = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
      const pcs = stores.filter(s => s.status === 'Open').map(s => String(s.pc));
      const BATCH = 6;
      for (let i = 0; i < pcs.length; i += BATCH) {
        if (cancelled) return;
        const results = {};
        await Promise.all(pcs.slice(i, i + BATCH).map(async pc => {
          try {
            const res = await fetch('/.netlify/functions/pulse', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ api: pc === '345986' ? 'p227' : 'p228', endpoint: 'getGuestChecks', locRef: pc, busDt: today, include: 'guestChecks.opnUTC,guestChecks.subTtl,guestChecks.chkTtl' }),
            });
            if (!res.ok) return;
            const j = await res.json();
            const hours = Array(24).fill(0);
            for (const c of (j.guestChecks || [])) {
              const raw = c.opnUTC || '';
              if (!raw) continue;
              const dt = new Date(raw.endsWith('Z') ? raw : raw + 'Z');
              if (isNaN(dt.getTime())) continue;
              const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(dt), 10) % 24;
              hours[h] += (c.subTtl != null ? c.subTtl : (c.chkTtl || 0)); // net (pre-tax) to match POS
            }
            results[pc] = hours;
          } catch {}
        }));
        if (cancelled) return;
        setLiveHeat(prev => ({ ...prev, ...results })); // progressive — clouds appear as batches land
      }
      if (!cancelled) setHeatLoading(false);
    };
    fetchLiveHeat();
    const id = setInterval(fetchLiveHeat, 15 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [storesFingerprint]);

  // Load hourly sales history when a pin is selected (for daypart heatmap)
  React.useEffect(() => {
    if (!selectedStore) { setStoreHourly(null); return; }
    setStoreHourly(null);
    setStoreHourlyLoading(true);
    cloudLoad(`pcg_hourly_history_${selectedStore.pc}`).then(d => {
      setStoreHourly(Array.isArray(d) ? d.slice(0, 7) : []);
      setStoreHourlyLoading(false);
    }).catch(() => { setStoreHourly([]); setStoreHourlyLoading(false); });
  }, [selectedStore?.pc]);

  // Load this week's Paycor schedule (staffing overlay) + district peers' hourly histories (dead-zone comparison)
  React.useEffect(() => {
    if (!selectedStore) { setStoreSched(null); setPeerHourly(null); return; }
    setStoreSched(null);
    setPeerHourly(null);
    cloudLoad(`pcg_schedule_${selectedStore.pc}`).then(d => setStoreSched(d?.shifts || [])).catch(() => setStoreSched([]));
    const mates = stores.filter(s => s.district === selectedStore.district && s.pc !== selectedStore.pc && s.status === 'Open').slice(0, 8);
    Promise.all(mates.map(m =>
      cloudLoad(`pcg_hourly_history_${m.pc}`).then(d => (Array.isArray(d) && d.length ? d.slice(0, 7) : null)).catch(() => null)
    )).then(all => setPeerHourly(all.filter(Boolean)));
  }, [selectedStore?.pc]);

  // Build a 7-day x hour grid of sales for the daypart heatmap
  const hourLabel = h => h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p';
  const heatmap = React.useMemo(() => {
    if (!storeHourly || storeHourly.length === 0) return null;
    // Only span hours that actually saw sales across the week (trim dead early/late columns)
    const sums = {};
    storeHourly.forEach(d => (d.hours || []).forEach(h => { sums[h.h] = (sums[h.h] || 0) + (h.sales || 0); }));
    const active = Object.keys(sums).map(Number).filter(h => sums[h] > 0);
    if (!active.length) return null;
    const minH = Math.min(...active), maxH = Math.max(...active);
    const hours = [];
    for (let h = minH; h <= maxH; h++) hours.push(h);
    let max = 0;
    const days = storeHourly.map(d => {
      const byHour = {};
      (d.hours || []).forEach(h => { byHour[h.h] = h.sales || 0; if ((h.sales || 0) > max) max = h.sales; });
      const values = hours.map(h => byHour[h] ?? 0);
      return { date: d.date, values, total: values.reduce((a, b) => a + b, 0) };
    }).reverse(); // oldest → newest, top to bottom
    let peakHour = hours[0];
    hours.forEach(h => { if ((sums[h] || 0) > (sums[peakHour] || 0)) peakHour = h; });
    return { hours, days, max, peakHour };
  }, [storeHourly]);

  // Staffing-fit thresholds — sales per scheduled labor hour
  const SPLH_OVER = 35, SPLH_UNDER = 110;

  // Staffing fit — the schedule blob covers the CURRENT week (today forward), while the sales
  // heatmap is the PAST 7 days. So compare the upcoming schedule against typical traffic for
  // that weekday/hour, flagging mismatches before the shift happens.
  const schedFit = React.useMemo(() => {
    if (!storeSched?.length || !storeHourly?.length || !heatmap) return null;
    // Expected sales per hour, by weekday, from the 7-day history (fallback: all-day average)
    const byDow = {};
    const avg = Array(24).fill(0);
    let nDays = 0;
    storeHourly.forEach(d => {
      if (!d.date) return;
      const a = Array(24).fill(0);
      (d.hours || []).forEach(h => { a[h.h] = h.sales || 0; });
      byDow[new Date(d.date + 'T12:00:00').getDay()] = a;
      a.forEach((v, h) => { avg[h] += v; });
      nDays++;
    });
    if (!nDays) return null;
    for (let h = 0; h < 24; h++) avg[h] /= nDays;
    const now = new Date();
    const tStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dates = [...new Set(storeSched.map(s => s.date).filter(d => d && d >= tStr))].sort().slice(0, 7);
    if (!dates.length) return null;
    const hours = heatmap.hours;
    const rows = dates.map(date => {
      const exp = byDow[new Date(date + 'T12:00:00').getDay()] || avg;
      const heads = hours.map(() => 0);
      storeSched.forEach(sh => {
        if (sh.date !== date || !sh.startDateTime || !sh.endDateTime) return;
        const st = new Date(sh.startDateTime), en = new Date(sh.endDateTime);
        if (isNaN(st.getTime()) || isNaN(en.getTime()) || en <= st) return;
        const sH = st.getHours() + st.getMinutes() / 60;
        const eH = en.getHours() + en.getMinutes() / 60 + (en.getDate() !== st.getDate() ? 24 : 0);
        hours.forEach((h, i) => { if (sH <= h + 0.5 && h + 0.5 < eH) heads[i]++; });
      });
      const cells = hours.map((h, i) => {
        const n = heads[i], expSales = exp[h] || 0;
        let fit = 'ok';
        if (n === 0) fit = expSales > 50 ? 'under' : 'off';
        else {
          const splh = expSales / n;
          if (n >= 2 && splh < SPLH_OVER) fit = 'over';
          else if (splh > SPLH_UNDER) fit = 'under';
        }
        return { n, exp: expSales, fit };
      });
      return { date, isToday: date === tStr, cells };
    });
    return { hours, rows };
  }, [storeSched, storeHourly, heatmap]);

  // Dead-zone detection: this store's share of daily sales per daypart vs district peers (7-day)
  const deadZone = React.useMemo(() => {
    if (!storeHourly?.length || !peerHourly?.length) return null;
    const DAYPARTS = [
      { label: '5–8a',   hs: [5, 6, 7] },
      { label: '8–11a',  hs: [8, 9, 10] },
      { label: '11a–2p', hs: [11, 12, 13] },
      { label: '2–5p',   hs: [14, 15, 16] },
      { label: '5–9p',   hs: [17, 18, 19, 20] },
    ];
    const sumHours = days => { const a = Array(24).fill(0); days.forEach(d => (d.hours || []).forEach(h => { a[h.h] += h.sales || 0; })); return a; };
    const mine = sumHours(storeHourly);
    const myTotal = mine.reduce((x, y) => x + y, 0);
    if (myTotal <= 0) return null;
    const peerShare = Array(24).fill(0);
    let peers = 0;
    peerHourly.forEach(hist => {
      const a = sumHours(hist);
      const t = a.reduce((x, y) => x + y, 0);
      if (t > 0) { a.forEach((v, h) => { peerShare[h] += v / t; }); peers++; }
    });
    if (!peers) return null;
    let worst = null;
    for (const dp of DAYPARTS) {
      const mineShare = dp.hs.reduce((x, h) => x + mine[h], 0) / myTotal * 100;
      const theirs = dp.hs.reduce((x, h) => x + peerShare[h], 0) / peers * 100;
      const gap = mineShare - theirs;
      if (!worst || gap < worst.gap) worst = { label: dp.label, mine: mineShare, peers: theirs, gap };
    }
    return { ...worst, peerCount: peers };
  }, [storeHourly, peerHourly]);

  // Ticket counts for pin alert dots (derived from allTickets)
  const ticketCounts = React.useMemo(() => {
    const counts = {};
    allTickets.forEach(t => { if (t.status !== 'Closed' && t.storePC) counts[t.storePC] = (counts[t.storePC] || 0) + 1; });
    return counts;
  }, [allTickets]);

  // Invalidate map size when panel opens/closes
  React.useEffect(() => {
    setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 350);
  }, [!!selectedStore]);

  // Initialize map once
  React.useEffect(() => {
    const L = window.L;
    if (!L || !containerRef.current || mapRef.current) return;
    mapRef.current = L.map(containerRef.current, { zoomControl: true, scrollWheelZoom: true, attributionControl: false }).setView([40.12, -75.18], 11);
    tileRef.current = L.tileLayer(
      th.dark
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      th.dark
        ? { attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>', maxZoom: 19, subdomains: 'abcd', detectRetina: true }
        : { attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 18 }
    ).addTo(mapRef.current);
    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, []);

  // Swap tile layer when theme toggles (skip on initial mount — init effect already set it)
  React.useEffect(() => {
    if (!tileSwapReady.current) { tileSwapReady.current = true; return; }
    const L = window.L;
    if (!L || !mapRef.current) return;
    if (tileRef.current) { tileRef.current.remove(); tileRef.current = null; }
    tileRef.current = L.tileLayer(
      th.dark
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      th.dark
        ? { attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>', maxZoom: 19, subdomains: 'abcd', detectRetina: true }
        : { attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 18 }
    ).addTo(mapRef.current);
  }, [th.dark]);

  // Sync markers with stores — color by labor % performance, matching portal thresholds
  React.useEffect(() => {
    const L = window.L;
    if (!L || !mapRef.current) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    heatRef.current.forEach(m => m.remove());
    heatRef.current = [];
    // Current ET hour for the live heat clouds
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const curHr = etNow.getHours(), curMin = etNow.getMinutes();
    stores.forEach(s => {
      const c = STORE_COORDS[s.pc];
      if (!c) return;
      const lPct = laborData?.[s.pc]?.today?.laborPct ?? null;
      // Filter by selected performance tier
      if (filterPerf) {
        if (filterPerf === 'green'  && !(lPct !== null && lPct < 23)) return;
        if (filterPerf === 'yellow' && !(lPct !== null && lPct >= 23 && lPct < 26)) return;
        if (filterPerf === 'red'    && !(lPct !== null && lPct >= 26)) return;
      }
      // Live heat cloud — this hour's sales vs the store's own peak hour today
      const heatHours = liveHeat[String(s.pc)];
      if (heatHours && s.status === 'Open') {
        const useHr = (curMin < 15 && curHr > 0) ? curHr - 1 : curHr;   // first 15 min → show last full hour
        let raw = heatHours[useHr] || 0;
        if (useHr === curHr && curMin >= 15) raw = raw / (curMin / 60); // prorate the partial hour
        const peak = Math.max(...heatHours);
        const intensity = peak > 0 ? Math.min(raw / peak, 1) : 0;
        // Uber-surge style tiers: red = slammed, orange = steady, grey = dead
        let rgb, a1, a2, size;
        if (intensity >= 0.65) {
          rgb = '239,68,68';    a1 = 0.55; a2 = 0.26; size = Math.round(80 + intensity * 30);  // red surge
        } else if (intensity >= 0.3) {
          rgb = '255,103,31';   a1 = 0.42; a2 = 0.18; size = Math.round(64 + intensity * 30);  // orange steady
        } else {
          rgb = '148,163,184';  a1 = 0.30; a2 = 0.12; size = 52;                               // grey dead/slow
        }
        const pulse = intensity >= 0.3 ? `animation:heatCloudPulse 3.4s ease-in-out infinite;` : '';
        const cloudHtml = `<div style="width:${size}px;height:${size}px;border-radius:50%;pointer-events:none;background:radial-gradient(circle, rgba(${rgb},${a1}) 0%, rgba(${rgb},${a2}) 45%, rgba(${rgb},0) 72%);${pulse}"></div>`;
        const cloudIcon = L.divIcon({ className: '', html: cloudHtml, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
        const cloud = L.marker([c.lat, c.lng], { icon: cloudIcon, interactive: false, keyboard: false, zIndexOffset: -1000 }).addTo(mapRef.current);
        heatRef.current.push(cloud);
      }
      let color;
      if (s.status !== 'Open' && s.status !== 'Remodel') {
        color = '#6b7280'; // not operational
      } else if (lPct === null) {
        color = '#94a3b8'; // no data yet
      } else if (lPct < 23) {
        color = '#22c55e'; // on target
      } else if (lPct < 26) {
        color = '#f59e0b'; // watch
      } else {
        color = '#ef4444'; // intervention needed
      }
      const hasAlert = (ticketCounts[s.pc] || 0) > 0;
      const pinHtml = `<div style="position:relative;width:16px;height:16px;">
        <div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,0.5);"></div>
        ${hasAlert ? `<div style="position:absolute;top:-3px;right:-3px;width:7px;height:7px;border-radius:50%;background:#ef4444;border:1.5px solid #fff;"></div>` : ''}
      </div>`;
      const icon = L.divIcon({ className: '', html: pinHtml, iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -12] });
      const marker = L.marker([c.lat, c.lng], { icon })
        .addTo(mapRef.current)
        .on('click', () => {
          if (selectRef.current) selectRef.current(s);
          mapRef.current.panTo([c.lat, c.lng], { animate: true, duration: 0.4 });
        });
      markersRef.current.push(marker);
    });
  }, [storesFingerprint, ticketCounts, laborData, filterPerf, liveHeat]);


  // Style zoom controls to match theme
  React.useEffect(() => {
    const id = 'pcg-leaflet-zoom-theme';
    let s = document.getElementById(id);
    if (!s) { s = document.createElement('style'); s.id = id; document.head.appendChild(s); }
    s.textContent = `
      .leaflet-bar { border: 1px solid ${th.cardBorder} !important; box-shadow: 0 2px 10px rgba(0,0,0,0.25) !important; border-radius: 0.5rem !important; overflow: hidden; }
      .leaflet-control-zoom-in, .leaflet-control-zoom-out { background: ${th.card} !important; color: ${th.text} !important; border-bottom: 1px solid ${th.cardBorder} !important; }
      .leaflet-control-zoom-in:hover, .leaflet-control-zoom-out:hover { background: ${th.card2} !important; color: #FF671F !important; }
      @keyframes heatCloudPulse { 0%, 100% { transform: scale(1); opacity: 0.85; } 50% { transform: scale(1.12); opacity: 1; } }
    `;
  }, [th.dark]);

  const legend = laborData
    ? (() => {
        let green = 0, yellow = 0, red = 0, noData = 0, notOp = 0;
        stores.forEach(s => {
          if (s.status !== 'Open' && s.status !== 'Remodel') { notOp++; return; }
          const lPct = laborData?.[s.pc]?.today?.laborPct ?? null;
          if (lPct === null) { noData++; return; }
          if (lPct < 23) green++; else if (lPct < 26) yellow++; else red++;
        });
        return [
          { color: '#22c55e', label: 'On Target',     sublabel: '<23%',  count: green,  filter: 'green'  },
          { color: '#f59e0b', label: 'Watch',          sublabel: '23–26%',count: yellow, filter: 'yellow' },
          { color: '#ef4444', label: 'Intervention',   sublabel: '≥26%',  count: red,    filter: 'red'    },
          { color: '#94a3b8', label: 'No Data',        sublabel: null,    count: noData, filter: null     },
          { color: '#6b7280', label: 'Not Operational',sublabel: null,    count: notOp,  filter: null     },
        ].filter(l => l.count > 0);
      })()
    : [{ color: '#94a3b8', label: 'Loading…', sublabel: null, count: stores.length, filter: null }];

  const storeTickets = selectedStore
    ? allTickets.filter(t => t.storePC === selectedStore.pc && t.status !== 'Closed')
    : [];
  const PRIORITY_COLOR = { Emergency:'#ef4444', High:'#f97316', Medium:'#3b82f6', Low:'#22c55e' };

  // Pre-compute store detail vars (safe when selectedStore is null)
  const detailLd      = selectedStore ? laborData?.[selectedStore.pc]?.today : null;
  const detailLPct    = detailLd?.laborPct ?? null;
  const detailLColor  = detailLPct===null ? th.muted : detailLPct<23 ? '#22c55e' : detailLPct<26 ? '#f59e0b' : '#ef4444';
  const detailSColor  = !selectedStore ? '#6b7280' : selectedStore.status==='Open' ? '#22c55e' : selectedStore.status==='Remodel' ? '#f59e0b' : '#6b7280';
  const detailWeather = selectedStore ? weatherData?.[selectedStore.district]?.days?.[0] : null;

  return (
    <div style={{ display:'flex', flexDirection:'column', height: height || 'calc(100vh - 80px)', overflow:'hidden', borderRadius:'0.875rem', border:`1px solid ${th.cardBorder}`, background:th.card }}>

      {/* ── Legend bar — top ── */}
      <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', padding:'0.6rem 1rem', borderBottom:`1px solid ${th.cardBorder}`, flexShrink:0, flexWrap:'wrap' }}>
        <span style={{ fontSize:'0.7rem', color:th.muted, fontWeight:700, textTransform:'uppercase', letterSpacing:0.8, fontFamily:"'Source Sans 3'", marginRight:4 }}>Filter</span>
        {legend.map(l => {
          const isActive = filterPerf === l.filter && l.filter !== null;
          const isClickable = l.filter !== null;
          return (
            <button key={l.label} onClick={isClickable ? () => setFilterPerf(p => p === l.filter ? null : l.filter) : undefined}
              style={{ display:'inline-flex', alignItems:'center', gap:'0.35rem', fontSize:'0.72rem', fontFamily:"'Source Sans 3'", fontWeight:isActive?700:500, background:isActive ? l.color+'22' : th.card2, border:isActive ? `1px solid ${l.color}66` : `1px solid ${th.cardBorder}`, borderRadius:'2rem', padding:'0.25rem 0.7rem', cursor:isClickable?'pointer':'default', color:isActive?l.color:th.text, transition:'all 0.15s' }}>
              <span style={{ width:7, height:7, borderRadius:'50%', background:l.color, flexShrink:0 }} />
              {l.count} {l.label}{l.sublabel && <span style={{ opacity:0.7 }}> {l.sublabel}</span>}
            </button>
          );
        })}
        {filterPerf && (
          <button onClick={() => setFilterPerf(null)} style={{ fontSize:'0.68rem', color:th.muted, background:'none', border:`1px solid ${th.cardBorder}`, borderRadius:'2rem', padding:'0.22rem 0.65rem', cursor:'pointer', fontFamily:"'Source Sans 3'" }}>✕ Show all</button>
        )}
        <span style={{ marginLeft:'auto', display:'inline-flex', alignItems:'center', gap:'0.55rem', fontSize:'0.68rem', color:th.muted, fontFamily:"'Source Sans 3'" }}>
          {heatLoading ? 'loading live heat…' : <>
            <span style={{ display:'inline-flex', alignItems:'center', gap:'0.25rem' }}>
              <span style={{ width:15, height:15, borderRadius:'50%', flexShrink:0, background:'radial-gradient(circle, rgba(239,68,68,0.8) 0%, rgba(239,68,68,0.35) 45%, rgba(239,68,68,0) 72%)' }} />Busy
            </span>
            <span style={{ display:'inline-flex', alignItems:'center', gap:'0.25rem' }}>
              <span style={{ width:15, height:15, borderRadius:'50%', flexShrink:0, background:'radial-gradient(circle, rgba(255,103,31,0.7) 0%, rgba(255,103,31,0.3) 45%, rgba(255,103,31,0) 72%)' }} />Steady
            </span>
            <span style={{ display:'inline-flex', alignItems:'center', gap:'0.25rem' }}>
              <span style={{ width:15, height:15, borderRadius:'50%', flexShrink:0, background:'radial-gradient(circle, rgba(148,163,184,0.6) 0%, rgba(148,163,184,0.25) 45%, rgba(148,163,184,0) 72%)' }} />Slow
            </span>
            <span style={{ opacity:0.75 }}>· this hour, live</span>
          </>}
        </span>
      </div>

      {/* ── Map + detail panel row ── */}
      <div style={{ display:'flex', flex:1, minHeight:0, overflow:'hidden' }}>

      {/* ── Map pane ── */}
      <div style={{ flex:1, position:'relative', minWidth:0 }}>
        <div ref={containerRef} style={{ width:'100%', height:'100%' }} />
      </div>

      {/* ── Store detail panel (slides in on pin click) ── */}
      {selectedStore && (
          <div style={{ width:400, flexShrink:0, borderLeft:`1px solid ${th.cardBorder}`, display:'flex', flexDirection:'column', overflow:'hidden', background:th.card }}>

            {/* Panel header */}
            <div style={{ padding:'1rem 1.25rem 0.875rem', borderBottom:`1px solid ${th.cardBorder}`, flexShrink:0 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', flexWrap:'wrap', marginBottom:'0.3rem' }}>
                    <span style={{ fontFamily:"'Raleway'", fontWeight:800, fontSize:'1.05rem', color:th.text }}>{selectedStore.name}</span>
                    <span style={{ fontSize:'0.62rem', fontWeight:700, color:detailSColor, background:detailSColor+'22', padding:'0.15rem 0.5rem', borderRadius:'1rem', border:`1px solid ${detailSColor}44` }}>{selectedStore.status}</span>
                  </div>
                  <div style={{ fontSize:'0.77rem', color:th.muted }}>{selectedStore.address}</div>
                  <div style={{ fontSize:'0.74rem', color:th.muted, marginTop:'0.1rem' }}>{selectedStore.city}, {selectedStore.state}{selectedStore.zip ? ' '+selectedStore.zip : ''}</div>
                  <div style={{ fontSize:'0.71rem', color:th.muted, marginTop:'0.2rem', display:'flex', gap:'0.75rem', flexWrap:'wrap' }}>
                    <span>District {selectedStore.district||'—'}</span>
                    <span>PC# {selectedStore.pc}</span>
                    {storeMgrName(selectedStore, users) && <span>MGR: {storeMgrName(selectedStore, users)}</span>}
                    {selectedStore.mgrPhone && <span>{selectedStore.mgrPhone}</span>}
                  </div>
                  {detailWeather && (
                    <div style={{ fontSize:'0.71rem', color:th.muted, marginTop:'0.3rem', display:'flex', alignItems:'center', gap:'0.35rem' }}>
                      <span>{WEATHER_EMOJI[detailWeather.condition]||'🌤️'}</span>
                      <span style={{ textTransform:'capitalize' }}>{detailWeather.condition}</span>
                      <span>·</span>
                      <span>{detailWeather.tempHighF}° / {detailWeather.tempLowF}°F</span>
                      {detailWeather.precipMm>0 && <span style={{ color:'#60a5fa' }}>💧 {detailWeather.precipMm}mm</span>}
                    </div>
                  )}
                </div>
                <button onClick={() => setSelectedStore(null)} style={{ background:'none', border:'none', cursor:'pointer', color:th.muted, fontSize:'1.1rem', padding:'0.1rem 0.3rem', lineHeight:1, flexShrink:0 }}>✕</button>
              </div>
            </div>

            {/* KPI row */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', padding:'0.75rem 1.25rem', borderBottom:`1px solid ${th.cardBorder}`, flexShrink:0, gap:'0.25rem' }}>
              {[
                { label:'Sales',   value: detailLd ? fmtDollars(detailLd.sales) : '—',                       color:'#FF671F'      },
                { label:'Labor %', value: detailLPct!==null ? detailLPct.toFixed(1)+'%' : '—',              color:detailLColor   },
                { label:'Clocked', value: detailLd ? String(detailLd.employeesOnClock??'—') : '—',          color:'#22c55e'      },
                { label:'Sched',   value: detailLd ? String(detailLd.scheduledNow??'—') : '—',              color:'#74c0fc'      },
                { label:'Tickets', value: String(storeTickets.length),                        color: storeTickets.length>0 ? '#ef4444' : th.muted },
              ].map(k => (
                <div key={k.label} style={{ textAlign:'center' }}>
                  <div style={{ fontFamily:"'Raleway'", fontWeight:800, fontSize:'1.25rem', color:k.color, lineHeight:1 }}>{k.value}</div>
                  <div style={{ fontSize:'0.58rem', color:th.muted, textTransform:'uppercase', letterSpacing:0.5, marginTop:'0.2rem', fontWeight:600 }}>{k.label}</div>
                </div>
              ))}
            </div>

            {/* Scrollable body */}
            <div style={{ flex:1, overflowY:'auto' }}>

              {/* Today's Team */}
              <div style={{ padding:'0.875rem 1.25rem', borderBottom:`1px solid ${th.cardBorder}` }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.5rem' }}>
                  <span style={{ fontFamily:"'Raleway'", fontWeight:700, fontSize:'0.8rem', color:th.text }}>Today's Team</span>
                  {storeEmpsLoading && <span style={{ fontSize:'0.65rem', color:th.muted }}>Loading…</span>}
                  {storeEmps && !storeEmpsLoading && <span style={{ fontSize:'0.65rem', color:th.muted }}>{storeEmps.length} employee{storeEmps.length!==1?'s':''}</span>}
                </div>
                {storeEmpsLoading && <div style={{ fontSize:'0.78rem', color:th.muted, fontStyle:'italic' }}>Fetching team data…</div>}
                {storeEmps && storeEmps.length===0 && <div style={{ fontSize:'0.78rem', color:th.muted, fontStyle:'italic' }}>No data available for today</div>}
                {storeEmps && storeEmps.length>0 && (
                  <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
                    {(teamExpanded ? storeEmps : storeEmps.slice(0, 5)).map((e, i) => {
                      const eName = typeof e.name === 'string' ? e.name : 'Unknown';
                      const eRole = typeof e.role === 'string' ? e.role : 'Crew';
                      const eHours = typeof e.hoursToday === 'number' ? e.hoursToday.toFixed(1)+'h' : '—';
                      const initials = eName.split(' ').map(n=>n[0]||'').join('').slice(0,2).toUpperCase() || '?';
                      return (
                        <div key={i} style={{ display:'flex', alignItems:'center', gap:'0.45rem', padding:'0.2rem 0.4rem', borderRadius:'0.4rem', background:th.card2 }}>
                          <div style={{ width:20, height:20, borderRadius:'50%', background:'#FF671F22', color:'#FF671F', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:800, fontSize:'0.52rem', flexShrink:0 }}>{initials}</div>
                          <span style={{ flex:1, minWidth:0, fontSize:'0.74rem', color:th.text, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                            {eName} <span style={{ color:th.muted, fontWeight:400, fontSize:'0.62rem' }}>· {eRole}</span>
                          </span>
                          {e.overtime==='ot' && <span style={{ fontSize:'0.52rem', color:'#ef4444', fontWeight:700, flexShrink:0 }}>OT</span>}
                          {e.overtime==='approaching' && <span style={{ fontSize:'0.52rem', color:'#f59e0b', fontWeight:700, flexShrink:0 }}>~OT</span>}
                          <span style={{ fontSize:'0.7rem', fontWeight:600, color:th.text, flexShrink:0 }}>{eHours}</span>
                        </div>
                      );
                    })}
                    {storeEmps.length > 5 && (
                      <button onClick={() => setTeamExpanded(x => !x)}
                        style={{ background:'none', border:'none', color:th.muted, fontSize:'0.66rem', fontWeight:600, cursor:'pointer', padding:'0.25rem 0', fontFamily:"'Source Sans 3'" }}>
                        {teamExpanded ? '▲ Show less' : `▼ Show all ${storeEmps.length}`}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Daypart Heatmap */}
              <div style={{ padding:'0.875rem 1.25rem', borderBottom:`1px solid ${th.cardBorder}` }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:'0.65rem' }}>
                  <span style={{ fontFamily:"'Raleway'", fontWeight:700, fontSize:'0.8rem', color:th.text }}>Hourly Traffic</span>
                  <span style={{ fontSize:'0.62rem', color:th.muted }}>
                    last 7 days{heatmap ? <> · peak <span style={{ color:O, fontWeight:700 }}>{hourLabel(heatmap.peakHour)}</span></> : ''}
                  </span>
                </div>
                {storeHourlyLoading && <div style={{ fontSize:'0.78rem', color:th.muted, fontStyle:'italic' }}>Loading…</div>}
                {storeHourly && storeHourly.length === 0 && <div style={{ fontSize:'0.78rem', color:th.muted, fontStyle:'italic' }}>No history available yet</div>}
                {heatmap && (() => {
                  // Quantized 5-step scale (GitHub-style) — calmer than a continuous gradient
                  const cellColor = v => {
                    const t = heatmap.max > 0 ? v / heatmap.max : 0;
                    if (t <= 0) return th.card2;
                    const alpha = t <= 0.15 ? '26' : t <= 0.35 ? '59' : t <= 0.6 ? '8c' : t <= 0.85 ? 'bf' : 'ff';
                    return `${O}${alpha}`;
                  };
                  const fmtTotal = t => t >= 1000 ? `$${(t / 1000).toFixed(1)}k` : `$${Math.round(t)}`;
                  const cols = `32px repeat(${heatmap.hours.length}, 1fr) 42px`;
                  const lastIdx = heatmap.days.length - 1;
                  return (
                    <div>
                      {/* Hour labels — every 3 hours */}
                      <div style={{ display:'grid', gridTemplateColumns:cols, gap:3, marginBottom:3 }}>
                        <span />
                        {heatmap.hours.map(h => (
                          <span key={h} style={{ fontSize:'0.56rem', color:th.muted, textAlign:'center', whiteSpace:'nowrap' }}>
                            {h % 3 === 0 ? hourLabel(h) : ''}
                          </span>
                        ))}
                        <span />
                      </div>
                      {/* Day rows — weekday | cells | day total */}
                      {heatmap.days.map((d, di) => (
                        <div key={d.date} style={{ display:'grid', gridTemplateColumns:cols, gap:3, alignItems:'center', marginBottom:3 }}>
                          <span style={{ fontSize:'0.6rem', fontWeight: di === lastIdx ? 700 : 500, color: di === lastIdx ? th.text : th.muted }}>
                            {new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}
                          </span>
                          {d.values.map((v, i) => (
                            <div key={i} title={`${hourLabel(heatmap.hours[i])} — ${fmtDollars(v)}`}
                              style={{ height:16, borderRadius:4, background:cellColor(v) }} />
                          ))}
                          <span style={{ fontSize:'0.58rem', color:th.muted, textAlign:'right', whiteSpace:'nowrap' }}>{fmtTotal(d.total)}</span>
                        </div>
                      ))}
                      {/* Dead-zone insight vs district peers */}
                      {deadZone && (deadZone.gap < -2.5 ? (
                        <div style={{ display:'flex', alignItems:'flex-start', gap:'0.4rem', marginTop:'0.55rem', padding:'0.4rem 0.6rem', borderRadius:'0.5rem', background:'#ef444412', border:'1px solid #ef444433', fontSize:'0.66rem', color:th.text, lineHeight:1.45 }}>
                          <span style={{ flexShrink:0 }}>⚠️</span>
                          <span><strong>Dead zone {deadZone.label}</strong> — {deadZone.mine.toFixed(1)}% of daily sales vs {deadZone.peers.toFixed(1)}% for {deadZone.peerCount} district peers. Market issue or ops issue?</span>
                        </div>
                      ) : (
                        <div style={{ display:'flex', alignItems:'center', gap:'0.4rem', marginTop:'0.55rem', fontSize:'0.64rem', color:'#22c55e' }}>
                          ✓ Daypart mix tracks district peers
                        </div>
                      ))}
                      {/* Legend */}
                      <div style={{ display:'flex', justifyContent:'flex-end', alignItems:'center', gap:4, marginTop:'0.5rem', fontSize:'0.58rem', color:th.muted }}>
                        <span>Less</span>
                        {['26', '59', '8c', 'bf', 'ff'].map(a => (
                          <div key={a} style={{ width:11, height:11, borderRadius:3, background:`${O}${a}` }} />
                        ))}
                        <span style={{ marginRight:2 }}>More</span>
                      </div>

                      {/* ── Staffing Fit — upcoming schedule vs typical traffic ── */}
                      {schedFit && (
                        <div style={{ marginTop:'0.85rem', paddingTop:'0.75rem', borderTop:`1px solid ${th.cardBorder}` }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:'0.45rem' }}>
                            <span style={{ fontFamily:"'Raleway'", fontWeight:700, fontSize:'0.74rem', color:th.text }}>Staffing Fit</span>
                            <span style={{ fontSize:'0.58rem', color:th.muted }}>scheduled heads vs typical traffic</span>
                          </div>
                          {schedFit.rows.map(r => (
                            <div key={r.date} style={{ display:'grid', gridTemplateColumns:cols, gap:3, alignItems:'center', marginBottom:3 }}>
                              <span style={{ fontSize:'0.6rem', fontWeight: r.isToday ? 700 : 500, color: r.isToday ? th.text : th.muted }}>
                                {new Date(r.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}
                              </span>
                              {r.cells.map((cell, i) => {
                                const c = cell.fit === 'over' ? '#ef4444' : cell.fit === 'under' ? '#f59e0b' : null;
                                let tip = `${hourLabel(schedFit.hours[i])} — ${cell.n} scheduled · typical ${fmtDollars(cell.exp)}`;
                                if (cell.fit === 'over') tip += ' · OVERSTAFFED';
                                if (cell.fit === 'under') tip += cell.n === 0 ? ' · NO COVERAGE' : ' · UNDERSTAFFED';
                                return (
                                  <div key={i} title={tip}
                                    style={{ height:16, borderRadius:4, display:'flex', alignItems:'center', justifyContent:'center',
                                      background: c ? `${c}22` : th.card2,
                                      color: c || th.muted, fontSize:'0.55rem', fontWeight:700 }}>
                                    {cell.fit === 'off' ? '' : cell.n}
                                  </div>
                                );
                              })}
                              <span />
                            </div>
                          ))}
                          <div style={{ display:'flex', justifyContent:'flex-end', alignItems:'center', gap:'0.6rem', marginTop:'0.4rem', fontSize:'0.58rem', color:th.muted }}>
                            <span style={{ display:'inline-flex', alignItems:'center', gap:3 }}><span style={{ width:11, height:11, borderRadius:3, background:'#ef444422', border:'1px solid #ef444455' }} /> overstaffed</span>
                            <span style={{ display:'inline-flex', alignItems:'center', gap:3 }}><span style={{ width:11, height:11, borderRadius:3, background:'#f59e0b22', border:'1px solid #f59e0b55' }} /> understaffed</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Open Tickets */}
              <div style={{ padding:'0.875rem 1.25rem' }}>
                <div style={{ fontFamily:"'Raleway'", fontWeight:700, fontSize:'0.8rem', color:th.text, marginBottom:'0.5rem', display:'flex', alignItems:'center', gap:'0.4rem' }}>
                  Open Tickets
                  {storeTickets.length>0 && <span style={{ fontSize:'0.65rem', color:'#ef4444', fontWeight:700, background:'#ef444420', padding:'0.1rem 0.4rem', borderRadius:'1rem' }}>{storeTickets.length}</span>}
                </div>
                {storeTickets.length===0 && <div style={{ fontSize:'0.78rem', color:'#22c55e', display:'flex', alignItems:'center', gap:'0.35rem' }}>✓ No open tickets</div>}
                {storeTickets.map((t, i) => {
                  const tTitle = typeof t.title === 'string' ? t.title : typeof t.description === 'string' ? t.description.slice(0,50) : 'Untitled';
                  const tPriority = typeof t.priority === 'string' ? t.priority : '—';
                  const tStatus = typeof t.status === 'string' ? t.status : '—';
                  const pColor = PRIORITY_COLOR[tPriority] || '#6b7280';
                  return (
                    <div key={t.id||i} style={{ padding:'0.5rem 0.625rem', borderRadius:'0.5rem', background:th.card2, marginBottom:'0.3rem', border:`1px solid ${th.cardBorder}` }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'0.5rem' }}>
                        <span style={{ fontSize:'0.78rem', color:th.text, fontWeight:600, lineHeight:1.3, flex:1 }}>{tTitle}</span>
                        <span style={{ fontSize:'0.6rem', fontWeight:700, padding:'0.15rem 0.4rem', borderRadius:'0.3rem', background:pColor+'22', color:pColor, flexShrink:0 }}>{tPriority}</span>
                      </div>
                      <div style={{ fontSize:'0.64rem', color:th.muted, marginTop:'0.2rem', display:'flex', gap:'0.5rem' }}>
                        <span>{tStatus}</span>
                        {t.createdAt && <span>· {new Date(t.createdAt).toLocaleDateString()}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer — quick-nav */}
            {setTab && (
              <div style={{ padding:'0.75rem 1.25rem', borderTop:`1px solid ${th.cardBorder}`, display:'flex', gap:'0.5rem', flexShrink:0 }}>
                <button onClick={() => setTab('labor')}   style={{ flex:1, ...btn(th, { fontSize:'0.73rem', padding:'0.4rem', background:th.card2 }) }}>📊 Labor</button>
                <button onClick={() => setTab('pulse')}   style={{ flex:1, ...btn(th, { fontSize:'0.73rem', padding:'0.4rem', background:th.card2 }) }}>⚡ Pulse</button>
                <button onClick={() => setTab('tickets')} style={{ flex:1, ...btn(th, { fontSize:'0.73rem', padding:'0.4rem', background:th.card2 }) }}>🔧 Tickets</button>
              </div>
            )}
          </div>
      )}
      </div>{/* end map+panel row */}
    </div>
  );
}
