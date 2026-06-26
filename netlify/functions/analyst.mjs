// analyst.mjs — HTTP handler for the UOP Analyst module
// Actions: ask, brief, brief-refresh, case-list, case-detail, case-update, feedback, report-settings

import { askAnalyst, askAnalystWithTools, generateStructured } from './analyst-lib/analyst-claude.mjs';
import { MAINT_TOOLS, executeMaintTool } from './analyst-lib/maint-actions.mjs';
import { buildDataContext, buildKPISnapshot, buildStoreContext, buildMaintenanceContext, STORES, getWeatherForecast, getDailyNetSales } from './analyst-lib/analyst-data.mjs';
import { buildBriefPrompt, buildStoreBriefPrompt, buildPrePlanPrompt, buildAskPrompt, PERSONA, MAINT_ASK_SYSTEM, REPORT_SYSTEM, buildReportPrompt } from './analyst-lib/analyst-prompts.mjs';
import { computeStorePar } from './analyst-lib/par-optimizer.mjs';
import { saveReport } from './analyst-lib/analyst-reports-gen.mjs';
import { getCases, loadCase, updateCaseStatus, loadDecisionLog } from './analyst-lib/analyst-cases.mjs';
import { cacheSave, cacheLoad } from './analyst-lib/analyst-cache.mjs';
import { logFeedback, logAccessEvent, loadAccessEntries } from './analyst-lib/analyst-audit.mjs';
import { forecastStoreFull, forecastStoreWeek, learnHolidayFactor, tomorrowISO, addDaysISO } from './analyst-lib/forecast.mjs';
import { holidayInfo } from './analyst-lib/holidays.mjs';
import { loadKBContent, buildKBContext } from './analyst-lib/analyst-kb.mjs';
import { loadReportSettings, sendExecReport, sendExecDailyReport, sendDMBriefs } from './analyst-lib/analyst-reports.mjs';
import { resolveCaller } from './_shared/auth.mjs';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers });
}

export default async (request, context) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return json(405, { error: 'POST only' });

  let payload;
  try {
    payload = await request.json().catch(() => ({}));
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { action, userId, userRole, district } = payload;
  const t0 = Date.now();

  // Wrap response so every action is audit-logged before returning
  const respond = async (status, body) => {
    const latencyMs = Date.now() - t0;
    // Don't log the audit-log read itself to avoid noise
    if (action !== 'audit-log') {
      logAccessEvent({ userId, userRole, action, district, statusCode: status, latencyMs }).catch(() => {});
    }
    return json(status, body);
  };

  // ── Access control ───────────────────────────────────────────────────
  // Resolve the caller's AUTHORITATIVE role/scope from the users table by id, so a crafted
  // payload can't claim a role/district/store it doesn't have. When the caller can't be
  // resolved (no userId / server-internal cron/MCP), fall back to the claimed values.
  const EXEC_ROLES = new Set(['executive', 'it']);
  const caller = await resolveCaller(userId);
  const effRole = caller?.role || userRole;
  const isExecRole = EXEC_ROLES.has(effRole);
  // exec/IT may target any district (drill-down) or null=network; everyone else is locked to
  // their own district, and managers to their own store — claimed values are ignored for them.
  const effDistrict = isExecRole ? (district ?? null) : (caller ? (caller.district ?? null) : (district ?? null));
  const EXEC_ONLY_ACTIONS = new Set([
    'snapshot', 'report-settings', 'send-report', 'create-report',
    'case-list', 'case-detail', 'case-update', 'decision-log', 'audit-log',
  ]);

  try {
    if (EXEC_ONLY_ACTIONS.has(action) && !isExecRole) {
      return respond(403, { error: 'This information is limited to Exec/IT.' });
    }

    // ── Ask Analyst (omnibar / chat) ─────────────────────────────────────
    if (action === 'ask') {
      const { question, forceDeep, channelId, threadId, storePC, history, tickets } = payload;
      if (!question) return respond(400, { error: 'Missing question' });

      // Build data context scoped to the caller's REAL role: store (managers), district (DMs),
      // or full network (execs). A manager is locked to their own store; a DM to their district.
      const effStorePC = effRole === 'manager' ? (caller?.storePC || storePC) : null;
      const isMaint = effRole === 'maintenance';
      let dataContext;
      let scope;
      if (isMaint) {
        // Maintenance crew works the whole network — give Orion the full ticket board
        // (triage, overdue, per-store history, recent resolutions) instead of financials.
        dataContext = await buildMaintenanceContext({ now: new Date() });
        scope = 'Maintenance — all stores';
      } else if (effRole === 'manager' && effStorePC) {
        dataContext = await buildStoreContext({ storePC: effStorePC });
        scope = `Store ${effStorePC}`;
      } else {
        scope = effDistrict ? `District ${effDistrict}` : 'Network';
        dataContext = await buildDataContext({ district: effDistrict || null, includeStoreDetail: true });
      }

      const [kbFiles] = await Promise.all([loadKBContent({ district: effDistrict || null, userId, userRole: effRole })]);
      const kbContext = buildKBContext(kbFiles);

      // Build open tickets context block (passed from frontend, already scoped to user's district/store)
      let ticketsContext = '';
      if (Array.isArray(tickets) && tickets.length > 0) {
        const lines = tickets.map(t =>
          `• #${t.number || t.id} | ${t.storeName || t.storePC} | ${t.title} | ${t.priority || 'Normal'} priority | ${t.category || ''} | Opened ${t.createdAt ? t.createdAt.slice(0, 10) : 'unknown'}${t.description ? ' | ' + t.description.slice(0, 120) : ''}`
        ).join('\n');
        ticketsContext = `\n\nOpen support tickets (${tickets.length}):\n${lines}`;
      }

      const prompt = buildAskPrompt(question, effRole || 'executive', scope, new Date().toISOString().slice(0, 10), dataContext, kbContext, ticketsContext);

      // Use thread-scoped history key when threadId is provided
      const historyKey = threadId
        ? `analyst/chat/${channelId}/thread/${threadId}`
        : `analyst/chat/${channelId}`;

      // Load conversation history from blob if channelId provided and no inline history
      let chatHistory = history || null;
      if (!chatHistory && channelId) {
        const stored = await cacheLoad(historyKey);
        if (stored && Array.isArray(stored)) chatHistory = stored;
      }

      // Maintenance gets tool-use so Orion can act on tickets (close/comment/assign/etc.);
      // the executor re-checks the caller's real role before any write.
      const maintCtx = { actorId: caller?.id, role: effRole }; // stable so the actor-name lookup memoizes
      const result = isMaint
        ? await askAnalystWithTools({
            userPrompt: prompt, system: MAINT_ASK_SYSTEM, history: chatHistory, userId,
            tools: MAINT_TOOLS,
            executeTool: (name, input) => executeMaintTool(name, input, maintCtx),
          })
        : await askAnalyst({ userPrompt: prompt, userId, forceDeep, history: chatHistory });

      const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      // Save conversation turn to history blob if channelId provided
      if (channelId) {
        const existing = (await cacheLoad(historyKey)) || [];
        const updated = Array.isArray(existing) ? existing : [];
        updated.push({ role: 'user', content: question, ts: new Date().toISOString() });
        updated.push({ role: 'assistant', content: result.answer, ts: new Date().toISOString(), messageId });
        // Keep last 20 turns (10 pairs)
        if (updated.length > 20) updated.splice(0, updated.length - 20);
        await cacheSave(historyKey, updated);
      }

      // Parse structured @[role:identifier] mention tags from the answer
      const mentionRegex = /@\[(dm|gm):([^\]]+)\]/g;
      const mentions = [];
      let mentionMatch;
      while ((mentionMatch = mentionRegex.exec(result.answer)) !== null) {
        mentions.push({ role: mentionMatch[1], identifier: mentionMatch[2], raw: mentionMatch[0] });
      }

      return respond(200, {
        answer: result.answer,
        model: result.model,
        tokens: result.tokens,
        latencyMs: result.latencyMs,
        messageId,
        mentions,
      });
    }

    // ── Chat History (load/clear) ────────────────────────────────────────
    if (action === 'chat-history') {
      const { channelId, clear } = payload;
      if (!channelId) return respond(400, { error: 'Missing channelId' });
      if (clear) {
        await cacheSave(`analyst/chat/${channelId}`, []);
        return respond(200, { ok: true, cleared: true });
      }
      const history = (await cacheLoad(`analyst/chat/${channelId}`)) || [];
      return respond(200, { history });
    }

    // ── Today's Brief ────────────────────────────────────────────────────
    if (action === 'brief') {
      const today = new Date().toISOString().slice(0, 10);
      const role = userRole === 'dm' ? 'District Manager' : 'VP / Executive';
      const briefKey = `analyst/briefs/${today}_${district || 'network'}`;

      // Check cache first
      const cached = await cacheLoad(briefKey);
      if (cached && !payload.refresh) {
        return respond(200, { brief: cached, cached: true });
      }

      // Generate fresh brief
      const dataContext = await buildDataContext({ district: district || null, includeVoids: true });
      const prompt = buildBriefPrompt(role, today, dataContext);
      const result = await generateStructured({
        system: PERSONA,
        userPrompt: prompt,
        action: 'brief',
        userId,
      });

      const brief = {
        date: today,
        scope: district ? `District ${district}` : 'Network',
        role,
        content: result.text,
        generatedAt: new Date().toISOString(),
        model: result.model,
      };

      await cacheSave(briefKey, brief);
      return respond(200, { brief, cached: false });
    }

    // ── Brief Refresh (force regeneration) ───────────────────────────────
    if (action === 'brief-refresh') {
      payload.refresh = true;
      payload.action = 'brief';
      // Re-call with refresh flag
      const today = new Date().toISOString().slice(0, 10);
      const role = userRole === 'dm' ? 'District Manager' : 'VP / Executive';
      const dataContext = await buildDataContext({ district: district || null, includeVoids: true });
      const prompt = buildBriefPrompt(role, today, dataContext);
      const result = await generateStructured({
        system: PERSONA,
        userPrompt: prompt,
        action: 'brief',
        userId,
      });

      const brief = {
        date: today,
        scope: district ? `District ${district}` : 'Network',
        role,
        content: result.text,
        generatedAt: new Date().toISOString(),
        model: result.model,
      };

      const briefKey = `analyst/briefs/${today}_${district || 'network'}`;
      await cacheSave(briefKey, brief);
      return respond(200, { brief, cached: false });
    }

    // ── Per-Store Brief ──────────────────────────────────────────────────
    if (action === 'store-brief') {
      const { storePC } = payload;
      if (!storePC) return respond(400, { error: 'Missing storePC' });
      const store = STORES.find(s => s.pc === storePC);
      if (!store) return respond(404, { error: 'Store not found' });

      const today = new Date().toISOString().slice(0, 10);
      const briefKey = `analyst/store-briefs/${storePC}_${today}`;

      const cached = await cacheLoad(briefKey);
      if (cached && !payload.refresh) {
        return respond(200, { brief: cached, cached: true });
      }

      const dataContext = await buildStoreContext({ storePC });
      const prompt = buildStoreBriefPrompt(store.name, storePC, today, dataContext);
      const result = await generateStructured({
        system: PERSONA,
        userPrompt: prompt,
        action: 'store-brief',
        userId,
      });

      const brief = {
        date: today,
        storePC,
        storeName: store.name,
        content: result.text,
        generatedAt: new Date().toISOString(),
        model: result.model,
      };

      await cacheSave(briefKey, brief);
      return respond(200, { brief, cached: false });
    }

    // ── Forecast Pre-Plan ────────────────────────────────────────────────
    // Tomorrow's forecast + suggested par + an Orion game plan (how to hit it,
    // what to avoid) grounded in this store's labor/schedule/voids/DCP data.
    if (action === 'forecast-plan') {
      const { storePC } = payload;
      if (!storePC) return respond(400, { error: 'Missing storePC' });
      const store = STORES.find(s => String(s.pc) === String(storePC));
      if (!store) return respond(404, { error: 'Store not found' });

      const target = payload.date || tomorrowISO();
      const planKey = `analyst/forecast-plans/${storePC}_${target}`;
      const cached = await cacheLoad(planKey);
      if (cached && !payload.refresh) return respond(200, { plan: cached, cached: true });

      // Expected weather + holiday for the target day (same wiring as `forecast`).
      const wxAll = await getWeatherForecast().catch(() => null);
      const wxDays = (wxAll && wxAll[store.district] && wxAll[store.district].days) || [];
      const cond = (wxDays.find(d => d && d.date === target) || {}).condition;
      const hf = await learnHolidayFactor(storePC, target, (pc, d) => getDailyNetSales(pc, d));
      const tgtHoliday = holidayInfo(target);

      const { forecast } = await forecastStoreFull(storePC, target, {
        weather: cond ? { condition: cond } : undefined,
        holidayFactor: hf ? hf.factor : 1,
        // Surface the holiday even when its sales factor couldn't be learned.
        holidayName: hf ? hf.name : (tgtHoliday ? tgtHoliday.name : null),
        holidayUnknown: !!tgtHoliday && !hf,
      });

      // Suggested par for the day (donut/munchkin), weather-adjusted off the forecast.
      const itemHistory = (await cacheLoad(`pcg_item_history_${storePC}`)) || [];
      const par = computeStorePar(itemHistory, {
        targetDate: target,
        weatherCondition: cond,
        weatherImpactPct: forecast ? Math.round((forecast.weatherFactor - 1) * 100) : 0,
      });

      const dataContext = await buildStoreContext({ storePC });
      const prompt = buildPrePlanPrompt(store.name, storePC, target, forecast, par, dataContext);
      const result = await generateStructured({ system: PERSONA, userPrompt: prompt, action: 'brief', userId });

      const plan = {
        date: target,
        storePC,
        storeName: store.name,
        forecast,
        par,
        content: result.text,
        generatedAt: new Date().toISOString(),
        model: result.model,
      };
      await cacheSave(planKey, plan);
      return respond(200, { plan, cached: false });
    }

    // ── Case List ────────────────────────────────────────────────────────
    if (action === 'case-list') {
      const { status, severity, limit } = payload;
      const cases = await getCases({ status, district, severity, limit: limit || 20 });

      // Compute totals
      const totalOpportunity = cases.reduce((s, c) => s + (c.dollarOpportunity || 0), 0);
      const byStatus = {};
      cases.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });

      return respond(200, { cases, totalOpportunity, byStatus, count: cases.length });
    }

    // ── Case Detail ──────────────────────────────────────────────────────
    if (action === 'case-detail') {
      const { caseId } = payload;
      if (!caseId) return respond(400, { error: 'Missing caseId' });
      const c = await loadCase(caseId);
      if (!c) return respond(404, { error: 'Case not found' });
      return respond(200, { case: c });
    }

    // ── Case Status Update ───────────────────────────────────────────────
    if (action === 'case-update') {
      const { caseId, status, reason } = payload;
      if (!caseId || !status) return respond(400, { error: 'Missing caseId or status' });
      const valid = ['New', 'In Review', 'Accepted', 'In Progress', 'Done'];
      if (!valid.includes(status)) return respond(400, { error: `Invalid status. Must be: ${valid.join(', ')}` });
      const updated = await updateCaseStatus(caseId, status, userId, reason);
      if (!updated) return respond(404, { error: 'Case not found' });
      return respond(200, { case: updated });
    }

    // ── Decision Log ─────────────────────────────────────────────────────
    if (action === 'decision-log') {
      const { days } = payload;
      const entries = await loadDecisionLog({ days: days || 30 });
      const accepted = entries.filter(e => ['Accepted', 'In Progress', 'Done'].includes(e.decision));
      const byAnomaly = {};
      const byDistrict = {};
      entries.forEach(e => {
        byAnomaly[e.anomalyType] = (byAnomaly[e.anomalyType] || 0) + 1;
        if (e.district) byDistrict[e.district] = (byDistrict[e.district] || 0) + 1;
      });
      const totalOpportunity = accepted.reduce((s, e) => s + (e.dollarOpportunity || 0), 0);
      return respond(200, { entries, count: entries.length, acceptedCount: accepted.length, totalOpportunity, byAnomaly, byDistrict });
    }

    // ── Feedback (thumbs up/down) ────────────────────────────────────────
    if (action === 'feedback') {
      const { messageId, rating, comment } = payload;
      if (!messageId || !rating) return respond(400, { error: 'Missing messageId or rating' });
      if (!['up', 'down'].includes(rating)) return respond(400, { error: 'Rating must be up or down' });
      await logFeedback({ userId, messageId, rating, comment });
      return respond(200, { ok: true });
    }

    // ── KPI Snapshot (raw data for debugging) ────────────────────────────
    if (action === 'snapshot') {
      const snapshot = await buildKPISnapshot({ district });
      return respond(200, snapshot);
    }

    // ── Report Settings (get/update) ───────────────────────────────────
    if (action === 'report-settings') {
      const { update } = payload;
      if (update) {
        // Merge update into existing settings
        const current = await loadReportSettings();
        const merged = { ...current, ...update };
        await cacheSave('analyst/report-settings', merged);
        return respond(200, { settings: merged, updated: true });
      }
      const settings = await loadReportSettings();
      return respond(200, { settings });
    }

    // ── Send Report Now (on-demand) ────────────────────────────────────
    if (action === 'send-report') {
      const { reportType } = payload; // 'exec' or 'dm'
      const settings = await loadReportSettings();

      if (reportType === 'exec') {
        const isLaborAdjusted = payload.laborAdjusted || false;
        const sent = await sendExecReport(settings, isLaborAdjusted);
        return respond(200, { ok: true, sent, reportType: 'exec', laborAdjusted: isLaborAdjusted });
      }

      if (reportType === 'daily') {
        const sent = await sendExecDailyReport(settings);
        return respond(200, { ok: true, sent, reportType: 'daily' });
      }

      if (reportType === 'dm') {
        const usersBlob = await cacheLoad('pcg_portal_users');
        const sent = await sendDMBriefs(settings, Array.isArray(usersBlob) ? usersBlob : []);
        return respond(200, { ok: true, sent, reportType: 'dm' });
      }

      return respond(400, { error: 'reportType must be exec, daily, or dm' });
    }

    // ── Client Event Log (PDF download, sync, backup, errors) ────────
    if (action === 'log-event') {
      const { event, meta } = payload;
      if (!event) return respond(400, { error: 'Missing event' });
      await logAccessEvent({ userId, userRole, action: event, district, statusCode: meta?.error ? 500 : 200, latencyMs: meta?.latencyMs || null, error: meta?.error || null, meta: meta || null });
      return json(200, { ok: true });
    }

    // ── Sales forecast (baseline) — project a store's day + live accuracy ──
    if (action === 'forecast') {
      const { storePC, date, range } = payload;
      if (!storePC) return respond(400, { error: 'Missing storePC' });

      // Expected weather (Open-Meteo 7-day, by district) → condition per date.
      const store = STORES.find(s => String(s.pc) === String(storePC));
      const wxAll = await getWeatherForecast().catch(() => null);
      const wxDays = (store && wxAll && wxAll[store.district] && wxAll[store.district].days) || [];
      const condByDate = {};
      wxDays.forEach(d => { if (d && d.date) condByDate[d.date] = d.condition; });
      const weatherFor = (dt) => (condByDate[dt] ? { condition: condByDate[dt] } : undefined);
      const pulseSales = (pc, d) => getDailyNetSales(pc, d);

      // range:'week' → model-driven projection for the Sunday–Saturday calendar
      // week (each day from its own weekday history); default → single-day
      // forecast + live accuracy. Both factor in weather + holidays (the latter
      // learned from Pulse history).
      if (range === 'week') {
        // Anchor the week to its Sunday. Client passes weekStart (computed in the
        // user's local time); fall back to the Sunday of the week containing the
        // target date so the view is always a full Sun→Sat week, never a rolling 7.
        const sundayOf = (iso) => { const dd = new Date(`${iso}T12:00:00`); dd.setDate(dd.getDate() - dd.getDay()); return `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`; };
        const start = payload.weekStart || sundayOf(date || tomorrowISO());
        const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(start, i));
        const weatherByDate = {};
        dates.forEach(d => { if (condByDate[d]) weatherByDate[d] = { condition: condByDate[d] }; });
        // Learn holiday factors only for the days that are actually holidays, and
        // do so SEQUENTIALLY. learnHolidayFactor does a load-modify-save of one
        // shared per-store cache blob (pcg_holiday_factor_{pc}); learning two
        // holidays in the same window concurrently (e.g. Dec 24+25, or Dec 31 +
        // Jan 1) would race and lose one's cached factor, forcing it to re-hit
        // Pulse on every request. Ordinary days never touch the cache (they
        // return null before any I/O), and a 7-day window holds at most ~2
        // holidays — each internally parallelizes its Pulse calls — so this stays
        // well under the 26s function timeout.
        const holidayFactorByDate = {}, holidayNameByDate = {}, holidayUnknownByDate = {};
        for (const d of dates) {
          const info = holidayInfo(d);
          if (!info) continue;
          const hf = await learnHolidayFactor(storePC, d, pulseSales).catch(() => null);
          if (hf) { holidayFactorByDate[d] = hf.factor; holidayNameByDate[d] = hf.name; }
          // Holiday with no learnable prior-year sales: surface the name (so the
          // day isn't shown as an ordinary weekday) and flag it unknown.
          else { holidayNameByDate[d] = info.name; holidayUnknownByDate[d] = true; }
        }
        const week = await forecastStoreWeek(storePC, start, { weatherByDate, holidayFactorByDate, holidayNameByDate, holidayUnknownByDate });

        if (week && Array.isArray(week.days)) {
          // Per-day actual net sales (elapsed days only — future dates have no sales,
          // so skip those Pulse calls) and the LY same-day +2% anchor (all 7 days).
          // Fetched in parallel so the week adds ~one round-trip rather than many.
          const today = payload.today || null;
          const [actuals, lyNets] = await Promise.all([
            Promise.all(dates.map(d => (!today || d <= today) ? getDailyNetSales(storePC, d) : Promise.resolve(null))),
            Promise.all(dates.map(d => getDailyNetSales(storePC, addDaysISO(d, -364)))),
          ]);
          week.days.forEach((day, i) => {
            const ly = lyNets[i];
            // Re-anchor the model's per-day projection to LY same weekday +2%,
            // keeping its shape (low/high/dayparts scale by the same factor).
            if (ly > 0 && day.dayTotal > 0) {
              const k = (ly * 1.02) / day.dayTotal;
              day.modelDayTotal = day.dayTotal;
              day.lyAnchor = Math.round(ly * 1.02);
              day.dayTotal = day.lyAnchor;
              day.low = Math.round(day.low * k);
              day.high = Math.round(day.high * k);
              if (day.dayparts) day.dayparts = {
                amRush: Math.round(day.dayparts.amRush * k),
                midMorning: Math.round(day.dayparts.midMorning * k),
                lunch: Math.round(day.dayparts.lunch * k),
                afternoon: Math.round(day.dayparts.afternoon * k),
              };
            }
            if (actuals[i] > 0) day.actual = Math.round(actuals[i]);
          });
          // Recompute weekly totals from the (anchored) per-day numbers, combining
          // day bands in quadrature (matches computeWeekForecast's method).
          const valid = week.days.filter(d => d.dayTotal != null);
          if (valid.length) {
            week.weekTotal = Math.round(valid.reduce((s, d) => s + d.dayTotal, 0));
            week.low = Math.round(week.weekTotal - Math.sqrt(valid.reduce((s, d) => s + Math.pow(d.dayTotal - d.low, 2), 0)));
            week.high = Math.round(week.weekTotal + Math.sqrt(valid.reduce((s, d) => s + Math.pow(d.high - d.dayTotal, 2), 0)));
          }
          // Week-to-date actual vs the forecast for those same elapsed days (a fair
          // pace). Only count days that have BOTH an actual and a model forecast, so a
          // day with sales but no weekday-history forecast can't skew the ratio.
          const done = week.days.filter(d => d.actual != null && d.dayTotal != null);
          week.weekActual = done.length ? Math.round(done.reduce((s, d) => s + d.actual, 0)) : null;
          week.forecastToDate = done.length ? Math.round(done.reduce((s, d) => s + d.dayTotal, 0)) : null;
        }

        return respond(200, { storePC, startDate: start, week });
      }

      const target = date || tomorrowISO();
      const hf = await learnHolidayFactor(storePC, target, pulseSales);
      const tgtHoliday = holidayInfo(target);
      const { forecast, accuracy } = await forecastStoreFull(storePC, target, {
        weather: weatherFor(target),
        holidayFactor: hf ? hf.factor : 1,
        // Surface the holiday even when its sales factor couldn't be learned, so
        // a closed/reduced holiday isn't silently projected as a normal weekday.
        holidayName: hf ? hf.name : (tgtHoliday ? tgtHoliday.name : null),
        holidayUnknown: !!tgtHoliday && !hf,
      });
      // YoY cross-check: last year's same weekday (−364d preserves day-of-week) × 1.02.
      // Surfaced alongside the model number so a manager can sanity-check the
      // recent-weeks model against what the store actually did a year ago.
      if (forecast) {
        const lyDate = addDaysISO(target, -364);
        const lyNet = await getDailyNetSales(storePC, lyDate);
        if (lyNet > 0) {
          forecast.lyDate = lyDate;
          forecast.lyNet = Math.round(lyNet);
          forecast.lyAnchor = Math.round(lyNet * 1.02);
        }
      }
      return respond(200, { storePC, date: target, forecast, accuracy });
    }

    // ── Audit Log (read access events for a given date) ───────────────
    if (action === 'audit-log') {
      const { date } = payload;
      const targetDate = date || new Date().toISOString().slice(0, 10);
      const entries = await loadAccessEntries(targetDate);
      return json(200, { date: targetDate, entries, count: entries.length, truncated: entries.truncated || 0 });
    }

    // ── Create Report (on-demand dashboard generation) ────────────────
    if (action === 'create-report') {
      const { prompt: userPrompt, scope, channelId } = payload;
      const reportDistrict = scope?.startsWith('district:') ? parseInt(scope.split(':')[1]) : null;
      const storePC = scope?.startsWith('store:') ? scope.split(':')[1] : null;
      const dataContext = await buildDataContext({ district: reportDistrict, storePC, userRole });
      const kpiSnapshot = await buildKPISnapshot({ district: reportDistrict });

      const dataSnapshot = `${dataContext}\n\nKPI Summary:\n${JSON.stringify(kpiSnapshot, null, 2)}`;
      const userMessage = buildReportPrompt(userPrompt, dataSnapshot);

      const answer = await askAnalyst({ userPrompt: userMessage, userId, history: [] });
      const rawAnswer = answer.answer || answer;

      let artifact;
      try {
        const parsed = typeof rawAnswer === 'string'
          ? JSON.parse(rawAnswer.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim())
          : rawAnswer;
        artifact = {
          type: parsed.type || 'dashboard',
          title: parsed.title || (userPrompt || '').slice(0, 60),
          scope: scope || 'network',
          createdBy: `user:${userId}`,
          trigger: 'on-demand',
          narrative: parsed.narrative || '',
          components: Array.isArray(parsed.components) ? parsed.components.slice(0, 8) : [],
        };
      } catch (parseErr) {
        return respond(200, { error: 'Failed to parse report structure', raw: rawAnswer });
      }

      const reportId = await saveReport(artifact);

      if (channelId) {
        const messages = (await cacheLoad('pcg_chat_messages_v1')) || [];
        messages.push({
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          channelId,
          senderId: 'orion',
          senderName: 'Orion',
          text: `New ${artifact.type} ready: **${artifact.title}** — [View in Reports](?tab=reports&report=${reportId})`,
          timestamp: new Date().toISOString(),
        });
        await cacheSave('pcg_chat_messages_v1', messages);
      }

      return respond(200, { ok: true, reportId, title: artifact.title });
    }

    return respond(400, { error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[analyst] error:', err);
    logAccessEvent({ userId, userRole, action, district, statusCode: 500, latencyMs: Date.now() - t0, error: err.message }).catch(() => {});
    return json(500, { error: err.message || 'Internal error' });
  }
};
