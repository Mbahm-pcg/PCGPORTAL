// analyst-cases.js — Business Case CRUD (stored in Netlify Blobs)
import { cacheSave, cacheLoad, cacheList } from './analyst-cache.mjs';
import { generateStructured } from './analyst-claude.mjs';
import { PERSONA, buildCasePrompt } from './analyst-prompts.mjs';

const DECISION_STATUSES = new Set(['Accepted', 'In Progress', 'Done']);

/** Log a decision entry when a case moves to a meaningful status */
async function logDecision(caseData, newStatus, userId, reason) {
  const today = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 7);
  const key = `analyst/decision-log/${today}/${Date.now()}_${rand}`;
  await cacheSave(key, {
    ts: new Date().toISOString(),
    caseId: caseData.id,
    title: caseData.title,
    summary: caseData.summary,
    anomalyType: caseData.anomalyType,
    severity: caseData.severity,
    district: caseData.district,
    storeName: caseData.storeName || null,
    dollarOpportunity: caseData.dollarOpportunity || 0,
    decision: newStatus,
    reason: reason || null,
    decidedBy: userId || null,
  });
}

/** Load decision log entries for a date range (defaults to last 30 days) */
async function loadDecisionLog({ days = 30 } = {}) {
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
  );
  const perDay = await Promise.all(
    dates.map(async d => {
      const keys = await cacheList(`analyst/decision-log/${d}/`);
      const items = await Promise.all(keys.map(k => cacheLoad(k)));
      return items.filter(Boolean);
    })
  );
  return perDay.flat().sort((a, b) => (b.ts > a.ts ? 1 : -1));
}

const CASES_INDEX_KEY = 'analyst/cases-index';

/** Generate a unique case ID */
function caseId() {
  return `case_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Load the cases index (array of case summaries) */
async function loadCasesIndex() {
  const idx = await cacheLoad(CASES_INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

/** Save the cases index */
async function saveCasesIndex(index) {
  await cacheSave(CASES_INDEX_KEY, index);
}

/** Load a full case by ID */
async function loadCase(id) {
  return cacheLoad(`analyst/cases/${id}`);
}

/** Save a full case */
async function saveCase(id, caseData) {
  await cacheSave(`analyst/cases/${id}`, caseData);
}

/**
 * Create a Business Case from an anomaly using the LLM.
 * Returns the saved case object.
 */
async function createCaseFromAnomaly(anomaly, dataContext) {
  const id = caseId();

  // Load recent decisions to inject as RL context into the prompt
  let recentDecisions = [];
  try { recentDecisions = await loadDecisionLog({ days: 14 }); } catch {}

  const prompt = buildCasePrompt(anomaly.description, {
    anomaly,
    dataContext: typeof dataContext === 'string' ? dataContext : JSON.stringify(dataContext),
  }, recentDecisions);

  let caseBody;
  try {
    const result = await generateStructured({
      system: PERSONA,
      userPrompt: prompt,
      action: 'case',
      userId: 'system',
    });

    // Parse JSON from LLM response
    let text = result.text.trim();
    // Strip markdown fences if present
    if (text.startsWith('```')) {
      text = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    }
    caseBody = JSON.parse(text);
  } catch (err) {
    // Fallback: create a basic case from the anomaly data directly
    caseBody = {
      title: `${anomaly.type}: ${anomaly.storeName}`,
      summary: anomaly.description,
      dollarOpportunity: 0,
      dollarBasis: 'Unable to estimate — LLM call failed',
      affectedLocations: [anomaly.storeName],
      actions: ['Review the data manually', 'Investigate root cause', 'Follow up with DM'],
      suggestedOwner: `DM District ${anomaly.district}`,
      suggestedDueDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
      confidence: 'low',
      citations: [{ source: 'Analyst', metric: anomaly.metric, value: String(anomaly.value), dateRange: 'today' }],
    };
  }

  const fullCase = {
    id,
    ...caseBody,
    status: 'New', // New | In Review | Accepted | In Progress | Done
    anomalyType: anomaly.type,
    severity: anomaly.severity,
    district: anomaly.district,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: 'Orion',
    statusHistory: [{ status: 'New', at: new Date().toISOString(), by: 'Orion' }],
  };

  // Save the full case
  await saveCase(id, fullCase);

  // Update the index
  const index = await loadCasesIndex();
  // Check for duplicate anomaly (same type + store + same day)
  const today = new Date().toISOString().slice(0, 10);
  const isDupe = index.some(c =>
    c.anomalyType === anomaly.type &&
    c.storeName === anomaly.storeName &&
    c.createdAt?.slice(0, 10) === today &&
    c.status !== 'Done'
  );
  if (isDupe) return null; // Skip duplicate

  index.unshift({
    id,
    title: fullCase.title,
    summary: fullCase.summary,
    dollarOpportunity: fullCase.dollarOpportunity,
    status: fullCase.status,
    severity: fullCase.severity,
    anomalyType: fullCase.anomalyType,
    storeName: anomaly.storeName,
    storePC: anomaly.storePC || anomaly.pc || null,
    district: fullCase.district,
    createdAt: fullCase.createdAt,
  });

  // Keep index to last 100 cases
  if (index.length > 100) index.length = 100;
  await saveCasesIndex(index);

  return fullCase;
}

/**
 * Update a case's status. Optionally logs a decision with a reason.
 */
async function updateCaseStatus(id, newStatus, userId, reason) {
  const c = await loadCase(id);
  if (!c) return null;

  c.status = newStatus;
  c.updatedAt = new Date().toISOString();
  c.statusHistory.push({ status: newStatus, at: c.updatedAt, by: userId, reason: reason || null });

  await saveCase(id, c);

  // Log decision for RL feedback when case moves to a meaningful status
  if (DECISION_STATUSES.has(newStatus)) {
    logDecision(c, newStatus, userId, reason).catch(() => {});
  }

  // Update index
  const index = await loadCasesIndex();
  const entry = index.find(e => e.id === id);
  if (entry) {
    entry.status = newStatus;
    await saveCasesIndex(index);
  }

  return c;
}

/**
 * Get cases filtered by status, district, or severity.
 */
async function getCases({ status, district, severity, limit } = {}) {
  let index = await loadCasesIndex();
  if (status) index = index.filter(c => c.status === status);
  if (district != null) index = index.filter(c => Number(c.district) === Number(district));
  if (severity) index = index.filter(c => c.severity === severity);
  if (limit) index = index.slice(0, limit);
  return index;
}

export { createCaseFromAnomaly, updateCaseStatus, getCases, loadCase, loadCasesIndex, loadDecisionLog };
