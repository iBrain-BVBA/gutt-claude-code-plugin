#!/usr/bin/env node
/**
 * Claude Code's built-in memory store — locating it and deciding whether it holds
 * anything worth migrating into gutt (GP-922, S3.8).
 *
 * Claude Code keeps a file-based memory store **per project**: an index plus one
 * `.md` per fact, under its own project directory. Where that store is non-empty it
 * is organizational knowledge sitting outside the graph — invisible to teammates,
 * to every other project on the machine, and to gutt search. This module is the
 * detection half of the offer to move it; `skills/migrate-memory` is the other half
 * and owns everything that touches MCP or deletes a file.
 *
 * Read-only by construction. Nothing here writes, renames, or removes anything —
 * which is also why it is not an allowlisted writer in
 * `tests/check-state-location.cjs`. The recorded decision is the only thing this
 * feature persists, and that goes through `runtime-config.cjs` like every other
 * durable key.
 *
 * It also owns the offer text and the two gates in front of it (`migrationOffer`).
 * That is policy rather than routing, so it cannot live in the hook: the
 * thin-router cap in `hook-architecture.test.cjs` is set just above the largest
 * surviving router precisely to push work like this out, the same way the R37 sweep
 * left `session-start.cjs` for `session-sweep.cjs` in GP-895.
 *
 * Latency (R25): SessionStart is the synchronous ≤50ms path, so detection is one
 * `readdir` and a filename filter. No frontmatter parsing, no file-content reads,
 * no walk of the projects root, no MCP.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { isMigrationSettled, isSnoozed } = require("./runtime-config.cjs");

/**
 * The store's index file. Claude Code keeps one-line pointers here and one `.md`
 * per fact alongside it, so this name is **never** a fact — which is what makes the
 * "is there anything to migrate" question answerable from filenames alone.
 */
const INDEX_FILE = "MEMORY.md";

/**
 * Root holding Claude Code's per-project directories. `CLAUDE_CONFIG_DIR` relocates
 * `~/.claude` wholesale, so it is honoured rather than assumed away.
 * @returns {string}
 */
function projectsRoot() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

/**
 * Claude Code's project-directory encoding: the absolute cwd with every `/`, `.`
 * and `_` flattened to `-`, e.g. `/Users/me/projects/app` → `-Users-me-projects-app`.
 *
 * Reverse-engineered from the directories on disk, not from a published contract,
 * which is exactly why it is the **fallback**. `storeDir()` prefers deriving the
 * path from `transcript_path`, where no encoding guess is involved at all. Keep this
 * for payloads that carry `cwd` and nothing else.
 *
 * Note the encoding is lossy — `/a/b-c` and `/a/b/c` both encode to `-a-b-c`. That
 * is inherited, not introduced: two such projects already *share* one built-in store,
 * so treating them as one store is correct rather than a collision to defend against.
 *
 * @param {string} cwd
 * @returns {string}
 */
function encodeProjectDir(cwd) {
  return String(cwd).replace(/[/._]/g, "-");
}

/**
 * Absolute path with symlinks resolved, falling back to plain resolution when the
 * directory does not exist (or cannot be read) — a path that is not there yet has no
 * real path, and guessing beats throwing on a hook path that must never fail.
 * @param {string} p
 * @returns {string}
 */
function realPath(p) {
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * The project directory for a hook payload, or null when the payload identifies no
 * project.
 *
 * `transcript_path` is preferred and is the reason this is reliable: the transcript
 * is written as `<projectDir>/<session-id>.jsonl`, so its parent *is* the project
 * directory — the same directory holding `memory/`. No encoding is reproduced, so
 * nothing here breaks if Claude Code changes how it encodes a cwd.
 *
 * The cwd fallback resolves symlinks first, because Claude Code encodes the **real**
 * path. On macOS this is the common case rather than an exotic one: `/tmp` and
 * `/var` are both symlinks into `/private`, so a session in `/var/folders/…/x`
 * gets a project directory named `-private-var-folders-…-x`. Encoding the
 * unresolved path yields a directory that does not exist and a store that is never
 * found — caught by the e2e, which planted a store one level away from where the
 * hook looked and saw no offer at all.
 *
 * @param {{transcript_path?: string, cwd?: string}} payload
 * @returns {string|null}
 */
function projectDir(payload = {}) {
  const transcript = payload.transcript_path;
  if (typeof transcript === "string" && transcript.trim()) {
    return path.dirname(path.resolve(transcript));
  }
  const cwd = payload.cwd;
  if (typeof cwd === "string" && cwd.trim()) {
    return path.join(projectsRoot(), encodeProjectDir(realPath(cwd)));
  }
  return null;
}

/**
 * Stable key for the *store* a payload belongs to — the encoded project-directory
 * name. This is what the per-project decision in `config.json` is keyed on.
 *
 * Keyed on the store rather than on the cwd deliberately. The decision being
 * recorded is "this store has been dealt with", and where two cwds share a store
 * (see `encodeProjectDir`) they should share the answer too.
 *
 * @param {{transcript_path?: string, cwd?: string}} payload
 * @returns {string|null}
 */
function projectKey(payload = {}) {
  const dir = projectDir(payload);
  return dir ? path.basename(dir) : null;
}

/**
 * Path to the built-in memory store for a payload, or null when unidentifiable.
 * @param {{transcript_path?: string, cwd?: string}} payload
 * @returns {string|null}
 */
function storeDir(payload = {}) {
  const dir = projectDir(payload);
  return dir ? path.join(dir, "memory") : null;
}

/**
 * The fact files in a store: every `.md` that is not the index.
 *
 * Excluding the index by name is the whole of the marker exclusion, and it is what
 * keeps a completed migration from re-offering itself forever. Migration ends by
 * writing a standing note into `MEMORY.md` — "gutt is the store of record; local
 * memory is the fallback for when MCP is unreachable" — and that note *is* content.
 * A naive "does this directory hold any `.md`" test is therefore true for the rest
 * of the project's life, and the offer would fire every session forever.
 *
 * Structural rather than content-matched on purpose: it costs no file read (R25), and
 * it cannot rot when the note is reworded. The index is not a fact under any
 * wording, so there is nothing here for a prose change to invalidate.
 *
 * This is the second of two independent gates. The recorded per-project decision is
 * the primary one; this one exists because that record is machine-local while the
 * store is not — a project whose decision was lost (new machine, cleared plugin
 * data) must not re-offer a store holding nothing but the note.
 *
 * @param {string|null} dir
 * @returns {string[]} file names, empty when the store is absent or unreadable
 */
function listFacts(dir) {
  if (!dir) {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // No store, or one we cannot read. Either way there is nothing to offer, and
    // failing toward silence is right: an offer to migrate a store we cannot even
    // list would be an offer we cannot honour.
    return [];
  }
  return entries
    .filter((e) => !e.isDirectory() && e.name !== INDEX_FILE && e.name.endsWith(".md"))
    .map((e) => e.name);
}

/**
 * Is there a built-in store for this payload holding at least one fact?
 *
 * The detection half of AC1: one `readdir`, one filename filter, no MCP.
 *
 * @param {{transcript_path?: string, cwd?: string}} payload
 * @returns {boolean}
 */
function hasMigratableStore(payload = {}) {
  return listFacts(storeDir(payload)).length > 0;
}

// ---------------------------------------------------------------------------
// The offer (delivered on SessionStart's additionalContext)
// ---------------------------------------------------------------------------

/**
 * The skill that owns the migration. Namespaced because a bare stem is not invocable
 * at runtime — `skill_listing` shows `<plugin>:<stem>` — and asserted to resolve by
 * `hook-architecture.test.cjs`, which checks both that the stem is a real skill
 * directory and that the prefix is this plugin's declared name.
 */
const MIGRATE_SKILL = "gutt-claude-code-plugin:migrate-memory";

/**
 * The offer text.
 *
 * Why SessionStart and not a fifth row in the GP-864 UserPromptSubmit matrix, which
 * is where S3.8 originally put it: that matrix emits **at most one**
 * `additionalContext`, so the offer would have contended for the first prompt of a
 * new session against the recall pointer — the row carrying the plugin's core value,
 * which fires every session. SessionStart has its own context channel, so there is no
 * contested slot, no fifth row, and no one-shot flag that must be held rather than
 * consumed to avoid being burned every session by the row that outranks it. The
 * trigger matrix and `advanceTurn()` are untouched by this story.
 *
 * `additionalContext` rather than `initialUserMessage`: the latter applies only in
 * non-interactive `-p` mode, so it cannot carry an interactive offer.
 *
 * Phrasing follows R23/GP-868 — a factual statement, no out-of-band command framing.
 * The scoping sentence at the end is load-bearing: without it this reads as "migrate
 * now", and a session opened to ask one quick question would get a migration run
 * instead of an answer. The offer is housekeeping and can wait for a yes.
 *
 * @param {number} count - how many local facts are waiting
 * @returns {string}
 */
function offerContext(count) {
  const notes = count === 1 ? "1 note" : `${count} notes`;
  return (
    `Claude Code has been keeping its own file-based memory store for this project, ` +
    `separate from gutt, and it currently holds ${notes}. Nothing in it is visible to ` +
    `teammates, to your other projects, or to gutt search. The \`${MIGRATE_SKILL}\` ` +
    `skill moves it into the graph and asks before it writes or deletes anything. Offer ` +
    `this to the user in one line at the end of your next reply, and run the skill only ` +
    `if they accept — this is housekeeping, so do not interrupt whatever they actually ` +
    `asked for. If they decline, the answer is recorded and the offer is not raised again.`
  );
}

/**
 * The offer decision: the context string, or null to stay silent.
 *
 * Two gates, both required, neither redundant. `isMigrationSettled` is the primary one
 * but is machine-local, so it cannot speak for a store carried to a new machine;
 * `listFacts` excludes the index by name, so a store holding nothing but the
 * post-migration note reads as empty even where the record was lost.
 *
 * @param {{transcript_path?: string, cwd?: string}} payload
 * @param {string} [sessionId]
 * @returns {string|null}
 */
function migrationOffer(payload = {}, sessionId = null) {
  // A snoozed plugin says nothing at all — the same contract the UserPromptSubmit
  // router honours on its row 1. (`enabled` is GP-866's to enforce across the surface.)
  if (isSnoozed(sessionId)) {
    return null;
  }
  if (isMigrationSettled(projectKey(payload))) {
    return null;
  }
  const count = listFacts(storeDir(payload)).length;
  return count > 0 ? offerContext(count) : null;
}

module.exports = {
  INDEX_FILE,
  MIGRATE_SKILL,
  projectsRoot,
  encodeProjectDir,
  realPath,
  projectDir,
  projectKey,
  storeDir,
  listFacts,
  hasMigratableStore,
  offerContext,
  migrationOffer,
};
