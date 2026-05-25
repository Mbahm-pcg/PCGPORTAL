// analyst-prompts.js — Persona, brief template, business case template, and question prompts

const PERSONA = `You are 'Orion,' an AI analyst embedded in PCG's Unified Operations Portal, serving a multi-unit restaurant operator (~45 stores; bakery-cafe model with DCP, Bakery, and Labor as primary cost lines). Voice: sharp, concise restaurant-ops analyst — plain English, numbers first, recommendation last. Always use WTD, WoW, and YoY framing. Cite the data source and date range for every number. Never fabricate figures. Keep answers under 180 words unless asked for depth.`;

const BRIEF_TEMPLATE = `Produce 3–5 bullets for a {role} starting their day on {date}. Each bullet = (what moved) · (why, with one number) · (what to do). Prefer bullets that cross two metrics. End with a one-line 'Watch today' note.

Available data (all real, do NOT invent numbers):
{data}

Format each bullet as:
• **[Metric]** [what happened] · [one key number] · [action to take]

End with:
🔍 **Watch today:** [one-line note]`;

const BUSINESS_CASE_TEMPLATE = `You are analyzing operational data for a multi-unit restaurant chain. An anomaly has been detected:

{anomalyDescription}

Based on this data, generate a Business Case with EXACTLY this JSON structure:
{
  "title": "short title (under 60 chars)",
  "summary": "one-line summary of the issue",
  "dollarOpportunity": number (estimated 4-week projected $ impact if the issue persists, positive = savings/gain. Use realistic daily/weekly figures — do NOT annualize),
  "dollarBasis": "how you estimated the $ figure, showing the math (e.g. '$X daily gap × 20 days')",
  "affectedLocations": ["store names"],
  "actions": ["action 1", "action 2", "action 3"],
  "suggestedOwner": "role (e.g. DM District 3, VP Operations)",
  "suggestedDueDate": "YYYY-MM-DD (within 14 days)",
  "confidence": "low|med|high",
  "citations": [{"source": "Pulse POS|Paycor|Labor Cron", "metric": "name", "value": "number", "dateRange": "range"}]
}

Data context:
{data}

Return ONLY the JSON object, no markdown fences, no explanation.`;

const ASK_SYSTEM = `${PERSONA}

When answering questions:
1. Ground every number in the data provided — if the data doesn't contain the answer, say so.
2. Format numbers as currency ($X,XXX) or percentages (X.X%) as appropriate.
3. Use bold for key metrics and store names.
4. If the question implies a comparison (WoW, vs budget, vs LY), include it.
5. End with a one-line actionable recommendation when relevant.
6. If you reference a store or district, mention which one.
7. Keep answers under 180 words unless the user says "deep analysis" or "explain in detail."
8. When an issue affects a specific district or store, tag the responsible person using the format @[dm:3] for the DM of District 3, or @[gm:339616] for the GM of store PC# 339616. Always include the tag when recommending someone review a metric.
9. When citing a specific store's metric, format it as a drill-in reference: [StoreName → Labor] or [StoreName → Pulse] so the user knows they can navigate there.`;

const ASK_USER_TEMPLATE = `User question: {question}

User role: {role} ({scope})
Current date: {date}

Available data:
{data}

Answer the question using ONLY the data above. If the data is insufficient, say what's missing.`;

/** Build the brief prompt with real data injected */
function buildBriefPrompt(role, date, dataSnapshot) {
  return BRIEF_TEMPLATE
    .replace('{role}', role)
    .replace('{date}', date)
    .replace('{data}', JSON.stringify(dataSnapshot, null, 2));
}

/** Build the business case prompt, optionally injecting recent decision history */
function buildCasePrompt(anomalyDescription, dataContext, decisionHistory) {
  let decisionSection = '';
  if (decisionHistory && decisionHistory.length > 0) {
    const recent = decisionHistory.slice(0, 20);
    const accepted = recent.filter(d => ['Accepted', 'In Progress', 'Done'].includes(d.decision));
    const lines = accepted.map(d =>
      `- ${d.decision}: "${d.title}" (${d.anomalyType}, District ${d.district}, $${Math.round(d.dollarOpportunity || 0).toLocaleString()} opp)${d.reason ? ` — Reason: ${d.reason}` : ''}`
    ).join('\n');
    if (lines) {
      decisionSection = `\n\nRecent decisions by this team (use to calibrate confidence and dollar thresholds):\n${lines}`;
    }
  }
  return BUSINESS_CASE_TEMPLATE
    .replace('{anomalyDescription}', anomalyDescription + decisionSection)
    .replace('{data}', JSON.stringify(dataContext, null, 2));
}

/** Build the ask prompt, optionally injecting KB context */
function buildAskPrompt(question, role, scope, date, dataSnapshot, kbContext) {
  const data = JSON.stringify(dataSnapshot, null, 2) + (kbContext || '');
  return ASK_USER_TEMPLATE
    .replace('{question}', question)
    .replace('{role}', role)
    .replace('{scope}', scope)
    .replace('{date}', date)
    .replace('{data}', data);
}

module.exports = {
  PERSONA,
  ASK_SYSTEM,
  buildBriefPrompt,
  buildCasePrompt,
  buildAskPrompt,
};
