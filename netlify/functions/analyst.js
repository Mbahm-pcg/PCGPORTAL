// analyst.js — HTTP handler for the UOP Analyst module
// Actions: ask, brief, brief-refresh, case-list, case-detail, case-update, feedback, report-settings

const { askAnalyst } = require('./analyst-lib/analyst-claude');
const { buildDataContext, buildKPISnapshot, buildStoreContext } = require('./analyst-lib/analyst-data');
const { buildBriefPrompt, buildAskPrompt, PERSONA } = require('./analyst-lib/analyst-prompts');
const { generateStructured } = require('./analyst-lib/analyst-claude');
const { getCases, loadCase, updateCaseStatus, loadDecisionLog } = require('./analyst-lib/analyst-cases');
const { cacheSave, cacheLoad } = require('./analyst-lib/analyst-cache');
const { logFeedback, logAccessEvent, loadAccessEntries } = require('./analyst-lib/analyst-audit');
const { loadKBContent, buildKBContext } = require('./analyst-lib/analyst-kb');
const { loadReportSettings } = require('./analyst-lib/analyst-reports');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { action, userId, userRole, district } = payload;
  const t0 = Date.now();

  // Wrap response so every action is audit-logged before returning
  const respond = async (statusCode, body) => {
    const latencyMs = Date.now() - t0;
    // Don't log the audit-log read itself to avoid noise
    if (action !== 'audit-log') {
      logAccessEvent({ userId, userRole, action, district, statusCode, latencyMs }).catch(() => {});
    }
    return json(statusCode, body);
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
      const dataContext = await buildDataContext({ district: district || null });
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
      const dataContext = await buildDataContext({ district: district || null });
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
      const { sendExecReport, sendExecDailyReport, sendDMBriefs, loadReportSettings: loadRS } = require('./analyst-lib/analyst-reports');
      const settings = await loadRS();

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

    // ── Audit Log (read access events for a given date) ───────────────
    if (action === 'audit-log') {
      const { date } = payload;
      const targetDate = date || new Date().toISOString().slice(0, 10);
      const entries = await loadAccessEntries(targetDate);
      return json(200, { date: targetDate, entries, count: entries.length });
    }

    return respond(400, { error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[analyst] error:', err);
    logAccessEvent({ userId, userRole, action, district, statusCode: 500, latencyMs: Date.now() - t0, error: err.message }).catch(() => {});
    return json(500, { error: err.message || 'Internal error' });
  }
};
