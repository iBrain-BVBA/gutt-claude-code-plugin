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
 *
 * `--plugin-data=<abs>` supplies the data dir for the same reason (GP-922 follow-up).
 * A skill shells out through the **Bash tool, which inherits neither
 * `CLAUDE_PLUGIN_ROOT` nor `CLAUDE_PLUGIN_DATA`** — only hooks get those. Without the
 * flag every skill-driven run reported `pluginDataAvailable: false` and the skill hit
 * its own "degrade by stopping" branch, so the migration could never complete: the
 * logic was fine and the invocation contract was not. The unit suite missed it by
 * injecting `CLAUDE_PLUGIN_DATA` into the child env, i.e. by supplying what the real
 * caller cannot.
 *
 * Setting the env var here is safe *after* the requires below because
 * `plugin-state.stateRoot()` reads `process.env` live on every call rather than
 * caching it at module load. No implicit fallback is introduced — absent both the
 * flag and the env var, paths still resolve to null and every write stays a no-op.
 */
"use strict";

const LIB = "../../../hooks/lib";
const { projectKey, storeDir, listFacts } = require(`${LIB}/builtin-memory.cjs`);
const store = require(`${LIB}/builtin-memory-store.cjs`);
const config = require(`${LIB}/runtime-config.cjs`);

/** @returns {{payload: Object, rest: string[], pluginData: string|null}} */
function parseArgs(argv) {
  const rest = [];
  let cwd = process.cwd();
  let pluginData = null;
  for (const arg of argv) {
    const cwdFlag = arg.match(/^--cwd=(.*)$/);
    const dataFlag = arg.match(/^--plugin-data=(.*)$/);
    if (cwdFlag) {
      cwd = cwdFlag[1];
    } else if (dataFlag) {
      pluginData = dataFlag[1];
    } else {
      rest.push(arg);
    }
  }
  return { payload: { cwd }, rest, pluginData };
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

// Flags are stripped from the whole argv *before* the subcommand is read, so
// `--cwd=… status` works as well as `status --cwd=…`. Reading argv[2] first made a
// leading flag look like the command and reported it as unknown.
const { payload, rest, pluginData } = parseArgs(process.argv.slice(2));

// An explicitly-passed dir wins over inherited env; an empty value is ignored so
// `--plugin-data=` cannot blank out a working env var. See the header note on why
// this must be settable from argv at all.
if (pluginData) {
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
}

const [command, ...operands] = rest;
const key = projectKey(payload);

try {
  switch (command) {
    case "status": {
      const dir = storeDir(payload);
      const pluginDataAvailable = Boolean(config.configPath());
      emit({
        projectKey: key,
        storeDir: dir,
        facts: listFacts(dir),
        decision: config.readMigrationState(key),
        settled: config.isMigrationSettled(key),
        backup: store.latestBackup(key),
        pluginDataAvailable,
        // `pluginDataAvailable` is computed after the flag has been applied, so a false
        // here has exactly one cause: the flag was missing or empty. The hint says so
        // outright rather than distinguishing two cases — there is no second case. Without
        // it a bare false reads as the platform's fail-safe and the skill stops for good.
        // A dir that is set but unwritable reports true and surfaces at `backup` instead.
        ...(pluginDataAvailable
          ? {}
          : {
              hint:
                "no data dir: pass --plugin-data=<${CLAUDE_PLUGIN_DATA} from the skill " +
                "body>. The Bash tool does not inherit CLAUDE_PLUGIN_DATA from the session.",
            }),
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
