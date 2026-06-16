// analyst-claude.js — LLM wrapper with Haiku/Sonnet routing, token counting, audit
const Anthropic = require('@anthropic-ai/sdk');
const { logLLMCall } = require('./analyst-audit');
const { PERSONA, ASK_SYSTEM } = require('./analyst-prompts');

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Pick model based on context:
 * - Haiku: scheduled scans, short answers, cache refreshes
 * - Sonnet: deep analysis, business case generation, long questions (>400 input tokens)
 */
function pickModel({ action, inputLength, forceDeep }) {
  if (forceDeep) return SONNET;
  if (action === 'case') return SONNET;
  if (action === 'deep') return SONNET;
  // Rough token estimate: 1 token ≈ 4 chars
  if (inputLength && inputLength > 1600) return SONNET; // >400 tokens
  return HAIKU;
}

/**
 * Call Claude with system + user prompt. Returns { text, model, inputTokens, outputTokens, latencyMs }
 */
async function callClaude({ system, userPrompt, action, userId, forceDeep, maxTokens }) {
  const inputLength = (system || '').length + (userPrompt || '').length;
  const model = pickModel({ action, inputLength, forceDeep });
  const start = Date.now();

  try {
    const response = await getClient().messages.create({
      model,
      max_tokens: maxTokens || 1024,
      system: system || PERSONA,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const latencyMs = Date.now() - start;
    const text = response.content?.[0]?.text || '';
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    // Log to audit trail (fire-and-forget)
    logLLMCall({ model, action, inputTokens, outputTokens, latencyMs, userId }).catch(() => {});

    return { text, model, inputTokens, outputTokens, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    logLLMCall({ model, action, inputTokens: 0, outputTokens: 0, latencyMs, userId, error: err.message }).catch(() => {});
    throw err;
  }
}

/**
 * Ask a question with the analyst persona. Returns { answer, model, tokens }
 * Supports conversation history for multi-turn chat.
 */
async function askAnalyst({ userPrompt, userId, forceDeep, history }) {
  const inputLength = (ASK_SYSTEM || '').length + (userPrompt || '').length;
  const model = pickModel({ action: forceDeep ? 'deep' : 'ask', inputLength, forceDeep });
  const start = Date.now();

  try {
    // Build messages array with conversation history
    const messages = [];
    if (history && Array.isArray(history)) {
      // Include last 10 turns max to control token usage
      const recent = history.slice(-10);
      for (const turn of recent) {
        if (turn.role === 'user') messages.push({ role: 'user', content: turn.content });
        else if (turn.role === 'assistant') messages.push({ role: 'assistant', content: turn.content });
      }
    }
    messages.push({ role: 'user', content: userPrompt });

    const response = await getClient().messages.create({
      model,
      max_tokens: forceDeep ? 2048 : 1024,
      system: ASK_SYSTEM,
      messages,
    });

    const latencyMs = Date.now() - start;
    const text = response.content?.[0]?.text || '';
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    logLLMCall({ model, action: forceDeep ? 'deep' : 'ask', inputTokens, outputTokens, latencyMs, userId }).catch(() => {});

    return {
      answer: text,
      model,
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    logLLMCall({ model, action: 'ask', inputTokens: 0, outputTokens: 0, latencyMs, userId, error: err.message }).catch(() => {});
    throw err;
  }
}

/**
 * Call Claude with the web_search server tool enabled. Used for competitive
 * intelligence (current competitor promotions/LTOs). Returns { text, citations, ... }.
 * Degrades by throwing if the tool isn't enabled on the API key — callers should catch.
 */
async function callClaudeWithWebSearch({ system, userPrompt, maxUses = 5, maxTokens = 2500, userId }) {
  const model = SONNET; // synthesis quality matters here
  const start = Date.now();
  try {
    const response = await getClient().messages.create({
      model,
      max_tokens: maxTokens,
      system: system || PERSONA,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
    });
    const latencyMs = Date.now() - start;
    const blocks = Array.isArray(response.content) ? response.content : [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const citations = [];
    for (const b of blocks) {
      if (b.type === 'text' && Array.isArray(b.citations)) {
        for (const c of b.citations) if (c.url) citations.push({ url: c.url, title: c.title || '' });
      }
    }
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    logLLMCall({ model, action: 'websearch', inputTokens, outputTokens, latencyMs, userId }).catch(() => {});
    return { text, citations, model, inputTokens, outputTokens, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    logLLMCall({ model, action: 'websearch', inputTokens: 0, outputTokens: 0, latencyMs, userId, error: err.message }).catch(() => {});
    throw err;
  }
}

/**
 * Generate a brief or business case (structured output).
 */
async function generateStructured({ system, userPrompt, action, userId }) {
  return callClaude({
    system: system || PERSONA,
    userPrompt,
    action,
    userId,
    forceDeep: action === 'case',
    maxTokens: action === 'pnl' ? 4096 : action === 'case' ? 1500 : action === 'brief' ? 2048 : 1024,
  });
}

module.exports = { callClaude, callClaudeWithWebSearch, askAnalyst, generateStructured, pickModel, HAIKU, SONNET };
