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
 */
async function askAnalyst({ userPrompt, userId, forceDeep }) {
  const result = await callClaude({
    system: ASK_SYSTEM,
    userPrompt,
    action: forceDeep ? 'deep' : 'ask',
    userId,
    forceDeep,
    maxTokens: forceDeep ? 2048 : 1024,
  });
  return {
    answer: result.text,
    model: result.model,
    tokens: { input: result.inputTokens, output: result.outputTokens },
    latencyMs: result.latencyMs,
  };
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
    maxTokens: action === 'case' ? 1500 : 1024,
  });
}

module.exports = { callClaude, askAnalyst, generateStructured, pickModel, HAIKU, SONNET };
