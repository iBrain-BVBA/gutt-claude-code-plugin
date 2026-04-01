#!/usr/bin/env node
/**
 * GUTT Agent Discovery Wrapper
 * Calls search_memory_nodes via the gutt MCP HTTP endpoint to discover relevant agents.
 * Falls back to seed registry if MCP is unreachable.
 *
 * @module agent-discovery
 */

const https = require("https");
const http = require("http");
const { scanSeeds } = require("./seed-registry.cjs");
const { debugLog } = require("./debug.cjs");
const { getGroupId } = require("./config.cjs");
const { getGuttMcpUrl } = require("./mcp-config.cjs");

/**
 * Parse raw SSE or plain JSON response body into a JSON string.
 * For SSE streams with multiple events, returns only the LAST event's data.
 * @param {string} data - Raw response body
 * @returns {string} JSON string ready for JSON.parse
 */
function parseSseResponse(data) {
  if (data.startsWith("data:")) {
    const events = data
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    if (events.length === 0) {
      throw new Error("SSE response contained no parseable data");
    }
    return events[events.length - 1];
  }
  return data;
}

const MCP_TIMEOUT_MS = 2000;
const DEFAULT_MAX_NODES = 5;
// Must be below PASSTHROUGH_MAX_SCORE (0.3 in router.cjs) to prevent false-positive routing when MCP is down
const FALLBACK_SCORE = 0.25;

/**
 * @typedef {Object} AgentMatch
 * @property {string} name    - Agent name (e.g. "cfo-analyst", "contact:poab")
 * @property {number} score   - Relevance score 0–1
 * @property {string} summary - Brief summary from memory graph (or seed description)
 */

/**
 * @typedef {Object} IntentResult
 * @property {string[]} keywords
 * @property {string[]} entityRefs
 * @property {string[]} domainSignals
 */

// ---------------------------------------------------------------------------
// MCP HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Get the gutt MCP base URL.
 * Prefers explicit GUTT_MCP_URL env var, falls back to extracting from Claude Code settings.
 * @returns {string|null}
 */
function getMcpUrl() {
  if (process.env.GUTT_MCP_URL) {
    return process.env.GUTT_MCP_URL;
  }
  // Fall back to extracting from Claude Code settings files
  const settingsUrl = getGuttMcpUrl();
  if (!settingsUrl) {
    return null;
  }
  // Claude Code stores the full MCP endpoint URL (e.g. "https://host/mcp").
  // callMcpTool() appends "/mcp" via new URL("/mcp", mcpUrl), so strip pathname.
  try {
    const parsed = new URL(settingsUrl);
    if (parsed.pathname === "/mcp" || parsed.pathname === "/mcp/") {
      return parsed.origin;
    }
  } catch {
    /* not a valid URL, return as-is */
  }
  return settingsUrl;
}

/**
 * Get auth headers for gutt MCP requests.
 * Uses GUTT_MCP_IDENTITY (→ identity_id header) and GUTT_MCP_TOKEN (→ authorization header).
 * @returns {Object}
 */
function getAuthHeaders() {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (process.env.GUTT_MCP_IDENTITY) {
    headers["identity_id"] = process.env.GUTT_MCP_IDENTITY;
  }
  if (process.env.GUTT_MCP_TOKEN) {
    headers["authorization"] = process.env.GUTT_MCP_TOKEN;
  }
  return headers;
}

/**
 * Make a JSON-RPC 2.0 request to the MCP StreamableHTTP endpoint.
 * Returns the parsed result or throws on error/timeout.
 *
 * @param {string} mcpUrl - Base MCP URL (e.g. "https://mcp.gutt.ai")
 * @param {string} method - MCP tool name (e.g. "search_memory_nodes")
 * @param {Object} params - Tool parameters
 * @returns {Promise<Object>} Parsed JSON-RPC result
 */
function callMcpTool(mcpUrl, method, params) {
  return new Promise((resolve, reject) => {
    const url = new URL("/mcp", mcpUrl);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: method,
        arguments: params,
      },
    });

    const headers = getAuthHeaders();
    headers["Content-Length"] = Buffer.byteLength(body);

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers,
    };

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const jsonStr = parseSseResponse(data);
          const parsed = JSON.parse(jsonStr);

          if (parsed.error) {
            reject(new Error(`MCP error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
            return;
          }
          resolve(parsed.result);
        } catch (err) {
          reject(new Error(`Failed to parse MCP response: ${err.message}`));
        }
      });
    });

    req.on("error", (err) => reject(err));

    // Timeout
    req.setTimeout(MCP_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`MCP request timed out after ${MCP_TIMEOUT_MS}ms`));
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fallback: seed registry
// ---------------------------------------------------------------------------

/**
 * Build fallback agent list from the seed registry with uniform FALLBACK_SCORE.
 * @returns {AgentMatch[]}
 */
function buildFallbackAgents() {
  try {
    const registry = scanSeeds();
    return Object.values(registry).map((seed) => ({
      name: seed.name,
      score: FALLBACK_SCORE,
      summary: `${seed.type} agent (seed registry fallback)`,
    }));
  } catch (err) {
    debugLog("agent-discovery", `Seed registry fallback failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

/**
 * Parse the MCP search_memory_nodes result into AgentMatch[].
 * The result.content is typically an array of text blocks or a JSON payload.
 *
 * @param {Object} result - JSON-RPC result from MCP
 * @returns {AgentMatch[]}
 */
function parseSearchResult(result) {
  if (!result) {
    return [];
  }

  // Handle MCP tool result format: { content: [{ type: "text", text: "..." }] }
  let payload = result;
  if (Array.isArray(result.content)) {
    const textBlock = result.content.find((c) => c.type === "text");
    if (textBlock) {
      try {
        payload = JSON.parse(textBlock.text);
      } catch {
        // Not JSON — return empty
        return [];
      }
    }
  }

  // Expect array of node objects: { name, summary, score? }
  const nodes = Array.isArray(payload) ? payload : payload.nodes || payload.results || [];
  return nodes
    .map((node) => ({
      name: node.name || node.entity_name || node.id || "unknown",
      score: typeof node.score === "number" ? node.score : 0.5,
      summary: node.summary || node.content || "",
    }))
    .filter((n) => n.name !== "unknown");
}

// ---------------------------------------------------------------------------
// discoverAgents
// ---------------------------------------------------------------------------

/**
 * Discover relevant agents for the given intent.
 * Calls search_memory_nodes via MCP HTTP, falls back to seed registry on failure.
 *
 * @param {IntentResult} intent - Result from extractIntent()
 * @returns {Promise<AgentMatch[]>} Agents sorted by score descending
 */
async function discoverAgents(intent) {
  const mcpUrl = getMcpUrl();

  if (!mcpUrl) {
    debugLog(
      "agent-discovery",
      "No MCP URL found (env var or settings) — using seed registry fallback"
    );
    return buildFallbackAgents().sort((a, b) => b.score - a.score);
  }

  // Build query from intent signals
  const queryParts = [
    ...(intent.keywords || []).slice(0, 8),
    ...(intent.entityRefs || []),
    ...(intent.domainSignals || []),
  ];
  const query = queryParts.join(" ").trim() || "agent";

  const params = {
    query,
    group_id: getGroupId(),
    max_nodes: DEFAULT_MAX_NODES,
    entity: "Agent",
  };

  try {
    const result = await callMcpTool(mcpUrl, "search_memory_nodes", params);
    const agents = parseSearchResult(result);

    if (agents.length === 0) {
      debugLog("agent-discovery", "MCP returned no agents — using seed registry fallback");
      return buildFallbackAgents().sort((a, b) => b.score - a.score);
    }

    return agents.sort((a, b) => b.score - a.score);
  } catch (err) {
    debugLog("agent-discovery", `MCP call failed (${err.message}) — using seed registry fallback`);
    return buildFallbackAgents().sort((a, b) => b.score - a.score);
  }
}

module.exports = { discoverAgents, parseSseResponse, getMcpUrl };
