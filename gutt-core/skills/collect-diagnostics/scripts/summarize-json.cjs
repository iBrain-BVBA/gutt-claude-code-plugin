#!/usr/bin/env node
/**
 * Reduce a JSON configuration file to its diagnostic shape.
 *
 * The files this exists for — the user's settings at two scopes, the host's plugin
 * inventory, a project's MCP configuration — are not ours, have no schema we
 * control, and routinely hold credentials: an `env` block with an API key, an
 * `apiKeyHelper` command, an MCP server with an authorization header, a
 * marketplace URL carrying an access token. Copying such a file and deleting what
 * looks like a secret is a negative control: it is correct only for the shapes
 * someone thought of, and a key named nothing in particular holding a token
 * survives it.
 *
 * So this inverts the rule. **Key names are the diagnostic content, values almost
 * never are.** A support engineer needs to know that `env` is set and which
 * variables are in it, not what they contain; that a `statusLine` exists and where
 * it points; which plugins are enabled; that `permissions` has 40 rules. All of
 * that is names, counts, and structure.
 *
 *   - Object keys and array structure: always kept. Names are not values.
 *   - Booleans, numbers, null: always kept. A flag cannot be a credential.
 *   - Strings: replaced with their type and length, UNLESS the key is one of the
 *     few named below whose value is itself the diagnosis — a status line that
 *     points at a path that has moved cannot be diagnosed without the path.
 *   - Kept strings are still scrubbed for embedded credentials, because a path or
 *     a source URL can carry one.
 *
 * Anything new is therefore withheld by default. That is the property a
 * pattern-matching redactor cannot have.
 *
 * Both collectors call this rather than each implementing it: this is the
 * highest-consequence logic in the pair, and a rule that exists twice is a rule
 * that can hold on one platform only. It costs a dependency on Node, which the
 * plugin's hooks already require — and when Node is absent the collectors skip
 * these artifacts entirely rather than falling back to copying the raw file.
 *
 * Usage: node summarize-json.cjs <file>
 * Exit:  0 summarized · 3 unreadable or unparseable · 4 no such file · 2 bad usage
 */

"use strict";

const fs = require("fs");

/**
 * Keys whose string value is kept verbatim, matched on the exact key name.
 *
 * Every entry has to earn its place by naming a fault that cannot be diagnosed
 * without it. `command` is the load-bearing one and the only user-authored string
 * here: a hook or status line that does not fire is diagnosed from the command the
 * host was told to run. `url` is deliberately absent — an endpoint is not worth a
 * credential in a query string.
 */
const KEEP_STRING_VALUES = new Set([
  "branch",
  "command",
  "commit",
  "displayName",
  "gitCommitSha",
  "installPath",
  "marketplace",
  "mode",
  "model",
  "name",
  "ref",
  "scope",
  "source",
  "type",
  "version",
]);

/** Structure caps. A settings file is small; a runaway one must not become the bundle. */
const MAX_DEPTH = 8;
const MAX_ARRAY_ENTRIES = 25;
const MAX_OBJECT_KEYS = 200;

/**
 * Scrub a kept string of embedded credentials.
 *
 * The same value shapes both collectors carry, and only those: the key-name rules
 * they also apply are unnecessary here, because a string only reaches this function
 * by being under an allowlisted name in the first place.
 */
function scrubValue(text) {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "<redacted-jwt>")
    .replace(/:\/\/[^/@\s"]+:[^/@\s"]+@/g, "://<redacted>@")
    .replace(/([?&](access_token|token|code|key|api_key|apikey|secret)=)[^&"\s]+/gi, "$1<redacted>")
    .replace(/(sk-|ghp_|gho_|ghs_|github_pat_|xoxb-|xoxp-)[A-Za-z0-9_-]{12,}/g, "<redacted>");
}

/**
 * @param {*} value
 * @param {string|null} key - the key this value sits under, or null at the root
 * @param {number} depth
 */
function shapeOf(value, key, depth) {
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (key !== null && KEEP_STRING_VALUES.has(key)) {
      return scrubValue(value);
    }
    return `<string:${value.length}>`;
  }
  if (depth >= MAX_DEPTH) {
    return Array.isArray(value)
      ? `<array:${value.length}, depth capped>`
      : "<object, depth capped>";
  }
  if (Array.isArray(value)) {
    // Arrays of primitives collapse to a count — a list of permission rules is a
    // list of strings, and its length is the whole diagnostic. Arrays of objects
    // are walked, because that is how hook entries are shaped.
    if (!value.some((entry) => entry !== null && typeof entry === "object")) {
      return `<array:${value.length}>`;
    }
    const kept = value.slice(0, MAX_ARRAY_ENTRIES).map((entry) => shapeOf(entry, key, depth + 1));
    if (value.length > MAX_ARRAY_ENTRIES) {
      kept.push(`<${value.length - MAX_ARRAY_ENTRIES} more entries not shown>`);
    }
    return kept;
  }
  const out = {};
  const keys = Object.keys(value);
  for (const name of keys.slice(0, MAX_OBJECT_KEYS)) {
    out[name] = shapeOf(value[name], name, depth + 1);
  }
  if (keys.length > MAX_OBJECT_KEYS) {
    out["<more keys not shown>"] = keys.length - MAX_OBJECT_KEYS;
  }
  return out;
}

function main(argv) {
  const file = argv[2];
  if (!file) {
    process.stderr.write("usage: node summarize-json.cjs <file>\n");
    return 2;
  }

  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return 4;
    }
    process.stderr.write(`cannot read ${file}: ${err.message}\n`);
    return 3;
  }

  let parsed;
  try {
    // \uFEFF rather than the character itself: a literal BOM in a source file is
    // invisible, and the hooks strip it the same way.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (err) {
    // A settings file the host cannot parse is a fault in its own right, and one
    // that explains a great deal — so report it as the summary rather than as a
    // failure to produce one. The message is emitted, never the file's text: an
    // unparseable file is exactly the one whose contents were never inspected.
    process.stdout.write(
      JSON.stringify(
        {
          _source: file,
          _summary: "the file exists but is not valid JSON, so the host cannot read it either",
          _parseError: err.message,
          _bytes: raw.length,
        },
        null,
        2
      ) + "\n"
    );
    return 0;
  }

  process.stdout.write(
    JSON.stringify(
      {
        _source: file,
        _summary:
          "key names, structure, booleans and numbers verbatim; string values withheld as <string:length> unless the key is one whose value is itself the diagnosis",
        _bytes: raw.length,
        _valuesKept: [...KEEP_STRING_VALUES].sort(),
        shape: shapeOf(parsed, null, 0),
      },
      null,
      2
    ) + "\n"
  );
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { shapeOf, scrubValue, KEEP_STRING_VALUES };
