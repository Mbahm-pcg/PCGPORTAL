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

// ── Orion Learning Loop — Q&A corpus ─────────────────────────────────────────
// Every user question to Orion + how it answered, in a queryable table. Powers the
// "what do people ask" analytics and the knowledge-gap backlog. Table is lazily
// created (idempotent) so it works without a manual db-migrate trigger.
let _qaReady = false;
async function ensureQATable(db) {
  if (_qaReady) return;
  await db`
    CREATE TABLE IF NOT EXISTS orion_qa (
      id           SERIAL PRIMARY KEY,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_id      INTEGER,
      user_role    VARCHAR(50),
      scope        VARCHAR(60),
      question     TEXT,
      answer       TEXT,
      model        VARCHAR(80),
      latency_ms   INTEGER,
      answered     BOOLEAN,
      gap_reason   VARCHAR(30),
      feedback     VARCHAR(10),
      message_id   VARCHAR(80),
      resolved     BOOLEAN NOT NULL DEFAULT false
    )`;
  await db`CREATE INDEX IF NOT EXISTS orion_qa_created_idx ON orion_qa(created_at)`;
  await db`CREATE INDEX IF NOT EXISTS orion_qa_gap_idx ON orion_qa(answered, feedback)`;
  // `regraded` — set once the independent judge has re-scored the row (idempotent add).
  await db`ALTER TABLE orion_qa ADD COLUMN IF NOT EXISTS regraded BOOLEAN NOT NULL DEFAULT false`;
  _qaReady = true;
}

/** Record one Orion Q&A turn. Fire-and-forget from the ask handler. */
async function logQA({ userId, userRole, scope, question, answer, model, latencyMs, answered, gapReason, messageId }) {
  try {
    const db = sql();
    await ensureQATable(db);
    await db`
      INSERT INTO orion_qa (user_id, user_role, scope, question, answer, model, latency_ms, answered, gap_reason, message_id)
      VALUES (${userId ?? null}, ${userRole || null}, ${scope || null}, ${question || null}, ${answer || null},
              ${model || null}, ${latencyMs ?? null}, ${answered ?? null}, ${gapReason || null}, ${messageId || null})`;
  } catch (e) { console.warn('orion_qa insert failed:', e.message); }
}

/** Attach a 👍/👎 to a logged Q&A row by messageId. */
async function updateQAFeedback({ messageId, feedback }) {
  if (!messageId) return;
  try {
    const db = sql();
    await ensureQATable(db);
    await db`UPDATE orion_qa SET feedback = ${feedback || null} WHERE message_id = ${messageId}`;
  } catch (e) { console.warn('orion_qa feedback update failed:', e.message); }
}

/** Load recent Q&A rows (admin analytics). `gapsOnly` = misses (self-flagged or 👎).
 *  LEFT JOINs users so each row carries the asker's name (name-level attribution). */
async function loadQA({ days = 30, gapsOnly = false, limit = 500 } = {}) {
  try {
    const db = sql();
    await ensureQATable(db);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = gapsOnly
      ? await db`SELECT q.*, u.name AS user_name FROM orion_qa q LEFT JOIN users u ON u.id = q.user_id WHERE q.created_at >= ${since} AND q.resolved = false AND (q.answered = false OR q.feedback = 'down') ORDER BY q.created_at DESC LIMIT ${limit}`
      : await db`SELECT q.*, u.name AS user_name FROM orion_qa q LEFT JOIN users u ON u.id = q.user_id WHERE q.created_at >= ${since} ORDER BY q.created_at DESC LIMIT ${limit}`;
    return rows.map(r => ({
      id: r.id, ts: new Date(r.created_at).toISOString(), userId: r.user_id, userName: r.user_name || null, userRole: r.user_role,
      scope: r.scope, question: r.question, answer: r.answer, model: r.model, latencyMs: r.latency_ms,
      answered: r.answered, gapReason: r.gap_reason, feedback: r.feedback, resolved: r.resolved,
    }));
  } catch (e) { console.warn('loadQA failed:', e.message); return []; }
}

/** Cheap count of unreviewed knowledge gaps (no LLM) — for the admin badge. */
async function countQAGaps({ days = 30 } = {}) {
  try {
    const db = sql();
    await ensureQATable(db);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const [{ c }] = await db`SELECT count(*)::int AS c FROM orion_qa WHERE created_at >= ${since} AND resolved = false AND (answered = false OR feedback = 'down')`;
    return c || 0;
  } catch (e) { console.warn('countQAGaps failed:', e.message); return 0; }
}

/** Weekly answered-rate trend — the proof-of-loop metric. Returns oldest→newest. */
async function qaTrend({ weeks = 8 } = {}) {
  try {
    const db = sql();
    await ensureQATable(db);
    const since = new Date(Date.now() - weeks * 7 * 86400000).toISOString();
    const rows = await db`
      SELECT date_trunc('week', created_at) AS wk,
             count(*)::int AS total,
             count(*) FILTER (WHERE answered IS TRUE)::int AS answered,
             count(*) FILTER (WHERE answered IS FALSE OR feedback = 'down')::int AS misses
      FROM orion_qa WHERE created_at >= ${since}
      GROUP BY wk ORDER BY wk ASC`;
    return rows.map(r => {
      const assessed = r.answered + r.misses;
      return { week: new Date(r.wk).toISOString().slice(0, 10), total: r.total, answered: r.answered, misses: r.misses,
        rate: assessed ? Math.round(r.answered / assessed * 100) : null };
    });
  } catch (e) { console.warn('qaTrend failed:', e.message); return []; }
}

// ── Resolved-theme registry — "did the fix work?" reopen tracking ────────────
let _rtReady = false;
async function ensureResolvedThemesTable(db) {
  if (_rtReady) return;
  await db`CREATE TABLE IF NOT EXISTS orion_resolved_themes (
    id SERIAL PRIMARY KEY, theme TEXT, cause VARCHAR(20),
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_by INTEGER )`;
  _rtReady = true;
}

/** Record the themes an admin just resolved (via KB article / feature request / review). */
async function recordResolvedThemes({ themes, userId }) {
  if (!Array.isArray(themes) || !themes.length) return;
  try {
    const db = sql();
    await ensureResolvedThemesTable(db);
    for (const t of themes.slice(0, 30)) {
      const theme = typeof t === 'string' ? t : t.theme;
      if (!theme) continue;
      await db`INSERT INTO orion_resolved_themes (theme, cause, resolved_by) VALUES (${theme}, ${(typeof t === 'object' && t.cause) || null}, ${userId ?? null})`;
    }
  } catch (e) { console.warn('recordResolvedThemes failed:', e.message); }
}

/** Themes resolved in the last `days` — used to flag reopened gaps. */
async function loadResolvedThemes({ days = 120 } = {}) {
  try {
    const db = sql();
    await ensureResolvedThemesTable(db);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await db`SELECT theme, cause, resolved_at FROM orion_resolved_themes WHERE resolved_at >= ${since} ORDER BY resolved_at DESC`;
    return rows.map(r => ({ theme: r.theme, cause: r.cause, resolvedAt: new Date(r.resolved_at).toISOString() }));
  } catch (e) { console.warn('loadResolvedThemes failed:', e.message); return []; }
}

/** Rows the independent judge hasn't re-scored yet (recent, with a real answer). */
async function loadQAForRegrade({ days = 10, limit = 40 } = {}) {
  try {
    const db = sql();
    await ensureQATable(db);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await db`
      SELECT id, question, answer, answered FROM orion_qa
      WHERE created_at >= ${since} AND regraded = false AND answer IS NOT NULL AND length(answer) > 0
      ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map(r => ({ id: r.id, question: r.question, answer: r.answer, answered: r.answered }));
  } catch (e) { console.warn('loadQAForRegrade failed:', e.message); return []; }
}

/** Apply the judge's verdict — updates the answered flag & marks the row regraded. */
async function applyRegrade({ id, answered, gapReason }) {
  try {
    const db = sql();
    await ensureQATable(db);
    if (answered == null) {
      await db`UPDATE orion_qa SET regraded = true WHERE id = ${id}`;
    } else {
      await db`UPDATE orion_qa SET answered = ${answered}, gap_reason = ${gapReason || null}, regraded = true WHERE id = ${id}`;
    }
  } catch (e) { console.warn('applyRegrade failed:', e.message); }
}

/** Mark a gap theme's example rows resolved (after a KB article / feature is filed). */
async function resolveQA({ ids }) {
  if (!Array.isArray(ids) || !ids.length) return;
  try {
    const db = sql();
    await ensureQATable(db);
    await db`UPDATE orion_qa SET resolved = true WHERE id = ANY(${ids})`;
  } catch (e) { console.warn('resolveQA failed:', e.message); }
}

export { logAudit, loadAuditEntries, logLLMCall, logFeedback, logAccessEvent, loadAccessEntries, logQA, updateQAFeedback, loadQA, resolveQA, qaTrend, recordResolvedThemes, loadResolvedThemes, loadQAForRegrade, applyRegrade, countQAGaps };
