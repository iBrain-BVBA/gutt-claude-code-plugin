#!/usr/bin/env node
/**
 * The `/gutt-pro:*` config command surface (GP-866, GP-931, R24).
 *
 * `/gutt-pro:config`, `/gutt-pro:on`, `/gutt-pro:off [minutes|session]`,
 * `/gutt-pro:disable`, `/gutt-pro:mode auto|hitl`. Everything here is
 * deterministic: the UserPromptSubmit hook hands us the raw prompt text, we parse
 * it, mutate `config.json` through `runtime-config.cjs`, and return the outcome as
 * a string for the hook to inject as `additionalContext`. No model reads the
 * arguments, so a mistyped minute count cannot become a seven-month silence.
 *
 * Why the hook and not a script the model shells out to: only hooks get
 * `CLAUDE_PLUGIN_DATA` in their environment. The Bash tool does not — that is why
 * `skills/migrate-memory/scripts/store-cli.cjs` has to be handed `--plugin-data`
 * by hand — so a hook is the one place that can find `config.json` unaided.
 *
 * Spelling (GP-931 reversed GP-866 here). GP-866 shipped one `/gutt` command with
 * subcommands, because the sibling spelling needs the plugin's `name` to be `gutt`
 * and renaming it moves `${CLAUDE_PLUGIN_DATA}` and orphans every user's state.
 * GP-931 renamed the plugin to `gutt-pro` and accepted that cost knowingly (its
 * D4), so the surface is now one command per verb. The 3.0 spellings — `/gutt …`,
 * `/gutt:<sub>`, and the autocompleted `/gutt-claude-code-plugin:gutt <sub>` — are
 * **not** aliases and not deprecation warnings; `parseCommand` returns null for all
 * three, which is why they are written out here rather than renamed away. A hard cut
 * is the safer failure because GP-931's D3 also reversed what `off` means: an alias
 * would silently do something other than what the user typed, where inert text does
 * nothing at all.
 *
 * `off` is the session-scoped verb and `disable` the durable one (D3), the reverse
 * of 3.0. The cheap, reversible action is what the short word gets; turning recall
 * off for good has to be typed on purpose. `renderConfig` therefore names the
 * *scope* of whatever is in force, because the reversal is invisible otherwise.
 *
 * Register: plain factual sentences. This text reaches the model as injected
 * context, and out-of-band system-command framing is what trips Claude's
 * prompt-injection defenses and gets the text surfaced to the user as suspicious
 * instead of consumed (R23, GP-868). Note the deliberate asymmetry with every other
 * injection in this plugin: here the user *should* end up seeing the content. That
 * is arranged by the relay instruction in each `gutt-core/commands/<verb>.md`,
 * which is user-authored prompt text, not by telling the model what to do from
 * inside the injected context.
 */
"use strict";

const config = require("./runtime-config.cjs");

/** Must equal `name` in `gutt-core/.claude-plugin/plugin.json`; a test asserts it. */
const PLUGIN_PREFIX = "gutt-pro";

/**
 * One command per verb (GP-931 D1). There is no stem: `/gutt-pro:config off` is not
 * a form, `/gutt-pro:off` is. Each name here needs a matching
 * `gutt-core/commands/<verb>.md`, or the typed command expands to nothing and the
 * outcome this module injects has no reply to sit alongside.
 */
const VERBS = ["config", "on", "off", "disable", "mode"];

/**
 * Bounds on `/gutt-pro:off <minutes>`: whole minutes, 1 minute to 7 days.
 *
 * Rejected rather than clamped. Clamping silently does something other than what
 * was typed, and the upper bound is the point: without it a fat-fingered
 * `/gutt-pro:off 300000` silences recall for seven months and the user has no
 * reason to suspect it.
 */
const MIN_MINUTES = 1;
const MAX_MINUTES = 10080;

/** The forms, quoted back on anything unrecognised so the reply is actionable. */
const FORMS =
  "/gutt-pro:config, /gutt-pro:on, /gutt-pro:off, /gutt-pro:off <minutes>, " +
  "/gutt-pro:off session, /gutt-pro:disable, /gutt-pro:mode auto, /gutt-pro:mode hitl";

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
 *
 * Coerced rather than assumed to be a string: `config.json` is hand-editable, so
 * `snoozeSessionId` can arrive as a number or a boolean. Every caller is on the
 * rendering path, where throwing would turn `/gutt-pro:config` — the one command
 * whose job is to explain a broken config — into a hard failure that explains
 * nothing.
 *
 * @param {unknown} id
 * @returns {string}
 */
function shortId(id) {
  const text = typeof id === "string" ? id : JSON.stringify(id);
  return text.length > 8 ? `${text.slice(0, 8)}…` : text;
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
 * Two accepted spellings, both anchored at the very start of the prompt:
 *
 *   /gutt-pro:off 30      what the `/` menu inserts, and the documented form
 *   /off 30               the bare form, when the platform resolves it to us
 *
 * The namespaced form is the one that matters and the easiest to forget: the
 * autocompleted form is the default path, and a parser that missed it would make
 * the common case a silent no-op where the model improvises about config it never
 * read. Verified against a real session log, where the prompt field carries the raw
 * typed text including arguments.
 *
 * The bare form is accepted because a plugin command with no name collision also
 * resolves unprefixed. Whether every verb here actually resolves that way — and
 * whether bare `/config` reaches us at all or is swallowed by Claude Code's own
 * `/config` — is recorded from a real run in `docs/plugin-platform-reference.md`
 * §8. Parsing it costs nothing when it never arrives; not parsing it would strand
 * the shortest form a user will try.
 *
 * `null` means "not addressed to us" and the hook stays silent. That covers every
 * legacy spelling (GP-931 D2): `/gutt off`, `/gutt:off` and
 * `/gutt-claude-code-plugin:gutt off` are ordinary prompt text now, because their
 * head word is not one of `VERBS`.
 *
 * A recognised verb with a bad tail is *not* null — it returns a parse the caller
 * reports on. That is deliberate: `/gutt-pro:off 30 and fix the tests` must not
 * mutate, and telling the user so beats silence. The cost is that prose genuinely
 * beginning with a slashed verb draws a "did not recognise" note alongside its
 * answer; that is rare enough, and loud beats quiet in both directions.
 *
 * @param {unknown} raw
 * @returns {{verb: string|null, arg: string|null, typed: string}|null}
 */
function parseCommand(raw) {
  const typed = typeof raw === "string" ? raw.trim() : "";
  // The whole-prompt fast path. This runs on every prompt on a 50ms budget (R25),
  // so the negative case must cost one character comparison and no file IO. Every
  // form we accept begins with a slash; ordinary prose does not.
  if (typed.charCodeAt(0) !== 47 /* "/" */) {
    return null;
  }

  const words = typed.split(/\s+/);
  const head = words[0].toLowerCase();
  const namespaced = `/${PLUGIN_PREFIX}:`;
  // Namespaced or bare. `/gutt-pro` with no verb falls through to the bare branch,
  // yields "gutt-pro", and is rejected below — there is no stem command (D1).
  const verb = head.startsWith(namespaced) ? head.slice(namespaced.length) : head.slice(1);

  // Anything else — another plugin command, a legacy `/gutt` spelling, or prose
  // that happens to start with a slash — is not ours.
  if (!VERBS.includes(verb)) {
    return null;
  }

  const rest = words.slice(1);
  const arg = rest[0] ?? null;
  // A second argument is always wrong — no form takes two — so it is carried
  // through as an unrecognised parse rather than ignored.
  if (rest.length > 1) {
    return { verb: null, arg: null, typed };
  }
  return { verb, arg, typed };
}

// ---------------------------------------------------------------------------
// Rendering `/gutt-pro:config`
// ---------------------------------------------------------------------------

/**
 * @param {Object|null} raw - the stored config, not the defaults-merged view
 * @returns {string}
 */
function enabledLine(raw) {
  const stored = raw?.enabled;
  if (stored === false) {
    return "enabled: false — recall is off until /gutt-pro:on, and it survives restarts";
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
 * What each mode actually does at the Stop judge.
 *
 * Until GP-866 this key was written and read by nobody, and every surface said so.
 * `gutt-core/hooks/stop-capture.cjs` now reads it and `shared/stop-judge.cjs`
 * appends the confirmation instruction on `hitl`, so the old "no behaviour reads
 * this key yet" wording became false in the same commit that made it consumable.
 * Keyed by mode so a mode added to `MODES` without an effect here renders a bare
 * label rather than `undefined`.
 */
const MODE_EFFECTS = {
  auto: "a capture is written without a confirmation step",
  hitl: "the end-of-turn capture judge asks you to confirm each subject before writing",
};

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
  return `mode: ${mode} — ${MODE_EFFECTS[mode] ?? "capture mode"}`;
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
 * How the suppression currently in force ends — the clause GP-931 D3 makes
 * load-bearing.
 *
 * `off` and `disable` both print "suppressed", and after the reversal a user cannot
 * tell from that word alone whether recall returns by itself. Each branch therefore
 * names its own exit: a session ending, a deadline lapsing, or nothing but
 * `/gutt-pro:on`. Ordered by durability, because a durable off outlives any snooze
 * layered under it and is the honest answer when both are set.
 *
 * @param {Object|null} raw
 * @param {string|null} sessionId
 * @param {number} now
 * @returns {string}
 */
function scopeClause(raw, sessionId, now) {
  if (raw?.enabled === false) {
    return "set by /gutt-pro:disable, so it holds until /gutt-pro:on — restarts do not clear it";
  }
  const until = raw?.snoozeUntil ?? null;
  if (!until) {
    return "set by /gutt-pro:off for this session, so it clears when this session ends";
  }
  const ms = Date.parse(until);
  const left = plural(Math.max(1, Math.ceil((ms - now) / 60000)), "minute");
  return `set by /gutt-pro:off for ${left}, so it clears on its own after that`;
}

/**
 * The `/gutt-pro:config` block: stored values, then the state they add up to.
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
  // Not `readRawConfig`: that returns null for both "no file yet" and "file is
  // corrupt", and rendering the defaults for the second case reports values that were
  // never read, under a header saying they were. This is the one command whose job is
  // to explain a broken config, so it must be able to say the file is broken.
  const { state, raw } = config.readRawConfigState();
  if (state === "unreadable") {
    return (
      `gutt configuration could not be read from ${file}: the file is present but is not ` +
      "valid JSON. The built-in defaults are in force — recall enabled, capture mode auto, " +
      "no snooze — and no setting can be saved until it is fixed, because a write would have " +
      "to overwrite state gutt could not read. Move the file aside or delete it and gutt " +
      "will recreate it."
    );
  }
  const suppressed = config.isSuppressed(sessionId, now);
  return [
    `gutt configuration, read from ${file}:`,
    `  ${enabledLine(raw)}`,
    `  ${modeLine(raw)}`,
    `  ${snoozeLine(raw, sessionId, now)}`,
    `  in force right now: ${
      suppressed
        ? "suppressed — no memory recall pointer is injected, and the end-of-turn capture " +
          `judge does not run. It is ${scopeClause(raw, sessionId, now)}.`
        : "active — memory recall pointers can be injected, and the end-of-turn capture " +
          "judge runs"
    }`,
    "Off and disable and snooze all silence both halves; mode governs only how a capture is " +
      "confirmed once the judge has fired.",
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
    "gutt could not save that: the write to config.json did not land, so nothing changed. " +
    "The usual causes are an unavailable plugin data directory and a config.json that is " +
    "present but unreadable — gutt refuses to overwrite a file it could not parse. " +
    "hook-errors.log in the plugin data directory records which it was."
  );
}

/**
 * `/gutt-pro:off [minutes|session]` — the session-scoped verb (GP-931 D3).
 *
 * Bare `off` and explicit `off session` are the same command. That is the reversal:
 * in 3.0 a bare `off` was durable, and the durable one is now `disable`. Nothing
 * here can write an unbounded snooze — `isSuppressed` cannot represent one — so the
 * durable state stays `enabled: false` and stays behind its own verb.
 *
 * @param {string|null} arg
 * @param {string|null} sessionId
 * @param {number} now
 * @returns {string}
 */
function runOff(arg, sessionId, now) {
  const session = arg === null || arg.toLowerCase() === "session";
  if (session) {
    // Refuse rather than write `snoozeSessionId: "unknown"`, which no real session
    // would match and which SessionEnd could never reclaim — a snooze that outlives
    // every session and is invisible in `/gutt-pro:config`.
    if (!sessionId || sessionId === "unknown") {
      return (
        "gutt could not scope a snooze to this session: no session id reached the hook. " +
        "Nothing changed — /gutt-pro:off <minutes> sets a deadline instead, and " +
        "/gutt-pro:disable turns recall off durably."
      );
    }
    return config.setSnooze({ sessionId })
      ? "gutt memory recall is off for the rest of this session. It comes back on its own in " +
          "the next session; /gutt-pro:on restores it now, and /gutt-pro:disable turns it off " +
          "durably instead."
      : writeFailed();
  }

  // `Number()` on its own accepts "30.5", "0x1e" and " 30 "; the shape test first
  // is what keeps the accepted set to plain whole minutes.
  const minutes = /^\d+$/.test(arg) ? Number(arg) : NaN;
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    return (
      `gutt did not change anything: "${arg}" is not a number of minutes between ` +
      `${MIN_MINUTES} and ${MAX_MINUTES}. Use /gutt-pro:off <minutes>, /gutt-pro:off for the ` +
      "rest of this session, or /gutt-pro:disable for a durable off."
    );
  }
  const untilMs = now + minutes * 60000;
  return config.setSnooze({ untilMs })
    ? `gutt memory recall is off for the next ${plural(minutes, "minute")}, until ` +
        `${localStamp(untilMs)}. It resumes on its own after that; /gutt-pro:on restores it now.`
    : writeFailed();
}

/**
 * `/gutt-pro:disable` — the durable off (GP-931 D3).
 *
 * Takes no argument. A tail is named rather than ignored: this is the one verb whose
 * effect survives a restart, so a user who typed `/gutt-pro:disable 30` expecting a
 * deadline must not be left with a permanent silence and a success message.
 *
 * @param {string|null} arg
 * @param {string} typed
 * @returns {string}
 */
function runDisable(arg, typed) {
  if (arg !== null) {
    return (
      `gutt did not recognise "${typed}" — /gutt-pro:disable takes no argument, and it is ` +
      "durable by definition. /gutt-pro:off <minutes> is the one that takes a deadline. " +
      `The forms are: ${FORMS}. Nothing was changed.`
    );
  }
  return config.setEnabled(false)
    ? "gutt memory recall is off until /gutt-pro:on turns it back on. This survives restarts, " +
        "and /gutt-pro:off is the session-scoped form if that is what you wanted."
    : writeFailed();
}

/**
 * `/gutt-pro:on`.
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
  const cleared = [wasOff ? "the off set by /gutt-pro:disable" : null, snooze].filter(Boolean);
  return `gutt memory recall is back on. Cleared ${cleared.join(" and ")}.`;
}

/**
 * A short noun phrase for the snooze `/gutt-pro:on` is about to clear, or null when
 * there is none. Short on purpose — the full state belongs in `/gutt-pro:config`,
 * and folding `snoozeLine`'s dashed clauses into this sentence read badly.
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
    // so `/gutt-pro:on` is a machine-global statement. Named rather than done
    // quietly, because the user did not set this one.
    return `a session-scoped snooze (${shortId(owner)})`;
  }
  const ms = Date.parse(until);
  if (!Number.isFinite(ms) || ms <= now) {
    return "a lapsed snooze";
  }
  return `a snooze that had ${plural(Math.ceil((ms - now) / 60000), "minute")} left`;
}

/**
 * `/gutt-pro:mode auto|hitl`.
 * @param {string|null} arg
 * @returns {string}
 */
function runMode(arg) {
  const next = arg === null ? null : arg.toLowerCase();
  if (!next || !config.MODES.includes(next)) {
    return (
      `gutt did not change the capture mode: the modes are ${config.MODES.join(" and ")}` +
      `${arg === null ? "" : `, not "${arg}"`}. Use /gutt-pro:mode auto or /gutt-pro:mode hitl.`
    );
  }
  const was = config.readConfig().mode;
  if (!config.setMode(next)) {
    return writeFailed();
  }
  const change = was === next ? `is ${next}, unchanged` : `is now ${next}, was ${was}`;
  return `gutt capture mode ${change} — ${MODE_EFFECTS[next]}.`;
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
  switch (parsed.verb) {
    case "config":
      // `config` takes no argument, so one is a typo worth naming rather than
      // ignoring — the user may think they changed something.
      return parsed.arg === null
        ? renderConfig(sessionId, now)
        : `gutt did not recognise "${parsed.typed}" — /gutt-pro:config takes no argument. ` +
            `The forms are: ${FORMS}. Nothing was changed.`;
    case "on":
      return runOn(sessionId, now);
    case "off":
      return runOff(parsed.arg, sessionId, now);
    case "disable":
      return runDisable(parsed.arg, parsed.typed);
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
  VERBS,
  MIN_MINUTES,
  MAX_MINUTES,
  parseCommand,
  configCommandResult,
};
