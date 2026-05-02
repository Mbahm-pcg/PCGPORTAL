// analyst-audit.js — Audit logging for every LLM call, feedback, and action
const { cacheSave, cacheLoad } = require('./analyst-cache');

/** Log an audit entry (appended to daily JSONL blob) */
async function logAudit(entry) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `analyst/audit/${today}`;
  const existing = await cacheLoad(key);
  const lines = Array.isArray(existing) ? existing : [];
  lines.push({
    ts: new Date().toISOString(),
    ...entry,
  });
  await cacheSave(key, lines);
}

/** Log an LLM API call with token counts and cost */
async function logLLMCall({ model, action, inputTokens, outputTokens, latencyMs, userId, error }) {
  // Pricing per 1M tokens (as of 2025)
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

/** Log user feedback (thumbs up/down) */
async function logFeedback({ userId, messageId, rating, comment }) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `analyst/feedback/${today}`;
  const existing = await cacheLoad(key);
  const entries = Array.isArray(existing) ? existing : [];
  entries.push({
    ts: new Date().toISOString(),
    userId,
    messageId,
    rating, // 'up' or 'down'
    comment: comment || null,
  });
  await cacheSave(key, entries);
}

module.exports = { logAudit, logLLMCall, logFeedback };
