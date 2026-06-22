// analyst-audit.mjs — Audit logging for every LLM call, feedback, and access event.
// Backed by Neon Postgres (audit_log table). Previously this used one Netlify Blob
// per event; the read path had to list + GET thousands of blobs and timed out, so
// it was migrated to a single indexed table. Exports are unchanged so callers
// (analyst.mjs, analyst-claude.mjs) need no edits.
import { sql } from '../_shared/db.mjs';

// Coerce a possibly-stringy district/number to an INTEGER column value or null.
const toInt = (v) => {
  if (v == null || v === '') return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : null;
};

const dayRange = (date) => date || new Date().toISOString().slice(0, 10);

/** Log a generic audit entry (used by logLLMCall). */
async function logAudit(entry) {
  const {
    type = 'audit', userId = null, userRole = null, action = null, model = null,
    inputTokens = null, outputTokens = null, costUSD = null, latencyMs = null,
    district = null, statusCode = null, rating = null, error = null, ...rest
  } = entry || {};
  const meta = Object.keys(rest).length ? JSON.stringify(rest) : null;
  try {
    const db = sql();
    await db`
      INSERT INTO audit_log (type, user_id, user_role, action, model, input_tokens, output_tokens, cost_usd, latency_ms, district, status_code, rating, error, metadata)
      VALUES (${type}, ${userId}, ${userRole}, ${action}, ${model}, ${inputTokens}, ${outputTokens}, ${costUSD}, ${latencyMs}, ${toInt(district)}, ${statusCode}, ${rating}, ${error}, ${meta}::jsonb)
    `;
  } catch (e) { console.warn('audit_log insert (audit) failed:', e.message); }
}

/** Load audit/LLM entries for a date (everything except access + feedback). */
async function loadAuditEntries(date) {
  try {
    const db = sql();
    const d = dayRange(date);
    const rows = await db`
      SELECT created_at, type, user_id, action, model, input_tokens, output_tokens, cost_usd, latency_ms, error, metadata
      FROM audit_log
      WHERE type NOT IN ('access', 'feedback')
        AND created_at >= ${d}::date AND created_at < (${d}::date + INTERVAL '1 day')
      ORDER BY created_at ASC
    `;
    return rows.map(r => ({
      ts: new Date(r.created_at).toISOString(),
      type: r.type, userId: r.user_id, action: r.action, model: r.model,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      costUSD: r.cost_usd, latencyMs: r.latency_ms, error: r.error,
      ...(r.metadata || {}),
    }));
  } catch (e) { console.warn('loadAuditEntries failed:', e.message); return []; }
}

/** Log an LLM API call with token counts and cost. */
async function logLLMCall({ model, action, inputTokens, outputTokens, latencyMs, userId, error }) {
  // Pricing per 1M tokens
  const pricing = {
    'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
    'claude-sonnet-4-5-20241022': { input: 3.00, output: 15.00 },
  };
  const p = pricing[model] || { input: 3.00, output: 15.00 };
  const costUSD = ((inputTokens || 0) * p.input + (outputTokens || 0) * p.output) / 1_000_000;

  await logAudit({
    type: 'llm_call',
    model,
    action,
    inputTokens,
    outputTokens,
    costUSD: Math.round(costUSD * 1_000_000) / 1_000_000,
    latencyMs,
    userId: userId || null,
    error: error || null,
  });
}

/** Log user feedback (thumbs up/down). */
async function logFeedback({ userId, messageId, rating, comment }) {
  try {
    const db = sql();
    const meta = JSON.stringify({ messageId: messageId || null, comment: comment || null });
    await db`
      INSERT INTO audit_log (type, user_id, rating, metadata)
      VALUES ('feedback', ${userId || null}, ${rating || null}, ${meta}::jsonb)
    `;
  } catch (e) { console.warn('audit_log insert (feedback) failed:', e.message); }
}

/** Log an API access event. */
async function logAccessEvent({ userId, userRole, action, district, statusCode, latencyMs, error, meta }) {
  try {
    const db = sql();
    const m = meta ? JSON.stringify(meta) : null;
    await db`
      INSERT INTO audit_log (type, user_id, user_role, action, district, status_code, latency_ms, error, metadata)
      VALUES ('access', ${userId || null}, ${userRole || null}, ${action || null}, ${toInt(district)}, ${statusCode || null}, ${latencyMs || null}, ${error || null}, ${m}::jsonb)
    `;
  } catch (e) { console.warn('audit_log insert (access) failed:', e.message); }
}

/** Load access events for a date — one indexed query, capped to the most recent `limit`.
 *  Returns entries in ascending time order (the UI reverses for display), with a
 *  `truncated` property = the full count when the cap dropped older rows, else 0. */
async function loadAccessEntries(date, limit = 500) {
  try {
    const db = sql();
    const d = dayRange(date);
    const rows = await db`
      SELECT created_at, user_id, user_role, action, district, status_code, latency_ms, error, metadata
      FROM audit_log
      WHERE type = 'access'
        AND created_at >= ${d}::date AND created_at < (${d}::date + INTERVAL '1 day')
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    const list = rows.map(r => ({
      ts: new Date(r.created_at).toISOString(),
      userId: r.user_id, userRole: r.user_role, action: r.action,
      district: r.district, statusCode: r.status_code, latencyMs: r.latency_ms,
      error: r.error, meta: r.metadata || null,
    })).reverse(); // DESC fetch (newest `limit`) → ascending for the UI

    let truncated = 0;
    if (rows.length === limit) {
      const [{ c }] = await db`
        SELECT count(*)::int AS c FROM audit_log
        WHERE type = 'access'
          AND created_at >= ${d}::date AND created_at < (${d}::date + INTERVAL '1 day')
      `;
      if (c > limit) truncated = c;
    }
    list.truncated = truncated;
    return list;
  } catch (e) {
    console.warn('loadAccessEntries failed:', e.message);
    const empty = [];
    empty.truncated = 0;
    return empty;
  }
}

export { logAudit, loadAuditEntries, logLLMCall, logFeedback, logAccessEvent, loadAccessEntries };
