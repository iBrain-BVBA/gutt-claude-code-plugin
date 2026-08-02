#!/usr/bin/env node
/**
 * The `/gutt-pro:*` config command surface (GP-866, GP-931, R24).
 *
 * `/gutt-pro:config`, `/gutt-pro:on`, `/gutt-pro:off [minutes|session]`,
 * `/gutt-pro:disable`, `/gutt-pro:mode auto|hitl`,
 * `/gutt-pro:statusline [off|status]`. Everything here is
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
const statusline = require("./statusline-install.cjs");
const sessionState = require("./session-state.cjs");

/** Must equal `name` in `gutt-core/.claude-plugin/plugin.json`; a test asserts it. */
const PLUGIN_PREFIX = "gutt-pro";

/**
 * One command per verb (GP-931 D1). There is no stem: `/gutt-pro:config off` is not
 * a form, `/gutt-pro:off` is. Each name here needs a matching
 * `gutt-core/commands/<verb>.md`, or the typed command expands to nothing and the
 * outcome this module injects has no reply to sit alongside.
 */
const VERBS = ["config", "on", "off", "disable", "mode", "statusline"];

/**
 * Verbs accepted **only** in their namespaced spelling.
 *
 * `statusline` collides with a Claude Code built-in of the same name, which
 * configures the user's status line through an agent. A bare `/statusline` is
 * therefore addressed to the built-in — but this parser sees raw prompt text and not
 * routing, so left alone it would match too and install the gutt HUD into
 * `~/.claude/settings.json`.
 *
 * The attribution line the other bare verbs rely on is not enough here, and the
 * difference is what is being written. `off`, `on`, `mode` and `disable` mutate
 * plugin-owned config that `/gutt-pro:on` undoes in one command; this verb writes a
 * file in the user's home directory that the plugin is otherwise forbidden to touch,
 * and the user having asked for it *on purpose* is the entire reason the verb exists
 * rather than a hook doing it silently. A prompt aimed at the built-in is not that
 * asking. So the collision has to prevent the write, not merely announce it after
 * the fact.
 *
 * A `Set` rather than a second array because membership is the only question asked
 * of it, and it will not stay a single entry — every verb this plugin adds whose
 * name a built-in might also want belongs here.
 */
const NAMESPACED_ONLY = new Set(["statusline"]);

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
  "/gutt-pro:off session, /gutt-pro:disable, /gutt-pro:mode auto, /gutt-pro:mode hitl, " +
  "/gutt-pro:statusline, /gutt-pro:statusline off, /gutt-pro:statusline status";

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
 * resolves unprefixed. Measured, `docs/plugin-platform-reference.md` §8: bare
 * `/on`, `/off`, `/disable` and `/mode` do resolve here with their arguments;
 * bare `/config` does not, because Claude Code's own `/config` intercepts it
 * before any hook sees it. `config` stays in `VERBS` anyway — one array lookup on
 * a path that never receives it, against having to re-probe if the built-in list
 * changes.
 *
 * What a bare match does *not* prove is that the prompt was addressed to us.
 * Routing and text-matching are independent: this parser sees raw prompt text and
 * has no idea which command Claude Code resolved. `off`, `on`, `mode` and
 * `disable` are generic names, so another plugin — or a user's own
 * `~/.claude/commands/off.md` — can own `/off` while we still match it and write.
 * §8's measurement assumed no such collision; nothing enforces that at runtime.
 * Hence `bare` on the parse: the caller prepends a line naming the verb it ran, so
 * a collision announces itself the first time it fires instead of silently
 * suppressing recall for a session. Loud beats quiet, the same rule the bad-tail
 * branch below follows. Requiring the namespaced form for the four mutating verbs
 * would prevent the write rather than expose it, at the cost of the shortest form
 * a user will type; that trade is open, and this is the reversible half of it.
 *
 * `statusline` is the exception, and it is decided rather than open: it is in
 * `NAMESPACED_ONLY`, so a bare `/statusline` returns null here. The collision there is
 * not hypothetical — a Claude Code built-in owns that name — and the write is not
 * reversible from one command, so announcing it afterwards is the wrong shape. See
 * `NAMESPACED_ONLY` for why that verb is treated differently from the other four.
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
 * @returns {{verb: string|null, arg: string|null, typed: string, bare: boolean}|null}
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
  const bare = !head.startsWith(namespaced);
  const verb = bare ? head.slice(1) : head.slice(namespaced.length);

  // A *namespaced* foreign command can never reach here — `/other:off` yields the
  // verb `other:off`, which is not in `VERBS`. A *bare* one can, and does match;
  // see the note on `bare` above. A legacy `/gutt` spelling, and prose that happens
  // to start with a slash, are both rejected here.
  if (!VERBS.includes(verb)) {
    return null;
  }

  // Spelled out or not addressed to us. The one verb that writes outside the plugin's
  // own state does not get the benefit of the doubt a generic bare name gets.
  if (bare && NAMESPACED_ONLY.has(verb)) {
    return null;
  }

  const rest = words.slice(1);
  const arg = rest[0] ?? null;
  // A second argument is always wrong — no form takes two — so it is carried
  // through as an unrecognised parse rather than ignored.
  if (rest.length > 1) {
    return { verb: null, arg: null, typed, bare };
  }
  return { verb, arg, typed, bare };
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
 * `gutt-core/hooks/stop-capture.cjs` now reads it and `stop-judge.cjs`
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
 *
 * The two causes get different sentences because only one of them leaves evidence.
 * An unreadable config.json is logged by `updateConfig`. A missing data directory
 * cannot be: `debug.cjs` resolves its log path from the same `CLAUDE_PLUGIN_DATA`
 * that is absent, so there is no `hook-errors.log`, no directory to hold one, and
 * nothing written. Naming that file in this branch sent the user to a path that
 * structurally cannot exist. One `configPath()` call tells the two apart.
 * @returns {string}
 */
function writeFailed() {
  if (!config.configPath()) {
    return (
      "gutt could not save that: this session has no plugin data directory, so no setting " +
      "can be stored and nothing changed. There is no log to check — the directory that " +
      "would hold one does not exist. This is usually a local --plugin-dir run."
    );
  }
  return (
    "gutt could not save that: the write to config.json did not land, so nothing changed. " +
    "The likeliest cause is a config.json that is present but unreadable — gutt refuses to " +
    "overwrite a file it could not parse. hook-errors.log in the plugin data directory " +
    "records what happened."
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
 * Report a failed statusline write, without letting the framing contradict it.
 *
 * `writeSettings` was taught to distinguish "could not write it, it is unchanged"
 * from "could not write it and could not put it back", and both callers then pasted
 * the same reassuring clause in front of either — so the losing case arrived as
 * *"gutt did not change your settings: ~/.claude/settings.json could not be written
 * and could not be put back — it is missing."* A user who reads six words and stops
 * has been told their settings file is fine at the moment it does not exist. Fixing
 * that one layer down and re-introducing it one layer up is why this lives in a
 * function rather than in a convention.
 *
 * @param {string} lead what the harmless case may say it did not do
 * @param {{status: string, detail?: string}} result
 * @returns {string}
 */
function statuslineFailure(lead, result) {
  if (result.status === "settings-lost") {
    return `gutt could not finish, and your settings.json was lost in the attempt. ${result.detail}`;
  }
  return `${lead}: ${result.detail}`;
}

/**
 * `/gutt-pro:statusline [off|status]` — the HUD's only install path (GP-867).
 *
 * This verb exists because a plugin cannot ship a status line: upstream supports
 * only `agent` and `subagentStatusLine` in a plugin's settings.json, so the key has
 * to go in the user's own file, and nothing may put it there unasked. Typing this
 * is the asking.
 *
 * Every failure names the file it did not change. The whole point of routing this
 * through a command rather than a hook is that the user is present for it, so a
 * silent no-op would be the one outcome worse than not offering the command at all.
 *
 * @param {string|null} arg
 * @param {string} typed
 * @returns {string}
 */
function runStatusline(arg, typed) {
  const verb = arg === null ? "install" : arg.toLowerCase();

  if (verb === "status") {
    const { present, known, foreign } = statusline.entryPresent();
    const consented = config.statuslineConsented();
    if (!known) {
      return (
        "gutt could not read ~/.claude/settings.json, so it cannot say whether the HUD is " +
        "installed. Fix the JSON there and run /gutt-pro:statusline status again."
      );
    }
    if (present) {
      // Present in settings.json is not the same as working. Both links behind the
      // entry can break on their own — the shim goes when the plugin is uninstalled,
      // the renderer moves under it on every update — and this is the command
      // someone runs *because* the status bar is blank, so it has to be able to see
      // that rather than reporting the settings key and stopping there.
      const { shim, current, renderer } = statusline.shimResolves();

      // Why this session could not fix it by itself, when it tried and failed. Read
      // *before* the first branch, because that branch needs it most: the entry point
      // is absent precisely when the write that creates it failed, and telling someone
      // to re-run the command without mentioning that the automatic attempt already
      // failed sends them to repeat it and get the same result. It is appended to
      // whichever diagnosis follows rather than replacing one — the state of the files
      // is what the user needs, and this is why it is still that way.
      const shimFailure = sessionState.getState().statuslineShim;
      const because = shimFailure
        ? ` gutt tried to write it automatically this session and could not (${shimFailure}).`
        : "";

      if (!shim) {
        return (
          "The gutt HUD is in your settings.json, but the file it points at is gone, so " +
          `nothing renders.${because} Run /gutt-pro:statusline to write it again.`
        );
      }
      // Three values, three sentences, and the third is the reason this is not a
      // boolean. `false` means the shim names a file that is not there. `null` means
      // the shim is in a shape this version cannot read — which is a statement about
      // *us*, not about their files, and must not be spoken as either "it is missing"
      // (a claim about a file we never identified) or "it is rendering" (a claim we
      // have no evidence for, and one that is wrong exactly when it matters, since a
      // shim naming nothing prints nothing). The remedy is the same repoint either
      // way; the diagnosis is not, and the diagnosis is what the user reads first.
      if (renderer === null) {
        return (
          "The gutt HUD is in your settings.json, but gutt could not read its entry point " +
          "well enough to tell what it forwards to, so it cannot say whether anything " +
          `renders.${because} Run /gutt-pro:statusline to rewrite it.`
        );
      }
      if (renderer === false) {
        return current
          ? "The gutt HUD is in your settings.json and its entry point is there, but the " +
              "renderer it forwards to is missing — usually a plugin update that could not " +
              `finish.${because} Run /gutt-pro:statusline to repoint it.`
          : "The gutt HUD is in your settings.json, but its entry point still points into a " +
              "previous version of the plugin, and that version is gone — so nothing renders." +
              `${because} Run /gutt-pro:statusline to repoint it.`;
      }
      // Resolves, and to something real. The bar is not blank, so a stale entry point
      // here is a report rather than a fault — and it is the one the user cannot see
      // any other way, because everything downstream of a stale shim works exactly as
      // well as it did in the version it still points at.
      if (!current) {
        return (
          "The gutt HUD is installed and rendering, but its entry point is not the one this " +
          "version writes, so you may not be seeing this version's status bar." +
          `${because} Run /gutt-pro:statusline to repoint it.`
        );
      }
      return `The gutt HUD is installed. /gutt-pro:statusline off removes it.`;
    }
    if (foreign) {
      return (
        "Your settings.json has a status line, but not one gutt wrote — so gutt is leaving " +
        "it alone. Remove it yourself first if you want the gutt HUD instead."
      );
    }
    if (!consented) {
      return "The gutt HUD is not installed. /gutt-pro:statusline installs it.";
    }
    // What the automatic repair actually did this session, where it recorded a
    // failure. Saying "the next session restores it" to someone whose repair has
    // been failing every session sends them away to wait for something that is not
    // coming.
    const failure = sessionState.getState().statuslineReassert;
    if (failure) {
      // The detail is printed here rather than deferred to a re-run. It is the only
      // copy: on the losing path settings.json is now simply absent, so running the
      // install again takes the "no file, create one" branch and reports plain
      // success — the sentence naming where the original went would never be said
      // again by anyone.
      return (
        "The gutt HUD is not in your settings.json, though you asked for it before. This " +
        `session tried to put it back and could not (${failure.status}). ` +
        (failure.detail ? `${failure.detail} ` : "") +
        "Run /gutt-pro:statusline to retry."
      );
    }
    return (
      "The gutt HUD is not in your settings.json, though you asked for it before. Claude Code " +
      "sometimes drops the key when it rewrites that file; the next session restores it, " +
      "or /gutt-pro:statusline installs it now."
    );
  }

  if (verb === "off") {
    // Consent comes off *first*, and the write is checked. Two failures live here,
    // and they were both silent.
    //
    // Ordering: the SessionStart re-assert reads this flag and reinstalls when the
    // entry is missing. With the removal first, a session landing in the gap between
    // the two steps sees consent still recorded and an absent entry — exactly its
    // trigger — and puts back what the user just removed. Withdrawing first makes
    // the worst case a HUD that is still installed with consent already off, which
    // the next `off` clears.
    //
    // Checking: `setStatuslineConsent` returns false on a read-only or unparseable
    // config, and discarding that told the user the HUD was gone while leaving the
    // flag that brings it back next session. Every other write verb here reports
    // that through `writeFailed()`; this one used to be the exception.
    if (!config.setStatuslineConsent(false)) {
      return writeFailed();
    }
    const result = statusline.removeEntry();
    if (!result.ok) {
      return statuslineFailure("gutt did not change your settings", result);
    }
    // Both replies lead with the consent withdrawal, because that is the part that
    // happened in every case and the part the user typed this for. "Nothing changed"
    // was flatly wrong on the second branch: for someone whose HUD the platform had
    // already dropped, and who typed `off` to stop it coming back, the durable flag
    // that decides exactly that had just been cleared — the one thing they wanted was
    // the one thing they were told had not occurred.
    return result.status === "removed"
      ? "The gutt HUD is removed from ~/.claude/settings.json and will not be restored " +
          "automatically (the previous file is backed up). /gutt-pro:statusline puts it back."
      : "The gutt HUD was not in your settings.json. gutt has recorded that you do not want " +
          "it, so no later session will put it back.";
  }

  if (arg !== null && verb !== "install") {
    return (
      `gutt did not recognise "${typed}" — /gutt-pro:statusline installs the HUD, ` +
      "/gutt-pro:statusline off removes it, /gutt-pro:statusline status reports it. " +
      "Nothing was changed."
    );
  }

  const result = statusline.installEntry();
  if (!result.ok) {
    return statuslineFailure("gutt did not install the HUD", result);
  }
  // Recorded after the write, not before: consent authorises the repair in later
  // sessions, and there is nothing to repair if the first write never landed.
  //
  // The return is checked because the HUD is now installed either way — what fails
  // here is only the repair, and silently. The platform drops `statusLine` when it
  // rewrites settings.json, and without the flag no later session puts it back; the
  // user is told it "updates itself", then it vanishes and `status` reports it as
  // never asked for. Saying so costs one sentence.
  const consent = config.setStatuslineConsent(true);
  if (result.status === "already-installed") {
    return consent
      ? "The gutt HUD is already installed. It updates itself when the plugin does."
      : "The gutt HUD is already installed, but gutt could not record that you asked for it, " +
          "so it will not be restored automatically if Claude Code drops the setting. " +
          "Re-run /gutt-pro:statusline if the HUD disappears.";
  }
  if (!consent) {
    return (
      "The gutt HUD is installed in ~/.claude/settings.json and shows up in your status bar " +
      "from the next session. One thing did not save: gutt could not record that you asked " +
      "for it, so if Claude Code drops the setting when it rewrites that file, no later " +
      "session will put it back — re-run /gutt-pro:statusline if the HUD disappears."
    );
  }
  return (
    "The gutt HUD is installed in ~/.claude/settings.json and shows up in your status bar " +
    "from the next session. It points at a stable path, so plugin upgrades will not break " +
    "it. /gutt-pro:statusline off removes it."
  );
}

/**
 * `/gutt-pro:on`.
 *
 * The pre-read is what lets the reply be honest: `restore()` returns false both
 * when there was nothing to clear and when the write failed, and those deserve
 * different sentences.
 *
 * It reads through `readRawConfigState` rather than `readRawConfig` because the
 * latter collapses *absent* and *unreadable* into the same `null` (by design, see
 * `plugin-state.readJson`). On a corrupt config.json that collapse made `wasOff`
 * false and `snooze` null, so the "nothing changed" short-circuit below fired
 * *before* `restore()` — and `updateConfig`'s refusal-to-overwrite never ran. This
 * was the one verb that answered a broken file with reassurance while `config`,
 * `off`, `disable` and `mode` all reported the failure.
 * @param {string|null} sessionId
 * @param {number} now
 * @returns {string}
 */
function runOn(sessionId, now) {
  const { state, raw } = config.readRawConfigState();
  if (state === "unreadable") {
    return writeFailed();
  }
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
 * Attribution prepended to a bare-form outcome.
 *
 * A bare `/off` matches on prompt text alone, and the text does not say which
 * command Claude Code routed (see `parseCommand`). If another plugin owns `/off`,
 * the user gets its output *and* a silent write here. Naming the verb we ran makes
 * that visible on the first occurrence rather than never — the user can read one
 * line and see that gutt acted on a prompt they aimed elsewhere.
 *
 * Only on the bare form: the namespaced spelling is unambiguous, and prefixing it
 * would be noise on the documented path.
 * @param {string} outcome
 * @param {string|null} verb
 * @returns {string}
 */
function attributeBare(outcome, verb) {
  const form = verb ? `/${PLUGIN_PREFIX}:${verb}` : `a /${PLUGIN_PREFIX} command`;
  return (
    `gutt read the bare command in this prompt as ${form} and acted on it. ` +
    `Use ${form} explicitly if another plugin also provides that name.\n${outcome}`
  );
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
  const outcome = runVerb(parsed, sessionId, now);
  return parsed.bare ? attributeBare(outcome, parsed.verb) : outcome;
}

/**
 * Dispatch a parsed command to its handler.
 * @param {{verb: string|null, arg: string|null, typed: string}} parsed
 * @param {string|null} sessionId
 * @param {number} now
 * @returns {string}
 */
function runVerb(parsed, sessionId, now) {
  switch (parsed.verb) {
    case "config":
      // `config` takes no argument, so one is a typo worth naming rather than
      // ignoring — the user may think they changed something.
      return parsed.arg === null
        ? renderConfig(sessionId, now)
        : `gutt did not recognise "${parsed.typed}" — /gutt-pro:config takes no argument. ` +
            `The forms are: ${FORMS}. Nothing was changed.`;
    case "on":
      // Same reasoning as `config` and `disable`: `on` takes no argument, and
      // `/gutt-pro:on 30` is a plausible typo now that `off` is the verb that takes
      // a deadline. Dropping the `30` silently would report a restore the user
      // reads as a 30-minute one.
      return parsed.arg === null
        ? runOn(sessionId, now)
        : `gutt did not recognise "${parsed.typed}" — /gutt-pro:on takes no argument, and ` +
            "it restores recall immediately. /gutt-pro:off <minutes> is the one that takes " +
            `a deadline. The forms are: ${FORMS}. Nothing was changed.`;
    case "off":
      return runOff(parsed.arg, sessionId, now);
    case "disable":
      return runDisable(parsed.arg, parsed.typed);
    case "mode":
      return runMode(parsed.arg);
    case "statusline":
      return runStatusline(parsed.arg, parsed.typed);
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
  NAMESPACED_ONLY,
  MIN_MINUTES,
  MAX_MINUTES,
  parseCommand,
  configCommandResult,
  // Exported for tests. Pure, and the one piece of this surface where the framing can
  // contradict the fact it is framing — worth pinning directly rather than through a
  // failure that needs a platform-specific rename to provoke.
  statuslineFailure,
};
