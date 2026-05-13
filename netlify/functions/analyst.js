// analyst.js — HTTP handler for the UOP Analyst module
// Actions: ask, brief, brief-refresh, case-list, case-detail, case-update, feedback, report-settings

const { askAnalyst } = require('./analyst-lib/analyst-claude');
const { buildDataContext, buildKPISnapshot } = require('./analyst-lib/analyst-data');
const { buildBriefPrompt, buildAskPrompt, PERSONA } = require('./analyst-lib/analyst-prompts');
const { generateStructured } = require('./analyst-lib/analyst-claude');
const { getCases, loadCase, updateCaseStatus } = require('./analyst-lib/analyst-cases');
const { cacheSave, cacheLoad } = require('./analyst-lib/analyst-cache');
const { logFeedback } = require('./analyst-lib/analyst-audit');
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

  try {
    // ── Ask Analyst (omnibar / chat) ─────────────────────────────────────
    if (action === 'ask') {
      const { question, forceDeep, channelId, history } = payload;
      if (!question) return json(400, { error: 'Missing question' });

      // Build data context scoped to user's district (DMs) or full network (execs)
      const scope = district ? `District ${district}` : 'Network';
      const dataContext = await buildDataContext({ district: district || null, includeStoreDetail: true });

      const prompt = buildAskPrompt(question, userRole || 'executive', scope, new Date().toISOString().slice(0, 10), dataContext);

      // Load conversation history from blob if channelId provided and no inline history
      let chatHistory = history || null;
      if (!chatHistory && channelId) {
        const stored = await cacheLoad(`analyst/chat/${channelId}`);
        if (stored && Array.isArray(stored)) chatHistory = stored;
      }

      const result = await askAnalyst({ userPrompt: prompt, userId, forceDeep, history: chatHistory });

      const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      // Save conversation turn to history blob if channelId provided
      if (channelId) {
        const existing = (await cacheLoad(`analyst/chat/${channelId}`)) || [];
        const updated = Array.isArray(existing) ? existing : [];
        updated.push({ role: 'user', content: question, ts: new Date().toISOString() });
        updated.push({ role: 'assistant', content: result.answer, ts: new Date().toISOString(), messageId });
        // Keep last 20 turns (10 pairs)
        if (updated.length > 20) updated.splice(0, updated.length - 20);
        await cacheSave(`analyst/chat/${channelId}`, updated);
      }

      return json(200, {
        answer: result.answer,
        model: result.model,
        tokens: result.tokens,
        latencyMs: result.latencyMs,
        messageId,
      });
    }

    // ── Chat History (load/clear) ────────────────────────────────────────
    if (action === 'chat-history') {
      const { channelId, clear } = payload;
      if (!channelId) return json(400, { error: 'Missing channelId' });
      if (clear) {
        await cacheSave(`analyst/chat/${channelId}`, []);
        return json(200, { ok: true, cleared: true });
      }
      const history = (await cacheLoad(`analyst/chat/${channelId}`)) || [];
      return json(200, { history });
    }

    // ── Today's Brief ────────────────────────────────────────────────────
    if (action === 'brief') {
      const today = new Date().toISOString().slice(0, 10);
      const role = userRole === 'dm' ? 'District Manager' : 'VP / Executive';
      const briefKey = `analyst/briefs/${today}_${district || 'network'}`;

      // Check cache first
      const cached = await cacheLoad(briefKey);
      if (cached && !payload.refresh) {
        return json(200, { brief: cached, cached: true });
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
      return json(200, { brief, cached: false });
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
      return json(200, { brief, cached: false });
    }

    // ── Case List ────────────────────────────────────────────────────────
    if (action === 'case-list') {
      const { status, severity, limit } = payload;
      const cases = await getCases({ status, district, severity, limit: limit || 20 });

      // Compute totals
      const totalOpportunity = cases.reduce((s, c) => s + (c.dollarOpportunity || 0), 0);
      const byStatus = {};
      cases.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });

      return json(200, { cases, totalOpportunity, byStatus, count: cases.length });
    }

    // ── Case Detail ──────────────────────────────────────────────────────
    if (action === 'case-detail') {
      const { caseId } = payload;
      if (!caseId) return json(400, { error: 'Missing caseId' });
      const c = await loadCase(caseId);
      if (!c) return json(404, { error: 'Case not found' });
      return json(200, { case: c });
    }

    // ── Case Status Update ───────────────────────────────────────────────
    if (action === 'case-update') {
      const { caseId, status } = payload;
      if (!caseId || !status) return json(400, { error: 'Missing caseId or status' });
      const valid = ['New', 'In Review', 'Accepted', 'In Progress', 'Done'];
      if (!valid.includes(status)) return json(400, { error: `Invalid status. Must be: ${valid.join(', ')}` });
      const updated = await updateCaseStatus(caseId, status, userId);
      if (!updated) return json(404, { error: 'Case not found' });
      return json(200, { case: updated });
    }

    // ── Feedback (thumbs up/down) ────────────────────────────────────────
    if (action === 'feedback') {
      const { messageId, rating, comment } = payload;
      if (!messageId || !rating) return json(400, { error: 'Missing messageId or rating' });
      if (!['up', 'down'].includes(rating)) return json(400, { error: 'Rating must be up or down' });
      await logFeedback({ userId, messageId, rating, comment });
      return json(200, { ok: true });
    }

    // ── KPI Snapshot (raw data for debugging) ────────────────────────────
    if (action === 'snapshot') {
      const snapshot = await buildKPISnapshot({ district });
      return json(200, snapshot);
    }

    // ── Report Settings (get/update) ───────────────────────────────────
    if (action === 'report-settings') {
      const { update } = payload;
      if (update) {
        // Merge update into existing settings
        const current = await loadReportSettings();
        const merged = { ...current, ...update };
        await cacheSave('analyst/report-settings', merged);
        return json(200, { settings: merged, updated: true });
      }
      const settings = await loadReportSettings();
      return json(200, { settings });
    }

    // ── Send Report Now (on-demand) ────────────────────────────────────
    if (action === 'send-report') {
      const { reportType } = payload; // 'exec' or 'dm'
      const { sendExecReport, sendDMBriefs, loadReportSettings: loadRS } = require('./analyst-lib/analyst-reports');
      const settings = await loadRS();

      if (reportType === 'exec') {
        const isLaborAdjusted = payload.laborAdjusted || false;
        const sent = await sendExecReport(settings, isLaborAdjusted);
        return json(200, { ok: true, sent, reportType: 'exec', laborAdjusted: isLaborAdjusted });
      }

      if (reportType === 'dm') {
        const usersBlob = await cacheLoad('pcg_portal_users');
        const sent = await sendDMBriefs(settings, Array.isArray(usersBlob) ? usersBlob : []);
        return json(200, { ok: true, sent, reportType: 'dm' });
      }

      return json(400, { error: 'reportType must be exec or dm' });
    }

    return json(400, { error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[analyst] error:', err);
    return json(500, { error: err.message || 'Internal error' });
  }
};
