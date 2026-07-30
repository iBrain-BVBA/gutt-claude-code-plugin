#!/usr/bin/env node
/**
 * The `/gutt` config command surface (GP-866, R24).
 *
 * `/gutt config`, `/gutt on`, `/gutt off [minutes|session]`, `/gutt mode auto|hitl`.
 * Everything here is deterministic: the UserPromptSubmit hook hands us the raw
 * prompt text, we parse it, mutate `config.json` through `runtime-config.cjs`, and
 * return the outcome as a string for the hook to inject as `additionalContext`.
 * No model reads the arguments, so a mistyped minute count cannot become a
 * seven-month silence.
 *
 * Why the hook and not a script the model shells out to: only hooks get
 * `CLAUDE_PLUGIN_DATA` in their environment. The Bash tool does not — that is why
 * `skills/migrate-memory/scripts/store-cli.cjs` has to be handed `--plugin-data`
 * by hand — so a hook is the one place that can find `config.json` unaided.
 *
 * Spelling: the plugin is named `gutt-claude-code-plugin`, so commands namespace as
 * `/gutt-claude-code-plugin:<name>` with the bare `/<name>` also resolving. The
 * ticket's `/gutt:off` would need the plugin renamed, which would move
 * `${CLAUDE_PLUGIN_DATA}` and orphan every user's state — so the surface is one
 * `/gutt` command with subcommands, which is also the spelling `runtime-config.cjs`
 * already documented for it. All three spellings are parsed; see `parseCommand`.
 *
 * Register: plain factual sentences. This text reaches the model as injected
 * context, and out-of-band system-command framing is what trips Claude's
 * prompt-injection defenses and gets the text surfaced to the user as suspicious
 * instead of consumed (R23, GP-868). Note the deliberate asymmetry with every other
 * injection in this plugin: here the user *should* end up seeing the content. That
 * is arranged by the relay instruction in `gutt-core/commands/gutt.md`, which is
 * user-authored prompt text, not by telling the model what to do from inside the
 * injected context.
 */
"use strict";

const config = require("./runtime-config.cjs");

/** Must equal `name` in `gutt-core/.claude-plugin/plugin.json`; a test asserts it. */
const PLUGIN_PREFIX = "gutt-claude-code-plugin";

/** The command stem, i.e. what a user types after the slash. */
const COMMAND = "gutt";

const SUBCOMMANDS = ["config", "on", "off", "mode"];

/**
 * Bounds on `/gutt off <minutes>`: whole minutes, 1 minute to 7 days.
 *
 * Rejected rather than clamped. Clamping silently does something other than what
 * was typed, and the upper bound is the point: without it a fat-fingered
 * `/gutt off 300000` silences recall for seven months and the user has no reason
 * to suspect it.
 */
const MIN_MINUTES = 1;
const MAX_MINUTES = 10080;

/** The forms, quoted back on anything unrecognised so the reply is actionable. */
const FORMS =
  "/gutt config, /gutt on, /gutt off, /gutt off <minutes>, /gutt off session, " +
  "/gutt mode auto, /gutt mode hitl";

/**
 * `YYYY-MM-DD HH:MM` in local time. Hand-rolled rather than `toLocaleString`,
 * which varies by machine locale and would make the rendered text untestable.
 * @param {number} ms
 * @returns {string}
 */
function localStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Enough of a session id to recognise, not enough to fill a line.
 * @param {string} id
 * @returns {string}
 */
function shortId(id) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/**
 * @param {number} n
 * @param {string} word
 * @returns {string}
 */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Parse a raw prompt into a config command, or `null` when it is not one.
 *
 * Three accepted spellings, all anchored at the very start of the prompt:
 *
 *   /gutt off 30                              typed by hand
 *   /gutt:off 30                              the ticket's spelling
 *   /gutt-claude-code-plugin:gutt off 30      what the `/` menu inserts
 *
 * The third is the one that matters most and the easiest to forget: the
 * autocompleted form is the default path, and a parser that missed it would make
 * the common case a silent no-op where the model improvises about config it never
 * read. Verified against a real session log, where the prompt field carries the
 * raw typed text including arguments.
 *
 * `null` means "not addressed to us" and the hook stays silent. A recognised
 * command with a bad tail is *not* null — it returns a parse the caller reports on.
 * That is deliberate: `/gutt off 30 and fix the tests` must not mutate, and telling
 * the user so beats silence. The cost is that prose genuinely beginning with
 * "/gutt " draws a "did not recognise" note alongside its answer; that is rare
 * enough, and loud beats quiet in both directions.
 *
 * @param {unknown} raw
 * @returns {{sub: string|null, arg: string|null, typed: string}|null}
 */
function parseCommand(raw) {
  const typed = typeof raw === "string" ? raw.trim() : "";
  // The whole-prompt fast path. This runs on every prompt on a 50ms budget (R25),
  // so the negative case must cost one string comparison and no file IO. The
  // prefix covers all three spellings; `/gutt-claude-code-plugin:memory-search`
  // also passes it and is rejected below.
  if (!typed.toLowerCase().startsWith(`/${COMMAND}`)) {
    return null;
  }

  const words = typed.split(/\s+/);
  const head = words[0].toLowerCase();
  const namespaced = `/${PLUGIN_PREFIX}:`;
  const stem = head.startsWith(namespaced) ? head.slice(namespaced.length) : head.slice(1);

  // `gutt` on its own, or `gutt:<sub>`. Anything else — `guttoff`,
  // `memory-search` — is another command or not a command at all.
  let inline = null;
  if (stem !== COMMAND) {
    if (!stem.startsWith(`${COMMAND}:`)) {
      return null;
    }
    inline = stem.slice(COMMAND.length + 1);
  }

  const rest = words.slice(1);
  const parts = inline ? [inline, ...rest] : rest;
  // Bare `/gutt` reports the configuration: the harmless subcommand is the right
  // default for a command whose other forms all change something.
  const sub = (parts[0] || "config").toLowerCase();
  const arg = parts[1] ?? null;
  // A third word is always wrong — no form takes two arguments — so it is carried
  // through as an unrecognised parse rather than ignored.
  const extra = parts.length > 2;

  if (!SUBCOMMANDS.includes(sub) || extra) {
    return { sub: null, arg: null, typed };
  }
  return { sub, arg, typed };
}

// ---------------------------------------------------------------------------
// Rendering `/gutt config`
// ---------------------------------------------------------------------------

/**
 * @param {Object|null} raw - the stored config, not the defaults-merged view
 * @returns {string}
 */
function enabledLine(raw) {
  const stored = raw?.enabled;
  if (stored === false) {
    return "enabled: false — recall is off; /gutt on turns it back on";
  }
  if (stored === undefined || stored === true) {
    return "enabled: true — memory recall pointers are allowed";
  }
  // Read as `true`, because `isSuppressed` compares with a strict `=== false`.
  // Printed raw so a hand-edit that does nothing is visible rather than assumed
  // to be working.
  return `enabled: ${JSON.stringify(stored)} — not a value this version understands, so it reads as true`;
}

/**
 * @param {Object|null} raw
 * @returns {string}
 */
function modeLine(raw) {
  const stored = raw?.mode;
  const mode = stored === undefined ? config.DEFAULTS.mode : stored;
  if (!config.MODES.includes(mode)) {
    return (
      `mode: ${JSON.stringify(stored)} — not a mode this version knows; ` +
      `the known modes are ${config.MODES.join(" and ")}`
    );
  }
  // No behavioural claim: the key is written and read back, and nothing consumes
  // it until the capture work lands.
  return `mode: ${mode} — capture mode; no behaviour reads this key yet`;
}

/**
 * @param {Object|null} raw
 * @param {string|null} sessionId
 * @param {number} now
 * @returns {string}
 */
function snoozeLine(raw, sessionId, now) {
  const until = raw?.snoozeUntil ?? null;
  const owner = raw?.snoozeSessionId ?? null;
  if (!until && !owner) {
    return "snooze: none";
  }
  if (owner && owner !== sessionId) {
    return `snooze: set by another session (${shortId(owner)}), so it is not in force here`;
  }
  if (!until) {
    return "snooze: in force for the rest of this session — it clears when the session ends";
  }
  const ms = Date.parse(until);
  if (!Number.isFinite(ms)) {
    return `snooze: an unreadable deadline (${JSON.stringify(until)}), so it is treated as lapsed`;
  }
  if (ms <= now) {
    return `snooze: lapsed at ${localStamp(ms)}, so it is no longer in force`;
  }
  const left = plural(Math.ceil((ms - now) / 60000), "minute");
  return `snooze: in force for ${left} more, until ${localStamp(ms)} — it survives a restart`;
}

/**
 * The `/gutt config` block: stored values, then the state they add up to.
 *
 * `projects` and `migrationsVersion` are deliberately absent. They live in the same
 * file but are not preferences — one records a per-project migration answer, the
 * other a schema version — and listing them would bury the four keys a user can act
 * on.
 *
 * @param {string|null} sessionId
 * @param {number} now
 * @returns {string}
 */
function renderConfig(sessionId, now) {
  const file = config.configPath();
  if (!file) {
    return (
      "gutt configuration is unavailable: this session has no plugin data directory, so " +
      "nothing can be read or written. The built-in defaults are in force — recall enabled, " +
      "capture mode auto, no snooze."
    );
  }
  const raw = config.readRawConfig();
  const suppressed = config.isSuppressed(sessionId, now);
  return [
    `gutt configuration, read from ${file}:`,
    `  ${enabledLine(raw)}`,
    `  ${modeLine(raw)}`,
    `  ${snoozeLine(raw, sessionId, now)}`,
    `  in force right now: ${
      suppressed
        ? "suppressed, so no memory recall pointer will be injected"
        : "active, so memory recall pointers can be injected"
    }`,
    "Turning recall off does not silence the end-of-turn capture prompt; that is what " +
      "capture mode will govern.",
    `Change it with ${FORMS}.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * What every mutator says when the write did not land.
 *
 * Reached whenever a setter returns false having intended to write — in practice
 * a missing plugin data directory, where every write in `plugin-state.cjs` is a
 * silent no-op. Reporting success there would be the quietest bug this surface
 * could ship, so each mutator checks the boolean it gets back.
 * @returns {string}
 */
function writeFailed() {
  return (
    "gutt could not save that: the plugin data directory is unavailable, so nothing was " +
    "written and nothing changed."
  );
}

/**
 * `/gutt off [minutes|session]`.
 * @param {string|null} arg
 * @param {string|null} sessionId
 * @param {number} now
 * @returns {string}
 */
function runOff(arg, sessionId, now) {
  // No argument: a durable off, which is `enabled: false`. It cannot be a snooze —
  // an unbounded snooze is not representable, see `isSuppressed`.
  if (arg === null) {
    return config.setEnabled(false)
      ? "gutt memory recall is off until /gutt on turns it back on. This survives restarts."
      : writeFailed();
  }

  if (arg.toLowerCase() === "session") {
    // Refuse rather than write `snoozeSessionId: "unknown"`, which no real session
    // would match and which SessionEnd could never reclaim — a snooze that outlives
    // every session and is invisible in `/gutt config`.
    if (!sessionId || sessionId === "unknown") {
      return (
        "gutt could not scope a snooze to this session: no session id reached the hook. " +
        "Nothing changed — /gutt off <minutes> or /gutt off both work here."
      );
    }
    return config.setSnooze({ sessionId })
      ? "gutt memory recall is off for the rest of this session. It comes back on its own in " +
          "the next session; /gutt on restores it now."
      : writeFailed();
  }

  // `Number()` on its own accepts "30.5", "0x1e" and " 30 "; the shape test first
  // is what keeps the accepted set to plain whole minutes.
  const minutes = /^\d+$/.test(arg) ? Number(arg) : NaN;
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    return (
      `gutt did not change anything: "${arg}" is not a number of minutes between ` +
      `${MIN_MINUTES} and ${MAX_MINUTES}. Use /gutt off <minutes>, /gutt off session, or ` +
      "/gutt off for no deadline."
    );
  }
  const untilMs = now + minutes * 60000;
  return config.setSnooze({ untilMs })
    ? `gutt memory recall is off for the next ${plural(minutes, "minute")}, until ` +
        `${localStamp(untilMs)}. It resumes on its own after that; /gutt on restores it now.`
    : writeFailed();
}

/**
 * `/gutt on`.
 *
 * The pre-read is what lets the reply be honest: `restore()` returns false both
 * when there was nothing to clear and when the write failed, and those deserve
 * different sentences.
 * @param {string|null} sessionId
 * @param {number} now
 * @returns {string}
 */
function runOn(sessionId, now) {
  const raw = config.readRawConfig();
  const wasOff = raw?.enabled === false;
  const snooze = describeClearedSnooze(raw, now);
  if (!wasOff && !snooze) {
    return "gutt memory recall was already on; nothing changed.";
  }
  if (!config.restore()) {
    return writeFailed();
  }
  const cleared = [wasOff ? "the off set by /gutt off" : null, snooze].filter(Boolean);
  return `gutt memory recall is back on. Cleared ${cleared.join(" and ")}.`;
}

/**
 * A short noun phrase for the snooze `/gutt on` is about to clear, or null when
 * there is none. Short on purpose — the full state belongs in `/gutt config`, and
 * folding `snoozeLine`'s dashed clauses into this sentence read badly.
 * @param {Object|null} raw
 * @param {number} now
 * @returns {string|null}
 */
function describeClearedSnooze(raw, now) {
  const until = raw?.snoozeUntil ?? null;
  const owner = raw?.snoozeSessionId ?? null;
  if (!until && !owner) {
    return null;
  }
  if (owner) {
    // Cleared even when another session set it: `config.json` is machine-global,
    // so `/gutt on` is a machine-global statement. Named rather than done quietly,
    // because the user did not set this one.
    return `a session-scoped snooze (${shortId(owner)})`;
  }
  const ms = Date.parse(until);
  if (!Number.isFinite(ms) || ms <= now) {
    return "a lapsed snooze";
  }
  return `a snooze that had ${plural(Math.ceil((ms - now) / 60000), "minute")} left`;
}

/**
 * `/gutt mode auto|hitl`.
 * @param {string|null} arg
 * @returns {string}
 */
function runMode(arg) {
  const next = arg === null ? null : arg.toLowerCase();
  if (!next || !config.MODES.includes(next)) {
    return (
      `gutt did not change the capture mode: the modes are ${config.MODES.join(" and ")}` +
      `${arg === null ? "" : `, not "${arg}"`}. Use /gutt mode auto or /gutt mode hitl.`
    );
  }
  const was = config.readConfig().mode;
  if (!config.setMode(next)) {
    return writeFailed();
  }
  const change = was === next ? `is ${next}, unchanged` : `is now ${next}, was ${was}`;
  return `gutt capture mode ${change}. No behaviour reads this key yet.`;
}

/**
 * Run the config command in `rawPrompt`, if there is one.
 *
 * @param {unknown} rawPrompt - the prompt exactly as submitted, untruncated
 * @param {string|null} [sessionId]
 * @param {number} [now]
 * @returns {string|null} text for the hook to inject, or null when the prompt is
 *   not a config command and the hook should stay silent
 */
function configCommandResult(rawPrompt, sessionId = null, now = Date.now()) {
  const parsed = parseCommand(rawPrompt);
  if (!parsed) {
    return null;
  }
  switch (parsed.sub) {
    case "config":
      // `config` takes no argument, so one is a typo worth naming rather than
      // ignoring — the user may think they changed something.
      return parsed.arg === null
        ? renderConfig(sessionId, now)
        : `gutt did not recognise "${parsed.typed}" — /gutt config takes no argument. ` +
            `The forms are: ${FORMS}. Nothing was changed.`;
    case "on":
      return runOn(sessionId, now);
    case "off":
      return runOff(parsed.arg, sessionId, now);
    case "mode":
      return runMode(parsed.arg);
    default:
      return (
        `gutt did not recognise "${parsed.typed}". The forms are: ${FORMS}. ` +
        "Nothing was changed."
      );
  }
}

module.exports = {
  PLUGIN_PREFIX,
  COMMAND,
  SUBCOMMANDS,
  MIN_MINUTES,
  MAX_MINUTES,
  parseCommand,
  configCommandResult,
};
