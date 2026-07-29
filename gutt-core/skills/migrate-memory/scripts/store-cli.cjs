#!/usr/bin/env node
/**
 * CLI the `migrate-memory` skill drives (GP-922). Every subcommand prints one JSON
 * object on stdout and exits 0, so the agent parses a result instead of scraping prose.
 *
 * Thin by design: all the logic lives in `shared/builtin-memory{,-store}.cjs`, which
 * is where `tests/check-state-location.cjs` can see the one module allowed to delete
 * outside the data dir. This file only parses argv.
 *
 *   status                     what is in the store, and what has been decided
 *   backup                     capture the store under ${CLAUDE_PLUGIN_DATA}
 *   verified <file>=<id> ...    record episodes a search actually returned
 *   delete                     remove only verified facts, then leave the note
 *   record <migrated|declined|later>   persist the per-project decision
 *
 * `status`/`backup`/`delete` locate the store from `--cwd` (default `process.cwd()`),
 * since a skill runs in the project rather than being handed a hook payload.
 */
"use strict";

const LIB = "../../../hooks/lib";
const { projectKey, storeDir, listFacts } = require(`${LIB}/builtin-memory.cjs`);
const store = require(`${LIB}/builtin-memory-store.cjs`);
const config = require(`${LIB}/runtime-config.cjs`);

/** @returns {{payload: Object, rest: string[]}} */
function parseArgs(argv) {
  const rest = [];
  let cwd = process.cwd();
  for (const arg of argv) {
    const flag = arg.match(/^--cwd=(.*)$/);
    if (flag) {
      cwd = flag[1];
    } else {
      rest.push(arg);
    }
  }
  return { payload: { cwd }, rest };
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

// Flags are stripped from the whole argv *before* the subcommand is read, so
// `--cwd=… status` works as well as `status --cwd=…`. Reading argv[2] first made a
// leading flag look like the command and reported it as unknown.
const { payload, rest } = parseArgs(process.argv.slice(2));
const [command, ...operands] = rest;
const key = projectKey(payload);

try {
  switch (command) {
    case "status": {
      const dir = storeDir(payload);
      emit({
        projectKey: key,
        storeDir: dir,
        facts: listFacts(dir),
        decision: config.readMigrationState(key),
        settled: config.isMigrationSettled(key),
        backup: store.latestBackup(key),
        pluginDataAvailable: Boolean(config.configPath()),
      });
      break;
    }
    case "backup": {
      const result = store.backupStore(payload);
      emit(
        result
          ? { ok: true, ...result }
          : { ok: false, reason: "nothing to back up, or plugin state unavailable" }
      );
      break;
    }
    case "verified": {
      // `<file>=<episode-id>` pairs. Split on the first `=` only: an episode id may
      // contain one, a file name may not.
      const confirmations = {};
      for (const pair of operands) {
        const at = pair.indexOf("=");
        if (at > 0) {
          confirmations[pair.slice(0, at)] = pair.slice(at + 1);
        }
      }
      emit({ ...store.recordVerified(key, confirmations) });
      break;
    }
    case "delete": {
      emit(store.deleteVerified(payload));
      break;
    }
    case "record": {
      const status = operands[0];
      emit({
        ok: config.setMigrationState(key, status),
        projectKey: key,
        decision: config.readMigrationState(key),
      });
      break;
    }
    default:
      emit({
        error: `unknown command ${command ? `"${command}"` : "(none given)"}`,
        commands: ["status", "backup", "verified", "delete", "record"],
      });
  }
} catch (err) {
  // Never a non-zero exit: the skill reads the JSON either way, and a stack trace on
  // stderr with a dead exit code is the least useful thing this could hand back.
  emit({ error: err?.message || String(err) });
}
process.exitCode = 0;
