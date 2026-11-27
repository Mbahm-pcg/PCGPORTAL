// src/screens/CashManagement.jsx — moved out of app.jsx unchanged (v23.36, scripts/extract-screen.mjs).
import { O, btn, card, inp } from '../theme.js';
import { districtNumbers } from '../store-status.mjs';
import { DISTRICTS_SEED, districtLabel, getBusinessDatesForDeposit, getExpectedDepositDate, isBankClosed, isCashAdmin, localDateStr, parseAnyDate } from '../../app.jsx';

const { useEffect, useRef, useState } = React;

export function CashManagement({ user, th, stores, districts, cashDeposits, setCashDeposits, cashUploads, setCashUploads, cashNotes, setCashNotes, cashPOS, setCashPOS, showAlert, isMobile, users }) {
  const G = "#22c55e";
  const R = "#ef4444";
  const Y = "#fbbf24";

  // Permission checks
  const canUpload = user?.userType === "executive" || user?.userType === "it" || user?.userType === "office_staff";
  const canEdit = isCashAdmin(user);
  const isDM = user?.userType === "dm";
  const dmDistrict = isDM ? user?.district : null;

  // Notes modal state
  const [noteModal, setNoteModal] = useState(null); // { pc, storeName, businessDate, districtNum, dmName } or null
  const [noteText, setNoteText] = useState("");
  // Edit deposit modal
  const [editDep, setEditDep] = useState(null); // deposit object or null
  const [editForm, setEditForm] = useState({ depositDate: "", amount: "" });
  // POS reconciliation state
  const [posLoading, setPosLoading] = useState(false);
  const [posProgress, setPosProgress] = useState(0);

  // File upload state
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState(null);

  // View state
  const [view, setView] = useState('alerts'); // 'alerts' | 'grid' | 'history'
  const [weekOffset, setWeekOffset] = useState(0); // 0 = current week, -1 = last week
  const [storeFilter, setStoreFilter] = useState(null); // pc string or null
  const [distFilter, setDistFilter] = useState(isDM ? dmDistrict : 0);

  const fmtUSD = v => '$' + (Math.round(v * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtUSDRound = v => '$' + Math.round(v).toLocaleString();
  const fmtShort = v => v >= 1000 ? '$' + (v/1000).toFixed(1) + 'k' : '$' + Math.round(v);

  // ─── Cross-check dedupe ───
  // Because the sheet is uploaded multiple times a day, the SAME deposit can land with
  // a slightly different date (re-export, pending vs. posted, etc.). Real cash is almost
  // never exactly the same to the penny for the same store on different days, so if we
  // see the same PC + same amount (penny-exact) within a 14-day window, we treat the
  // later ones as duplicates and keep only the EARLIEST. The raw cashDeposits array
  // stays untouched in state — this memo is what every grid/reconciliation read uses.
  const effectiveDeposits = React.useMemo(() => {
    if (!cashDeposits || cashDeposits.length === 0) return [];
    const DUP_WINDOW_DAYS = 14;
    const MS_PER_DAY = 86400000;
    // Sort earliest-first so the first occurrence wins
    const sorted = [...cashDeposits].sort((a, b) => (a.depositDate || '').localeCompare(b.depositDate || ''));
    const kept = [];
    const keptByKey = new Map(); // `${pc}|${amountCents}` -> array of kept deposit timestamps
    for (const d of sorted) {
      const cents = Math.round((d.amount || 0) * 100);
      const key = `${d.pc}|${cents}`;
      const t = new Date((d.depositDate || '') + 'T12:00:00').getTime();
      const priors = keptByKey.get(key) || [];
      const isDup = priors.some(pt => Math.abs(t - pt) <= DUP_WINDOW_DAYS * MS_PER_DAY);
      if (isDup) continue;
      kept.push(d);
      priors.push(t);
      keptByKey.set(key, priors);
    }
    return kept;
  }, [cashDeposits]);

  const duplicatesRemoved = (cashDeposits?.length || 0) - effectiveDeposits.length;

  // ─── File upload + parse ───
  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadErr(null);
    try {
      const XLSX = window.XLSX;
      if (!XLSX) throw new Error('SheetJS not loaded. Refresh the page.');
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      // Parse each row: A=date, B=PC+LLC, C=amount
      const parsed = [];
      for (const row of rows) {
        if (!row || row.length < 3) continue;
        const dateRaw = row[0];
        const pcLLC = String(row[1] || '').trim();
        const amountRaw = row[2];
        if (!dateRaw || !pcLLC || amountRaw === '' || amountRaw == null) continue;

        const date = parseAnyDate(dateRaw);
        if (!date) continue;

        // Extract PC# from start of col B (first 6-digit number)
        const pcMatch = pcLLC.match(/^\s*(\d{5,7})\b/);
        let pc = pcMatch ? pcMatch[1] : null;
        const llcName = pcLLC.replace(/^\s*\d{5,7}\s*/, '').trim();

        // Fallback: fuzzy match LLC name to stores[].legal if no PC#
        if (!pc) {
          const match = stores.find(s => {
            const legal = (s.legal || '').toLowerCase().replace(/[.,]/g, '').trim();
            const needle = llcName.toLowerCase().replace(/[.,]/g, '').trim();
            return legal && needle && (legal === needle || legal.includes(needle.split(' ')[0]));
          });
          if (match) pc = match.pc;
        }

        const amount = parseFloat(amountRaw);
        if (!pc || isNaN(amount)) continue;
        parsed.push({ date, pc, llcName, amount });
      }

      if (parsed.length === 0) throw new Error('No valid deposit rows found in this file. Expected columns: A=date, B=PC+LLC, C=amount.');

      // Dedupe against existing deposits
      // Exact fingerprint: same date + pc + amount
      const fingerprint = (d) => `${d.date || d.depositDate}|${d.pc}|${(d.amount || 0).toFixed(2)}`;
      const existing = new Set(cashDeposits.map(d => `${d.depositDate}|${d.pc}|${(d.amount || 0).toFixed(2)}`));
      // Cross-window: same pc + same amount within ±14 days is treated as a duplicate
      // (real cash almost never matches penny-for-penny across different business days)
      const DUP_WINDOW_MS = 14 * 86400000;
      const existingByKey = new Map(); // `${pc}|${cents}` -> [timestamps]
      for (const d of cashDeposits) {
        const cents = Math.round((d.amount || 0) * 100);
        const key = `${d.pc}|${cents}`;
        const t = new Date((d.depositDate || '') + 'T12:00:00').getTime();
        const arr = existingByKey.get(key) || [];
        arr.push(t);
        existingByKey.set(key, arr);
      }
      const uploadId = `upl_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      const now = new Date().toISOString();
      const newDeps = [];
      const duplicates = [];
      for (const p of parsed) {
        const fp = fingerprint(p);
        if (existing.has(fp)) { duplicates.push(p); continue; }
        // Cross-window dedupe check
        const cents = Math.round((p.amount || 0) * 100);
        const key = `${p.pc}|${cents}`;
        const t = new Date(p.date + 'T12:00:00').getTime();
        const priors = existingByKey.get(key) || [];
        const isWindowDup = priors.some(pt => Math.abs(t - pt) <= DUP_WINDOW_MS);
        if (isWindowDup) { duplicates.push(p); continue; }
        existing.add(fp);
        priors.push(t);
        existingByKey.set(key, priors);
        // Attach business date(s) — the cash earn date(s) this deposit covers
        const businessDates = getBusinessDatesForDeposit(p.date);
        newDeps.push({
          id: `dep_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
          depositDate: p.date,
          businessDates,
          pc: p.pc,
          llcName: p.llcName,
          amount: p.amount,
          uploadId,
          uploadedAt: now,
          uploadedBy: user?.id,
        });
      }

      if (newDeps.length > 0) setCashDeposits(prev => [...prev, ...newDeps]);

      const totalAmount = newDeps.reduce((a, d) => a + d.amount, 0);
      const upload = {
        id: uploadId,
        filename: file.name,
        uploadedAt: now,
        uploadedBy: user?.id,
        uploadedByName: user?.name,
        totalRows: parsed.length,
        newDeposits: newDeps.length,
        duplicatesSkipped: duplicates.length,
        totalAmount,
      };
      setCashUploads(prev => [upload, ...prev]);

      showAlert && showAlert('success',
        `Uploaded ${newDeps.length} new deposit${newDeps.length !== 1 ? 's' : ''}` +
        (duplicates.length > 0 ? `, ${duplicates.length} duplicate${duplicates.length !== 1 ? 's' : ''} skipped` : '')
      );
    } catch (err) {
      setUploadErr(err.message);
      showAlert && showAlert('error', err.message);
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  // ─── Notes helpers ───
  const addNote = (pc, businessDate, text, action = null) => {
    const now = new Date().toISOString();
    const note = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      pc, businessDate,
      text: text || "",
      action, // "dm_alerted" | "store_called" | "manager_replied" | "confirmed_en_route" | null
      createdAt: now,
      createdBy: user?.id,
      createdByName: user?.name,
    };
    setCashNotes(prev => [...prev, note]);
    return note;
  };

  const deleteNote = (noteId) => {
    if (!canEdit) return;
    setCashNotes(prev => prev.filter(n => n.id !== noteId));
  };

  // Get notes for a specific missing deposit (pc + businessDate)
  const getNotesFor = (pc, businessDate) => {
    return cashNotes.filter(n => n.pc === pc && n.businessDate === businessDate).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  // ─── Delete / Edit deposit (admin only) ───
  const deleteDeposit = (dep) => {
    if (!canEdit) return;
    if (!confirm(`Delete deposit of $${dep.amount.toFixed(2)} for ${dep.llcName} on ${dep.depositDate}?`)) return;
    setCashDeposits(prev => prev.filter(d => d.id !== dep.id));
    showAlert && showAlert('success', 'Deposit deleted');
  };

  const startEditDeposit = (dep) => {
    if (!canEdit) return;
    setEditDep(dep);
    setEditForm({ depositDate: dep.depositDate, amount: dep.amount.toString() });
  };

  const saveEditDeposit = () => {
    if (!editDep) return;
    const amt = parseFloat(editForm.amount);
    if (isNaN(amt) || amt <= 0) { showAlert && showAlert('error', 'Invalid amount'); return; }
    if (!editForm.depositDate) { showAlert && showAlert('error', 'Invalid date'); return; }
    const businessDates = getBusinessDatesForDeposit(editForm.depositDate);
    setCashDeposits(prev => prev.map(d => d.id === editDep.id ? { ...d, depositDate: editForm.depositDate, amount: amt, businessDates, editedAt: new Date().toISOString(), editedBy: user?.id } : d));
    setEditDep(null);
    showAlert && showAlert('success', 'Deposit updated');
  };

  // ─── POS Reconciliation ───
  // Fetches cash tender totals from Dunkin POS for every (store, business date) in view.
  // Tender Media #1 = "Cash" across all stores.
  const apiFor = (pc) => pc === '345986' ? 'p227' : 'p228';
  const posKey = (pc, date) => `${pc}_${date}`;

  const loadPOSCash = async (opts = {}) => {
    const { silent = false, forceRefresh = false } = opts;
    if (!weekRange) return;
    setPosLoading(true);
    setPosProgress(0);
    const newPOS = forceRefresh ? {} : { ...cashPOS };
    // For every store in view, fetch cash tender for each business date in the current week
    // AND the previous week (so reconciliation can match catch-up deposits to prior-week cash)
    const todayD = new Date(today + 'T12:00:00');
    // Build prior week dates (7 days before current week's Sunday)
    const priorSun = new Date(weekRange.sun + 'T12:00:00'); priorSun.setDate(priorSun.getDate() - 7);
    const priorWeekDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(priorSun); d.setDate(priorSun.getDate() + i);
      priorWeekDates.push(localDateStr(d));
    }
    const allDates = [...priorWeekDates, ...weekRange.dates];
    const targets = [];
    for (const store of visibleStores) {
      for (const date of allDates) {
        if (new Date(date + 'T12:00:00') > todayD) continue; // skip future
        if (newPOS[posKey(store.pc, date)]) continue; // already cached
        targets.push({ pc: store.pc, date });
      }
    }
    if (targets.length === 0) { setPosLoading(false); return; }

    let done = 0;
    const batchSize = 6;
    for (let i = 0; i < targets.length; i += batchSize) {
      await Promise.all(targets.slice(i, i + batchSize).map(async t => {
        try {
          const res = await fetch('/.netlify/functions/pulse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api: apiFor(t.pc),
              endpoint: 'getTenderMediaDailyTotals',
              locRef: t.pc,
              busDt: t.date,
              include: 'revenueCenters.tenderMedias',
            }),
          });
          if (res.ok) {
            const json = await res.json();
            let cash = 0;
            for (const rc of (json.revenueCenters || [])) {
              for (const tm of (rc.tenderMedias || [])) {
                if (tm.tmedNum === 1) cash += tm.ttl || 0; // tmedNum 1 = Cash
              }
            }
            newPOS[posKey(t.pc, t.date)] = { cash, fetchedAt: new Date().toISOString() };
          } else {
            newPOS[posKey(t.pc, t.date)] = { cash: null, error: `HTTP ${res.status}`, fetchedAt: new Date().toISOString() };
          }
        } catch (e) {
          newPOS[posKey(t.pc, t.date)] = { cash: null, error: e.message, fetchedAt: new Date().toISOString() };
        }
      }));
      done += batchSize;
      setPosProgress(Math.min(100, Math.round((done / targets.length) * 100)));
      setCashPOS({ ...newPOS }); // progressive update
    }
    setPosLoading(false);
    if (!silent) showAlert && showAlert('success', `POS cash totals loaded (${targets.length} fetched)`);
  };

  // Auto-load POS Cash whenever user enters the Reconciliation tab (and when the week changes)
  // Note: weekRange is declared LATER in this component, so we can't reference it in deps.
  // We use weekOffset + distFilter + view which are all state hooks declared earlier.
  const posAutoLoadedRef = useRef('');
  useEffect(() => {
    if (view !== 'recon') return;
    // weekRange is now in scope (React runs effects after render)
    const key = `${weekOffset}|${distFilter}|${view}`;
    if (posAutoLoadedRef.current === key) return;
    posAutoLoadedRef.current = key;
    loadPOSCash({ silent: true });
  }, [view, weekOffset, distFilter]);

  // Compute the cash expected for each (store, businessDate) from POS (from cashPOS cache)
  const getPOSCash = (pc, businessDate) => {
    const entry = cashPOS[posKey(pc, businessDate)];
    return entry && entry.cash != null ? entry.cash : null;
  };

  // Compute deposit total covering a specific business date for a store
  const getDepositedForBusinessDate = (pc, businessDate) => {
    return effectiveDeposits
      .filter(d => d.pc === pc && (d.businessDates || []).includes(businessDate))
      .reduce((sum, d) => sum + d.amount, 0);
  };

  // ─── Amount-based matching ───
  // Match deposits to POS cash amounts (penny tolerance). Handles catch-up deposits.
  // Returns: { matches: [{ deposit, bizDate, posCash, delta }], unmatchedDeposits: [], unmatchedBizDates: [{ bizDate, posCash }] }
  const matchStoreDeposits = (pc, bizDatesWithCash, storeDeposits) => {
    // bizDatesWithCash: [{ bizDate, posCash }]  — business days with POS cash values
    // storeDeposits: [{ id, amount, depositDate }]
    const TOL_PENNY = 0.01;
    const TOL_DOLLAR = 1.00;
    const TOL_FIVE = 5.00;

    // Work with mutable copies
    const availableDeposits = storeDeposits.map(d => ({ ...d, _matched: false }));
    const bizList = bizDatesWithCash.map(b => ({ ...b, _matched: false }));
    const matches = [];

    // Pass 1: exact penny match (highest priority)
    for (const biz of bizList) {
      if (biz._matched) continue;
      if (biz.posCash == null || biz.posCash === 0) continue;
      // Find a deposit with exact matching amount
      const dep = availableDeposits.find(d => !d._matched && Math.abs(d.amount - biz.posCash) < TOL_PENNY);
      if (dep) {
        dep._matched = true;
        biz._matched = true;
        matches.push({ deposit: dep, bizDate: biz.bizDate, posCash: biz.posCash, delta: 0, tolerance: 'exact' });
      }
    }

    // Pass 2: within $1
    for (const biz of bizList) {
      if (biz._matched) continue;
      if (biz.posCash == null || biz.posCash === 0) continue;
      const dep = availableDeposits.find(d => !d._matched && Math.abs(d.amount - biz.posCash) < TOL_DOLLAR);
      if (dep) {
        dep._matched = true;
        biz._matched = true;
        matches.push({ deposit: dep, bizDate: biz.bizDate, posCash: biz.posCash, delta: dep.amount - biz.posCash, tolerance: 'dollar' });
      }
    }

    // Pass 3: within $5
    for (const biz of bizList) {
      if (biz._matched) continue;
      if (biz.posCash == null || biz.posCash === 0) continue;
      const dep = availableDeposits.find(d => !d._matched && Math.abs(d.amount - biz.posCash) < TOL_FIVE);
      if (dep) {
        dep._matched = true;
        biz._matched = true;
        matches.push({ deposit: dep, bizDate: biz.bizDate, posCash: biz.posCash, delta: dep.amount - biz.posCash, tolerance: 'five' });
      }
    }

    // Pass 4: try to combine two deposits on same day that sum to match a biz date (common case)
    for (const biz of bizList) {
      if (biz._matched) continue;
      if (biz.posCash == null || biz.posCash === 0) continue;
      // Look for 2 deposits on the same day that sum to this cash (within $1)
      const byDay = {};
      for (const d of availableDeposits) {
        if (d._matched) continue;
        if (!byDay[d.depositDate]) byDay[d.depositDate] = [];
        byDay[d.depositDate].push(d);
      }
      let found = false;
      for (const [day, deps] of Object.entries(byDay)) {
        for (let i = 0; i < deps.length && !found; i++) {
          for (let j = i + 1; j < deps.length && !found; j++) {
            const sum = deps[i].amount + deps[j].amount;
            if (Math.abs(sum - biz.posCash) < TOL_DOLLAR) {
              deps[i]._matched = true;
              deps[j]._matched = true;
              biz._matched = true;
              matches.push({ deposit: deps[i], bizDate: biz.bizDate, posCash: biz.posCash, delta: sum - biz.posCash, tolerance: 'sum', partnerDeposit: deps[j] });
              found = true;
            }
          }
        }
      }
    }

    const unmatchedDeposits = availableDeposits.filter(d => !d._matched);
    const unmatchedBizDates = bizList.filter(b => !b._matched && b.posCash != null && b.posCash > 0);

    return { matches, unmatchedDeposits, unmatchedBizDates };
  };

  // ─── Date range (current week by default, adjustable) ───
  // Week is Sun-Sat, but we shift so "this week" = Mon-Sat (bank's open days) + Sun-skipped
  // Actually we want the full Mon-Sun for display, with Sun grayed out.
  const today = localDateStr(new Date());
  const weekRange = (() => {
    const dt = new Date(today + 'T12:00:00');
    dt.setDate(dt.getDate() + (weekOffset * 7));
    // Go back to Sunday
    const sun = new Date(dt); sun.setDate(dt.getDate() - dt.getDay());
    const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sun); d.setDate(sun.getDate() + i);
      dates.push(localDateStr(d));
    }
    return { sun: localDateStr(sun), sat: localDateStr(sat), dates };
  })();

  // Filter deposits for visible stores based on role
  const visibleStores = stores.filter(s => {
    if (isDM && s.district !== dmDistrict) return false;
    if (!isDM && distFilter && s.district !== distFilter) return false;
    return s.status === 'Open'; // only count open stores
  });
  const visiblePCs = new Set(visibleStores.map(s => s.pc));

  // Deposits in range for visible stores, sorted by date desc
  const rangeDeposits = effectiveDeposits
    .filter(d => visiblePCs.has(d.pc) && weekRange.dates.includes(d.depositDate))
    .sort((a, b) => b.depositDate.localeCompare(a.depositDate) || b.uploadedAt.localeCompare(a.uploadedAt));

  // ─── Missing deposits logic ───
  // For each store, check whether there's a deposit covering EACH business day in the range
  // A business day is "covered" if there's any deposit whose businessDates includes it.
  //
  // v22.18: a missing deposit is only a finding when a deposit file that could contain it
  // has been uploaded. With no upload since before this week began, every store x every
  // elapsed day reads "missing" (45 x 3 = the 135 red alerts of 10/21 when the last file
  // was from 8/25) — that is a stale FEED, not 135 missing deposits. In that state the
  // page shows one banner and counts zero; the per-day list comes back with the next upload.
  const newestUploadAt = (cashUploads || []).reduce((m, u) => (u?.uploadedAt > m ? u.uploadedAt : m), '')
    || effectiveDeposits.reduce((m, d) => (d?.uploadedAt > m ? d.uploadedAt : m), '');
  const uploadCoversRange = !!newestUploadAt && String(newestUploadAt).slice(0, 10) >= weekRange.dates[0];
  const uploadStale = !uploadCoversRange;
  const missing = [];
  const now = new Date(today + 'T12:00:00');
  for (const store of (uploadCoversRange ? visibleStores : [])) {
    const storeDeposits = effectiveDeposits.filter(d => d.pc === store.pc);
    // For each date in range that's NOT today and NOT a future date (we expect it by now)
    // and NOT a Sunday (no cash earned? actually cash IS earned Sunday, but deposited Monday)
    for (const bizDate of weekRange.dates) {
      // Skip Sundays — but actually Sunday's cash gets deposited Monday, so we DO want to track it
      // Skip future business dates
      if (new Date(bizDate + 'T12:00:00') > now) continue;
      // Expected deposit date for this business day
      const expectedDep = getExpectedDepositDate(bizDate);
      // Has ANY deposit covered this business date?
      const covered = storeDeposits.some(d => (d.businessDates || []).includes(bizDate));
      if (!covered) {
        // Only flag as missing if the expected deposit date has passed or is today
        const depDate = new Date(expectedDep + 'T12:00:00');
        if (depDate <= now) {
          const daysLate = Math.max(0, Math.floor((now - depDate) / (24 * 60 * 60 * 1000)));
          missing.push({
            pc: store.pc,
            storeName: store.name,
            city: store.city,
            district: store.district,
            dmName: store.dmName,
            businessDate: bizDate,
            expectedDepositDate: expectedDep,
            daysLate,
            isBaskin: store.isBaskin,
          });
        }
      }
    }
  }
  // Sort missing: most days late first, then by district
  missing.sort((a, b) => b.daysLate - a.daysLate || a.district - b.district || a.storeName.localeCompare(b.storeName));

  // Group missing by district for the alert card
  const missingByDist = {};
  for (const m of missing) {
    if (!missingByDist[m.district]) missingByDist[m.district] = { district: m.district, dmName: m.dmName, items: [] };
    missingByDist[m.district].items.push(m);
  }
  const missingDistricts = Object.values(missingByDist).sort((a, b) => a.district - b.district);

  // KPI summary for the date range
  const rangeTotal = rangeDeposits.reduce((a, d) => a + d.amount, 0);
  const uniqueStoresDeposited = new Set(rangeDeposits.map(d => d.pc)).size;
  const lastUpload = cashUploads[0];

  // District list for filter
  const distList = Object.values(districts || DISTRICTS_SEED).sort((a, b) => a.num - b.num);

  // ─── Render ───
  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{
        position: 'relative', overflow: 'hidden', borderRadius: '1rem', marginBottom: '1.25rem',
        padding: '1.5rem 2rem', background: `linear-gradient(135deg, ${th.card} 0%, ${th.card2} 100%)`,
        border: `1px solid ${G}33`,
      }}>
        <div style={{ position:'absolute', top:-40, right:-40, width:160, height:160, borderRadius:'50%', background:`${G}10`, pointerEvents:'none' }} />
        <div style={{ position:'relative', zIndex:1, display:'flex', alignItems:'flex-start', justifyContent:'space-between', flexWrap:'wrap', gap:'1rem' }}>
          <div>
            <div style={{ fontFamily:"'Raleway'", fontWeight:900, fontSize:'1.5rem', color:th.text, display:'flex', alignItems:'center', gap:'0.6rem' }}>
              💰 Cash Management
            </div>
            <div style={{ fontSize:'0.8rem', color:th.muted, marginTop:'0.25rem' }}>
              Deposit tracking and missing-deposit alerts
              {lastUpload && <span style={{ marginLeft: '0.5rem' }}>· Last upload: {new Date(lastUpload.uploadedAt).toLocaleString()}</span>}
            </div>
            {uploadStale && (
              <div style={{ marginTop:'0.6rem', padding:'0.5rem 0.75rem', borderRadius:'0.375rem', background:'rgba(245,158,11,0.14)', color:'#d97706', fontSize:'0.78rem', fontWeight:600 }}>
                No deposit file has been uploaded since {newestUploadAt ? new Date(newestUploadAt).toLocaleDateString() : 'the last period'} — missing deposits for this week can't be judged until this week's file is uploaded.
              </div>
            )}
          </div>
          {canUpload && (
            <div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display:'none' }} onChange={handleUpload} disabled={uploading} />
              <button onClick={() => fileRef.current?.click()} disabled={uploading}
                style={btn(th, { background: G, color: '#fff', padding: '0.6rem 1.2rem', fontSize: '0.85rem', fontWeight: 700 })}>
                {uploading ? '⏳ Parsing...' : '⬆ Upload Spreadsheet'}
              </button>
            </div>
          )}
        </div>
        {uploadErr && (
          <div style={{ marginTop:'0.75rem', padding:'0.5rem 0.75rem', borderRadius:'0.375rem', background:`${R}18`, color:R, fontSize:'0.75rem', fontWeight:600 }}>
            ⚠️ {uploadErr}
          </div>
        )}
      </div>

      {/* ─── KPI Cards ─────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {[
          { label: 'Week Total Deposits', value: fmtUSDRound(rangeTotal), color: G, glow: true },
          { label: 'Missing Deposits', value: missing.length, color: missing.length > 0 ? R : G, glow: missing.length > 0 },
          { label: 'Stores Deposited', value: `${uniqueStoresDeposited}/${visibleStores.length}`, color: '#74c0fc' },
          { label: 'Transactions', value: rangeDeposits.length, color: '#b197fc' },
        ].map(k => (
          <div key={k.label} style={{
            position: 'relative',
            background: th.card,
            borderRadius: '0.75rem',
            padding: '1rem 1.15rem 0.95rem',
            border: `1px solid ${th.cardBorder}`,
            overflow: 'hidden',
            boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
            transition: 'all .2s cubic-bezier(.4,0,.2,1)',
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = `${k.color}55`; e.currentTarget.style.boxShadow = `0 10px 24px rgba(0,0,0,0.08), 0 0 0 1px ${k.color}33, 0 0 18px ${k.color}22`; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.borderColor = th.cardBorder; e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.04)'; }}
          >
            <div aria-hidden="true" style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 3,
              background: `linear-gradient(90deg, ${k.color}, ${k.color}88 40%, transparent)`,
            }} />
            <div style={{
              fontFamily: "'Raleway'", fontWeight: 900, fontSize: '1.55rem',
              color: k.color, letterSpacing: -0.5, lineHeight: 1,
              textShadow: k.glow ? `0 0 18px ${k.color}55` : 'none',
            }}>{k.value}</div>
            <div style={{ fontSize: '0.6rem', color: th.muted, textTransform: 'uppercase', letterSpacing: 0.9, fontWeight: 800, marginTop: '0.4rem' }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* ─── Tab bar + week selector ────────────────────────────── */}
      <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1.25rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{
          display: 'inline-flex', gap: '0.25rem',
          background: th.card2, padding: '0.3rem',
          border: `1px solid ${th.cardBorder}`, borderRadius: '0.625rem',
          flexWrap: 'wrap',
        }}>
          {[
            { key: 'alerts', label: `🚨 Alerts${missing.length > 0 ? ' (' + missing.length + ')' : ''}` },
            { key: 'grid', label: '📊 Deposit Grid' },
            { key: 'recon', label: '💵 POS Cash Match' },
            { key: 'history', label: '📋 Upload History' },
          ].map(t => {
            const active = view === t.key;
            return (
              <button key={t.key} onClick={() => setView(t.key)} style={{
                padding: '0.5rem 0.9rem',
                fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.6,
                fontFamily: "'Source Sans 3'",
                background: active ? `linear-gradient(135deg, ${O}, #ff8040)` : 'transparent',
                color: active ? '#fff' : th.muted,
                border: 'none', borderRadius: '0.4rem',
                cursor: 'pointer', transition: 'all .2s',
                boxShadow: active ? `0 4px 12px ${O}55` : 'none',
                whiteSpace: 'nowrap',
              }}>{t.label}</button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {!isDM && (
            <select style={{ ...inp(th), width: 'auto', padding: '0.55rem 0.75rem', fontSize: '0.75rem', borderRadius: '0.625rem' }}
              value={distFilter} onChange={e => setDistFilter(+e.target.value)}>
              <option value={0}>All Districts</option>
              {distList.map(d => <option key={d.num} value={d.num}>{districtLabel(d.num)}</option>)}
            </select>
          )}
          {/* Week selector stepper */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: th.card2, border: `1px solid ${th.cardBorder}`, borderRadius: '0.625rem', padding: '0.25rem' }}>
            <button onClick={() => setWeekOffset(w => w - 1)} style={{
              background: 'transparent', border: 'none', color: th.text, cursor: 'pointer',
              padding: '0.4rem 0.55rem', fontSize: '0.9rem', fontWeight: 800,
              borderRadius: '0.375rem', transition: 'all .15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = `${O}22`; e.currentTarget.style.color = O; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = th.text; }}>‹</button>
            <div style={{ fontSize: '0.68rem', color: th.text, fontWeight: 800, padding: '0.35rem 0.6rem', textTransform: 'uppercase', letterSpacing: 0.7, whiteSpace: 'nowrap' }}>
              {weekOffset === 0 ? 'This Week' : weekOffset === -1 ? 'Last Week' : `${Math.abs(weekOffset)} Weeks Ago`}
            </div>
            <button onClick={() => setWeekOffset(w => Math.min(0, w + 1))} disabled={weekOffset === 0}
              style={{
                background: 'transparent', border: 'none',
                color: weekOffset === 0 ? th.muted : th.text,
                cursor: weekOffset === 0 ? 'default' : 'pointer',
                padding: '0.4rem 0.55rem', fontSize: '0.9rem', fontWeight: 800,
                opacity: weekOffset === 0 ? 0.4 : 1,
                borderRadius: '0.375rem', transition: 'all .15s',
              }}
              onMouseEnter={e => { if (weekOffset !== 0) { e.currentTarget.style.background = `${O}22`; e.currentTarget.style.color = O; } }}
              onMouseLeave={e => { if (weekOffset !== 0) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = th.text; } }}>›</button>
          </div>
        </div>
      </div>

      {/* ── Alerts View ── */}
      {view === 'alerts' && (
        <>
          {missing.length === 0 ? (
            <div style={{ ...card(th), padding:'3rem 2rem', textAlign:'center', borderLeft:`3px solid ${G}` }}>
              <div style={{ fontSize:'3rem', marginBottom:'0.75rem' }}>✅</div>
              <div style={{ fontFamily:"'Raleway'", fontWeight:800, fontSize:'1.2rem', color:G, marginBottom:'0.375rem' }}>All Caught Up</div>
              <div style={{ fontSize:'0.85rem', color:th.muted }}>
                Every store has deposited on time for the current week. Great work.
              </div>
            </div>
          ) : (
            <div style={{ marginBottom:'1.25rem' }}>
              {/* Overall alert banner */}
              <div style={{ padding:'1rem 1.25rem', marginBottom:'1rem', borderRadius:'0.75rem',
                background:`${R}12`, border:`1px solid ${R}44`, borderLeft:`4px solid ${R}`,
                display:'flex', alignItems:'center', gap:'1rem', flexWrap:'wrap' }}>
                <div style={{ fontSize:'2rem' }}>🚨</div>
                <div style={{ flex:1, minWidth:200 }}>
                  <div style={{ fontFamily:"'Raleway'", fontWeight:800, fontSize:'1.05rem', color:R }}>
                    {missing.length} Missing Deposit{missing.length !== 1 ? 's' : ''}
                  </div>
                  <div style={{ fontSize:'0.78rem', color:th.muted, marginTop:'0.2rem' }}>
                    Across {missingDistricts.length} district{missingDistricts.length !== 1 ? 's' : ''} · {new Set(missing.map(m => m.pc)).size} store{new Set(missing.map(m => m.pc)).size !== 1 ? 's' : ''} affected
                  </div>
                </div>
              </div>

              {/* Grouped by district */}
              {missingDistricts.map(dist => (
                <div key={dist.district} style={{ ...card(th), padding:'1.25rem', marginBottom:'0.875rem', borderLeft:`3px solid ${R}` }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'0.75rem', flexWrap:'wrap', gap:'0.5rem' }}>
                    <div>
                      <div style={{ fontFamily:"'Raleway'", fontWeight:800, fontSize:'1rem', color:th.text }}>
                        {districtLabel(dist.district)}
                      </div>
                      <div style={{ fontSize:'0.72rem', color:th.muted, marginTop:'0.15rem' }}>
                        DM: <strong style={{ color:th.text }}>{dist.dmName || 'Unassigned'}</strong>
                      </div>
                    </div>
                    <div style={{ fontSize:'0.72rem', fontWeight:700, color:R, background:`${R}18`, padding:'0.25rem 0.625rem', borderRadius:'1rem' }}>
                      {dist.items.length} missing
                    </div>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))', gap:'0.5rem' }}>
                    {dist.items.map((m, i) => {
                      const itemNotes = getNotesFor(m.pc, m.businessDate);
                      const lastAction = itemNotes.filter(n => n.action).pop();
                      return (
                      <div key={i} style={{
                        background:th.card2, borderRadius:'0.5rem', padding:'0.75rem 0.875rem',
                        borderLeft:`3px solid ${m.daysLate >= 2 ? R : m.daysLate >= 1 ? Y : R + '88'}`,
                      }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'0.5rem', marginBottom:'0.25rem' }}>
                          <div style={{ fontWeight:700, fontSize:'0.85rem', color:th.text }}>{m.storeName}</div>
                          <div style={{ fontSize:'0.62rem', fontWeight:700, padding:'0.15rem 0.5rem', borderRadius:'0.25rem',
                            background: m.daysLate >= 2 ? `${R}22` : m.daysLate >= 1 ? `${Y}22` : `${R}11`,
                            color: m.daysLate >= 2 ? R : m.daysLate >= 1 ? '#d97706' : R,
                            whiteSpace:'nowrap' }}>
                            {m.daysLate === 0 ? 'Due Today' : m.daysLate === 1 ? '1 Day Late' : `${m.daysLate} Days Late`}
                          </div>
                        </div>
                        <div style={{ fontSize:'0.68rem', color:th.muted, marginBottom:'0.15rem' }}>
                          PC# {m.pc}{m.city ? ' · ' + m.city : ''}
                        </div>
                        <div style={{ fontSize:'0.68rem', color:th.muted }}>
                          Business date: <strong style={{ color:th.text }}>{new Date(m.businessDate + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })}</strong>
                        </div>
                        <div style={{ fontSize:'0.68rem', color:th.muted, marginBottom: itemNotes.length > 0 ? '0.4rem' : 0 }}>
                          Expected deposit: <strong style={{ color:th.text }}>{new Date(m.expectedDepositDate + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })}</strong>
                        </div>
                        {/* Notes strip */}
                        {itemNotes.length > 0 && (
                          <div style={{ marginTop:'0.5rem', paddingTop:'0.5rem', borderTop:`1px dashed ${th.cardBorder}` }}>
                            {itemNotes.slice(-2).map(n => (
                              <div key={n.id} style={{ fontSize:'0.62rem', color:th.muted, marginBottom:'0.2rem', lineHeight:1.4, display:'flex', alignItems:'flex-start', gap:'0.35rem' }}>
                                <span style={{ color: n.action ? '#74c0fc' : th.muted, flexShrink:0 }}>
                                  {n.action === 'dm_alerted' ? '📢' : n.action === 'store_called' ? '📞' : n.action === 'manager_replied' ? '💬' : n.action === 'confirmed_en_route' ? '🚚' : '✎'}
                                </span>
                                <div style={{ flex:1, minWidth:0 }}>
                                  <strong style={{ color:th.text }}>{n.createdByName}</strong>
                                  {' · '}
                                  <span>{new Date(n.createdAt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</span>
                                  {n.text && <div style={{ color:th.text, marginTop:'0.1rem' }}>{n.text}</div>}
                                </div>
                              </div>
                            ))}
                            {itemNotes.length > 2 && (
                              <div style={{ fontSize:'0.6rem', color:th.muted, fontStyle:'italic' }}>+{itemNotes.length - 2} earlier note{itemNotes.length - 2 !== 1 ? 's' : ''}</div>
                            )}
                          </div>
                        )}
                        {/* Actions */}
                        <div style={{ marginTop:'0.5rem', display:'flex', gap:'0.35rem', flexWrap:'wrap' }}>
                          <button onClick={() => { addNote(m.pc, m.businessDate, 'DM alerted', 'dm_alerted'); }}
                            style={{ background:'#74c0fc22', color:'#74c0fc', border:'1px solid #74c0fc55', padding:'0.2rem 0.5rem', borderRadius:'0.3rem', fontSize:'0.6rem', fontWeight:700, cursor:'pointer', fontFamily:"'Source Sans 3'" }}>
                            📢 DM Alerted
                          </button>
                          <button onClick={() => { addNote(m.pc, m.businessDate, 'Store called', 'store_called'); }}
                            style={{ background:`${Y}22`, color:'#d97706', border:`1px solid ${Y}55`, padding:'0.2rem 0.5rem', borderRadius:'0.3rem', fontSize:'0.6rem', fontWeight:700, cursor:'pointer', fontFamily:"'Source Sans 3'" }}>
                            📞 Store Called
                          </button>
                          <button onClick={() => { addNote(m.pc, m.businessDate, 'Manager replied', 'manager_replied'); }}
                            style={{ background:`${G}22`, color:G, border:`1px solid ${G}55`, padding:'0.2rem 0.5rem', borderRadius:'0.3rem', fontSize:'0.6rem', fontWeight:700, cursor:'pointer', fontFamily:"'Source Sans 3'" }}>
                            💬 Manager Replied
                          </button>
                          <button onClick={() => { addNote(m.pc, m.businessDate, 'Deposit confirmed en route', 'confirmed_en_route'); }}
                            style={{ background:'#b197fc22', color:'#b197fc', border:'1px solid #b197fc55', padding:'0.2rem 0.5rem', borderRadius:'0.3rem', fontSize:'0.6rem', fontWeight:700, cursor:'pointer', fontFamily:"'Source Sans 3'" }}>
                            🚚 En Route
                          </button>
                          <button onClick={() => { setNoteModal(m); setNoteText(""); }}
                            style={{ background:'none', color:th.muted, border:`1px solid ${th.cardBorder}`, padding:'0.2rem 0.5rem', borderRadius:'0.3rem', fontSize:'0.6rem', fontWeight:700, cursor:'pointer', fontFamily:"'Source Sans 3'" }}>
                            ✎ Add Note
                          </button>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Grid View ── */}
      {view === 'grid' && (() => {
        // District color palette (1-8) — distinct, high-contrast colors for easy scanning
        const DIST_COLORS = {
          1: '#74c0fc', // sky blue
          2: '#ffd43b', // amber
          3: '#69db7c', // lime green
          4: '#f06595', // pink
          5: '#b197fc', // lavender
          6: '#ff922b', // orange
          7: '#20c997', // teal
          8: '#e599f7', // light purple
          9: '#4dabf7', // blue (v22.21)
          10: '#a9e34b', // green-yellow
        };
        const distColor = (n) => DIST_COLORS[n] || '#94a3b8';
        return (
        <div style={{ ...card(th), padding:'1.25rem', overflowX:'auto' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'1rem', flexWrap:'wrap', gap:'0.5rem' }}>
            <div style={{ fontFamily:"'Raleway'", fontWeight:800, fontSize:'0.95rem', color:th.text }}>
              Deposit Grid — Week of {new Date(weekRange.sun + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })} to {new Date(weekRange.sat + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })}
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', flexWrap:'wrap' }}>
              {duplicatesRemoved > 0 && (
                <div title="Deposits with the same store + same amount (penny-exact) within a 14-day window are treated as duplicates and excluded." style={{ fontSize:'0.62rem', color:Y, fontWeight:700, padding:'0.25rem 0.55rem', background:`${Y}15`, border:`1px solid ${Y}55`, borderRadius:'0.4rem' }}>
                  ⚠ {duplicatesRemoved} duplicate{duplicatesRemoved !== 1 ? 's' : ''} removed
                </div>
              )}
              {canEdit && <div style={{ fontSize:'0.62rem', color:th.muted, fontStyle:'italic' }}>💡 Click any deposit cell to edit or delete</div>}
            </div>
          </div>
          {/* District color legend */}
          <div style={{ display:'flex', gap:'0.75rem', flexWrap:'wrap', marginBottom:'0.875rem', fontSize:'0.65rem' }}>
            {districtNumbers(stores).map(n => {
              const d = (districts || DISTRICTS_SEED)[n] || { num: n };
              if (!d) return null;
              return (
                <div key={n} style={{ display:'flex', alignItems:'center', gap:'0.3rem' }}>
                  <span style={{ width:10, height:10, borderRadius:2, background:distColor(n) }} />
                  <span style={{ color:th.muted }}>D{n} · <strong style={{ color:distColor(n) }}>{(d.name || '').split(' ')[0]}</strong></span>
                </div>
              );
            })}
          </div>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'0.78rem' }}>
            <thead>
              <tr style={{ borderBottom:`2px solid ${th.cardBorder}`, background:th.card }}>
                <th style={{ padding:'0.5rem 0.65rem', textAlign:'left', color:th.muted, fontWeight:700, textTransform:'uppercase', fontSize:'0.65rem', letterSpacing:0.7, whiteSpace:'nowrap' }}>Store</th>
                <th style={{ padding:'0.5rem 0.4rem', color:th.muted, fontWeight:700, textTransform:'uppercase', fontSize:'0.65rem', letterSpacing:0.7 }}>Dist</th>
                <th style={{ padding:'0.5rem 0.65rem', textAlign:'left', color:th.muted, fontWeight:700, textTransform:'uppercase', fontSize:'0.65rem', letterSpacing:0.7, whiteSpace:'nowrap' }}>District Mgr</th>
                {weekRange.dates.map((date, i) => {
                  const d = new Date(date + 'T12:00:00');
                  const closed = isBankClosed(date);
                  return (
                    <th key={date} style={{ padding:'0.5rem 0.4rem', textAlign:'center', color: closed ? th.muted : th.muted, fontWeight:700, textTransform:'uppercase', fontSize:'0.62rem', letterSpacing:0.5, opacity: closed ? 0.5 : 1 }}>
                      <div>{d.toLocaleDateString('en-US', { weekday:'short' })}</div>
                      <div style={{ fontSize:'0.6rem', fontWeight:500 }}>{d.getMonth()+1}/{d.getDate()}</div>
                      {closed && <div style={{ fontSize:'0.55rem', color:th.muted, fontWeight:400 }}>closed</div>}
                    </th>
                  );
                })}
                <th style={{ padding:'0.5rem 0.65rem', textAlign:'right', color:th.muted, fontWeight:700, textTransform:'uppercase', fontSize:'0.65rem', letterSpacing:0.7, whiteSpace:'nowrap' }}>Week Total</th>
              </tr>
            </thead>
            <tbody>
              {visibleStores.sort((a,b) => a.district - b.district || a.name.localeCompare(b.name)).map((store, idx) => {
                const storeDeps = effectiveDeposits.filter(d => d.pc === store.pc);
                const weekTotal = weekRange.dates.reduce((sum, date) => {
                  return sum + storeDeps.filter(d => d.depositDate === date).reduce((a, d) => a + d.amount, 0);
                }, 0);
                const dColor = distColor(store.district);
                return (
                  <tr key={store.pc} style={{ borderBottom:`1px solid ${th.cardBorder}`, background: idx % 2 ? `${th.card2}50` : 'transparent' }}>
                    <td style={{ padding:'0.55rem 0.65rem', borderLeft: `3px solid ${dColor}` }}>
                      <div style={{ fontWeight:800, color:dColor, fontSize:'0.82rem' }}>{store.name}</div>
                      <div style={{ fontSize:'0.62rem', color:th.muted }}>{store.pc}</div>
                    </td>
                    <td style={{ padding:'0.55rem 0.4rem', textAlign:'center', fontSize:'0.72rem', fontWeight:700, color:dColor }}>
                      {store.district}
                    </td>
                    <td style={{ padding:'0.55rem 0.65rem', fontSize:'0.72rem', color:th.text, whiteSpace:'nowrap' }}>
                      {store.dmName || '—'}
                    </td>
                    {weekRange.dates.map(date => {
                      const dayDeps = storeDeps.filter(d => d.depositDate === date).sort((a, b) => b.amount - a.amount);
                      const closed = isBankClosed(date);
                      const isFuture = new Date(date + 'T12:00:00') > now;
                      return (
                        <td key={date} style={{ padding:'0.45rem 0.4rem', textAlign:'center', opacity: closed ? 0.3 : 1, verticalAlign:'top' }}>
                          {dayDeps.length > 0 ? (
                            <div style={{ display:'flex', flexDirection:'column', gap:'0.2rem', alignItems:'center' }}>
                              {dayDeps.map((dep, di) => (
                                <div key={dep.id}
                                  onClick={() => canEdit && startEditDeposit(dep)}
                                  title={canEdit ? 'Click to edit' : `Deposit ${di+1} of ${dayDeps.length}`}
                                  style={{
                                    fontWeight:700, color:G, fontSize:'0.7rem', whiteSpace:'nowrap',
                                    cursor: canEdit ? 'pointer' : 'default',
                                    padding: dayDeps.length > 1 ? '0.1rem 0.35rem' : 0,
                                    borderRadius: dayDeps.length > 1 ? '0.25rem' : 0,
                                    background: dayDeps.length > 1 ? `${G}12` : 'transparent',
                                  }}>
                                  {fmtUSD(dep.amount)}
                                </div>
                              ))}
                            </div>
                          ) : closed ? (
                            <div style={{ fontSize:'0.6rem', color:th.muted }}>—</div>
                          ) : isFuture ? (
                            <div style={{ fontSize:'0.6rem', color:th.muted }}>—</div>
                          ) : (
                            <div style={{ fontSize:'0.85rem', color:R, fontWeight:700 }}>✗</div>
                          )}
                        </td>
                      );
                    })}
                    <td style={{ padding:'0.55rem 0.65rem', textAlign:'right', fontWeight:800, color: weekTotal > 0 ? G : th.muted, fontSize:'0.85rem' }}>
                      {weekTotal > 0 ? fmtUSD(weekTotal) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        );
      })()}

      {/* ── Reconciliation View (Amount-Based Matching) ── */}
      {view === 'recon' && (() => {
        // Build the 2-week window (prior week + current week) so we can match catch-up deposits
        const todayD = new Date(today + 'T12:00:00');
        const priorSun = new Date(weekRange.sun + 'T12:00:00'); priorSun.setDate(priorSun.getDate() - 7);
        const priorWeekDates = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(priorSun); d.setDate(priorSun.getDate() + i);
          priorWeekDates.push(localDateStr(d));
        }
        // All business dates in 2-week window up to today (cash could exist on any of these)
        const allBizDates = [...priorWeekDates, ...weekRange.dates].filter(d => new Date(d + 'T12:00:00') <= todayD);

        // For each store: run amount-based matching
        const storeReports = visibleStores.map(store => {
          // POS cash entries for this store (only biz dates with > 0 cash)
          const bizDatesWithCash = allBizDates.map(bizDate => ({ bizDate, posCash: getPOSCash(store.pc, bizDate) }))
            .filter(b => b.posCash != null);
          // All deposits for this store in the 2-week window (+ a few days buffer forward for catch-up)
          const windowStart = priorWeekDates[0];
          const storeDeposits = effectiveDeposits
            .filter(d => d.pc === store.pc && d.depositDate >= windowStart)
            .sort((a, b) => a.depositDate.localeCompare(b.depositDate) || b.amount - a.amount);

          const { matches, unmatchedDeposits, unmatchedBizDates } = matchStoreDeposits(store.pc, bizDatesWithCash, storeDeposits);

          // Filter matches/unmatched to just the current week for display (but matcher used 2-week window for correctness)
          const currentWeekSet = new Set(weekRange.dates);
          const priorWeekSet = new Set(priorWeekDates);

          // A match is "relevant to this week's view" if either the biz date or the deposit date is in the current week
          const relevantMatches = matches.filter(m => currentWeekSet.has(m.bizDate) || currentWeekSet.has(m.deposit.depositDate));
          // Missing biz dates this week — but exclude business dates whose expected deposit date hasn't arrived yet.
          // Rule: cash earned on day X is due to be deposited on the NEXT business day.
          // Today's cash is not missing — it's not due until tomorrow (or Monday if today is Sat).
          const missingThisWeek = unmatchedBizDates.filter(b => {
            if (!currentWeekSet.has(b.bizDate)) return false;
            const expectedDep = getExpectedDepositDate(b.bizDate);
            const expectedDepDate = new Date(expectedDep + 'T12:00:00');
            // Only flag as missing if the expected deposit date has already passed (strictly earlier than today)
            return expectedDepDate < todayD;
          });
          // Unmatched deposits this week (deposits that don't match any POS cash — likely from outside window)
          const unmatchedDepsThisWeek = unmatchedDeposits.filter(d => currentWeekSet.has(d.depositDate));

          return {
            store,
            matches: relevantMatches,
            missingBizDates: missingThisWeek,
            unmatchedDeposits: unmatchedDepsThisWeek,
            bizDatesWithCash: bizDatesWithCash.filter(b => currentWeekSet.has(b.bizDate)),
            hasPOSLoaded: bizDatesWithCash.length > 0,
          };
        });

        // Summary stats
        const storesWithPOS = storeReports.filter(r => r.hasPOSLoaded);
        const totalMatches = storeReports.reduce((a, r) => a + r.matches.length, 0);
        const totalExactMatches = storeReports.reduce((a, r) => a + r.matches.filter(m => m.tolerance === 'exact').length, 0);
        const totalVarianceMatches = storeReports.reduce((a, r) => a + r.matches.filter(m => m.tolerance !== 'exact').length, 0);
        const totalMissing = storeReports.reduce((a, r) => a + r.missingBizDates.length, 0);
        const totalUnmatchedDeps = storeReports.reduce((a, r) => a + r.unmatchedDeposits.length, 0);
        const totalVarianceAmt = storeReports.reduce((a, r) => a + r.matches.reduce((s, m) => s + (m.delta || 0), 0), 0);
        const totalMissingAmt = storeReports.reduce((a, r) => a + r.missingBizDates.reduce((s, b) => s + (b.posCash || 0), 0), 0);

        const loaded = storesWithPOS.length > 0;

        return (
          <div>
            {/* Header / Fetch button */}
            <div style={{ ...card(th), padding:'1rem 1.25rem', marginBottom:'1rem', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:'0.75rem' }}>
              <div>
                <div style={{ fontFamily:"'Raleway'", fontWeight:800, fontSize:'1rem', color:th.text }}>POS Cash Reconciliation</div>
                <div style={{ fontSize:'0.7rem', color:th.muted, marginTop:'0.2rem' }}>
                  Matches deposit amounts to POS cash totals. Handles multi-deposit days and prior-week catch-ups automatically.
                </div>
              </div>
              <button onClick={() => loadPOSCash({ forceRefresh: true })} disabled={posLoading}
                style={btn(th, { background:'#74c0fc22', color:'#74c0fc', border:'1px solid #74c0fc55', padding:'0.5rem 1rem', fontSize:'0.8rem', fontWeight:700 })}>
                {posLoading ? `⏳ Loading ${posProgress}%` : '⚡ Refresh POS Cash'}
              </button>
            </div>

            {posLoading && (
              <div style={{ marginBottom:'1rem' }}>
                <div style={{ background:th.card3, borderRadius:4, height:4, overflow:'hidden' }}>
                  <div style={{ height:'100%', background:'#74c0fc', width:posProgress+'%', transition:'width .3s' }} />
                </div>
              </div>
            )}

            {!loaded && !posLoading ? (
              <div style={{ ...card(th), padding:'3rem 2rem', textAlign:'center' }}>
                <div style={{ fontSize:'2.5rem', marginBottom:'0.75rem' }}>💵</div>
                <div style={{ fontFamily:"'Raleway'", fontWeight:800, fontSize:'1.1rem', color:th.text, marginBottom:'0.5rem' }}>Loading Reconciliation…</div>
                <div style={{ fontSize:'0.85rem', color:th.muted }}>
                  Fetching POS cash totals for the current and prior week…
                </div>
              </div>
            ) : (
              <>
                {/* Summary KPIs */}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))', gap:'0.75rem', marginBottom:'1rem' }}>
                  <div style={{ background:th.card2, borderRadius:'0.625rem', padding:'0.875rem 1rem', borderLeft:`3px solid ${G}`, minWidth:0 }}>
                    <div style={{ fontFamily:"'Raleway'", fontWeight:900, fontSize:'1.35rem', color:G, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{totalExactMatches}</div>
                    <div style={{ fontSize:'0.64rem', color:th.muted, textTransform:'uppercase', letterSpacing:0.6, fontWeight:600, marginTop:'0.2rem' }}>Exact Matches</div>
                  </div>
                  <div style={{ background:th.card2, borderRadius:'0.625rem', padding:'0.875rem 1rem', borderLeft:`3px solid ${Y}`, minWidth:0 }}>
                    <div style={{ fontFamily:"'Raleway'", fontWeight:900, fontSize:'1.35rem', color:Y, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{totalVarianceMatches}</div>
                    <div style={{ fontSize:'0.64rem', color:th.muted, textTransform:'uppercase', letterSpacing:0.6, fontWeight:600, marginTop:'0.2rem' }}>Variance Matches</div>
                  </div>
                  <div style={{ background:th.card2, borderRadius:'0.625rem', padding:'0.875rem 1rem', borderLeft:`3px solid ${totalMissing > 0 ? R : G}`, minWidth:0 }}>
                    <div style={{ fontFamily:"'Raleway'", fontWeight:900, fontSize:'1.35rem', color: totalMissing > 0 ? R : G, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{totalMissing}</div>
                    <div style={{ fontSize:'0.64rem', color:th.muted, textTransform:'uppercase', letterSpacing:0.6, fontWeight:600, marginTop:'0.2rem' }}>Unmatched Cash Days</div>
                  </div>
                  <div style={{ background:th.card2, borderRadius:'0.625rem', padding:'0.875rem 1rem', borderLeft:`3px solid ${totalUnmatchedDeps > 0 ? '#b197fc' : G}`, minWidth:0 }}>
                    <div style={{ fontFamily:"'Raleway'", fontWeight:900, fontSize:'1.35rem', color: totalUnmatchedDeps > 0 ? '#b197fc' : G, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{totalUnmatchedDeps}</div>
                    <div style={{ fontSize:'0.64rem', color:th.muted, textTransform:'uppercase', letterSpacing:0.6, fontWeight:600, marginTop:'0.2rem' }}>Unmatched Deposits</div>
                  </div>
                  <div style={{ background:th.card2, borderRadius:'0.625rem', padding:'0.875rem 1rem', borderLeft:`3px solid ${R}`, minWidth:0, gridColumn:'span 2' }}>
                    <div style={{ fontFamily:"'Raleway'", fontWeight:900, fontSize:'1.5rem', color:R, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{fmtUSD(totalMissingAmt)}</div>
                    <div style={{ fontSize:'0.64rem', color:th.muted, textTransform:'uppercase', letterSpacing:0.6, fontWeight:600, marginTop:'0.2rem' }}>Missing Cash $</div>
                  </div>
                  <div style={{ background:th.card2, borderRadius:'0.625rem', padding:'0.875rem 1rem', borderLeft:`3px solid ${Math.abs(totalVarianceAmt) < 0.01 ? G : Y}`, minWidth:0, gridColumn:'span 2' }}>
                    <div style={{ fontFamily:"'Raleway'", fontWeight:900, fontSize:'1.5rem', color: Math.abs(totalVarianceAmt) < 0.01 ? G : Y, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                      {totalVarianceAmt >= 0 ? '+' : ''}{fmtUSD(totalVarianceAmt)}
                    </div>
                    <div style={{ fontSize:'0.64rem', color:th.muted, textTransform:'uppercase', letterSpacing:0.6, fontWeight:600, marginTop:'0.2rem' }}>Net Match Variance</div>
                  </div>
                </div>

                {/* Per-store ledger */}
                <div style={{ display:'flex', flexDirection:'column', gap:'0.75rem' }}>
                  {storeReports.filter(r => r.hasPOSLoaded && (r.matches.length > 0 || r.missingBizDates.length > 0 || r.unmatchedDeposits.length > 0)).sort((a, b) => {
                    // Sort: stores with problems first
                    const aProblems = a.missingBizDates.length + a.unmatchedDeposits.length;
                    const bProblems = b.missingBizDates.length + b.unmatchedDeposits.length;
                    if (aProblems !== bProblems) return bProblems - aProblems;
                    return a.store.district - b.store.district || a.store.name.localeCompare(b.store.name);
                  }).map(r => {
                    const hasProblems = r.missingBizDates.length > 0 || r.unmatchedDeposits.length > 0;
                    const allExact = r.matches.every(m => m.tolerance === 'exact');
                    const borderColor = hasProblems ? R : (allExact ? G : Y);
                    return (
                      <div key={r.store.pc} style={{ ...card(th), padding:'1rem 1.25rem', borderLeft:`3px solid ${borderColor}` }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'0.75rem', flexWrap:'wrap', gap:'0.5rem' }}>
                          <div>
                            <div style={{ fontFamily:"'Raleway'", fontWeight:800, fontSize:'0.95rem', color:th.text }}>{r.store.name}</div>
                            <div style={{ fontSize:'0.65rem', color:th.muted }}>PC# {r.store.pc} · D{r.store.district} · {r.store.dmName}</div>
                          </div>
                          <div style={{ display:'flex', gap:'0.375rem', flexWrap:'wrap' }}>
                            {r.matches.length > 0 && <span style={{ fontSize:'0.6rem', fontWeight:700, padding:'0.15rem 0.5rem', borderRadius:'0.25rem', background:`${G}22`, color:G }}>✓ {r.matches.length} matched</span>}
                            {r.missingBizDates.length > 0 && <span style={{ fontSize:'0.6rem', fontWeight:700, padding:'0.15rem 0.5rem', borderRadius:'0.25rem', background:`${R}22`, color:R }}>⚠️ {r.missingBizDates.length} missing</span>}
                            {r.unmatchedDeposits.length > 0 && <span style={{ fontSize:'0.6rem', fontWeight:700, padding:'0.15rem 0.5rem', borderRadius:'0.25rem', background:'#b197fc22', color:'#b197fc' }}>? {r.unmatchedDeposits.length} unmatched</span>}
                          </div>
                        </div>

                        {/* Matches */}
                        {r.matches.length > 0 && (
                          <div style={{ marginBottom: (r.missingBizDates.length > 0 || r.unmatchedDeposits.length > 0) ? '0.75rem' : 0 }}>
                            <div style={{ fontSize:'0.62rem', fontWeight:700, color:th.muted, textTransform:'uppercase', letterSpacing:0.8, marginBottom:'0.3rem' }}>Matched Pairs</div>
                            <div style={{ display:'flex', flexDirection:'column', gap:'0.25rem' }}>
                              {r.matches.sort((a, b) => a.bizDate.localeCompare(b.bizDate)).map((m, i) => {
                                const tolColor = m.tolerance === 'exact' ? G : m.tolerance === 'dollar' ? Y : m.tolerance === 'sum' ? '#74c0fc' : Y;
                                const tolLabel = m.tolerance === 'exact' ? '✓ Exact' : m.tolerance === 'dollar' ? '~ Within $1' : m.tolerance === 'sum' ? '∑ Sum' : '~ Within $5';
                                return (
                                  <div key={i} style={{ display:'flex', alignItems:'center', gap:'0.75rem', padding:'0.4rem 0.6rem', background:th.card2, borderRadius:'0.375rem', fontSize:'0.72rem' }}>
                                    <span style={{ fontSize:'0.58rem', fontWeight:700, padding:'0.1rem 0.4rem', borderRadius:'0.25rem', background: tolColor + '22', color: tolColor, whiteSpace:'nowrap' }}>{tolLabel}</span>
                                    <span style={{ color:th.muted }}>
                                      {new Date(m.bizDate + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })} cash
                                    </span>
                                    <strong style={{ color:th.text }}>{fmtUSD(m.posCash)}</strong>
                                    <span style={{ color:th.muted }}>↔</span>
                                    <span style={{ color:th.muted }}>
                                      {new Date(m.deposit.depositDate + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })} deposit
                                    </span>
                                    <strong style={{ color:G }}>{fmtUSD(m.deposit.amount)}{m.partnerDeposit ? ' + ' + fmtUSD(m.partnerDeposit.amount) : ''}</strong>
                                    {Math.abs(m.delta) >= 0.01 && (
                                      <span style={{ marginLeft:'auto', fontSize:'0.65rem', fontWeight:700, color: m.delta < 0 ? R : Y }}>
                                        {m.delta > 0 ? '+' : ''}{fmtUSD(m.delta)}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Missing biz dates (cash existed but no deposit matched) */}
                        {r.missingBizDates.length > 0 && (
                          <div style={{ marginBottom: r.unmatchedDeposits.length > 0 ? '0.75rem' : 0 }}>
                            <div style={{ fontSize:'0.62rem', fontWeight:700, color:R, textTransform:'uppercase', letterSpacing:0.8, marginBottom:'0.3rem' }}>⚠️ Unmatched Cash (needs a deposit)</div>
                            <div style={{ display:'flex', flexDirection:'column', gap:'0.25rem' }}>
                              {r.missingBizDates.sort((a, b) => a.bizDate.localeCompare(b.bizDate)).map((b, i) => (
                                <div key={i} style={{ display:'flex', alignItems:'center', gap:'0.75rem', padding:'0.4rem 0.6rem', background:`${R}11`, borderRadius:'0.375rem', fontSize:'0.72rem' }}>
                                  <span style={{ color:R, fontWeight:700 }}>MISSING</span>
                                  <span style={{ color:th.muted }}>
                                    {new Date(b.bizDate + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })} cash
                                  </span>
                                  <strong style={{ color:th.text }}>{fmtUSD(b.posCash)}</strong>
                                  <span style={{ marginLeft:'auto', color:th.muted, fontSize:'0.65rem' }}>No deposit matched this amount</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Unmatched deposits (probably from outside the 2-week window) */}
                        {r.unmatchedDeposits.length > 0 && (
                          <div>
                            <div style={{ fontSize:'0.62rem', fontWeight:700, color:'#b197fc', textTransform:'uppercase', letterSpacing:0.8, marginBottom:'0.3rem' }}>? Unmatched Deposits (possibly from outside 2-week window)</div>
                            <div style={{ display:'flex', flexDirection:'column', gap:'0.25rem' }}>
                              {r.unmatchedDeposits.map((d, i) => (
                                <div key={i} style={{ display:'flex', alignItems:'center', gap:'0.75rem', padding:'0.4rem 0.6rem', background:'#b197fc11', borderRadius:'0.375rem', fontSize:'0.72rem' }}>
                                  <span style={{ color:'#b197fc', fontWeight:700 }}>NO MATCH</span>
                                  <span style={{ color:th.muted }}>
                                    {new Date(d.depositDate + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })} deposit
                                  </span>
                                  <strong style={{ color:th.text }}>{fmtUSD(d.amount)}</strong>
                                  <span style={{ marginLeft:'auto', color:th.muted, fontSize:'0.65rem' }}>No POS cash matches this amount</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {storeReports.filter(r => r.hasPOSLoaded).every(r => r.matches.length === 0 && r.missingBizDates.length === 0 && r.unmatchedDeposits.length === 0) && (
                    <div style={{ ...card(th), padding:'2rem', textAlign:'center', color:th.muted }}>
                      No cash activity found in the current week.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* ── Upload History ── */}
      {view === 'history' && (
        <div>
          {cashUploads.length === 0 ? (
            <div style={{ ...card(th), padding:'3rem 2rem', textAlign:'center', color:th.muted }}>
              No uploads yet. Click "Upload Spreadsheet" to get started.
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:'0.625rem' }}>
              {cashUploads.map(u => (
                <div key={u.id} style={{ ...card(th), padding:'1rem 1.25rem', borderLeft:`3px solid ${G}` }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'1rem', flexWrap:'wrap' }}>
                    <div style={{ flex:1, minWidth:200 }}>
                      <div style={{ fontWeight:700, fontSize:'0.85rem', color:th.text }}>{u.filename}</div>
                      <div style={{ fontSize:'0.68rem', color:th.muted, marginTop:'0.2rem' }}>
                        Uploaded by <strong style={{ color:th.text }}>{u.uploadedByName || 'Unknown'}</strong>
                        {' · '}{new Date(u.uploadedAt).toLocaleString()}
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:'1rem', flexWrap:'wrap', fontSize:'0.72rem' }}>
                      <div>
                        <div style={{ fontWeight:800, color:G, fontSize:'0.95rem' }}>{u.newDeposits}</div>
                        <div style={{ color:th.muted, fontSize:'0.62rem', textTransform:'uppercase', letterSpacing:0.5 }}>New</div>
                      </div>
                      {u.duplicatesSkipped > 0 && (
                        <div>
                          <div style={{ fontWeight:800, color:th.muted, fontSize:'0.95rem' }}>{u.duplicatesSkipped}</div>
                          <div style={{ color:th.muted, fontSize:'0.62rem', textTransform:'uppercase', letterSpacing:0.5 }}>Dupes</div>
                        </div>
                      )}
                      <div>
                        <div style={{ fontWeight:800, color:th.text, fontSize:'0.95rem' }}>{fmtUSDRound(u.totalAmount)}</div>
                        <div style={{ color:th.muted, fontSize:'0.62rem', textTransform:'uppercase', letterSpacing:0.5 }}>Total</div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Add Note Modal ── */}
      {noteModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999, padding:'1rem' }}
          onClick={() => setNoteModal(null)}>
          <div onClick={e => e.stopPropagation()} style={{
            background:th.card, borderRadius:'0.875rem', padding:'1.5rem', width:'100%', maxWidth:520,
            border:`1px solid ${th.cardBorder}`, boxShadow:'0 24px 64px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontFamily:"'Raleway'", fontWeight:800, fontSize:'1.1rem', color:th.text, marginBottom:'0.25rem' }}>
              Add Note — {noteModal.storeName}
            </div>
            <div style={{ fontSize:'0.72rem', color:th.muted, marginBottom:'1rem' }}>
              PC# {noteModal.pc} · Business date {new Date(noteModal.businessDate + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })}
            </div>
            {/* Existing notes */}
            {getNotesFor(noteModal.pc, noteModal.businessDate).length > 0 && (
              <div style={{ marginBottom:'1rem', maxHeight:200, overflowY:'auto', background:th.card2, borderRadius:'0.5rem', padding:'0.75rem' }}>
                <div style={{ fontSize:'0.65rem', fontWeight:700, color:th.muted, textTransform:'uppercase', letterSpacing:1, marginBottom:'0.5rem' }}>Existing Notes</div>
                {getNotesFor(noteModal.pc, noteModal.businessDate).map(n => (
                  <div key={n.id} style={{ fontSize:'0.72rem', marginBottom:'0.5rem', paddingBottom:'0.5rem', borderBottom:`1px dashed ${th.cardBorder}`, display:'flex', gap:'0.5rem' }}>
                    <span>{n.action === 'dm_alerted' ? '📢' : n.action === 'store_called' ? '📞' : n.action === 'manager_replied' ? '💬' : n.action === 'confirmed_en_route' ? '🚚' : '✎'}</span>
                    <div style={{ flex:1 }}>
                      <div style={{ color:th.text }}>{n.text}</div>
                      <div style={{ fontSize:'0.62rem', color:th.muted, marginTop:'0.15rem' }}>
                        {n.createdByName} · {new Date(n.createdAt).toLocaleString()}
                      </div>
                    </div>
                    {canEdit && (
                      <button onClick={() => deleteNote(n.id)} style={{ background:'none', border:'none', color:R, cursor:'pointer', fontSize:'0.7rem', padding:0 }}>×</button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <textarea value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Enter a note..."
              style={{ ...inp(th), minHeight:80, resize:'vertical', marginBottom:'1rem' }} />
            <div style={{ display:'flex', gap:'0.5rem', justifyContent:'flex-end', flexWrap:'wrap' }}>
              <button onClick={() => setNoteModal(null)}
                style={btn(th, { background:th.card3, color:th.muted })}>Cancel</button>
              <button onClick={() => {
                if (noteText.trim()) addNote(noteModal.pc, noteModal.businessDate, noteText.trim());
                setNoteModal(null); setNoteText("");
              }} disabled={!noteText.trim()}
                style={btn(th, { background:O, color:'#fff', opacity: noteText.trim() ? 1 : 0.5 })}>Save Note</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Deposit Modal ── */}
      {editDep && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999, padding:'1rem' }}
          onClick={() => setEditDep(null)}>
          <div onClick={e => e.stopPropagation()} style={{
            background:th.card, borderRadius:'0.875rem', padding:'1.5rem', width:'100%', maxWidth:480,
            border:`1px solid ${th.cardBorder}`, boxShadow:'0 24px 64px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontFamily:"'Raleway'", fontWeight:800, fontSize:'1.1rem', color:th.text, marginBottom:'0.25rem' }}>
              Edit Deposit
            </div>
            <div style={{ fontSize:'0.72rem', color:th.muted, marginBottom:'1rem' }}>
              {editDep.llcName} · PC# {editDep.pc}
            </div>
            <div style={{ marginBottom:'0.75rem' }}>
              <label style={{ fontSize:'0.7rem', fontWeight:700, color:th.muted, textTransform:'uppercase', letterSpacing:1, display:'block', marginBottom:'0.25rem' }}>Deposit Date</label>
              <input type="date" value={editForm.depositDate} onChange={e => setEditForm(f => ({ ...f, depositDate: e.target.value }))}
                style={inp(th)} />
            </div>
            <div style={{ marginBottom:'1rem' }}>
              <label style={{ fontSize:'0.7rem', fontWeight:700, color:th.muted, textTransform:'uppercase', letterSpacing:1, display:'block', marginBottom:'0.25rem' }}>Amount</label>
              <input type="number" step="0.01" value={editForm.amount} onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))}
                style={inp(th)} />
            </div>
            <div style={{ display:'flex', gap:'0.5rem', justifyContent:'space-between' }}>
              <button onClick={() => { deleteDeposit(editDep); setEditDep(null); }}
                style={btn(th, { background:`${R}22`, color:R, border:`1px solid ${R}55` })}>🗑 Delete</button>
              <div style={{ display:'flex', gap:'0.5rem' }}>
                <button onClick={() => setEditDep(null)}
                  style={btn(th, { background:th.card3, color:th.muted })}>Cancel</button>
                <button onClick={saveEditDeposit}
                  style={btn(th, { background:G, color:'#fff' })}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
