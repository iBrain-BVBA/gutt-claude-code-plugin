#!/usr/bin/env node
/**
 * GUTT Agent Seed Registry
 * Scans agent seed .md files, parses Grounding and Learning protocols,
 * and provides fast lookups by agent name.
 *
 * The registry maps agent names to their specific grounding queries and
 * learning protocol templates, enabling seed-aware memory injection.
 *
 * group_id is NEVER stored in the registry — it's resolved at runtime
 * via getGroupId() from config.cjs.
 */

const fs = require("fs");
const path = require("path");
const { PROJECT_DIR, PROJECT_STATE_DIR } = require("./env.cjs");
const { debugLog } = require("./debug.cjs");

const STATE_DIR = path.join(PROJECT_STATE_DIR, "hooks", ".state");
const REGISTRY_PATH = path.join(STATE_DIR, "gutt-seed-registry.json");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Directories to scan for agent seed files, in priority order
 */
function getScanPaths() {
  return [path.join(PROJECT_DIR, "agents"), path.join(PROJECT_DIR, ".claude", "agents")];
}

/**
 * Parse a grounding query call from markdown text
 * Extracts tool name and query string, strips group_id
 *
 * Matches patterns like:
 *   search_memory_nodes(query="revenue costs", group_id="gutt_pro_v1")
 *   fetch_lessons_learned(group_id="gutt_pro_v1")
 *
 * @param {string} line - A line of markdown text
 * @returns {Object|null} { tool, query } or null
 */
const KNOWN_TOOLS = new Set([
  "search_memory_nodes",
  "search_memory_facts",
  "fetch_lessons_learned",
]);

function parseGroundingCall(line) {
  // Check for tool-like calls that don't match known tools
  const unknownMatch = line.match(/`?(\w+)\([^)]*\)`?/);
  if (unknownMatch && !KNOWN_TOOLS.has(unknownMatch[1]) && unknownMatch[1].includes("_")) {
    debugLog("seed-registry", `Unrecognized tool in grounding query: ${unknownMatch[1]}`);
  }

  // Match tool_name(...)
  const callMatch = line.match(
    /`?(search_memory_nodes|search_memory_facts|fetch_lessons_learned)\(([^)]*)\)`?/
  );
  if (!callMatch) {
    return null;
  }

  const tool = callMatch[1];
  const args = callMatch[2];

  // Extract query parameter (may not exist for fetch_lessons_learned)
  const queryMatch = args.match(/query\s*=\s*"([^"]*)"/);
  const query = queryMatch ? queryMatch[1] : null;

  return { tool, query };
}

/**
 * Extract a markdown section by heading
 * @param {string} content - Full markdown content
 * @param {string} heading - Heading text to find (e.g., "Grounding Protocol")
 * @returns {string|null} Section content or null
 */
function extractSection(content, heading) {
  // Match ## Heading (level 2)
  const regex = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const match = content.match(regex);
  if (!match) {
    return null;
  }

  const start = match.index + match[0].length;
  // Find next ## heading or --- separator or end of file
  const nextSection = content.slice(start).search(/^(##\s|---\s*$)/m);
  const end = nextSection === -1 ? content.length : start + nextSection;

  return content.slice(start, end).trim();
}

/**
 * Parse a single agent seed .md file
 * @param {string} filePath - Path to the .md file
 * @returns {Object|null} Parsed seed data or null
 */
function parseSeedFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");

    // Extract agent name from first # heading
    const nameMatch = content.match(/^#\s+(.+)$/m);
    if (!nameMatch) {
      return null;
    }
    const name = nameMatch[1].trim();

    // Extract type from **Type**: line
    const typeMatch = content.match(/\*\*Type\*\*:\s*(\w+)/);
    const type = typeMatch ? typeMatch[1].trim() : "unknown";

    // Parse Grounding Protocol
    const groundingSection = extractSection(content, "Grounding Protocol");
    const groundingQueries = [];
    if (groundingSection) {
      for (const line of groundingSection.split("\n")) {
        const call = parseGroundingCall(line);
        if (call) {
          groundingQueries.push(call);
        }
      }
    }

    // Parse Learning Protocol
    const learningSection = extractSection(content, "Learning Protocol");
    let outcomeName = null;
    let surpriseName = null;
    if (learningSection) {
      // Split learning section into subsections by ### headings
      // This prevents lazy [\s\S]*? from crossing subsection boundaries
      const subsections = learningSection.split(/(?=^###\s)/m);

      for (const sub of subsections) {
        const nameMatch = sub.match(/\*\*name\*\*:\s*"([^"]*)"/);
        if (!nameMatch) {
          continue;
        }

        if (/^###\s*Outcomes/m.test(sub)) {
          outcomeName = nameMatch[1];
        } else if (/^###\s*Surprises/m.test(sub)) {
          surpriseName = nameMatch[1];
        }
      }
    }

    return {
      name,
      type,
      groundingQueries,
      learningProtocol: {
        outcomeName,
        surpriseName,
      },
      sourcePath: filePath,
    };
  } catch (err) {
    debugLog("seed-registry", `Failed to parse ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Scan all agent seed directories and build the registry
 * @returns {Object} Registry mapping agent names to seed data
 */
function scanSeeds() {
  const registry = {};
  const scanPaths = getScanPaths();

  for (const dir of scanPaths) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        // Skip template files
        if (file.startsWith("_")) {
          continue;
        }

        const filePath = path.join(dir, file);
        const seed = parseSeedFile(filePath);
        if (
          seed &&
          (seed.groundingQueries.length > 0 ||
            seed.learningProtocol.outcomeName ||
            seed.learningProtocol.surpriseName)
        ) {
          // Index by name (lowercase for case-insensitive matching)
          registry[seed.name.toLowerCase()] = seed;
        }
      }
    } catch (err) {
      debugLog("seed-registry", `Failed to scan ${dir}: ${err.message}`);
    }
  }

  // Write cache
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    const cacheData = {
      scannedAt: new Date().toISOString(),
      agentCount: Object.keys(registry).length,
      registry,
    };
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(cacheData, null, 2));
  } catch (err) {
    debugLog("seed-registry", `Failed to write cache: ${err.message}`);
  }

  return registry;
}

/**
 * Check if any agent .md file in the scan directories was modified
 * after the given timestamp.
 * @param {number} cacheTime - Cache timestamp in milliseconds
 * @returns {boolean} True if any file is newer than the cache
 */
function agentFilesModifiedSince(cacheTime) {
  const scanPaths = getScanPaths();
  for (const dir of scanPaths) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > cacheTime) {
          return true;
        }
      }
    } catch {
      // If we can't read the directory, invalidate to be safe
      return true;
    }
  }
  return false;
}

/**
 * Load registry from cache if fresh
 * @returns {Object|null} Cached registry or null if stale/missing
 */
function loadFromCache() {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) {
      return null;
    }

    const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    if (!data.scannedAt) {
      return null;
    }

    const cacheTime = new Date(data.scannedAt).getTime();
    const age = Date.now() - cacheTime;
    if (age > CACHE_TTL_MS) {
      return null;
    }

    // Invalidate if any agent file was modified after cache was written
    if (agentFilesModifiedSince(cacheTime)) {
      return null;
    }

    return data.registry || null;
  } catch {
    return null;
  }
}

/**
 * Get agent seed data by agent type string
 *
 * Supports matching:
 * - Exact: "cfo-analyst"
 * - Prefixed: "gutt-claude-code-plugin:cfo-analyst"
 * - Kebab to colon: "contact-poab" matches "contact:poab"
 *
 * @param {string} agentType - The agent_type from SubagentStart hook
 * @returns {Object|null} Seed data or null if not found
 */
function getAgentSeed(agentType) {
  if (!agentType) {
    return null;
  }

  // Load or scan registry
  let registry = loadFromCache();
  if (!registry) {
    registry = scanSeeds();
  }

  const normalized = agentType.toLowerCase();

  // Try exact match
  if (registry[normalized]) {
    return registry[normalized];
  }

  // Try stripping plugin prefix (e.g., "gutt-claude-code-plugin:cfo-analyst" → "cfo-analyst")
  // Use indexOf (first colon) not lastIndexOf — "plugin:contact:poab" → "contact:poab"
  const colonIdx = normalized.indexOf(":");
  if (colonIdx !== -1) {
    const stripped = normalized.slice(colonIdx + 1);
    if (registry[stripped]) {
      return registry[stripped];
    }
  }

  // Try converting first hyphen to colon for relationship agents
  // "contact-poab" → "contact:poab"
  const hyphenIdx = normalized.indexOf("-");
  if (hyphenIdx !== -1) {
    const colonVariant = normalized.slice(0, hyphenIdx) + ":" + normalized.slice(hyphenIdx + 1);
    if (registry[colonVariant]) {
      return registry[colonVariant];
    }
  }

  return null;
}

/**
 * Clear the seed cache (force rescan on next access)
 */
function clearSeedCache() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      fs.unlinkSync(REGISTRY_PATH);
    }
  } catch (err) {
    debugLog("seed-registry", `Failed to clear cache: ${err.message}`);
  }
}

module.exports = {
  getAgentSeed,
  scanSeeds,
  clearSeedCache,
  agentFilesModifiedSince,
  REGISTRY_PATH,
};
