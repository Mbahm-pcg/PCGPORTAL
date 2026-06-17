// mcp.mjs — Model Context Protocol endpoint for PCG Portal
// Exposes Pulse, Labor, and Orion Analyst data as MCP tools
// Compatible with Claude Desktop, Claude Code, and any MCP client
//
// ── Setup (Claude Desktop) ───────────────────────────────────────────────────
// Add to ~/Library/Application Support/Claude/claude_desktop_config.json:
// {
//   "mcpServers": {
//     "pcg-portal": {
//       "type": "http",
//       "url": "https://pcg-ops.netlify.app/.netlify/functions/mcp",
//       "headers": { "Authorization": "Bearer YOUR_PCG_MCP_SECRET" }
//     }
//   }
// }
//
// ── Setup (Claude Code) ──────────────────────────────────────────────────────
// claude mcp add pcg-portal --transport http \
//   --url https://pcg-ops.netlify.app/.netlify/functions/mcp \
//   --header "Authorization: Bearer YOUR_PCG_MCP_SECRET"
//
// ── Auth ─────────────────────────────────────────────────────────────────────
// Set PCG_MCP_SECRET in Netlify env vars. Requests must include:
//   Authorization: Bearer <PCG_MCP_SECRET>

import { cacheLoad } from './analyst-lib/analyst-cache.js';
import { buildDataContext, buildKPISnapshot } from './analyst-lib/analyst-data.js';
import { buildAskPrompt, PERSONA } from './analyst-lib/analyst-prompts.js';
import { askAnalyst } from './analyst-lib/analyst-claude.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'PCG Portal', version: '7.7' };

const TOOLS = [
  {
    name: 'get_network_summary',
    description: "Returns the latest network-wide labor and sales summary for all PCG Dunkin' stores. Includes total labor cost, average labor %, total sales, and a per-store breakdown. Data refreshes every 4 hours via cron.",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_store_labor',
    description: "Returns detailed labor and sales history for a specific store. Includes 30 days of daily records and 13 weeks of weekly records with cost, sales, labor %, and scheduled headcount.",
    inputSchema: {
      type: 'object',
      properties: {
        store_pc: {
          type: 'string',
          description: 'The Pulse Cloud store number (pc). Examples: "339616" (Wadsworth), "345986" (Willits). Ask get_network_summary first to see all store PCs.',
        },
      },
      required: ['store_pc'],
    },
  },
  {
    name: 'get_kpi_snapshot',
    description: "Returns a real-time KPI snapshot with current-day sales, labor costs, and performance metrics. Can be scoped to the full network or a single district.",
    inputSchema: {
      type: 'object',
      properties: {
        district: {
          type: 'number',
          description: 'District number 1–8. Omit for a full network snapshot.',
        },
      },
      required: [],
    },
  },
  {
    name: 'ask_analyst',
    description: "Ask Orion, the PCG AI analyst, any question about operations, sales, or labor. Returns a concise data-grounded answer. Examples: 'Which district has the highest labor % this week?', 'What drove the sales dip at Wadsworth on Monday?', 'Compare WTD sales vs last week for District 3.'",
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The business question to ask Orion.',
        },
        district: {
          type: 'number',
          description: 'Scope the data to a specific district (1–8). Omit for network-wide context.',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'get_todays_brief',
    description: "Returns today's AI-generated operations brief. Covers sales performance, labor trends, and key flags for the day. Cached from the morning cron run; optionally scoped to a district.",
    inputSchema: {
      type: 'object',
      properties: {
        district: {
          type: 'number',
          description: 'District number 1–8. Omit for the network-wide brief.',
        },
      },
      required: [],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  if (name === 'get_network_summary') {
    const data = await cacheLoad('pcg_labor_v1');
    if (!data) {
      return text('Labor data is not yet available. The cron job runs every 4 hours — check back shortly.');
    }
    return text(JSON.stringify(data, null, 2));
  }

  if (name === 'get_store_labor') {
    const { store_pc } = args || {};
    if (!store_pc) return error('Missing required argument: store_pc');
    const data = await cacheLoad(`pcg_labor_store_${store_pc}`);
    if (!data) return text(`No labor data found for store ${store_pc}. Use get_network_summary to find valid store PCs.`);
    return text(JSON.stringify(data, null, 2));
  }

  if (name === 'get_kpi_snapshot') {
    const snapshot = await buildKPISnapshot({ district: args?.district || null });
    return text(JSON.stringify(snapshot, null, 2));
  }

  if (name === 'ask_analyst') {
    const { question, district } = args || {};
    if (!question) return error('Missing required argument: question');
    const scope = district ? `District ${district}` : 'Network';
    const today = new Date().toISOString().slice(0, 10);
    const dataContext = await buildDataContext({ district: district || null, includeStoreDetail: true });
    const prompt = buildAskPrompt(question, 'executive', scope, today, dataContext);
    const result = await askAnalyst({ userPrompt: prompt, userId: 'mcp', forceDeep: false });
    return text(result.answer);
  }

  if (name === 'get_todays_brief') {
    const today = new Date().toISOString().slice(0, 10);
    const key = `analyst/briefs/${today}_${args?.district || 'network'}`;
    const brief = await cacheLoad(key);
    if (!brief) {
      return text('No brief is available for today yet. It is generated by the morning cron job (7 AM ET). You can use ask_analyst to get a live summary instead.');
    }
    const out = [
      `📋 ${brief.scope} Brief — ${brief.date}`,
      `Role: ${brief.role}`,
      `Generated: ${brief.generatedAt}`,
      '',
      brief.content,
    ].join('\n');
    return text(out);
  }

  return error(`Unknown tool: ${name}`);
}

// ── Response helpers ──────────────────────────────────────────────────────────

function text(str) {
  return { content: [{ type: 'text', text: str }] };
}

function error(msg) {
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

function rpcOk(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcErr(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAuthorized(request) {
  const secret = process.env.PCG_MCP_SECRET;
  if (!secret) return true; // open if not configured (dev)
  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${secret}`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async (request, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify(rpcErr(null, -32600, 'POST only')), { status: 405, headers });

  if (!isAuthorized(request)) {
    return new Response(JSON.stringify(rpcErr(null, -32600, 'Unauthorized')), { status: 401, headers });
  }

  let req;
  try {
    req = await request.json();
  } catch {
    return new Response(JSON.stringify(rpcErr(null, -32700, 'Parse error')), { status: 400, headers });
  }

  const { id, method, params } = req;

  try {
    // ── initialize ────────────────────────────────────────────────────────────
    if (method === 'initialize') {
      return new Response(JSON.stringify(rpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })), { status: 200, headers });
    }

    // ── notifications/initialized (no response needed) ────────────────────────
    if (method === 'notifications/initialized') {
      return new Response(null, { status: 204, headers });
    }

    // ── tools/list ────────────────────────────────────────────────────────────
    if (method === 'tools/list') {
      return new Response(JSON.stringify(rpcOk(id, { tools: TOOLS })), { status: 200, headers });
    }

    // ── tools/call ────────────────────────────────────────────────────────────
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      if (!name) {
        return new Response(JSON.stringify(rpcErr(id, -32602, 'Missing tool name')), { status: 400, headers });
      }
      const result = await handleTool(name, args || {});
      return new Response(JSON.stringify(rpcOk(id, result)), { status: 200, headers });
    }

    // ── ping ──────────────────────────────────────────────────────────────────
    if (method === 'ping') {
      return new Response(JSON.stringify(rpcOk(id, {})), { status: 200, headers });
    }

    return new Response(JSON.stringify(rpcErr(id, -32601, `Method not found: ${method}`)), { status: 400, headers });

  } catch (err) {
    console.error('[mcp] error:', err);
    return new Response(JSON.stringify(rpcErr(id, -32603, err.message || 'Internal error')), { status: 500, headers });
  }
};
