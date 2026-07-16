// analyst.mjs — HTTP handler for the UOP Analyst module
// Actions: ask, brief, brief-refresh, case-list, case-detail, case-update, feedback, report-settings

import { askAnalyst, askAnalystWithTools, generateStructured } from './analyst-lib/analyst-claude.mjs';
import { MAINT_TOOLS, executeMaintTool } from './analyst-lib/maint-actions.mjs';
import { buildDataContext, buildKPISnapshot, buildStoreContext, buildStoreRosterContext, buildPulseComparisonContext, buildSentimentContext, buildWeatherContext, buildMaintenanceContext, buildSalesMixContext, buildMixComparisonContext, buildNewProductsContext, STORES, resolveStoreFromText, getWeatherForecast, getDailyNetSales } from './analyst-lib/analyst-data.mjs';
import { NEW_PRODUCTS_KEY } from './analyst-lib/new-products.mjs';
import { buildBriefPrompt, buildStoreBriefPrompt, buildPrePlanPrompt, buildAskPrompt, PERSONA, MAINT_ASK_SYSTEM, REPORT_SYSTEM, buildReportPrompt } from './analyst-lib/analyst-prompts.mjs';
import { computeStorePar } from './analyst-lib/par-optimizer.mjs';
import { saveReport } from './analyst-lib/analyst-reports-gen.mjs';
import { getCases, loadCase, updateCaseStatus, loadDecisionLog } from './analyst-lib/analyst-cases.mjs';
import { cacheSave, cacheLoad } from './analyst-lib/analyst-cache.mjs';
import { logFeedback, logAccessEvent, loadAccessEntries, logQA, updateQAFeedback, loadQA, resolveQA, qaTrend, recordResolvedThemes, loadResolvedThemes, countQAGaps } from './analyst-lib/analyst-audit.mjs';
import { forecastStoreFull, forecastStoreWeek, learnHolidayFactor, tomorrowISO, addDaysISO } from './analyst-lib/forecast.mjs';
import { holidayInfo } from './analyst-lib/holidays.mjs';
import { loadKBContent, buildKBContext } from './analyst-lib/analyst-kb.mjs';
import { loadReportSettings, sendExecReport, sendExecDailyReport, sendDMBriefs } from './analyst-lib/analyst-reports.mjs';
import { resolveCaller } from './_shared/auth.mjs';
import { sql } from './_shared/db.mjs';
import { sessionGate } from './auth-lib/require-user.js';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers });
}

export default async (request, context) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return json(405, { error: 'POST only' });

  let payload;
  try {
    payload = await request.json().catch(() => ({}));
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const { action, userId, userRole, district } = payload;
  const t0 = Date.now();

  // Audit identity — starts from the payload, then gets backfilled from the
  // server-resolved caller once known (below) so a call that sent a userId but no
  // role still logs the real role (e.g. case-list). Render-only Orion fetches that
  // fire automatically on dashboard-card render carry no user identity and aren't
  // deliberate access events, so they're skipped to keep the log clean (was the
  // source of the anonymous "—" rows).
  let auditUserId = userId;
  let auditRole = userRole;
  const SKIP_AUDIT = new Set(['audit-log', 'store-brief', 'forecast', 'forecast-plan']);

  // Wrap response so every action is audit-logged before returning
  const respond = async (status, body) => {
    const latencyMs = Date.now() - t0;
    if (!SKIP_AUDIT.has(action)) {
      logAccessEvent({ userId: auditUserId, userRole: auditRole, action, district, statusCode: status, latencyMs }).catch(() => {});
    }
    return json(status, body);
  };

  // ── Access control ───────────────────────────────────────────────────
  // Resolve the caller's AUTHORITATIVE role/scope from the users table by id, so a crafted
  // payload can't claim a role/district/store it doesn't have. When the caller can't be
  // resolved (no userId / server-internal cron/MCP), fall back to the claimed values.
  const EXEC_ROLES = new Set(['executive', 'it']);
  // Revocation gate: if this request carries a session token (cookie/header), it must be
  // active — a signed-out/revoked browser session is rejected here. Tokenless server/cron/MCP
  // callers fall through unchanged (no token → 'no-token').
  const eventShim = { headers: { authorization: request.headers.get('authorization') || '', cookie: request.headers.get('cookie') || '' } };
  if (await sessionGate(eventShim, sql()) === 'revoked') return respond(401, { error: 'Session ended. Please sign in again.' });
  const caller = await resolveCaller(userId);
  const effRole = caller?.role || userRole;
  // Backfill audit identity from the resolved caller so the log shows the real
  // person + role even when the client omitted them (fixes blank-role rows).
  if (caller?.id != null) auditUserId = caller.id;
  if (effRole) auditRole = effRole;
  const isExecRole = EXEC_ROLES.has(effRole);
  // exec/IT may target any district (drill-down) or null=network; everyone else is locked to
  // their own district, and managers to their own store — claimed values are ignored for them.
  const effDistrict = isExecRole ? (district ?? null) : (caller ? (caller.district ?? null) : (district ?? null));
  const EXEC_ONLY_ACTIONS = new Set([
    'snapshot', 'report-settings', 'send-report', 'create-report',
    'case-list', 'case-detail', 'case-update', 'decision-log', 'audit-log',
    'qa-log', 'qa-gaps', 'qa-resolve', 'qa-trend', 'qa-draft-kb', 'qa-feature-req', 'qa-feature-list', 'qa-gap-count',
  ]);

  try {
    if (EXEC_ONLY_ACTIONS.has(action) && !isExecRole) {
      return respond(403, { error: 'This information is limited to Exec/IT.' });
    }

    // ── Ask Analyst (omnibar / chat) ─────────────────────────────────────
    if (action === 'ask') {
      const { question, forceDeep, channelId, threadId, storePC, history, tickets } = payload;
      if (!question) return respond(400, { error: 'Missing question' });

      // Build data context scoped to the caller's REAL role: store (managers), district (DMs),
      // or full network (execs). A manager is locked to their own store; a DM to their district.
      const effStorePC = effRole === 'manager' ? (caller?.storePC || storePC) : null;
      // Fail closed: a manager with no resolvable store must never fall through to the
      // district/network data path below.
      if (effRole === 'manager' && !effStorePC) {
        return respond(200, {
          answer: "I can't tell which store you're assigned to yet, so I can't pull your numbers. Ask IT to set the store on your user profile and I'll be ready to go.",
          model: 'scope-guard', tokens: 0, latencyMs: Date.now() - t0,
          messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, mentions: [],
        });
      }
      const isMaint = effRole === 'maintenance';
      let dataContext;
      let scope;
      if (isMaint) {
        // Maintenance crew works the whole network — give Orion the full ticket board
        // (triage, overdue, per-store history, recent resolutions) instead of financials.
        dataContext = await buildMaintenanceContext({ now: new Date() });
        scope = 'Maintenance — all stores';
      } else if (effRole === 'manager' && effStorePC) {
        dataContext = await buildStoreContext({ storePC: effStorePC });
        scope = `Store ${effStorePC}`;
      } else {
        scope = effDistrict ? `District ${effDistrict}` : 'Network';
        dataContext = await buildDataContext({ district: effDistrict || null, includeStoreDetail: true });
      }

      const [kbFiles] = await Promise.all([loadKBContent({ district: effDistrict || null, userId, userRole: effRole })]);
      const kbContext = buildKBContext(kbFiles);

      // Build open tickets context block (passed from frontend, already scoped to user's district/store)
      let ticketsContext = '';
      if (Array.isArray(tickets) && tickets.length > 0) {
        const lines = tickets.map(t =>
          `• #${t.number || t.id} | ${t.storeName || t.storePC} | ${t.title} | ${t.priority || 'Normal'} priority | ${t.category || ''} | Opened ${t.createdAt ? t.createdAt.slice(0, 10) : 'unknown'}${t.description ? ' | ' + t.description.slice(0, 120) : ''}`
        ).join('\n');
        ticketsContext = `\n\nOpen support tickets (${tickets.length}):\n${lines}`;
      }

      // Store roster metadata (status/Next-Gen/Baskin/asset/manager/address) for DMs and
      // managers, scoped to their district/store so they only ever see their own. Fail closed:
      // a DM with no resolved district gets NO roster (never the network-wide list), so a
      // misconfigured user can't see other districts' managers/addresses.
      let rosterContext = '';
      if (effRole === 'dm' && effDistrict != null) rosterContext = await buildStoreRosterContext({ district: effDistrict });
      else if (effRole === 'manager' && effStorePC) rosterContext = await buildStoreRosterContext({ storePC: effStorePC });

      // Most users think in store PC# ("332941"), not the store name — if one's mentioned
      // in the question, resolve it once and reuse it everywhere below (base context here,
      // plus the cause/comparison enrichment blocks further down) so "NDCP orders for
      // 332941" and "why did 332941 drop" both work the same as if they'd typed "Bustleton".
      // ONE scope check, reused for every use of the match: exec/it can look up any store;
      // a DM only one inside their own district (fail closed, same as the roster above);
      // managers are already locked to their own store and maintenance works ticket-only,
      // so neither gets this — mentioning another store's PC# must never leak outside
      // their existing access.
      const mentionedStore = (isExecRole || effRole === 'dm') ? resolveStoreFromText(question) : null;
      const canLookupMentionedStore = !!mentionedStore && (isExecRole || (effRole === 'dm' && effDistrict != null && mentionedStore.district === effDistrict));
      let mentionedStoreContext = '';
      if (canLookupMentionedStore) {
        try { mentionedStoreContext = '\n\n' + await buildStoreContext({ storePC: mentionedStore.pc }); }
        catch (e) { console.warn('[analyst] mentioned-store context failed:', e.message); }
      }

      // Guest sentiment (review themes/ratings) + weather forecast (with historical sales
      // impact) give DMs/execs a fuller picture — coaching grounded in what guests actually
      // complain about, and planning around weather. Both are compact, read-only, and
      // district-scoped. Fail closed for DMs (a null district gets nothing, never network);
      // execs may see network or a drilled-in district.
      let extraContext = rosterContext + mentionedStoreContext;
      if ((effRole === 'dm' && effDistrict != null) || isExecRole) {
        const distArg = isExecRole ? (effDistrict || null) : effDistrict;
        const [sentiment, weather] = await Promise.all([
          buildSentimentContext({ district: distArg }),
          buildWeatherContext({ district: distArg }),
        ]);
        extraContext += (sentiment || '') + (weather || '');
      } else if (effRole === 'manager' && effStorePC) {
        // Managers: sentiment locked to THEIR store only; weather by their store's
        // district (weather is regional — no cross-store data in it).
        const mgrDistrict = STORES.find(s => s.pc === effStorePC)?.district ?? null;
        const [sentiment, weather] = await Promise.all([
          buildSentimentContext({ storePC: effStorePC }),
          mgrDistrict != null ? buildWeatherContext({ district: mgrDistrict }) : Promise.resolve(''),
        ]);
        extraContext += (sentiment || '') + (weather || '');
      }
      // Pulse comparison engine — today-so-far vs yesterday-same-time / WTD vs last week /
      // MTD vs last month + voids/refunds/discounts + today-by-hour, per store + district.
      // Reads the pcg_pulse_today_v1 cache (pulse-compare-cron) so it's normally ZERO live
      // calls; only a cold cache triggers a live fallback for this district's ~6 stores.
      // Still gated to Pulse-relevant questions so roster/metadata asks stay lean.
      const PULSE_Q = /\b(sales?|sell|sold|revenue|labou?r|guest|traffic|customer|check|avg|average|upsell|hour|hourly|rush|morning|afternoon|today|yesterday|week|wtd|month|mtd|compare|comparison|vs|versus|trend|pace|pacing|forecast|rank|top|bottom|worst|best|drop|decline|grow|void|refund|discount|exception|anomal|unusual|wrong|attention|focus|priorit|call first|coach|recap|target|profit|perform)\b/i;
      if (effRole === 'dm' && effDistrict != null && PULSE_Q.test(question || '')) {
        try { extraContext += await buildPulseComparisonContext({ district: effDistrict }); }
        catch (e) { console.warn('[analyst] pulse comparison failed:', e.message); }
      } else if (effRole === 'manager' && effStorePC && PULSE_Q.test(question || '')) {
        // Managers get the same today/yesterday/WTD/MTD + today-by-hour engine,
        // scoped to exactly their store (answers peak-hour / checks-by-hour /
        // avg-check-vs-last-week questions from real data instead of guessing).
        try { extraContext += await buildPulseComparisonContext({ storePC: effStorePC }); }
        catch (e) { console.warn('[analyst] store pulse comparison failed:', e.message); }
      }

      // Forecast & game plan (managers): tomorrow's projection by daypart + weather
      // factor for THEIR store, so "what do I need tomorrow / which daypart is
      // strongest / am I staffed right for the afternoon" answers from the same
      // model the Forecast & Game Plan card uses.
      const FORECAST_Q = /\b(forecast|tomorrow|game ?plan|project(ed|ion)|daypart|par|baseline|donut|munchkin|staff(ed|ing)?|transactions? (do i )?need|target)\b/i;
      if (effRole === 'manager' && effStorePC && FORECAST_Q.test(question || '')) {
        try {
          const { forecast: fc, accuracy } = await forecastStoreFull(effStorePC);
          if (fc && fc.dayTotal > 0) {
            const money = n => '$' + Math.round(n || 0).toLocaleString();
            const dp = fc.dayparts || {};
            const dpStr = `AM rush (5–9a) ${money(dp.amRush)}, mid-morning (9–11a) ${money(dp.midMorning)}, lunch (11a–2p) ${money(dp.lunch)}, afternoon (2p–close) ${money(dp.afternoon)}`;
            const wf = fc.weatherFactor && fc.weatherFactor !== 1 ? `\n  Weather factor applied: ×${fc.weatherFactor}` : '';
            const hol = fc.holidayName ? `\n  Holiday: ${fc.holidayName}${fc.holidayUnknown ? ' (no learned factor — treat with low confidence)' : ` ×${fc.holidayFactor}`}` : '';
            const acc = accuracy?.mape != null ? `\n  Model accuracy: ~${accuracy.mape}% avg error over the last ${accuracy.window} scored days` : '';
            extraContext += `\n\nTOMORROW'S FORECAST (${fc.date} ${fc.dowLabel}, your store): ${money(fc.dayTotal)} projected (range ${money(fc.low)}–${money(fc.high)}, confidence: ${fc.confidence})` +
              `\n  By daypart: ${dpStr}` + wf + hol + acc +
              `\n  (Same model as the Forecast & Game Plan card. For "transactions needed", divide the target by the recent avg check from the daily performance data.)`;
          }
        } catch (e) { console.warn('[analyst] manager forecast failed:', e.message); }
      }
      // Sales-mix attribution — category-level drops matched to open equipment tickets, so
      // Orion can answer "why are <category> sales down at <store>?" with a cause, not a guess.
      // Scoped: manager → store, DM → district, exec → drilled district or network. Gated to
      // cause/"why-down" questions (not all Pulse asks) so an exec's network-scope query only
      // triggers the 45-store item-history fan-out when the attribution is actually relevant.
      const CAUSE_Q = /\b(why|cause|caused|reason|explain|down|drop|dropp|dip|decline|declin|fell|falling|lower|slow|soft|underperform|below|behind|hurt|impact|off)\b/i;
      if (CAUSE_Q.test(question || '') && (isExecRole || (effRole === 'dm' && effDistrict != null) || (effRole === 'manager' && effStorePC))) {
        try {
          const mixOpts = (effRole === 'manager' && effStorePC)
            ? { storePC: effStorePC }
            : canLookupMentionedStore
              ? { storePC: mentionedStore.pc }
              : { district: isExecRole ? (effDistrict || null) : effDistrict };
          const mix = await buildSalesMixContext(mixOpts);
          if (mix.storesWithDrops > 0) {
            const lines = mix.stores.slice(0, 8).map(st =>
              `• ${st.name} (D${st.district}): ` + st.drops.map(d =>
                `${d.category} down ${d.dropPct}% (-$${d.lostSales} vs baseline${d.cause ? `; likely cause: open ticket #${d.cause.ticketNumber} ${d.cause.ticketTitle}` : '; no open ticket explains it'})`
              ).join('; ')
            ).join('\n');
            extraContext += `\n\nSales-mix drops today (product category running below its day-of-week baseline, attributed to open maintenance tickets where the equipment matches):\n${lines}`;
          }
        } catch (e) { console.warn('[analyst] sales-mix failed:', e.message); }
      }

      // Cross-store item comparison — how a store's product mix compares to its district peers.
      // Gated to comparison/"why so low vs others" questions so it only fans out over item
      // history when relevant. Managers → own store vs district; DM → district; exec → network.
      // Mix-specific phrasing only — deliberately narrow so common words ("more", "than",
      // "average") don't trigger the 45-store item-history fan-out on unrelated Pulse asks.
      const COMPARE_Q = /\b(item mix|product mix|sales mix|mix outlier|category (mix|share|comparison)|vs (the )?district|district average|other stores?|compared to (peers?|other|district)|underperform|over-?index|sells? (fewer|less|more) \w+ than)\b/i;
      if (COMPARE_Q.test(question || '') && (isExecRole || (effRole === 'dm' && effDistrict != null) || (effRole === 'manager' && effStorePC))) {
        try {
          const cmpOpts = (effRole === 'manager' && effStorePC)
            ? { storePC: effStorePC }
            : canLookupMentionedStore
              ? { storePC: mentionedStore.pc }
              : { district: isExecRole ? (effDistrict || null) : effDistrict };
          const cmp = await buildMixComparisonContext(cmpOpts);
          if (cmp.storesWithOutliers > 0) {
            const lines = cmp.stores.slice(0, 8).map(st =>
              `• ${st.name} (D${st.district}): ` + st.outliers.slice(0, 4).map(o =>
                `${o.category} ${o.gapPct}% ${o.direction} district avg (${o.storeSharePct}% of mix vs ${o.districtSharePct}%)`
              ).join('; ')
            ).join('\n');
            extraContext += `\n\nCross-store item-mix outliers (each store's category share of sales vs its district-peer average; "below" = sells relatively less of that category):\n${lines}`;
          }
        } catch (e) { console.warn('[analyst] mix-compare failed:', e.message); }
      }

      // New product launch performance — network adoption + ramp for tracked launches. Gated to
      // launch/new-product questions so the registry + item-history fan-out only runs when asked.
      const LAUNCH_Q = /\b(new (product|item|menu)|launch|debut|rollout|roll[- ]out|adoption|introduc|just added|new drink|new sandwich)\b/i;
      if (LAUNCH_Q.test(question || '') && (isExecRole || (effRole === 'dm' && effDistrict != null) || (effRole === 'manager' && effStorePC))) {
        try {
          const npOpts = (effRole === 'manager' && effStorePC) ? { storePC: effStorePC } : { district: isExecRole ? (effDistrict || null) : effDistrict };
          const np = await buildNewProductsContext(npOpts);
          if (np.products && np.products.length) {
            const lines = np.products.slice(0, 6).map(p =>
              `• ${p.name}${p.launchDate ? ` (launched ${p.launchDate})` : ''}: ${p.totalUnits} units, ${p.adoption.selling}/${p.adoption.of} stores selling (${p.adoption.pct}% adoption)`
            ).join('\n');
            extraContext += `\n\nNew product launch performance (tracked launches, units + network adoption in scope):\n${lines}`;
          }
        } catch (e) { console.warn('[analyst] new-products failed:', e.message); }
      }

      let prompt = buildAskPrompt(question, effRole || 'executive', scope, new Date().toISOString().slice(0, 10), dataContext, kbContext, ticketsContext, extraContext);
      // Self-assessment tag for the Learning Loop — Orion appends exactly one hidden
      // marker as its last line; the app strips it before display and logs it so we
      // can detect knowledge/data gaps. (a=Y answered, a=N + reason = a miss.)
      prompt += `\n\nAFTER your answer, append EXACTLY ONE hidden marker as the final line (the app removes it before showing the user): "<<META a=Y r=ok>>" if you fully answered from the data provided; "<<META a=N r=no-data>>" if the answer isn't in the data you were given; "<<META a=N r=scope>>" if it falls outside this user's allowed scope.`;

      // Use thread-scoped history key when threadId is provided
      const historyKey = threadId
        ? `analyst/chat/${channelId}/thread/${threadId}`
        : `analyst/chat/${channelId}`;

      // Load conversation history from blob if channelId provided and no inline history
      let chatHistory = history || null;
      if (!chatHistory && channelId) {
        const stored = await cacheLoad(historyKey);
        if (stored && Array.isArray(stored)) chatHistory = stored;
      }

      // Maintenance gets tool-use so Orion can act on tickets (close/comment/assign/etc.);
      // the executor re-checks the caller's real role before any write.
      const maintCtx = { actorId: caller?.id, role: effRole }; // stable so the actor-name lookup memoizes
      const result = isMaint
        ? await askAnalystWithTools({
            userPrompt: prompt, system: MAINT_ASK_SYSTEM, history: chatHistory, userId,
            tools: MAINT_TOOLS,
            executeTool: (name, input) => executeMaintTool(name, input, maintCtx),
          })
        : await askAnalyst({ userPrompt: prompt, userId, forceDeep, history: chatHistory });

      const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      // Strip Orion's self-assessment marker and derive answered/gap. Match the marker
      // ANYWHERE (not just anchored at the end) and strip every occurrence, so a stray
      // trailing word or a mis-placed marker never leaks "<<META …>>" to the user.
      let answer = result.answer || '';
      let qaAnswered = null, qaGap = null;
      const metaMatch = answer.match(/<<META\s+a=([YN])\s+r=([a-z-]+)\s*>>/i);
      if (metaMatch) {
        qaAnswered = metaMatch[1].toUpperCase() === 'Y';
        qaGap = metaMatch[2].toLowerCase() === 'ok' ? null : metaMatch[2].toLowerCase();
      }
      answer = answer.replace(/<<META\s+a=[YN]\s+r=[a-z-]+\s*>>/ig, '').trim();

      // Learning Loop — log the Q&A turn (fire-and-forget; never blocks the answer).
      logQA({ userId, userRole: effRole, scope, question, answer, model: result.model, latencyMs: result.latencyMs, answered: qaAnswered, gapReason: qaGap, messageId }).catch(() => {});

      // Save conversation turn to history blob if channelId provided
      if (channelId) {
        const existing = (await cacheLoad(historyKey)) || [];
        const updated = Array.isArray(existing) ? existing : [];
        updated.push({ role: 'user', content: question, ts: new Date().toISOString() });
        updated.push({ role: 'assistant', content: answer, ts: new Date().toISOString(), messageId });
        // Keep last 20 turns (10 pairs)
        if (updated.length > 20) updated.splice(0, updated.length - 20);
        await cacheSave(historyKey, updated);
      }

      // Parse structured @[role:identifier] mention tags from the answer
      const mentionRegex = /@\[(dm|gm):([^\]]+)\]/g;
      const mentions = [];
      let mentionMatch;
      while ((mentionMatch = mentionRegex.exec(answer)) !== null) {
        mentions.push({ role: mentionMatch[1], identifier: mentionMatch[2], raw: mentionMatch[0] });
      }

      return respond(200, {
        answer,
        model: result.model,
        tokens: result.tokens,
        latencyMs: result.latencyMs,
        messageId,
        mentions,
      });
    }

    // ── Chat History (load/clear) ────────────────────────────────────────
    if (action === 'chat-history') {
      const { channelId, clear } = payload;
      if (!channelId) return respond(400, { error: 'Missing channelId' });
      if (clear) {
        await cacheSave(`analyst/chat/${channelId}`, []);
        return respond(200, { ok: true, cleared: true });
      }
      const history = (await cacheLoad(`analyst/chat/${channelId}`)) || [];
      return respond(200, { history });
    }

    // ── Today's Brief ────────────────────────────────────────────────────
    if (action === 'brief') {
      const today = new Date().toISOString().slice(0, 10);
      const role = userRole === 'dm' ? 'District Manager' : 'VP / Executive';
      const briefKey = `analyst/briefs/${today}_${district || 'network'}`;

      // Check cache first
      const cached = await cacheLoad(briefKey);
      if (cached && !payload.refresh) {
        return respond(200, { brief: cached, cached: true });
      }

      // Generate fresh brief
      const dataContext = await buildDataContext({ district: district || null, includeVoids: true });
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
      return respond(200, { brief, cached: false });
    }

    // ── Brief Refresh (force regeneration) ───────────────────────────────
    if (action === 'brief-refresh') {
      payload.refresh = true;
      payload.action = 'brief';
      // Re-call with refresh flag
      const today = new Date().toISOString().slice(0, 10);
      const role = userRole === 'dm' ? 'District Manager' : 'VP / Executive';
      const dataContext = await buildDataContext({ district: district || null, includeVoids: true });
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
      return respond(200, { brief, cached: false });
    }

    // ── Per-Store Brief ──────────────────────────────────────────────────
    if (action === 'store-brief') {
      const { storePC } = payload;
      if (!storePC) return respond(400, { error: 'Missing storePC' });
      const store = STORES.find(s => s.pc === storePC);
      if (!store) return respond(404, { error: 'Store not found' });

      const today = new Date().toISOString().slice(0, 10);
      const briefKey = `analyst/store-briefs/${storePC}_${today}`;

      const cached = await cacheLoad(briefKey);
      if (cached && !payload.refresh) {
        return respond(200, { brief: cached, cached: true });
      }

      const dataContext = await buildStoreContext({ storePC });
      const prompt = buildStoreBriefPrompt(store.name, storePC, today, dataContext);
      const result = await generateStructured({
        system: PERSONA,
        userPrompt: prompt,
        action: 'store-brief',
        userId,
      });

      const brief = {
        date: today,
        storePC,
        storeName: store.name,
        content: result.text,
        generatedAt: new Date().toISOString(),
        model: result.model,
      };

      await cacheSave(briefKey, brief);
      return respond(200, { brief, cached: false });
    }

    // ── Forecast Pre-Plan ────────────────────────────────────────────────
    // Tomorrow's forecast + suggested par + an Orion game plan (how to hit it,
    // what to avoid) grounded in this store's labor/schedule/voids/DCP data.
    if (action === 'forecast-plan') {
      const { storePC } = payload;
      if (!storePC) return respond(400, { error: 'Missing storePC' });
      const store = STORES.find(s => String(s.pc) === String(storePC));
      if (!store) return respond(404, { error: 'Store not found' });

      const target = payload.date || tomorrowISO();
      const planKey = `analyst/forecast-plans/${storePC}_${target}`;
      const cached = await cacheLoad(planKey);
      if (cached && !payload.refresh) return respond(200, { plan: cached, cached: true });

      // Expected weather + holiday for the target day (same wiring as `forecast`).
      const wxAll = await getWeatherForecast().catch(() => null);
      const wxDays = (wxAll && wxAll[store.district] && wxAll[store.district].days) || [];
      const cond = (wxDays.find(d => d && d.date === target) || {}).condition;
      const hf = await learnHolidayFactor(storePC, target, (pc, d) => getDailyNetSales(pc, d));
      const tgtHoliday = holidayInfo(target);

      const { forecast } = await forecastStoreFull(storePC, target, {
        weather: cond ? { condition: cond } : undefined,
        holidayFactor: hf ? hf.factor : 1,
        // Surface the holiday even when its sales factor couldn't be learned.
        holidayName: hf ? hf.name : (tgtHoliday ? tgtHoliday.name : null),
        holidayUnknown: !!tgtHoliday && !hf,
      });

      // Suggested par for the day (donut/munchkin), weather-adjusted off the forecast.
      const itemHistory = (await cacheLoad(`pcg_item_history_${storePC}`)) || [];
      const par = computeStorePar(itemHistory, {
        targetDate: target,
        weatherCondition: cond,
        weatherImpactPct: forecast ? Math.round((forecast.weatherFactor - 1) * 100) : 0,
        // Holiday demand swing — reuse the same learned factor already feeding the forecast.
        // hf is null for non-holidays; a known holiday with no learnable factor is flagged.
        holidayFactor: hf ? hf.factor : 1,
        holidayName: hf ? hf.name : (tgtHoliday ? tgtHoliday.name : null),
        holidayUnknown: !!tgtHoliday && !hf,
      });

      const dataContext = await buildStoreContext({ storePC });
      const prompt = buildPrePlanPrompt(store.name, storePC, target, forecast, par, dataContext);
      const result = await generateStructured({ system: PERSONA, userPrompt: prompt, action: 'brief', userId });

      const plan = {
        date: target,
        storePC,
        storeName: store.name,
        forecast,
        par,
        content: result.text,
        generatedAt: new Date().toISOString(),
        model: result.model,
      };
      await cacheSave(planKey, plan);
      return respond(200, { plan, cached: false });
    }

    // ── Case List ────────────────────────────────────────────────────────
    if (action === 'case-list') {
      const { status, severity, limit } = payload;
      const cases = await getCases({ status, district, severity, limit: limit || 20 });

      // Compute totals
      const totalOpportunity = cases.reduce((s, c) => s + (c.dollarOpportunity || 0), 0);
      const byStatus = {};
      cases.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });

      return respond(200, { cases, totalOpportunity, byStatus, count: cases.length });
    }

    // ── Case Detail ──────────────────────────────────────────────────────
    if (action === 'case-detail') {
      const { caseId } = payload;
      if (!caseId) return respond(400, { error: 'Missing caseId' });
      const c = await loadCase(caseId);
      if (!c) return respond(404, { error: 'Case not found' });
      return respond(200, { case: c });
    }

    // ── Case Status Update ───────────────────────────────────────────────
    if (action === 'case-update') {
      const { caseId, status, reason } = payload;
      if (!caseId || !status) return respond(400, { error: 'Missing caseId or status' });
      const valid = ['New', 'In Review', 'Accepted', 'In Progress', 'Done'];
      if (!valid.includes(status)) return respond(400, { error: `Invalid status. Must be: ${valid.join(', ')}` });
      const updated = await updateCaseStatus(caseId, status, userId, reason);
      if (!updated) return respond(404, { error: 'Case not found' });
      return respond(200, { case: updated });
    }

    // ── Decision Log ─────────────────────────────────────────────────────
    if (action === 'decision-log') {
      const { days } = payload;
      const entries = await loadDecisionLog({ days: days || 30 });
      const accepted = entries.filter(e => ['Accepted', 'In Progress', 'Done'].includes(e.decision));
      const byAnomaly = {};
      const byDistrict = {};
      entries.forEach(e => {
        byAnomaly[e.anomalyType] = (byAnomaly[e.anomalyType] || 0) + 1;
        if (e.district) byDistrict[e.district] = (byDistrict[e.district] || 0) + 1;
      });
      const totalOpportunity = accepted.reduce((s, e) => s + (e.dollarOpportunity || 0), 0);
      return respond(200, { entries, count: entries.length, acceptedCount: accepted.length, totalOpportunity, byAnomaly, byDistrict });
    }

    // ── Feedback (thumbs up/down) ────────────────────────────────────────
    if (action === 'feedback') {
      const { messageId, rating, comment } = payload;
      if (!messageId || !rating) return respond(400, { error: 'Missing messageId or rating' });
      if (!['up', 'down'].includes(rating)) return respond(400, { error: 'Rating must be up or down' });
      await logFeedback({ userId, messageId, rating, comment });
      // Learning Loop — a 👎 marks the Q&A row a miss even if Orion thought it answered.
      updateQAFeedback({ messageId, feedback: rating === 'up' ? 'up' : 'down' }).catch(() => {});
      return respond(200, { ok: true });
    }

    // ── Orion Learning Loop — Q&A analytics + knowledge-gap backlog (Exec/IT) ──
    if (action === 'qa-log' || action === 'qa-gaps') {
      const rows = await loadQA({ days: payload.days || 30, gapsOnly: action === 'qa-gaps', limit: payload.limit || 500 });
      if (action === 'qa-log') return respond(200, { rows });
      // Cluster the raw gap questions into themes with counts + cause, via Orion itself.
      if (rows.length === 0) return respond(200, { gaps: [] });
      const list = rows.slice(0, 200).map((r, i) => `${i}. [${r.userRole || '?'} · ${r.scope || '?'}${r.gapReason ? ' · ' + r.gapReason : ''}] ${(r.question || '').slice(0, 200)}`).join('\n');
      const gapPrompt = `These are questions users asked Orion that it could NOT answer (self-flagged as no-data/out-of-scope, or thumbs-down). Each row is prefixed with [role · scope]. Cluster them into themes. Output ONLY a JSON array, most-asked first:\n[{"theme":"short label","count":<how many rows fit this theme>,"cause":"knowledge"|"data","roles":["which distinct roles asked this, e.g. manager, dm, executive"],"exampleQuestions":["..."],"suggestedFix":"one line — write a KB article about X, or wire data source Y"}]\nRows:\n${list}`;
      const gr = await generateStructured({ system: 'You cluster support questions into actionable themes. knowledge = answerable with an SOP/policy KB article; data = a metric Orion cannot currently see. Output only JSON.', userPrompt: gapPrompt, action: 'brief', userId });
      let gaps = [];
      try { const p = JSON.parse(String(gr.text || '[]').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); if (Array.isArray(p)) gaps = p; } catch (e) { console.warn('[analyst] qa-gaps parse failed:', e.message); }
      // "Did the fix work?" — flag any theme that closely matches one we already resolved (it came back).
      const resolvedThemes = await loadResolvedThemes({ days: 120 });
      const tokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3));
      for (const g of gaps) {
        const gt = tokens(g.theme);
        g.reopened = resolvedThemes.some(rt => {
          const rtoks = tokens(rt.theme); if (!rtoks.size || !gt.size) return false;
          const overlap = [...gt].filter(w => rtoks.has(w)).length;
          return overlap / Math.min(gt.size, rtoks.size) >= 0.5;
        });
      }
      return respond(200, { gaps, sampled: rows.length, ids: rows.map(r => r.id) });
    }

    if (action === 'qa-resolve') {
      await resolveQA({ ids: payload.ids });
      // Remember the themes so we can detect if they resurface later.
      if (Array.isArray(payload.themes) && payload.themes.length) await recordResolvedThemes({ themes: payload.themes, userId });
      return respond(200, { ok: true });
    }

    if (action === 'qa-trend') {
      const trend = await qaTrend({ weeks: payload.weeks || 8 });
      return respond(200, { trend });
    }

    if (action === 'qa-gap-count') {
      const count = await countQAGaps({ days: payload.days || 30 });
      return respond(200, { count });
    }

    // Orion drafts a KB article for a knowledge gap — admin reviews & publishes.
    if (action === 'qa-draft-kb') {
      const theme = String(payload.theme || '').slice(0, 200);
      const examples = Array.isArray(payload.exampleQuestions) ? payload.exampleQuestions.slice(0, 6) : [];
      if (!theme) return respond(400, { error: 'theme required' });
      const draftPrompt = `Users keep asking Orion about "${theme}" and it lacks a knowledge-base article to answer them. Write a concise internal KB article for People Capital Group (a Dunkin' franchise operator) that would let Orion answer these questions.\nExample questions asked:\n${examples.map(q => '- ' + q).join('\n')}\n\nOutput ONLY JSON: {"title":"short article title","category":"SOP"|"Policy"|"Training"|"Reference"|"Setup Guide","description":"one-line summary","content":"the article body as clean HTML using <h3>, <p>, <ul>, <li>, <strong>. Where a company-specific fact is unknown, insert a clearly marked [FILL IN: ...] placeholder rather than guessing."}`;
      const dr = await generateStructured({ system: 'You write clear, accurate internal knowledge-base articles. Never invent company-specific facts — mark them [FILL IN: ...]. Output only JSON.', userPrompt: draftPrompt, action: 'brief', userId });
      let draft = null;
      try { draft = JSON.parse(String(dr.text || '{}').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); } catch (e) { console.warn('[analyst] qa-draft-kb parse failed:', e.message); }
      if (!draft || !draft.content) return respond(200, { draft: { title: theme, category: 'SOP', description: '', content: `<h3>${theme}</h3><p>[FILL IN: write the answer to "${theme}"]</p>` } });
      return respond(200, { draft });
    }

    // Log a data-gap as a tracked feature request (stored in a blob backlog).
    if (action === 'qa-feature-req') {
      const list = (await cacheLoad('pcg_orion_feature_requests_v1')) || [];
      const arr = Array.isArray(list) ? list : [];
      const item = {
        id: `fr_${Date.now().toString(36)}`,
        theme: String(payload.theme || '').slice(0, 200),
        detail: String(payload.suggestedFix || '').slice(0, 400),
        exampleQuestions: Array.isArray(payload.exampleQuestions) ? payload.exampleQuestions.slice(0, 5) : [],
        roles: Array.isArray(payload.roles) ? payload.roles : [],
        count: payload.count || 1,
        status: 'open',
        createdAt: new Date().toISOString(),
        createdBy: userId ?? null,
      };
      await cacheSave('pcg_orion_feature_requests_v1', [item, ...arr].slice(0, 200));
      if (payload.theme) await recordResolvedThemes({ themes: [{ theme: payload.theme, cause: 'data' }], userId });
      return respond(200, { ok: true, item });
    }

    if (action === 'qa-feature-list') {
      const list = (await cacheLoad('pcg_orion_feature_requests_v1')) || [];
      return respond(200, { requests: Array.isArray(list) ? list : [] });
    }

    // ── KPI Snapshot (raw data for debugging) ────────────────────────────
    if (action === 'snapshot') {
      const snapshot = await buildKPISnapshot({ district });
      return respond(200, snapshot);
    }

    // ── Sales Mix Intelligence (9.3): category drops + ticket attribution ──
    // Scoped like 'ask': managers → their store, DMs → their district, exec/IT →
    // any district or network. Fail closed if a non-exec has no resolved scope.
    if (action === 'sales-mix') {
      // Explicit role allowlist — only ops roles that own sales get category-drop data.
      // Denies vendor/construction/maintenance/kiosk even if their user row carries a stray
      // district, rather than relying solely on scope resolution to fail closed.
      if (!new Set(['executive', 'it', 'dm', 'manager', 'office_staff']).has(effRole)) {
        return respond(403, { error: 'Not available for your role.' });
      }
      // Managers are locked to their OWN store, resolved from the users table — never a
      // client-supplied storePC. A manager with no resolved store is denied rather than
      // falling through to district scope (which would leak their whole district).
      const isManager = effRole === 'manager';
      const effStorePC = isManager ? (caller?.storePC || null) : null;
      if (isManager && !effStorePC) return respond(403, { error: 'No store resolved for your account.' });
      if (!isExecRole && !effStorePC && effDistrict == null) {
        return respond(403, { error: 'No scope resolved for your account.' });
      }
      const opts = effStorePC ? { storePC: effStorePC } : { district: effDistrict || null };
      const mix = await buildSalesMixContext(opts);
      return respond(200, mix);
    }

    // ── Cross-store item comparison (9.3): category share-of-mix vs district peers ──
    // Same allowlist + scoping as sales-mix. Managers get their own store's outliers judged
    // against their district peers (resolved server-side); DMs their district; exec/IT network.
    if (action === 'mix-compare') {
      if (!new Set(['executive', 'it', 'dm', 'manager', 'office_staff']).has(effRole)) {
        return respond(403, { error: 'Not available for your role.' });
      }
      const isManager = effRole === 'manager';
      const effStorePC = isManager ? (caller?.storePC || null) : null;
      if (isManager && !effStorePC) return respond(403, { error: 'No store resolved for your account.' });
      if (!isExecRole && !effStorePC && effDistrict == null) {
        return respond(403, { error: 'No scope resolved for your account.' });
      }
      const opts = effStorePC ? { storePC: effStorePC } : { district: effDistrict || null };
      const cmp = await buildMixComparisonContext(opts);
      return respond(200, cmp);
    }

    // ── New product launch tracking (9.3): network adoption + ramp ──
    // Read is available to the same ops roles; scope mirrors sales-mix. Managers see how
    // their own store is doing on each launch; DMs their district; exec/IT the network.
    if (action === 'new-products') {
      if (!new Set(['executive', 'it', 'dm', 'manager', 'office_staff']).has(effRole)) {
        return respond(403, { error: 'Not available for your role.' });
      }
      const isManager = effRole === 'manager';
      const effStorePC = isManager ? (caller?.storePC || null) : null;
      if (isManager && !effStorePC) return respond(403, { error: 'No store resolved for your account.' });
      if (!isExecRole && !effStorePC && effDistrict == null) {
        return respond(403, { error: 'No scope resolved for your account.' });
      }
      const opts = effStorePC ? { storePC: effStorePC } : { district: effDistrict || null };
      const np = await buildNewProductsContext(opts);
      return respond(200, np);
    }

    // ── New product REGISTRY read/write (exec/IT only for writes) ──
    // GET-style: any allowlisted ops role can read the registry so the tracker UI can label
    // launches. Writes (add/remove tracked products) are exec/IT-gated.
    if (action === 'new-products-registry') {
      const { update } = payload;
      if (update !== undefined) {
        if (!isExecRole) return respond(403, { error: 'Editing tracked products is limited to Exec/IT.' });
        if (!Array.isArray(update)) return respond(400, { error: 'update must be an array of products.' });
        // Keep only well-formed entries; normalize terms to a trimmed string array.
        const clean = update.filter(p => p && p.id && p.name).map(p => ({
          id: String(p.id), name: String(p.name),
          terms: Array.isArray(p.terms) ? p.terms.map(t => String(t).trim()).filter(Boolean) : [],
          launchDate: p.launchDate || null, category: p.category || null,
        }));
        await cacheSave(NEW_PRODUCTS_KEY, clean);
        return respond(200, { registry: clean, updated: true });
      }
      const registry = await cacheLoad(NEW_PRODUCTS_KEY);
      return respond(200, { registry: Array.isArray(registry) ? registry : [] });
    }

    // ── Report Settings (get/update) ───────────────────────────────────
    if (action === 'report-settings') {
      const { update } = payload;
      if (update) {
        // Merge update into existing settings
        const current = await loadReportSettings();
        const merged = { ...current, ...update };
        await cacheSave('analyst/report-settings', merged);
        return respond(200, { settings: merged, updated: true });
      }
      const settings = await loadReportSettings();
      return respond(200, { settings });
    }

    // ── Send Report Now (on-demand) ────────────────────────────────────
    if (action === 'send-report') {
      const { reportType } = payload; // 'exec' or 'dm'
      const settings = await loadReportSettings();

      if (reportType === 'exec') {
        const isLaborAdjusted = payload.laborAdjusted || false;
        const sent = await sendExecReport(settings, isLaborAdjusted);
        return respond(200, { ok: true, sent, reportType: 'exec', laborAdjusted: isLaborAdjusted });
      }

      if (reportType === 'daily') {
        const sent = await sendExecDailyReport(settings);
        return respond(200, { ok: true, sent, reportType: 'daily' });
      }

      if (reportType === 'dm') {
        const usersBlob = await cacheLoad('pcg_portal_users');
        const sent = await sendDMBriefs(settings, Array.isArray(usersBlob) ? usersBlob : []);
        return respond(200, { ok: true, sent, reportType: 'dm' });
      }

      return respond(400, { error: 'reportType must be exec, daily, or dm' });
    }

    // ── Client Event Log (PDF download, sync, backup, errors) ────────
    if (action === 'log-event') {
      const { event, meta } = payload;
      if (!event) return respond(400, { error: 'Missing event' });
      // Prefer the server-resolved identity; fall back to the payload (and, for
      // events fired as the session ends, the name carried in meta) so events like
      // session_timeout still attribute even after the client cleared the user.
      await logAccessEvent({
        userId: caller?.id ?? userId ?? null,
        userRole: effRole || userRole || null,
        action: event, district,
        statusCode: meta?.error ? 500 : 200,
        latencyMs: meta?.latencyMs || null, error: meta?.error || null, meta: meta || null,
      });
      return json(200, { ok: true });
    }

    // ── Sales forecast (baseline) — project a store's day + live accuracy ──
    if (action === 'forecast') {
      const { storePC, date, range } = payload;
      if (!storePC) return respond(400, { error: 'Missing storePC' });

      // Expected weather (Open-Meteo 7-day, by district) → condition per date.
      const store = STORES.find(s => String(s.pc) === String(storePC));
      const wxAll = await getWeatherForecast().catch(() => null);
      const wxDays = (store && wxAll && wxAll[store.district] && wxAll[store.district].days) || [];
      const condByDate = {};
      wxDays.forEach(d => { if (d && d.date) condByDate[d.date] = d.condition; });
      const weatherFor = (dt) => (condByDate[dt] ? { condition: condByDate[dt] } : undefined);
      const pulseSales = (pc, d) => getDailyNetSales(pc, d);

      // range:'week' → model-driven projection for the Sunday–Saturday calendar
      // week (each day from its own weekday history); default → single-day
      // forecast + live accuracy. Both factor in weather + holidays (the latter
      // learned from Pulse history).
      if (range === 'week') {
        // Anchor the week to its Sunday. Client passes weekStart (computed in the
        // user's local time); fall back to the Sunday of the week containing the
        // target date so the view is always a full Sun→Sat week, never a rolling 7.
        const sundayOf = (iso) => { const dd = new Date(`${iso}T12:00:00`); dd.setDate(dd.getDate() - dd.getDay()); return `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`; };
        const start = payload.weekStart || sundayOf(date || tomorrowISO());
        const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(start, i));
        const weatherByDate = {};
        dates.forEach(d => { if (condByDate[d]) weatherByDate[d] = { condition: condByDate[d] }; });
        // Learn holiday factors only for the days that are actually holidays, and
        // do so SEQUENTIALLY. learnHolidayFactor does a load-modify-save of one
        // shared per-store cache blob (pcg_holiday_factor_{pc}); learning two
        // holidays in the same window concurrently (e.g. Dec 24+25, or Dec 31 +
        // Jan 1) would race and lose one's cached factor, forcing it to re-hit
        // Pulse on every request. Ordinary days never touch the cache (they
        // return null before any I/O), and a 7-day window holds at most ~2
        // holidays — each internally parallelizes its Pulse calls — so this stays
        // well under the 26s function timeout.
        const holidayFactorByDate = {}, holidayNameByDate = {}, holidayUnknownByDate = {};
        for (const d of dates) {
          const info = holidayInfo(d);
          if (!info) continue;
          const hf = await learnHolidayFactor(storePC, d, pulseSales).catch(() => null);
          if (hf) { holidayFactorByDate[d] = hf.factor; holidayNameByDate[d] = hf.name; }
          // Holiday with no learnable prior-year sales: surface the name (so the
          // day isn't shown as an ordinary weekday) and flag it unknown.
          else { holidayNameByDate[d] = info.name; holidayUnknownByDate[d] = true; }
        }
        const week = await forecastStoreWeek(storePC, start, { weatherByDate, holidayFactorByDate, holidayNameByDate, holidayUnknownByDate });

        if (week && Array.isArray(week.days)) {
          // Per-day actual net sales (elapsed days only — future dates have no sales,
          // so skip those Pulse calls) and the LY same-day +2% anchor (all 7 days).
          // Fetched in parallel so the week adds ~one round-trip rather than many.
          const today = payload.today || null;
          const [actuals, lyNets] = await Promise.all([
            Promise.all(dates.map(d => (!today || d <= today) ? getDailyNetSales(storePC, d) : Promise.resolve(null))),
            Promise.all(dates.map(d => getDailyNetSales(storePC, addDaysISO(d, -364)))),
          ]);
          week.days.forEach((day, i) => {
            const ly = lyNets[i];
            // Re-anchor the model's per-day projection to LY same weekday +2%,
            // keeping its shape (low/high/dayparts scale by the same factor).
            if (ly > 0 && day.dayTotal > 0) {
              const k = (ly * 1.02) / day.dayTotal;
              day.modelDayTotal = day.dayTotal;
              day.lyAnchor = Math.round(ly * 1.02);
              day.dayTotal = day.lyAnchor;
              day.low = Math.round(day.low * k);
              day.high = Math.round(day.high * k);
              if (day.dayparts) day.dayparts = {
                amRush: Math.round(day.dayparts.amRush * k),
                midMorning: Math.round(day.dayparts.midMorning * k),
                lunch: Math.round(day.dayparts.lunch * k),
                afternoon: Math.round(day.dayparts.afternoon * k),
              };
            }
            if (actuals[i] > 0) day.actual = Math.round(actuals[i]);
          });
          // Recompute weekly totals from the (anchored) per-day numbers, combining
          // day bands in quadrature (matches computeWeekForecast's method).
          const valid = week.days.filter(d => d.dayTotal != null);
          if (valid.length) {
            week.weekTotal = Math.round(valid.reduce((s, d) => s + d.dayTotal, 0));
            week.low = Math.round(week.weekTotal - Math.sqrt(valid.reduce((s, d) => s + Math.pow(d.dayTotal - d.low, 2), 0)));
            week.high = Math.round(week.weekTotal + Math.sqrt(valid.reduce((s, d) => s + Math.pow(d.high - d.dayTotal, 2), 0)));
          }
          // Week-to-date actual vs the forecast for those same elapsed days (a fair
          // pace). Only count days that have BOTH an actual and a model forecast, so a
          // day with sales but no weekday-history forecast can't skew the ratio.
          const done = week.days.filter(d => d.actual != null && d.dayTotal != null);
          week.weekActual = done.length ? Math.round(done.reduce((s, d) => s + d.actual, 0)) : null;
          week.forecastToDate = done.length ? Math.round(done.reduce((s, d) => s + d.dayTotal, 0)) : null;
        }

        return respond(200, { storePC, startDate: start, week });
      }

      const target = date || tomorrowISO();
      const hf = await learnHolidayFactor(storePC, target, pulseSales);
      const tgtHoliday = holidayInfo(target);
      const { forecast, accuracy } = await forecastStoreFull(storePC, target, {
        weather: weatherFor(target),
        holidayFactor: hf ? hf.factor : 1,
        // Surface the holiday even when its sales factor couldn't be learned, so
        // a closed/reduced holiday isn't silently projected as a normal weekday.
        holidayName: hf ? hf.name : (tgtHoliday ? tgtHoliday.name : null),
        holidayUnknown: !!tgtHoliday && !hf,
      });
      // YoY cross-check: last year's same weekday (−364d preserves day-of-week) × 1.02.
      // Surfaced alongside the model number so a manager can sanity-check the
      // recent-weeks model against what the store actually did a year ago.
      if (forecast) {
        const lyDate = addDaysISO(target, -364);
        const lyNet = await getDailyNetSales(storePC, lyDate);
        if (lyNet > 0) {
          forecast.lyDate = lyDate;
          forecast.lyNet = Math.round(lyNet);
          forecast.lyAnchor = Math.round(lyNet * 1.02);
        }
      }
      return respond(200, { storePC, date: target, forecast, accuracy });
    }

    // ── Audit Log (read access events for a given date) ───────────────
    if (action === 'audit-log') {
      const { date } = payload;
      const targetDate = date || new Date().toISOString().slice(0, 10);
      const entries = await loadAccessEntries(targetDate);
      return json(200, { date: targetDate, entries, count: entries.length, truncated: entries.truncated || 0 });
    }

    // ── Create Report (on-demand dashboard generation) ────────────────
    if (action === 'create-report') {
      const { prompt: userPrompt, scope, channelId } = payload;
      const reportDistrict = scope?.startsWith('district:') ? parseInt(scope.split(':')[1]) : null;
      const storePC = scope?.startsWith('store:') ? scope.split(':')[1] : null;
      const dataContext = await buildDataContext({ district: reportDistrict, storePC, userRole });
      const kpiSnapshot = await buildKPISnapshot({ district: reportDistrict });

      const dataSnapshot = `${dataContext}\n\nKPI Summary:\n${JSON.stringify(kpiSnapshot, null, 2)}`;
      const userMessage = buildReportPrompt(userPrompt, dataSnapshot);

      const answer = await askAnalyst({ userPrompt: userMessage, userId, history: [] });
      const rawAnswer = answer.answer || answer;

      let artifact;
      try {
        const parsed = typeof rawAnswer === 'string'
          ? JSON.parse(rawAnswer.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim())
          : rawAnswer;
        artifact = {
          type: parsed.type || 'dashboard',
          title: parsed.title || (userPrompt || '').slice(0, 60),
          scope: scope || 'network',
          createdBy: `user:${userId}`,
          trigger: 'on-demand',
          narrative: parsed.narrative || '',
          components: Array.isArray(parsed.components) ? parsed.components.slice(0, 8) : [],
        };
      } catch (parseErr) {
        return respond(200, { error: 'Failed to parse report structure', raw: rawAnswer });
      }

      const reportId = await saveReport(artifact);

      if (channelId) {
        const messages = (await cacheLoad('pcg_chat_messages_v1')) || [];
        messages.push({
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          channelId,
          senderId: 'orion',
          senderName: 'Orion',
          text: `New ${artifact.type} ready: **${artifact.title}** — [View in Reports](?tab=reports&report=${reportId})`,
          timestamp: new Date().toISOString(),
        });
        await cacheSave('pcg_chat_messages_v1', messages);
      }

      return respond(200, { ok: true, reportId, title: artifact.title });
    }

    return respond(400, { error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[analyst] error:', err);
    logAccessEvent({ userId, userRole, action, district, statusCode: 500, latencyMs: Date.now() - t0, error: err.message }).catch(() => {});
    return json(500, { error: err.message || 'Internal error' });
  }
};
