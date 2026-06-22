// analyst-audit.js — Audit logging for every LLM call, feedback, and action
// Per-entry blob keys (analyst/audit/{date}/{ts}_{rand}) prevent concurrent-write race conditions
import { cacheSave, cacheLoad, cacheList } from './analyst-cache.mjs';

/** Log an audit entry — one blob per event to avoid concurrent-write collisions */
async function logAudit(entry) {
  const today = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 7);
  const key = `analyst/audit/${today}/${Date.now()}_${rand}`;
  await cacheSave(key, { ts: new Date().toISOString(), ...entry });
}

/** Load all audit entries for a given date (aggregated from per-entry blobs) */
async function loadAuditEntries(date) {
  const keys = await cacheList(`analyst/audit/${date}/`);
  const entries = await Promise.all(keys.map(k => cacheLoad(k)));
  return entries.filter(Boolean).sort((a, b) => (a.ts > b.ts ? 1 : -1));
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

/** Log user feedback (thumbs up/down) — one blob per event */
async function logFeedback({ userId, messageId, rating, comment }) {
  const today = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 7);
  const key = `analyst/feedback/${today}/${Date.now()}_${rand}`;
  await cacheSave(key, {
    ts: new Date().toISOString(),
    userId,
    messageId,
    rating,
    comment: comment || null,
  });
}

/** Log an API access event — one blob per event to avoid concurrent-write collisions */
async function logAccessEvent({ userId, userRole, action, district, statusCode, latencyMs, error, meta }) {
  const today = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 7);
  const key = `analyst/access/${today}/${Date.now()}_${rand}`;
  await cacheSave(key, {
    ts: new Date().toISOString(),
    type: 'access',
    userId: userId || null,
    userRole: userRole || null,
    action: action || null,
    district: district || null,
    statusCode: statusCode || null,
    latencyMs: latencyMs || null,
    error: error || null,
    meta: meta || null,
  });
}

/** Load access events for a given date (aggregated from per-entry blobs).
 *  A busy day can accumulate thousands of per-event blobs; loading every one
 *  (a blob GET each) overruns the 26s function timeout and the read returns
 *  nothing. Keys embed the epoch ms (analyst/access/{date}/{ms}_{rand}) so a
 *  lexicographic sort is chronological — we keep only the most recent `limit`
 *  and GET just those, bounding the work regardless of the day's volume. */
async function loadAccessEntries(date, limit = 500) {
  const keys = await cacheList(`analyst/access/${date}/`);
  const total = keys.length;
  const recent = keys.sort().slice(-limit);
  // GET in bounded batches rather than one giant Promise.all — a single fan-out
  // of hundreds of concurrent blob reads can exhaust the function's sockets and
  // stall, which is what made the read time out (502) in the first place.
  const entries = [];
  const BATCH = 50;
  for (let i = 0; i < recent.length; i += BATCH) {
    const chunk = await Promise.all(recent.slice(i, i + BATCH).map(k => cacheLoad(k)));
    entries.push(...chunk);
  }
  const list = entries.filter(Boolean).sort((a, b) => (a.ts > b.ts ? 1 : -1));
  list.truncated = total > recent.length ? total : 0; // total when capped, else 0
  return list;
}

export { logAudit, loadAuditEntries, logLLMCall, logFeedback, logAccessEvent, loadAccessEntries };
