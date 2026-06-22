// analyst.mjs — HTTP handler for the UOP Analyst module
// Actions: ask, brief, brief-refresh, case-list, case-detail, case-update, feedback, report-settings

import { askAnalyst, generateStructured } from './analyst-lib/analyst-claude.mjs';
import { buildDataContext, buildKPISnapshot, buildStoreContext, STORES, getWeatherForecast, getDailyNetSales } from './analyst-lib/analyst-data.mjs';
import { buildBriefPrompt, buildStoreBriefPrompt, buildPrePlanPrompt, buildAskPrompt, PERSONA, REPORT_SYSTEM, buildReportPrompt } from './analyst-lib/analyst-prompts.mjs';
import { computeStorePar } from './analyst-lib/par-optimizer.mjs';
import { saveReport } from './analyst-lib/analyst-reports-gen.mjs';
import { getCases, loadCase, updateCaseStatus, loadDecisionLog } from './analyst-lib/analyst-cases.mjs';
import { cacheSave, cacheLoad } from './analyst-lib/analyst-cache.mjs';
import { logFeedback, logAccessEvent, loadAccessEntries } from './analyst-lib/analyst-audit.mjs';
import { forecastStoreFull, forecastStoreWeek, learnHolidayFactor, tomorrowISO, addDaysISO } from './analyst-lib/forecast.mjs';
import { holidayInfo } from './analyst-lib/holidays.mjs';
import { loadKBContent, buildKBContext } from './analyst-lib/analyst-kb.mjs';
import { loadReportSettings, sendExecReport, sendExecDailyReport, sendDMBriefs } from './analyst-lib/analyst-reports.mjs';

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

  try {
    // ── Ask Analyst (omnibar / chat) ─────────────────────────────────────
    if (action === 'ask') {
      const { question, forceDeep, channelId, threadId, storePC, history, tickets } = payload;
      if (!question) return respond(400, { error: 'Missing question' });

      // Build data context scoped to user's role: store (managers), district (DMs), or full network (execs)
      let dataContext;
      let scope;
      if (storePC && userRole === 'manager') {
        dataContext = await buildStoreContext({ storePC });
        scope = `Store ${storePC}`;
      } else {
        scope = district ? `District ${district}` : 'Network';
        dataContext = await buildDataContext({ district: district || null, includeStoreDetail: true });
      }

      const [kbFiles] = await Promise.all([loadKBContent({ district: district || null, userId, userRole })]);
      const kbContext = buildKBContext(kbFiles);

      // Build open tickets context block (passed from frontend, already scoped to user's district/store)
      let ticketsContext = '';
      if (Array.isArray(tickets) && tickets.length > 0) {
        const lines = tickets.map(t =>
          `• #${t.number || t.id} | ${t.storeName || t.storePC} | ${t.title} | ${t.priority || 'Normal'} priority | ${t.category || ''} | Opened ${t.createdAt ? t.createdAt.slice(0, 10) : 'unknown'}${t.description ? ' | ' + t.description.slice(0, 120) : ''}`
        ).join('\n');
        ticketsContext = `\n\nOpen support tickets (${tickets.length}):\n${lines}`;
      }

      const prompt = buildAskPrompt(question, userRole || 'executive', scope, new Date().toISOString().slice(0, 10), dataContext, kbContext, ticketsContext);

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

      const result = await askAnalyst({ userPrompt: prompt, userId, forceDeep, history: chatHistory });

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

      // range:'week' → model-driven next-7-days projection (each day from its
      // own weekday history); default → single-day forecast + live accuracy.
      // Both factor in weather + holidays (the latter learned from Pulse history).
      if (range === 'week') {
        const start = date || tomorrowISO();
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
