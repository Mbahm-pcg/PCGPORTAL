// analyst-claude.js — LLM wrapper with Haiku/Sonnet routing, token counting, audit
import Anthropic from '@anthropic-ai/sdk';
import { logLLMCall } from './analyst-audit.mjs';
import { PERSONA, ASK_SYSTEM } from './analyst-prompts.mjs';

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
async function askAnalyst({ userPrompt, userId, forceDeep, history, system }) {
  const sys = system || ASK_SYSTEM;
  const inputLength = (sys || '').length + (userPrompt || '').length;
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
      system: sys,
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

/**
 * Ask with tool-use (Claude function-calling). Runs the request → tool_use → execute →
 * tool_result loop until the model returns a final text answer (or maxTurns is hit).
 * Used by the maintenance assistant so Orion can actually act on tickets, not just read.
 *
 * @param executeTool async (name, input) => result object (returned to the model as a tool_result)
 * Returns { answer, model, tokens, latencyMs, actions } where actions is the list of
 * { name, input, result } the model performed this turn.
 */
async function askAnalystWithTools({ userPrompt, system, history, tools, executeTool, userId, maxTurns = 5 }) {
  const model = SONNET; // tool use needs a capable model
  const start = Date.now();
  const messages = [];
  if (Array.isArray(history)) {
    for (const turn of history.slice(-10)) {
      if (turn.role === 'user') messages.push({ role: 'user', content: turn.content });
      else if (turn.role === 'assistant') messages.push({ role: 'assistant', content: turn.content });
    }
  }
  messages.push({ role: 'user', content: userPrompt });

  const actions = [];
  let inTok = 0, outTok = 0, finalText = '';
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const resp = await getClient().messages.create({ model, max_tokens: 1024, system, tools, messages });
      inTok += resp.usage?.input_tokens || 0;
      outTok += resp.usage?.output_tokens || 0;
      const blocks = Array.isArray(resp.content) ? resp.content : [];
      const toolUses = blocks.filter(b => b.type === 'tool_use');
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('').trim();

      if (resp.stop_reason === 'tool_use' && toolUses.length) {
        messages.push({ role: 'assistant', content: resp.content });
        const results = [];
        for (const tu of toolUses) {
          let result;
          try { result = await executeTool(tu.name, tu.input); }
          catch (e) { result = { ok: false, error: e.message }; }
          actions.push({ name: tu.name, input: tu.input, result });
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result), is_error: !!(result && result.ok === false) });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      finalText = text;
      break;
    }
    // If the loop ended mid-action without a closing message, summarize what was done.
    if (!finalText && actions.length) {
      finalText = actions.map(a => a.result?.summary || a.result?.error).filter(Boolean).join(' ');
    }
    const latencyMs = Date.now() - start;
    logLLMCall({ model, action: 'maint_tools', inputTokens: inTok, outputTokens: outTok, latencyMs, userId }).catch(() => {});
    return { answer: finalText, model, tokens: { input: inTok, output: outTok }, latencyMs, actions };
  } catch (err) {
    const latencyMs = Date.now() - start;
    logLLMCall({ model, action: 'maint_tools', inputTokens: inTok, outputTokens: outTok, latencyMs, userId, error: err.message }).catch(() => {});
    throw err;
  }
}

export { callClaude, callClaudeWithWebSearch, askAnalyst, askAnalystWithTools, generateStructured, pickModel, HAIKU, SONNET };
