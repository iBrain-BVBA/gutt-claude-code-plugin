#!/usr/bin/env node
/**
 * The mutating half of the built-in-memory migration (GP-922, S3.8): back the store
 * up, record which facts were *verified* present in the graph, and remove only those.
 *
 * Split from the read-only `builtin-memory.cjs` on purpose. This module deletes files
 * in a directory the plugin does not own — Claude Code's per-project memory store —
 * so it is an allowlisted direct writer in `tests/check-state-location.cjs` with a
 * one-line reason, the same treatment GP-895 gave `migrations.cjs`. Keeping detection
 * write-free means the hot SessionStart path never loads any of this.
 *
 * ## Why deletion is gated on a recorded verification
 *
 * `skills/memory-capture` rule 6: an MCP write is **queued, not confirmed**. A success
 * response means enqueued, and extraction can still fail silently server-side. So
 * "the write returned 200" is not grounds to delete the only other copy of a fact.
 *
 * Prose alone cannot enforce that ordering — so the ordering is structural here:
 *
 *   1. `backupStore()`      — the whole store captured into one JSON under
 *                             ${CLAUDE_PLUGIN_DATA}. Nothing is removed.
 *   2. (agent writes the episodes, then searches for them)
 *   3. `recordVerified()`   — the agent records `file -> episode id`, and can only
 *                             do that for a fact a search actually returned.
 *   4. `deleteVerified()`   — removes exactly the files with a recorded id.
 *
 * A write that reports success and never lands therefore produces no search hit, no
 * recorded id, and **zero deletions** — which is the property the story asks to see
 * tested, and it is testable precisely because step 4 cannot see step 2.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const { statePath, readJson, writeJson, updateJson, exists } = require("./plugin-state.cjs");
const { INDEX_FILE, projectKey, storeDir, listFacts } = require("./builtin-memory.cjs");

/** Where backups live. `migrations/` is never swept — see the R37 state contract. */
const BACKUP_DIR = "migrations";
const BACKUP_PREFIX = "builtin-memory-";

/**
 * The standing note migration leaves behind in `MEMORY.md`.
 *
 * This is the mitigation for the one thing a recorded `migrated` cannot cover: Claude
 * Code's built-in memory feature stays active after the migration, so without a note
 * telling it otherwise it would simply start accumulating local facts again — and the
 * primary gate, being terminal, would never re-offer them. The note is what redirects
 * future writes into the graph instead.
 *
 * Detection never reads this text (`listFacts` excludes the index by name), so
 * rewording it cannot break the gate.
 */
const MARKER_NOTE = [
  "# Project memory",
  "",
  "gutt is the store of record for this project's memory. Write new memories to the",
  "gutt knowledge graph over MCP — see the `gutt-claude-code-plugin:memory-capture`",
  "skill — so they are visible to teammates, to your other projects, and to gutt search.",
  "",
  "This local store is a fallback for when the gutt MCP server is unreachable. Its",
  "previous contents were migrated into the graph; anything recorded here in the",
  "meantime should be moved across and removed once MCP is back.",
  "",
].join("\n");

/**
 * Absolute path of a backup file for one project, or null when state is unavailable.
 * @param {string} key
 * @param {number} now
 * @returns {string|null}
 */
function backupPath(key, now) {
  return statePath(BACKUP_DIR, `${BACKUP_PREFIX}${key}-${now}.json`);
}

/**
 * Every backup on disk for one project, newest first.
 * @param {string|null} key
 * @returns {string[]} absolute paths
 */
function listBackups(key) {
  const dir = statePath(BACKUP_DIR);
  if (!key || !dir) {
    return [];
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(`${BACKUP_PREFIX}${key}-`) && n.endsWith(".json"))
    .sort()
    .reverse()
    .map((n) => path.join(dir, n));
}

/** @returns {string|null} the newest backup for a project */
function latestBackup(key) {
  return listBackups(key)[0] || null;
}

/**
 * Capture the whole store — every fact plus the index — into one JSON file under
 * ${CLAUDE_PLUGIN_DATA}.
 *
 * One file rather than a directory copy: it goes through the sanctioned writer, so it
 * is atomic, lands where R37 says state lands, and needs no new filesystem primitive.
 * It outlives the session because `migrations/` is exempt from the SessionStart sweep
 * — a TTL here would be a TTL on the user's ability to undo.
 *
 * @param {{transcript_path?: string, cwd?: string}} payload
 * @param {number} [now]
 * @returns {{path: string, files: string[]}|null} null when there is nothing to back
 *   up, or when plugin state is unavailable
 */
function backupStore(payload, now = Date.now()) {
  const key = projectKey(payload);
  const dir = storeDir(payload);
  const facts = listFacts(dir);
  if (!key || !dir || facts.length === 0) {
    return null;
  }
  const file = backupPath(key, now);
  if (!file) {
    return null;
  }

  const files = {};
  for (const name of facts) {
    try {
      files[name] = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      // A fact we cannot read is a fact we cannot back up, so it must not end up in
      // the backup as though it were captured — leaving it out is what later stops
      // `deleteVerified` from removing it.
    }
  }
  let index = null;
  try {
    index = fs.readFileSync(path.join(dir, INDEX_FILE), "utf8");
  } catch {
    // An index-less store is unusual but harmless; the facts are what matter.
  }

  const written = writeJson(file, {
    projectKey: key,
    storeDir: dir,
    takenAt: new Date(now).toISOString(),
    index,
    files,
    // Populated by recordVerified(). Empty means nothing may be deleted yet.
    verified: {},
  });
  return written ? { path: file, files: Object.keys(files) } : null;
}

/**
 * Record that a fact's episode was confirmed present in the graph.
 *
 * `confirmations` maps a store file name to whatever identifies the episode a search
 * returned (uuid, semantic id — the value is opaque here). Only names captured in the
 * backup are accepted: a name the backup never held is one whose content was never
 * saved, and recording it would authorise deleting a file with no undo.
 *
 * @param {string|null} key
 * @param {Object<string,string>} confirmations
 * @returns {{recorded: string[], rejected: string[]}}
 */
function recordVerified(key, confirmations = {}) {
  const file = latestBackup(key);
  const result = { recorded: [], rejected: [] };
  if (!file) {
    result.rejected = Object.keys(confirmations);
    return result;
  }
  updateJson(file, (current) => {
    if (!current) {
      return current;
    }
    const verified =
      current.verified && typeof current.verified === "object" ? current.verified : {};
    for (const [name, episodeId] of Object.entries(confirmations)) {
      if (Object.prototype.hasOwnProperty.call(current.files || {}, name) && episodeId) {
        verified[name] = String(episodeId);
        result.recorded.push(name);
      } else {
        result.rejected.push(name);
      }
    }
    current.verified = verified;
    return current;
  });
  return result;
}

/**
 * Is `name` a fact file this module may touch inside `dir`?
 *
 * The names reaching `deleteVerified` come from an agent's tool call, so they are
 * checked rather than trusted: no separators, no traversal, must be a `.md`, must not
 * be the index, and the resolved path must still sit directly inside the store.
 *
 * @param {string} dir
 * @param {string} name
 * @returns {boolean}
 */
function isDeletableFact(dir, name) {
  if (typeof name !== "string" || !name.endsWith(".md") || name === INDEX_FILE) {
    return false;
  }
  if (name !== path.basename(name)) {
    return false;
  }
  const resolved = path.resolve(dir, name);
  return path.dirname(resolved) === path.resolve(dir);
}

/**
 * Remove exactly those facts with a recorded verification, then leave the standing
 * note in `MEMORY.md`.
 *
 * Deletes nothing at all when there is no backup, or when nothing has been verified.
 * That is the whole safety property: an unverified write leaves `verified` empty and
 * this becomes a no-op.
 *
 * @param {{transcript_path?: string, cwd?: string}} payload
 * @returns {{deleted: string[], kept: string[], note: boolean, reason?: string}}
 */
function deleteVerified(payload) {
  const key = projectKey(payload);
  const dir = storeDir(payload);
  const outcome = { deleted: [], kept: [], note: false };

  const file = latestBackup(key);
  if (!dir || !file || !exists(dir)) {
    return { ...outcome, kept: listFacts(dir), reason: "no backup on disk — nothing deleted" };
  }
  const backup = readJson(file, null);
  const verified = backup?.verified || {};
  if (!Object.keys(verified).length) {
    return { ...outcome, kept: listFacts(dir), reason: "nothing verified — nothing deleted" };
  }

  for (const name of listFacts(dir)) {
    if (!verified[name] || !isDeletableFact(dir, name)) {
      outcome.kept.push(name);
      continue;
    }
    try {
      fs.unlinkSync(path.join(dir, name));
      outcome.deleted.push(name);
    } catch {
      outcome.kept.push(name);
    }
  }

  // The note goes in only once the facts are actually gone. Written before, it would
  // be the sole survivor of a half-finished migration and would read as a completed
  // one to anybody — including a future session whose recorded decision was lost.
  if (outcome.deleted.length && !outcome.kept.length) {
    try {
      fs.writeFileSync(path.join(dir, INDEX_FILE), MARKER_NOTE);
      outcome.note = true;
    } catch {
      // The facts are safely in the graph either way; a missing note only means
      // Claude Code may keep writing locally, which the next session can fix.
    }
  }
  return outcome;
}

module.exports = {
  BACKUP_DIR,
  BACKUP_PREFIX,
  MARKER_NOTE,
  backupPath,
  listBackups,
  latestBackup,
  backupStore,
  recordVerified,
  isDeletableFact,
  deleteVerified,
};
