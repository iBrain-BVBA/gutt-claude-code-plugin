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
 * It goes at the top of the index rather than replacing it, so a migration that left
 * facts behind still installs the redirect while keeping the pointers to what has not
 * moved yet.
 *
 * Which case is unrecoverable is the opposite of what an earlier version of this comment
 * claimed, and the distinction decides where the note matters most. A **partial**
 * migration leaves the decision unset, so `migrationOffer` speaks again and a later
 * session can finish the job. A **complete** one records `migrated`, which is terminal,
 * and empties the store — so both gates fall silent and nothing ever reaches this code
 * again. A note that fails to land on a complete run is therefore never installed by
 * anyone. That is why `deleteVerified` reports whether the write succeeded and why step
 * 10 of the skill refuses to record `migrated` without it.
 *
 * Detection never reads this text (`listFacts` excludes the index by name), so rewording
 * it cannot break the gate. Rewording it cannot break `stripNote` either, because that
 * matches the sentinels rather than the prose — but only since the sentinels exist; the
 * byte-exact match this replaced would have stacked a second note on the first reword.
 */
const NOTE_START = "<!-- gutt:memory-migrated -->";
const NOTE_END = "<!-- /gutt:memory-migrated -->";

const MARKER_NOTE = [
  NOTE_START,
  "# Project memory",
  "",
  "gutt is the store of record for this project's memory. Write new memories to the",
  "gutt knowledge graph over MCP — see the `gutt-pro:memory-capture`",
  "skill — so they are visible to teammates, to your other projects, and to gutt search.",
  "",
  "This local store is a fallback for when the gutt MCP server is unreachable. Its",
  "migrated contents have been removed; anything still listed below has not been",
  "migrated yet, and anything recorded here in the meantime should be moved across",
  "and removed once MCP is back.",
  NOTE_END,
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
 * Two ways this used to lie, both of which authorised or misreported deletions:
 *
 *   - **It reported success from inside the updater.** `result.recorded` was pushed to
 *     while computing the new state, and `updateJson`'s `{written}` flag was dropped — so
 *     a backup the lock could read but not write back (disk full, permissions, data dir
 *     pulled mid-run) still returned every name as recorded. `delete` then said "nothing
 *     verified", and the only explanation that offers a caller is "the episodes never
 *     landed" — inviting a second write of the whole store.
 *   - **It destroyed the backup when it could not parse it.** Returning `current` was
 *     meant as "leave the file alone", but `updateJson` has no such contract: it writes
 *     whatever the updater returns, and `readJson`'s fallback for a parse *or* read error
 *     is `null`, so `JSON.stringify(null)` replaced the user's only undo with four bytes.
 *     A half-written backup from a killed run still holds every fact's text; that text is
 *     what was being overwritten.
 *
 * So: validate before entering the updater, and treat an unwritten file as nothing
 * recorded. Erring toward `rejected` is always safe — a name not recorded is a file not
 * deleted.
 *
 * @param {string|null} key
 * @param {Object<string,string>} confirmations
 * @returns {{recorded: string[], rejected: string[], reason?: string}}
 */
function recordVerified(key, confirmations = {}) {
  const file = latestBackup(key);
  const names = Object.keys(confirmations);
  if (!file) {
    return {
      recorded: [],
      rejected: names,
      reason: "no backup on disk — nothing may be authorised for deletion without one",
    };
  }

  const backup = readJson(file, null);
  if (!backup || typeof backup !== "object") {
    return {
      recorded: [],
      rejected: names,
      reason: `the backup at ${file} is missing or unreadable, so nothing can be authorised for deletion. It has been left untouched; check it before retrying.`,
    };
  }

  const result = { recorded: [], rejected: [] };
  const verified = backup.verified && typeof backup.verified === "object" ? backup.verified : {};
  for (const [name, episodeId] of Object.entries(confirmations)) {
    if (Object.prototype.hasOwnProperty.call(backup.files || {}, name) && episodeId) {
      verified[name] = String(episodeId);
      result.recorded.push(name);
    } else {
      result.rejected.push(name);
    }
  }

  const { written } = updateJson(file, (current) => {
    // Re-read under the lock so a concurrent writer is not clobbered, but fall back to
    // the copy validated above rather than to null — returning null here is the bug this
    // function's docstring describes.
    const base = current && typeof current === "object" ? current : backup;
    base.verified = { ...(base.verified || {}), ...verified };
    return base;
  });

  if (!written) {
    return {
      recorded: [],
      rejected: names,
      reason: `could not persist confirmations to ${file}, so nothing is authorised for deletion. The episodes themselves may well have landed in the graph — re-run verification rather than re-writing them.`,
    };
  }
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
 * Strip a previously-written standing note out of an index.
 *
 * Matched between its sentinels, not by its bytes. The predecessor compared an exact
 * `MARKER_NOTE` prefix, which failed in two reachable ways — and in both, the unmatched
 * old note carries no pointer, so the keep rule in `rewriteIndex` preserved it as user
 * content and prepended a second note above it, reporting success:
 *
 *   - **CRLF.** The index is read with `split(/\r?\n/)` precisely because stores can be
 *     CRLF, but the prefix test ran on the raw text ahead of that split, so a CRLF index
 *     never matched. Windows plus a second partial run is enough. Hence the normalisation
 *     here rather than at the split.
 *   - **Rewording.** Editing one word of `MARKER_NOTE` between plugin versions orphaned
 *     every note already on disk. The docstring up there actively invited that edit.
 *
 * Only the region between the sentinels is removed, so anything a user added below the
 * note survives. No released version wrote the sentinel-free form, so there is no
 * migration path to keep for it.
 *
 * @param {string} text
 * @returns {string}
 */
function stripNote(text) {
  const normalised = text.replace(/\r\n/g, "\n");
  const start = normalised.indexOf(NOTE_START);
  if (start === -1) {
    return normalised;
  }
  const end = normalised.indexOf(NOTE_END, start);
  if (end === -1) {
    return normalised;
  }
  return normalised.slice(0, start) + normalised.slice(end + NOTE_END.length);
}

/**
 * Rewrite `MEMORY.md` with the standing note on top, dropping the pointers whose target
 * files are gone and preserving everything else.
 *
 * The rewrite used to be gated on the store having emptied, which left a partial
 * migration with an index full of pointers to files it had just deleted. That is not
 * cosmetic: Claude Code loads the index into context every session, so each dead pointer
 * re-injects a one-line description of a note nobody can open, indefinitely.
 *
 * **What is dropped is deliberately narrow, and an earlier version of this function got
 * it wrong.** It kept only lines that *were* resolvable pointers, which silently deleted
 * every heading, paragraph and plain bullet in the file. Real stores on one machine held
 * up to 46 such lines, and one held four facts with no pointer lines at all — where
 * "keep only pointers" reduced the index to the note alone and so reproduced the exact
 * "reads as a completed migration" failure the old gate existed to prevent. A line is
 * therefore removed only when it is a pointer *and* every file it points at is gone.
 * Everything this module did not write, it does not delete.
 *
 * Installing the note unconditionally is safe for the reason the old gate doubted: a note
 * above the surviving content is not "the sole survivor of a half-finished migration",
 * because the content is still there. Detection is untouched either way — `listFacts`
 * excludes the index by name, so the note can never make a non-empty store look empty.
 *
 * Dead pointers are identified from what is on disk rather than from what this run
 * deleted, so pointers orphaned by an *earlier* partial run are repaired too — though
 * only on a run that deletes something, since that is what `deleteVerified` gates this
 * call on.
 *
 * @param {string} dir
 * @returns {boolean} whether the index was written
 */
function rewriteIndex(dir) {
  const target = path.join(dir, INDEX_FILE);
  let existing = "";
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch (err) {
    // A missing index is ordinary: write the note into a fresh one. An index that exists
    // and cannot be read is not — overwriting it would discard content never seen, which
    // is the one outcome worth failing for.
    if (err.code !== "ENOENT") {
      return false;
    }
  }

  // Bare `.md` names only, for the reason `isDeletableFact` refuses a separator: a
  // pointer carrying one does not address a fact in this store, so its target's absence
  // says nothing. Such a line has no bare-name pointer, falls into the keep branch, and
  // is preserved untouched.
  const kept = stripNote(existing)
    .split(/\r?\n/)
    .filter((line) => {
      const names = [...line.matchAll(/]\(([^)/\\]+\.md)\)/g)].map((m) => m[1]);
      // A line pointing at several facts survives while any one of them does, so a
      // shared line can keep one stale pointer — strictly better than dropping the live
      // ones alongside it.
      return names.length === 0 || names.some((name) => exists(path.join(dir, name)));
    });

  const body = kept.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  // The blank line matters: a list butted straight against the closing paragraph is not
  // a list to a strict markdown parser, and this file is read by both.
  const contents = body ? `${MARKER_NOTE}\n${body}\n` : MARKER_NOTE;

  // Temp-then-rename, for the reason `plugin-state.cjs` gives for its own atomic write:
  // "a failed write returns false rather than risk a torn file". `writeFileSync` opens
  // O_TRUNC, so ENOSPC mid-write — or the process dying between truncate and write —
  // leaves the index empty, and by this point the facts it indexed are already unlinked.
  // That combination is unrecoverable in practice: the backup's own copy of the index may
  // be null, and there is no `restore` subcommand to reach it with.
  //
  // `atomicWrite` itself cannot be reused — it refuses paths outside ${CLAUDE_PLUGIN_DATA},
  // correctly, and this is the user's file. Same directory for the temp so the rename
  // stays within one filesystem.
  const temp = `${target}.gutt-tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, contents);
    fs.renameSync(temp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Nothing to clean up, or we cannot — either way the target is untouched, which is
      // the property that matters. Swallowed deliberately: reporting a temp-file leak
      // over the failed write it accompanies would bury the signal the caller needs.
    }
    return false;
  }
}

/**
 * Remove exactly those facts with a recorded verification, then leave the standing
 * note at the top of `MEMORY.md` and drop the pointers whose targets have gone.
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

  // Only once something was actually removed — a run that deleted nothing has no
  // business rewriting the user's index as a side effect.
  //
  // A failed rewrite is not something "the next session can fix", as this comment used to
  // claim. The runs are asymmetric: a partial one leaves the decision unset and does come
  // back, but a run that empties the store gets `migrated` recorded, which is terminal,
  // and `listFacts` then reads the store as empty — so both gates in `migrationOffer` go
  // quiet and nothing reaches this code again. The index keeps its dead pointers and
  // never receives the redirect.
  //
  // Hence the reason string. `note` on its own was a correct signal with no consumer: the
  // skill read only `kept`, so a failed rewrite with `kept` empty was reported to the user
  // as a clean migration. Step 10 now gates `record migrated` on the note as well.
  if (outcome.deleted.length) {
    outcome.note = rewriteIndex(dir);
    if (!outcome.note) {
      outcome.reason =
        `deleted ${outcome.deleted.length} fact(s), but ${INDEX_FILE} could not be ` +
        `rewritten: it still lists deleted facts and carries no redirect to gutt. Report ` +
        `this and do NOT record the migration as complete — recording it is terminal and ` +
        `no later session can repair the index.`;
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
