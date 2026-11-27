// src/screens/TipsReportBuilder.jsx — moved out of app.jsx unchanged (v23.36, scripts/extract-screen.mjs).
import { FIN_CSS, FinBanner, FinBar, FinFigure, FinFigures, FinRefreshIcon, FinSkeleton, FinStatusIcon, FinTicker, finInt, finMoney, finMoney0, finStyles } from '../finance-ui.jsx';
import { FONTS, O } from '../theme.js';
import { withAlpha } from '../chart-style.js';
import { TIPS_DOW, TIPS_DOW_FULL, TIPS_MONTHS, TIPS_SNAPSHOT_RETENTION_DAYS, canPaycorPush, cloudLoad, cloudSave, paycorDeptCodeForJobTitle, tipsAddDays, tipsAggregatePeriodByStore, tipsAoaToSheet, tipsBuildDaySheetAOA, tipsBuildPeriodTotalsAOA, tipsComputeDayInfo, tipsFindFlaggedStorePcs, tipsFormatISODate, tipsParseISODate, tipsRound2, tipsSheetNameFor, tipsStableProcessId } from '../../app.jsx';

const { useEffect, useState } = React;

export function TipsReportBuilder({ th, stores, user }) {
  const todayStr = tipsFormatISODate(new Date());
  const [periodStart, setPeriodStart] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dayInfo, setDayInfo] = useState(null); // [{date, filled, total, stores, employees, missing}]
  const [snapshots, setSnapshots] = useState(null); // raw array, index-aligned with the 14 dates
  const [grandTotal, setGrandTotal] = useState(0);
  const canPushToPaycor = canPaycorPush(user);
  // Department code is derived automatically per employee from their current
  // job title at send-time (see paycorDeptCodeForJobTitle) — confirmed
  // 2026-08-24 that it depends on role (Cust Svc/Shift Leader/Asst Manager),
  // not a single value. earningCode's scope is still unconfirmed — kept
  // per-store until that's settled. It can't be defaulted from Paycor's API
  // itself (per Paycor support, 2026-08-20) — it's a payroll-config value
  // that only exists in Paycor's own setup screens.
  const [paycorCfg, setPaycorCfg] = useState({}); // { [pc]: { earningCode } }
  const [paycorCfgLoaded, setPaycorCfgLoaded] = useState(false);
  const [paycorPush, setPaycorPush] = useState(null); // null | { running, results: [{pc, store, status, detail}] }
  const [singleSendPc, setSingleSendPc] = useState(''); // store picked for a one-off resend (e.g. after a Tips Editor correction)
  const [singleSending, setSingleSending] = useState(false);
  const [refreshingDates, setRefreshingDates] = useState(() => new Set()); // whole-day refreshes in flight
  const [refreshingStores, setRefreshingStores] = useState(() => new Set()); // `${pc}|${date}` single-store refreshes in flight

  useEffect(() => {
    if (!canPushToPaycor || paycorCfgLoaded) return;
    cloudLoad('pcg_paycor_tips_config').then(cfg => setPaycorCfg(cfg?.earningCodes || {})).catch(() => {}).finally(() => setPaycorCfgLoaded(true));
  }, [canPushToPaycor, paycorCfgLoaded]);

  // "Tips " (confirmed 2026-08-24, including Paycor's own trailing-space
  // typo) is the real earning code — but only confirmed present on Bustleton
  // so far. A Willits employee had no "Tips" earning type at all, since the
  // rollout across legal entities is still in progress — so this is a
  // one-click convenience for stores where it's already live, NOT a
  // guarantee. Only fills stores that don't already have a value, so it
  // never clobbers a manually-entered/corrected code.
  const fillAllEarningCodeWithTips = (storePcs) => {
    setPaycorCfg(prev => {
      const next = { ...prev };
      storePcs.forEach(pc => { if (!next[pc]?.earningCode) next[pc] = { earningCode: 'Tips ' }; });
      cloudSave('pcg_paycor_tips_config', { earningCodes: next }).catch(() => {});
      return next;
    });
  };
  // Auto-fills as soon as a period loads, instead of requiring the "Fill all
  // with Tips" button click every time — still just calls the same function
  // above, so the "never overwrites an already-set/corrected code" safety is
  // unchanged; this only changes WHEN it runs, not what it's allowed to do.
  useEffect(() => {
    if (!canPushToPaycor || !paycorCfgLoaded || !snapshots) return;
    const { byStore, storeOrder } = tipsAggregatePeriodByStore(snapshots);
    fillAllEarningCodeWithTips(storeOrder.map(store => byStore[store][0]?.pc));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPushToPaycor, paycorCfgLoaded, snapshots]);
  // On-demand only (button click, not automatic on load) — this is the one live
  // Paycor call this page makes, deliberately opt-in. The saved snapshots only
  // ever record people who DID have punches; there's no saved record of who's
  // on the active roster but absent, so finding that requires asking Paycor
  // directly for each store's current employee list to diff against.
  const [missingCheck, setMissingCheck] = useState(null); // null | { loading, results, error }

  const start = periodStart ? tipsParseISODate(periodStart) : null;
  const end = start ? tipsAddDays(start, 13) : null;
  const daysOld = start ? Math.round((tipsParseISODate(todayStr).getTime() - start.getTime()) / 86400000) : 0;
  const tooOld = start && daysOld > TIPS_SNAPSHOT_RETENTION_DAYS;

  const load = async () => {
    if (!start) return;
    setLoading(true); setError(null); setSnapshots(null); setDayInfo(null); setMissingCheck(null);
    try {
      const dates = Array.from({ length: 14 }, (_, i) => tipsFormatISODate(tipsAddDays(start, i)));
      const loaded = await Promise.all(dates.map(d => cloudLoad('pcg_tips_snapshot_' + d).catch(() => null)));
      const info = dates.map((d, i) => tipsComputeDayInfo(d, loaded[i]));
      setSnapshots(loaded);
      setDayInfo(info);
      setGrandTotal(tipsRound2(info.reduce((sum, d) => sum + (d.total || 0), 0)));
    } catch (e) {
      setError(e.message || 'Failed to load tips data.');
    } finally {
      setLoading(false);
    }
  };

  // Manual re-fetch for one day (whole-day rebuild) or one store within one
  // day (targeted merge, leaves the other 45 stores' saved data untouched) —
  // both call the SAME already-existing tips-report-refresh-background.mjs
  // that previously had no UI path to it at all (only reachable via a direct
  // HTTP POST). It's a background function, so the initial POST only ever
  // returns Netlify's immediate 202 with no useful body — the actual result
  // only ever shows up in the saved pcg_tips_snapshot_{date} blob itself,
  // which is why this polls that blob afterward instead of reading the
  // fetch's own response.
  const refreshOneDay = async (date, storePc = null) => {
    if (!start) return;
    const dayKey = date, storeKey = storePc ? `${storePc}|${date}` : null;
    setRefreshingDates(prev => storePc ? prev : new Set(prev).add(dayKey));
    setRefreshingStores(prev => storePc ? new Set(prev).add(storeKey) : prev);
    // A day being re-fetched usually already HAS some saved data (that's the
    // whole reason to retry it) — cloudLoad has no timestamp to check, so
    // just polling for "does something exist" would immediately "succeed"
    // against the SAME stale data that prompted the retry, before the real
    // background rebuild has had any chance to actually finish. Capture a
    // fingerprint of the current state up front and wait for it to actually
    // change, not merely exist.
    const before = await cloudLoad('pcg_tips_snapshot_' + date).catch(() => null);
    const fingerprintOf = (data) => storePc
      ? JSON.stringify((data || []).find(s => String(s.pc) === String(storePc)) || null)
      : JSON.stringify(data);
    const beforeFingerprint = fingerprintOf(before);

    try {
      await fetch('/.netlify/functions/tips-report-refresh-background', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storePc ? { busDt: date, storePc } : { busDt: date }),
      }).catch(() => {});

      // A full 46-store rebuild is a real multi-minute Paycor scrape (a single-
      // store targeted merge is much faster, but polls the same way for
      // simplicity) — wait a bit before the first check, then keep polling
      // for up to ~4 minutes total.
      await new Promise(r => setTimeout(r, storePc ? 3000 : 15000));
      let fresh = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        const candidate = await cloudLoad('pcg_tips_snapshot_' + date).catch(() => null);
        if (candidate && fingerprintOf(candidate) !== beforeFingerprint) { fresh = candidate; break; }
        await new Promise(r => setTimeout(r, 8000));
      }
      if (!fresh) { setError(`Refresh for ${date} didn't finish in time (or came back with the exact same data) — check back in a minute and reload the period.`); return; }

      const dates = Array.from({ length: 14 }, (_, i) => tipsFormatISODate(tipsAddDays(start, i)));
      const dateIdx = dates.indexOf(date);
      if (dateIdx < 0) return; // date isn't part of the currently-loaded period
      setSnapshots(prev => {
        const next = [...(prev || [])];
        next[dateIdx] = fresh;
        return next;
      });
      setDayInfo(prev => {
        const next = [...(prev || [])];
        next[dateIdx] = tipsComputeDayInfo(date, fresh);
        setGrandTotal(tipsRound2(next.reduce((sum, d) => sum + (d.total || 0), 0)));
        return next;
      });
    } finally {
      setRefreshingDates(prev => { const next = new Set(prev); next.delete(dayKey); return next; });
      if (storeKey) setRefreshingStores(prev => { const next = new Set(prev); next.delete(storeKey); return next; });
    }
  };

  const download = () => {
    const XLSX = window.XLSX;
    if (!XLSX) { setError('SheetJS library not loaded — please refresh the page.'); return; }
    if (!snapshots || !start) return;
    const dates = Array.from({ length: 14 }, (_, i) => tipsAddDays(start, i));
    const wb = XLSX.utils.book_new();
    const { rows: periodRows } = tipsBuildPeriodTotalsAOA(start, end, snapshots);
    XLSX.utils.book_append_sheet(wb, tipsAoaToSheet(XLSX, periodRows), 'Pay Period Totals');
    dates.forEach((dt, i) => {
      const dayResults = snapshots[i];
      const rows = dayResults ? tipsBuildDaySheetAOA(dt, dayResults) : [[`${TIPS_DOW_FULL[dt.getUTCDay()]}, ${TIPS_MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()} — no data saved for this day`]];
      XLSX.utils.book_append_sheet(wb, tipsAoaToSheet(XLSX, rows), tipsSheetNameFor(dt, start));
    });
    XLSX.writeFile(wb, `Biweekly_Tips_Report_${tipsFormatISODate(start)}_to_${tipsFormatISODate(end)}.xlsx`);
  };

  // Stages this period's per-store tips into Paycor's paygrid via
  // stagePayrollHours (netlify/functions/paycor.mjs) — one call per store's
  // legal entity, matching how the tips pipeline already computes shares
  // per-store/per-day (see tipsAggregatePeriodByStore). This only STAGES
  // data for human review in Paycor's own UI; it does not submit payroll.
  // Requires per-store earningCode/departmentCode to already be filled in —
  // Paycor doesn't expose a way to look these up via the API, so there's
  // nothing to default or validate them against beyond "is it filled in."
  // Stages exactly ONE store (by its tipsAggregatePeriodByStore key, i.e. the
  // 'store' label used as byStore's index) into Paycor's paygrid and returns
  // the final {pc, store, status, detail} row — same math/validation as the
  // full-period send below, just scoped to one store so a single corrected
  // store (e.g. via the Tips Editor) can be resent without touching the
  // other 44. Shared by both sendToPaycor (full period) and
  // sendOneStoreToPaycor (the standalone one-store control).
  const stageOneStoreForPaycor = async (storeKey, byStore, flaggedByPc) => {
    const recs = byStore[storeKey];
    const storePc = recs?.[0]?.pc;
    const storeMeta = (stores || []).find(s => s.pc === storePc);
    const cfg = paycorCfg[storePc];
    const fail = (status, detail) => ({ pc: storePc, store: storeKey, status, detail });

    // Hard block, not a warning someone can miss — a store with an
    // unresolved anomaly day never gets sent, full stop, until it's fixed
    // (re-fetch the flagged day). The alternative is real risk: an
    // employee's tips silently never reach Paycor because nobody happened
    // to read the email warning before clicking Send.
    if (flaggedByPc[storePc]?.length) {
      return fail('blocked', `Unresolved data gap — re-fetch before sending: ${flaggedByPc[storePc].map(f => f.detail).join('; ')}`);
    }
    if (!storeMeta?.paycor) return fail('error', 'No Paycor legal entity ID configured for this store');
    if (!cfg?.earningCode) return fail('skipped', 'Earning code not auto-filled yet for this store — try Send again in a moment');

    const toSend = recs.filter(r => r.payrollId && r.tips > 0);
    const missingPayrollId = recs.filter(r => !r.payrollId && r.tips > 0).length;
    if (toSend.length === 0) return fail('skipped', missingPayrollId ? `${missingPayrollId} employee(s) missing a payroll ID, nothing else to send` : 'No employees with tips this period');

    // Department code depends on each person's current role (Cust Svc /
    // Shift Leader / Asst Manager), which isn't in the saved snapshot — so
    // this looks up each store's CURRENT roster live, right before
    // sending, and maps payrollId (employeeNumber) -> job title. Anyone
    // not found live (e.g. since departed) falls back to 101, same as
    // Paycor's own behavior for a missing job title.
    const titleByPayrollId = {};
    // v2's schema keys each import row by employeeId (Paycor's internal
    // GUID), not employeeNumber — the tips pipeline only ever tracked
    // payrollId (employeeNumber), so the GUID has to come from this same
    // live roster fetch, same as the job-title lookup right below.
    const idByPayrollId = {};
    let rosterFetchFailed = false;
    try {
      let employees = [], continuationToken;
      do {
        const res = await fetch('/.netlify/functions/paycor', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'employees', legalEntityId: storeMeta.paycor, ...(continuationToken ? { continuationToken } : {}) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json().catch(() => null);
        const page = Array.isArray(json?.records) ? json.records : (Array.isArray(json) ? json : []);
        employees = employees.concat(page);
        continuationToken = json?.continuationToken || null;
        if (!page.length) continuationToken = null;
      } while (continuationToken);
      employees.forEach(e => {
        const num = e?.employeeNumber || e?.alternateEmployeeNumber;
        if (num) {
          titleByPayrollId[String(num)] = e?.positionData?.jobTitle;
          if (e?.id) idByPayrollId[String(num)] = e.id;
        }
      });
    } catch (e) {
      rosterFetchFailed = true;
    }

    // payGroupId is a required field on every earning entry (confirmed via
    // Paycor's own docs, 2026-08-24) — one per legal entity, so fetched
    // once per store rather than per employee. No fallback if this fails:
    // unlike a missing job title (which safely defaults to Cust Svc), a
    // missing payGroupId means the whole store's request would be
    // rejected anyway, so there's nothing useful to default it to.
    let payGroupId = null;
    try {
      const res = await fetch('/.netlify/functions/paycor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'payGroups', legalEntityId: storeMeta.paycor }),
      });
      const json = await res.json().catch(() => null);
      const records = Array.isArray(json?.records) ? json.records : (Array.isArray(json) ? json : []);
      payGroupId = records[0]?.payGroupId || null;
    } catch (e) { /* handled by the null check below */ }
    if (!payGroupId) return fail('error', "Couldn't look up this store's Paycor pay group — required for every submission");

    // businessStartDate/businessEndDate bound this earning to exactly the
    // period being sent, per Paycor's schema ("Start/End date of
    // TimeCard") — required so a store's tips don't get miscategorized as
    // applying to some other, unbounded date range.
    const businessStartDate = `${tipsFormatISODate(start)}T00:00:00Z`;
    const businessEndDate = `${tipsFormatISODate(end)}T23:59:59Z`;

    let defaultedCount = 0;
    // employeeId (the GUID) is required by v2's schema — unlike a missing
    // job title (safe to default to Cust Svc), there's no sensible
    // fallback for "which employee is this," so anyone not found in the
    // live roster is skipped from this store's submission entirely rather
    // than sent with an undefined/garbage employeeId.
    const noLiveIdCount = toSend.filter(r => !idByPayrollId[String(r.payrollId)]).length;
    const importEmployees = toSend.filter(r => idByPayrollId[String(r.payrollId)]).map(r => {
      const hasLiveMatch = Object.prototype.hasOwnProperty.call(titleByPayrollId, String(r.payrollId));
      if (!hasLiveMatch) defaultedCount++;
      const deptCode = paycorDeptCodeForJobTitle(titleByPayrollId[String(r.payrollId)]);
      return {
        employeeId: idByPayrollId[String(r.payrollId)],
        importEarnings: [{ departmentCode: Number(deptCode), earningCode: cfg.earningCode, earningAmount: r.tips, businessStartDate, businessEndDate, payGroupId }],
      };
    });
    if (importEmployees.length === 0) return fail('skipped', `No employee(s) could be matched to a live Paycor ID this store${noLiveIdCount ? ` (${noLiveIdCount} skipped)` : ''}`);

    try {
      // Stable per store+period, not crypto.randomUUID() — see
      // tipsStableProcessId. replaceData:true means a re-send for the same
      // store/period overwrites Paycor's existing staged batch with this
      // call's full current total instead of adding a duplicate one — this
      // is exactly what makes a single-store resend after a Tips Editor
      // correction safe: it replaces that store's prior staged batch rather
      // than piling a second one on top of it.
      const processId = await tipsStableProcessId(`${storeMeta.paycor}_${tipsFormatISODate(start)}`);
      const res = await fetch('/.netlify/functions/paycor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stagePayrollHours', legalEntityId: storeMeta.paycor, processId, importEmployees, replaceData: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const notes = [];
        if (missingPayrollId) notes.push(`skipped ${missingPayrollId} missing a payroll ID`);
        if (noLiveIdCount) notes.push(`skipped ${noLiveIdCount} not found on current roster (no Paycor ID to send)`);
        if (rosterFetchFailed) notes.push(`couldn't fetch current roster — all defaulted to Cust Svc (101)`);
        else if (defaultedCount) notes.push(`${defaultedCount} not found on current roster, defaulted to Cust Svc (101)`);
        return { pc: storePc, store: storeKey, status: 'ok', detail: `Staged ${importEmployees.length} employee(s)${notes.length ? ', ' + notes.join(', ') : ''} — still needs human review/submit in Paycor` };
      }
      return fail('error', data?.Detail || data?.message || data?.error || `HTTP ${res.status}`);
    } catch (e) {
      return fail('error', e.message || 'Request failed');
    }
  };

  const sendToPaycor = async () => {
    if (!snapshots || !start) return;
    const { byStore, storeOrder } = tipsAggregatePeriodByStore(snapshots);
    const periodDates = Array.from({ length: 14 }, (_, i) => tipsFormatISODate(tipsAddDays(start, i)));
    const flaggedByPc = tipsFindFlaggedStorePcs(snapshots, periodDates, stores, todayStr);
    // Every store is shown up front as 'pending' the instant Send is clicked
    // — not appended one at a time as each finishes — so the live checklist
    // below can show the whole list with a spinner on what hasn't run yet,
    // instead of only ever showing stores that already completed.
    const results = storeOrder.map(store => ({ pc: byStore[store][0]?.pc, store, status: 'pending', detail: null }));
    setPaycorPush({ running: true, results });
    for (const store of storeOrder) {
      const result = await stageOneStoreForPaycor(store, byStore, flaggedByPc);
      const idx = results.findIndex(r => r.pc === result.pc);
      if (idx >= 0) results[idx] = result;
      setPaycorPush({ running: true, results: [...results] });
    }
    setPaycorPush({ running: false, results });
  };

  // Resends just ONE store — the common case being "I already sent the full
  // period, then found/fixed one store's missing crew member in the Tips
  // Editor, now I just need that one store re-staged" — without re-running
  // the other 44 stores' live Paycor roster/payGroup lookups for nothing.
  const sendOneStoreToPaycor = async () => {
    if (!snapshots || !start || !singleSendPc) return;
    setSingleSending(true);
    const { byStore, storeOrder } = tipsAggregatePeriodByStore(snapshots);
    const storeKey = storeOrder.find(k => String(byStore[k][0]?.pc) === String(singleSendPc));
    const periodDates = Array.from({ length: 14 }, (_, i) => tipsFormatISODate(tipsAddDays(start, i)));
    const flaggedByPc = tipsFindFlaggedStorePcs(snapshots, periodDates, stores, todayStr);
    let result;
    if (!storeKey) {
      const storeMeta = (stores || []).find(s => String(s.pc) === String(singleSendPc));
      result = { pc: singleSendPc, store: storeMeta?.name || singleSendPc, status: 'skipped', detail: 'No tips data for this store in the loaded period' };
    } else {
      result = await stageOneStoreForPaycor(storeKey, byStore, flaggedByPc);
    }
    setSingleSending(false);
    setPaycorPush(prev => {
      const results = prev ? [...prev.results] : [];
      const idx = results.findIndex(r => r.pc === result.pc);
      if (idx >= 0) results[idx] = result; else results.push(result);
      return { running: false, results };
    });
  };

  const filledCount = dayInfo ? dayInfo.filter(d => d.filled).length : 0;
  // Split "not filled" into two different situations: a day strictly before
  // today with nothing saved is a real gap (the nightly report should have
  // run and didn't); today or later simply hasn't been processed yet, since
  // the nightly report only runs after a business day closes — not a problem,
  // just not-yet-collected, and shouldn't read like one.
  const missingDates = dayInfo ? dayInfo.filter(d => !d.filled && d.date < todayStr).map(d => d.date) : [];
  const notYetCollectedDates = dayInfo ? dayInfo.filter(d => !d.filled && d.date >= todayStr).map(d => d.date) : [];

  // Same GM/Store Manager exclusion the tip pool itself uses (tipsRecordsForStore's
  // caller / tips-report-cron-background.mjs) — flagging an intentionally-excluded
  // manager as "missing tips" would just be a false alarm, not a real gap.
  const isExcludedManager = (jobTitle) => /general\s*manager|store\s*manager/i.test(jobTitle || '') && !/assist|asst/i.test(jobTitle || '');

  const checkMissingEmployees = async () => {
    if (!snapshots || !start) return;
    setMissingCheck({ loading: true, results: null, error: null });
    try {
      // Every name that showed up with hours ANYWHERE in the loaded period, per store.
      const crewNamesByStore = {};
      for (const dayResults of (snapshots || [])) {
        if (!dayResults) continue;
        for (const s of dayResults) {
          if (!crewNamesByStore[s.pc]) crewNamesByStore[s.pc] = new Set();
          (s.crew || []).forEach(c => crewNamesByStore[s.pc].add(c.name));
        }
      }

      const storeList = (stores || []).filter(s => s.paycor);
      const results = [];
      const BATCH = 6;
      for (let i = 0; i < storeList.length; i += BATCH) {
        const batch = storeList.slice(i, i + BATCH);
        await Promise.all(batch.map(async (store) => {
          try {
            let records = [], continuationToken;
            do {
              const res = await fetch('/.netlify/functions/paycor', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'employees', legalEntityId: store.paycor, ...(continuationToken ? { continuationToken } : {}) }),
              });
              // A non-OK response (e.g. the documented Paycor token-mutex race) must
              // not be treated as "this store has zero employees" — that silently
              // drops the store from results as if it were checked and clean, when
              // it was never actually retrieved. Throw so it lands as a fetchError.
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const json = await res.json().catch(() => null);
              const page = Array.isArray(json?.records) ? json.records : (Array.isArray(json) ? json : []);
              records = records.concat(page);
              continuationToken = json?.continuationToken || json?.nextToken || null;
              if (!page.length) continuationToken = null;
            } while (continuationToken);

            const crewNames = crewNamesByStore[store.pc] || new Set();
            const missing = [];
            records.forEach(e => {
              if (e?.statusData?.status !== 'Active') return;
              if (isExcludedManager(e?.positionData?.jobTitle)) return;
              const name = `${(e.firstName || '').trim()} ${(e.lastName || '').trim()}`.trim();
              if (name && !crewNames.has(name)) missing.push(name);
            });
            if (missing.length) results.push({ pc: store.pc, name: store.name, district: store.district, missing: missing.sort() });
          } catch (err) {
            results.push({ pc: store.pc, name: store.name, district: store.district, fetchError: err.message });
          }
        }));
      }
      results.sort((a, b) => (a.district || 0) - (b.district || 0) || a.name.localeCompare(b.name));
      setMissingCheck({ loading: false, results, error: null });
    } catch (e) {
      setMissingCheck({ loading: false, results: null, error: e.message || 'Check failed.' });
    }
  };

  // ── v22.30 Hallmark redesign (design.md, Finance system) — the view only; every
  // handler above is unchanged. Signature: the pay period as a 14-day tip calendar,
  // each day's bar sized by its tips. Paycor send: a progress bar + a live per-store list.
  const fs = finStyles(th);
  const periodDates = start ? Array.from({ length: 14 }, (_, i) => tipsFormatISODate(tipsAddDays(start, i))) : [];
  const flaggedByPc = (snapshots && start) ? tipsFindFlaggedStorePcs(snapshots, periodDates, stores, todayStr) : {};
  const flaggedPcs = Object.keys(flaggedByPc);
  const storeNameOf = (pc) => (stores || []).find(s => String(s.pc) === String(pc))?.name || pc;
  const maxDay = dayInfo ? Math.max(1, ...dayInfo.map(d => d.total || 0)) : 1;
  const shortDate = (iso) => { const dt = tipsParseISODate(iso); return `${TIPS_MONTHS[dt.getUTCMonth()].slice(0, 3)} ${dt.getUTCDate()}`; };
  const longDate = (dt) => `${TIPS_DOW_FULL[dt.getUTCDay()]}, ${TIPS_MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;

  return (
    <div className="fin-root">
      <style>{FIN_CSS(th)}</style>
      <h2 style={fs.title}>Tips Report</h2>
      <p style={fs.lede}>
        Pulls the pay period’s tip data straight from what’s already saved each night: no files to upload, nothing fetched live. Pick the first day of the pay period below.
      </p>

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <label style={fs.fieldLabel}>
          Pay period start date
          <input type="date" className="fin-input" value={periodStart} max={todayStr} onChange={e => { setPeriodStart(e.target.value); setSnapshots(null); setDayInfo(null); setError(null); setMissingCheck(null); }} style={{ ...fs.input, width: 200 }} />
        </label>
        <button type="button" className="fin-btn" onClick={load} disabled={!periodStart || loading} style={{ ...fs.primary, opacity: (!periodStart || loading) ? 0.5 : 1 }}>{loading ? 'Loading…' : 'Load period'}</button>
        {start && <span style={{ fontSize: '0.86rem', color: th.muted, paddingBottom: '0.6rem' }}>Covers {longDate(start)} to {longDate(end)}, {end.getUTCFullYear()}</span>}
      </div>

      {tooOld && <FinBanner th={th} tone="warn">That start date is {daysOld} days ago. Daily snapshots are only kept for about {TIPS_SNAPSHOT_RETENTION_DAYS} days, so some or all of this period’s data may already be gone. Try a more recent pay period.</FinBanner>}
      {error && <FinBanner th={th} tone="error">{error}</FinBanner>}
      {loading && !dayInfo && <FinSkeleton th={th} rows={2} figures={3} />}

      {dayInfo && (
        <div style={{ ...fs.panel, marginBottom: '1rem' }}>
          <div style={fs.panelHead}>
            <div style={{ minWidth: 0 }}>
              <div style={fs.panelTitle}>Pay period</div>
              <div style={{ fontSize: '0.86rem', color: th.muted, marginTop: '0.1rem' }}>{shortDate(periodDates[0])} to {shortDate(periodDates[13])}, {end.getUTCFullYear()}</div>
            </div>
            <FinFigures>
              <FinFigure th={th} label="Tips so far" value={grandTotal} format={finMoney.format} />
              <FinFigure th={th} label="Days found" value={filledCount} format={v => `${Math.round(v)} of 14`} />
              <FinFigure th={th} label="Stores with a data gap" value={flaggedPcs.length} format={v => finInt.format(v)} tone={flaggedPcs.length ? 'bad' : undefined} />
            </FinFigures>

            {/* Signature: the 14-day tip calendar */}
            <div role="list" aria-label="Tips by day this pay period" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '0.45rem' }}>
              {dayInfo.map(d => {
                const dt = tipsParseISODate(d.date);
                const isFuture = d.date >= todayStr;
                const isRefreshing = refreshingDates.has(d.date);
                const gap = !d.filled && !isFuture;
                const frac = d.filled ? (d.total || 0) / maxDay : 0;
                return (
                  <div key={d.date} role="listitem" title={d.filled ? `${d.employees} employees, ${d.stores} stores, $${(d.total || 0).toFixed(2)}` : 'No data saved for this day'}
                    style={{ position: 'relative', minWidth: 0, borderRadius: '0.6rem', border: `1px solid ${gap ? withAlpha(th.warn, 0.45) : th.cardBorder}`, background: isFuture ? 'transparent' : th.card2, padding: '0.5rem 0.45rem 0.45rem', display: 'grid', gap: '0.3rem', opacity: isFuture ? 0.55 : 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.2rem' }}>
                      <span style={{ fontSize: '0.75rem', color: th.muted }}>{TIPS_DOW[dt.getUTCDay()]} {dt.getUTCMonth() + 1}/{dt.getUTCDate()}</span>
                      {!isFuture && (
                        <button type="button" className="fin-btn" onClick={() => !isRefreshing && refreshOneDay(d.date)} disabled={isRefreshing} aria-label={isRefreshing ? `Refreshing ${d.date}` : `Re-fetch ${d.date} from Pulse/Paycor`} title={isRefreshing ? 'Refreshing…' : `Re-fetch ${d.date} from Pulse/Paycor`}
                          style={{ background: 'transparent', border: 'none', padding: 4, margin: -4, borderRadius: '0.4rem', cursor: isRefreshing ? 'default' : 'pointer', display: 'inline-flex' }}>
                          <FinRefreshIcon color={isRefreshing ? O : th.muted} spinning={isRefreshing} />
                        </button>
                      )}
                    </div>
                    <div aria-hidden="true" style={{ position: 'relative', height: 46, borderRadius: '0.35rem', overflow: 'hidden', background: th.card3 }}>
                      <div className="fin-col" style={{ position: 'absolute', inset: 0, background: d.filled ? O : 'transparent', transform: `scaleY(${Math.max(d.filled ? 0.04 : 0, frac).toFixed(3)})` }} />
                    </div>
                    <span className="fin-num" style={{ fontSize: '0.8rem', fontWeight: 700, color: gap ? th.warn : isFuture ? th.muted : th.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {d.filled ? finMoney0.format(d.total || 0) : isFuture ? 'Not yet' : 'No data'}
                    </span>
                  </div>
                );
              })}
            </div>
            {missingDates.length > 0 && <div style={{ fontSize: '0.82rem', color: th.warn }}>No saved data for {missingDates.map(shortDate).join(', ')}. Either before the nightly report existed, or that night’s run didn’t complete.</div>}
            {notYetCollectedDates.length > 0 && <div style={{ fontSize: '0.82rem', color: th.muted }}>{notYetCollectedDates.map(shortDate).join(', ')} {notYetCollectedDates.length === 1 ? 'hasn’t' : 'haven’t'} happened yet or {notYetCollectedDates.length === 1 ? 'isn’t' : 'aren’t'} closed out for the night, so there’s nothing to collect yet.</div>}
          </div>

          {flaggedPcs.length > 0 && (
            <div role="alert" style={{ borderTop: `1px solid ${th.cardBorder}`, borderLeft: `3px solid ${th.danger}`, padding: '0.9rem 1.1rem', background: withAlpha(th.danger, 0.06) }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.88rem', fontWeight: 700, color: th.danger }}>
                <FinStatusIcon th={th} status="blocked" />
                <span>{flaggedPcs.length} store{flaggedPcs.length === 1 ? ' has' : 's have'} an unresolved data gap this period. They’ll be skipped if you send to Paycor now, not silently included wrong.</span>
              </div>
              <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.6rem', display: 'grid', gap: '0.35rem' }}>
                {flaggedPcs.map(pc => {
                  const uniqueDates = [...new Set(flaggedByPc[pc].map(f => f.date))];
                  return (
                    <li key={pc} style={{ fontSize: '0.84rem', color: th.text }}>
                      <strong>{storeNameOf(pc)}</strong>: {flaggedByPc[pc].map(f => f.detail).join('; ')}
                      {uniqueDates.map(d => {
                        const isRefreshing = refreshingStores.has(`${pc}|${d}`);
                        return (
                          <button key={d} type="button" className="fin-btn" onClick={() => !isRefreshing && refreshOneDay(d, pc)} disabled={isRefreshing}
                            style={{ marginLeft: '0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', background: 'transparent', border: `1px solid ${withAlpha(th.danger, 0.4)}`, borderRadius: '0.45rem', padding: '0.15rem 0.5rem', fontSize: '0.78rem', fontWeight: 700, color: isRefreshing ? th.muted : th.danger, cursor: isRefreshing ? 'default' : 'pointer', fontFamily: FONTS.body }}>
                            <FinRefreshIcon color={isRefreshing ? th.muted : th.danger} size={12} spinning={isRefreshing} />{isRefreshing ? `Refreshing ${shortDate(d)}…` : `Retry ${shortDate(d)}`}
                          </button>
                        );
                      })}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {canPushToPaycor && (
            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.85rem 1.1rem', borderTop: `1px solid ${th.cardBorder}` }}>
              <span style={{ fontSize: '0.84rem', color: th.muted }}>Just fixed one store (e.g. in the Tips Editor)? Resend only that store:</span>
              <select className="fin-input" value={singleSendPc} onChange={e => setSingleSendPc(e.target.value)} style={{ ...fs.input, width: 'auto', minWidth: 210 }}>
                <option value="">Select a store…</option>
                {(stores || []).filter(s => s.paycor).map(s => <option key={s.pc} value={s.pc}>{s.name} (PC# {s.pc})</option>)}
              </select>
              <button type="button" className="fin-btn" onClick={sendOneStoreToPaycor} disabled={!singleSendPc || singleSending || paycorPush?.running} style={{ ...fs.ghost, opacity: (!singleSendPc || singleSending || paycorPush?.running) ? 0.5 : 1 }}>
                {singleSending ? 'Sending…' : 'Send Just This Store'}
              </button>
            </div>
          )}

          <div style={fs.footer}>
            <span style={{ fontSize: '0.82rem', color: th.muted, marginRight: 'auto', maxWidth: 520 }}>The workbook’s first sheet, “Pay Period Totals,” adds up each employee’s tips across the whole period; that’s the one to key into Paycor. The other 14 sheets are the day-by-day breakdown.</span>
            <button type="button" className="fin-btn" onClick={checkMissingEmployees} disabled={missingCheck?.loading} style={{ ...fs.ghost, opacity: missingCheck?.loading ? 0.5 : 1 }}>
              {missingCheck?.loading ? 'Checking Paycor rosters…' : 'Check for missing employees'}
            </button>
            <button type="button" className="fin-btn" onClick={download} style={canPushToPaycor ? fs.ghost : fs.primary}>Download workbook</button>
            {canPushToPaycor && (
              <button type="button" className="fin-btn" onClick={sendToPaycor} disabled={paycorPush?.running} style={{ ...fs.primary, opacity: paycorPush?.running ? 0.5 : 1 }}>
                {paycorPush?.running ? 'Sending to Paycor…' : 'Send to Paycor'}
              </button>
            )}
          </div>
        </div>
      )}

      {paycorPush && (() => {
        const doneCount = paycorPush.results.filter(r => r.status !== 'pending').length;
        const total = paycorPush.results.length;
        const okCount = paycorPush.results.filter(r => r.status === 'ok').length;
        const problemCount = paycorPush.results.filter(r => r.status === 'error' || r.status === 'blocked').length;
        return (
          <div style={{ ...fs.panel, marginBottom: '1rem' }}>
            <div style={fs.panelHead}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div style={fs.panelTitle}>Paycor send progress</div>
                <span aria-live="polite" style={{ fontSize: '0.86rem', color: th.muted }}>
                  <FinTicker value={doneCount} format={v => Math.round(v)} style={{ fontWeight: 700, color: th.text }} /> of {total} stores {paycorPush.running ? 'so far' : 'done'}
                </span>
              </div>
              <FinBar th={th} frac={total ? doneCount / total : 0} height={8} />
              <FinFigures>
                <FinFigure th={th} label="Staged" value={okCount} format={v => finInt.format(v)} tone={okCount ? 'good' : undefined} />
                <FinFigure th={th} label="Need attention" value={problemCount} format={v => finInt.format(v)} tone={problemCount ? 'bad' : undefined} />
              </FinFigures>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.5rem 1rem', padding: '0 1.1rem 1.1rem' }}>
              {paycorPush.results.map(r => (
                <div key={r.pc} title={r.detail || ''} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', fontSize: '0.84rem', minWidth: 0 }}>
                  <FinStatusIcon th={th} status={r.status} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ color: th.text, fontWeight: 600 }}>{r.store}</span>
                    {r.detail && r.status !== 'pending' && (
                      <span style={{ display: 'block', color: r.status === 'ok' ? th.muted : r.status === 'skipped' ? th.muted : th.danger, fontSize: '0.78rem', lineHeight: 1.35 }}>{r.status === 'blocked' ? 'Blocked: ' : ''}{r.detail}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {missingCheck && (
        <div style={{ ...fs.panel, marginBottom: '1rem' }}>
          <div style={fs.panelHead}>
            <div>
              <div style={fs.panelTitle}>Active employees with no tips this period</div>
              <div style={{ fontSize: '0.84rem', color: th.muted, marginTop: '0.3rem', lineHeight: 1.5, maxWidth: 720 }}>
                Compares each store’s live Active Paycor roster against everyone who actually has hours somewhere in this loaded period. Someone showing up here either didn’t work at all this period, or worked but their punches are missing. Worth a quick check before finalizing.
              </div>
            </div>
            {missingCheck.loading && <div style={{ fontSize: '0.86rem', color: th.muted, display: 'flex', alignItems: 'center', gap: '0.5rem' }}><FinStatusIcon th={th} status="pending" />Checking {(stores || []).filter(s => s.paycor).length} stores…</div>}
            {missingCheck.error && <div role="alert" style={{ fontSize: '0.86rem', color: th.danger }}>{missingCheck.error}</div>}
            {!missingCheck.loading && !missingCheck.error && missingCheck.results && missingCheck.results.length === 0 && (
              <div style={{ fontSize: '0.86rem', color: th.success, display: 'flex', alignItems: 'center', gap: '0.5rem' }}><FinStatusIcon th={th} status="ok" />Every active employee has recorded hours somewhere in this period. Nothing to flag.</div>
            )}
          </div>
          {!missingCheck.loading && missingCheck.results && missingCheck.results.length > 0 && (
            <div style={{ display: 'grid' }}>
              {missingCheck.results.map(r => (
                <div key={r.pc} style={{ borderTop: `1px solid ${th.cardBorder}`, padding: '0.7rem 1.1rem', display: 'grid', gridTemplateColumns: 'minmax(0, 220px) minmax(0, 1fr)', gap: '0.25rem 1rem' }}>
                  <div style={{ fontSize: '0.86rem', fontWeight: 700, color: th.text }}>{r.name} <span style={{ color: th.muted, fontWeight: 400 }}>(PC# {r.pc}, District {r.district})</span></div>
                  {r.fetchError
                    ? <div style={{ fontSize: '0.84rem', color: th.warn }}>Couldn’t check this store’s roster: {r.fetchError}</div>
                    : <div style={{ fontSize: '0.86rem', color: th.text }}>{r.missing.join(', ')}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
