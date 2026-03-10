#!/usr/bin/env node
/**
 * Playbook Matcher
 * Scans a playbooks directory for .md files with YAML frontmatter,
 * matches intent keywords against playbook name + tags, and returns
 * the best-matching playbook or null.
 *
 * Exported API:
 *   matchPlaybook(intent, playbooksDir?) -> PlaybookMatch | null
 *
 * PlaybookMatch shape:
 *   { name, tags, lead, supporting, description, file }
 *
 * Playbook frontmatter schema:
 *   ---
 *   name: prep-client-meeting
 *   tags: [meeting, client, prep, agenda]
 *   lead: contact:*
 *   supporting: [sales-advisor]
 *   ---
 */

const fs = require("fs");
const path = require("path");
const { debugLog } = require("./debug.cjs");

/**
 * Default playbooks directory.
 * Resolves to the sibling gutt-agents/playbooks/ relative to the plugin root.
 * When CLAUDE_PLUGIN_ROOT is set (normal runtime), that is the plugin root.
 * When running tests or standalone, falls back to __dirname/../../../gutt-agents/playbooks.
 */
function defaultPlaybooksDir() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "../../");
  // Try sibling repo first: <pluginRoot>/../gutt-agents/playbooks
  const siblingPath = path.resolve(pluginRoot, "../gutt-agents/playbooks");
  if (fs.existsSync(siblingPath)) {
    return siblingPath;
  }
  // Fallback: playbooks/ inside the project being edited
  const projectDir =
    process.env.CURSOR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.join(projectDir, "playbooks");
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Supports simple key: value and key: [a, b, c] syntax only.
 *
 * @param {string} content - Raw file content
 * @returns {{ frontmatter: Object, body: string } | null}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    return null;
  }

  const raw = match[1];
  const body = match[2].trim();
  const frontmatter = {};

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const valueRaw = trimmed.slice(colonIdx + 1).trim();

    // Array syntax: [a, b, c]
    if (valueRaw.startsWith("[") && valueRaw.endsWith("]")) {
      frontmatter[key] = valueRaw
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    } else {
      // Scalar — strip optional quotes
      frontmatter[key] = valueRaw.replace(/^['"]|['"]$/g, "");
    }
  }

  return { frontmatter, body };
}

/**
 * Load all playbooks from the given directory.
 * Skips files that start with _ (templates).
 * Skips files missing a 'name' in frontmatter.
 *
 * @param {string} playbooksDir - Absolute path to playbooks directory
 * @returns {Array<Object>}
 */
function loadPlaybooks(playbooksDir) {
  const dir = playbooksDir || defaultPlaybooksDir();

  if (!fs.existsSync(dir)) {
    debugLog("playbook-matcher", `Playbooks directory not found: ${dir}`);
    return [];
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  const playbooks = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = parseFrontmatter(content);

      if (!parsed) {
        debugLog("playbook-matcher", `No frontmatter in ${file}, skipping`);
        continue;
      }

      const { frontmatter, body } = parsed;

      if (!frontmatter.name) {
        debugLog("playbook-matcher", `Missing 'name' in frontmatter of ${file}, skipping`);
        continue;
      }

      playbooks.push({
        name: frontmatter.name,
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
        lead: frontmatter.lead || null,
        supporting: Array.isArray(frontmatter.supporting) ? frontmatter.supporting : [],
        description: body,
        file,
      });
    } catch (err) {
      debugLog("playbook-matcher", `Failed to load ${file}: ${err.message}`);
    }
  }

  debugLog("playbook-matcher", `Loaded ${playbooks.length} playbooks from ${dir}`);
  return playbooks;
}

/**
 * Stop words stripped from description scoring to prevent generic word bias.
 * Common function words that appear in most descriptions and carry no domain signal.
 */
const DESC_STOP_WORDS = new Set([
  "do",
  "i",
  "this",
  "a",
  "the",
  "is",
  "it",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "we",
  "our",
  "you",
  "be",
  "an",
  "and",
  "or",
  "but",
  "with",
  "by",
  "from",
  "that",
  "are",
  "was",
  "were",
  "have",
  "has",
  "as",
  "if",
  "not",
  "can",
  "will",
  "when",
  "which",
  "who",
  "what",
  "how",
  "its",
  "all",
  "any",
  "one",
  "may",
  "so",
  "up",
  "out",
  "no",
]);

/**
 * Tokenise a string into lowercase words.
 * Splits on whitespace, hyphens, underscores, and punctuation.
 *
 * @param {string} text
 * @returns {Array<string>}
 */
function tokenise(text) {
  return text
    .toLowerCase()
    .split(/[\s\-_.,!?;:()[\]"']+/)
    .filter(Boolean);
}

/**
 * Score a playbook against a set of intent tokens.
 * Normalised string overlap — no fuzzy matching, no LLM.
 *
 * Scoring weights:
 *   Tag match:         3 points per matching token
 *   Name match:        2 points per matching token
 *   Description match: 1 point per matching token (capped at 5 to prevent bias)
 *   Stop words are excluded from description scoring to prevent generic word bias.
 *
 * @param {Object} playbook
 * @param {Array<string>} intentTokens
 * @returns {number}
 */
function scorePlaybook(playbook, intentTokens) {
  let score = 0;

  const nameTokens = new Set(tokenise(playbook.name));
  const tagTokens = new Set(playbook.tags.flatMap((t) => tokenise(t)));
  // Strip stop words from description tokens to avoid generic word inflation
  const descTokens = new Set(tokenise(playbook.description).filter((t) => !DESC_STOP_WORDS.has(t)));

  for (const token of intentTokens) {
    if (tagTokens.has(token)) {
      score += 3;
    }
    if (nameTokens.has(token)) {
      score += 2;
    }
  }

  let descHits = 0;
  for (const token of intentTokens) {
    if (!DESC_STOP_WORDS.has(token) && descTokens.has(token)) {
      descHits++;
    }
  }
  score += Math.min(descHits, 5);

  return score;
}

/**
 * Match a user intent string to the best playbook.
 *
 * @param {string} intent - The user's message or extracted intent keywords
 * @param {string} [playbooksDir] - Absolute path to playbooks directory.
 *   Defaults to sibling gutt-agents/playbooks/ relative to plugin root.
 * @param {Object} [options]
 * @param {number} [options.threshold=3] - Minimum score to consider a match
 * @returns {Object|null} Matched playbook (PlaybookMatch) or null
 */
function matchPlaybook(intent, playbooksDir, options = {}) {
  // Allow calling as matchPlaybook(intent, options) without playbooksDir
  if (playbooksDir && typeof playbooksDir === "object") {
    options = playbooksDir;
    playbooksDir = null;
  }

  const threshold = options.threshold !== undefined ? options.threshold : 3;

  if (!intent || typeof intent !== "string") {
    return null;
  }

  const intentTokens = tokenise(intent);
  if (intentTokens.length === 0) {
    return null;
  }

  const playbooks = loadPlaybooks(playbooksDir);
  if (playbooks.length === 0) {
    return null;
  }

  let bestScore = 0;
  let bestPlaybook = null;

  for (const playbook of playbooks) {
    const score = scorePlaybook(playbook, intentTokens);
    debugLog("playbook-matcher", `Playbook '${playbook.name}' scored ${score}`);
    if (score > bestScore) {
      bestScore = score;
      bestPlaybook = playbook;
    }
  }

  if (bestScore >= threshold) {
    debugLog("playbook-matcher", `Matched playbook '${bestPlaybook.name}' (score ${bestScore})`);
    return bestPlaybook;
  }

  debugLog(
    "playbook-matcher",
    `No playbook matched (best score ${bestScore} < threshold ${threshold})`
  );
  return null;
}

module.exports = {
  matchPlaybook,
  loadPlaybooks,
  parseFrontmatter,
};
