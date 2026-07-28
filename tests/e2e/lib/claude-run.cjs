#!/usr/bin/env node
/**
 * Harness for end-to-end tests that drive a real `claude -p` session (GP-863).
 *
 * Everything here exists to turn one headless Claude Code run into inspectable
 * evidence: the CLI's own debug log, the runtime state the hooks wrote under
 * ${CLAUDE_PLUGIN_DATA}, and the session transcript Claude Code keeps in
 * ~/.claude/projects. A test asserts against those three artifacts rather than
 * against a simulation of them.
 *
 * Two things about this environment shape the design, both verified rather than
 * assumed:
 *
 *  - CLAUDE_PLUGIN_DATA is NOT read from the inherited environment. Exporting it
 *    changes nothing; the plugin's data dir is derived from how the plugin was
 *    loaded. So the data dir is *resolved* after the run by locating the session
 *    file, never hardcoded.
 *  - stdout can carry a "no stdin data received" warning ahead of the result
 *    JSON, so the result is parsed by scanning lines from the end rather than
 *    with a bare JSON.parse of the whole stream.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const HOME = os.homedir();
const PLUGIN_DATA_ROOT = path.join(HOME, ".claude", "plugins", "data");
const PROJECTS_ROOT = path.join(HOME, ".claude", "projects");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PLUGIN_DIR = path.join(REPO_ROOT, "gutt-core");
const FIXTURE_PROJECT = path.join(__dirname, "..", "fixture-project");

/**
 * Every variable that can route this suite onto something the user pays for
 * per-token (R36). Not just the two API-key vars: Bedrock and Vertex are
 * selected by their own flags and bill to a cloud account, and a redirected
 * base URL can point at a metered gateway. A test suite that quietly spends
 * the user's money is a worse failure than one that does not run.
 */
const BILLABLE_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

/**
 * Tools the model is not allowed to reach for. The plugin's UserPromptSubmit
 * hook injects a "search organizational memory first" instruction, and an
 * obliging model will happily spend a minute and a subagent on it. Denying the
 * tools keeps every run to a couple of turns and a few cents without changing
 * the hook behaviour under test.
 */
const DEFAULT_DISALLOWED_TOOLS = [
  "Task",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
];

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Build an environment for the child that cannot be billed to an API key.
 * @param {Object} [extra] - additional variables to set
 * @returns {Object} the child environment
 */
function subscriptionSafeEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of BILLABLE_ENV_KEYS) {
    delete env[key];
  }
  const leaked = BILLABLE_ENV_KEYS.filter((key) => env[key]);
  if (leaked.length > 0) {
    throw new Error(`refusing to run: ${leaked.join(", ")} survived scrubbing`);
  }
  return env;
}

/**
 * @returns {string|null} the CLI version, or null when `claude` is unusable
 */
function claudeVersion() {
  try {
    const probe = spawnSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 30000,
    });
    if (probe.status !== 0) {
      return null;
    }
    return (probe.stdout || "").trim() || null;
  } catch {
    return null;
  }
}

/** @returns {string} the plugin name declared by the manifest under test */
function pluginName() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")
  );
  return manifest.name;
}

/**
 * Where a `--plugin-dir` load keeps its runtime state. Claude Code suffixes the
 * plugin name with `-inline` for directory loads. Tests assert this matches the
 * dir actually resolved from the run, so a change in that convention surfaces as
 * a failure instead of a silently skipped check.
 * @returns {string}
 */
function inlineDataDir() {
  return path.join(PLUGIN_DATA_ROOT, `${pluginName()}-inline`);
}

/**
 * Materialise the committed fixture project into a throwaway directory. The
 * fixture is the "test project folder" the plugin gets installed into; copying
 * it per run keeps each run from inheriting the last one's leftovers.
 * @param {string} [label] - included in the directory name for debuggability
 * @returns {string} absolute path to the new project directory
 */
function createProject(label = "session") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gutt-e2e-${label}-`));
  for (const entry of fs.readdirSync(FIXTURE_PROJECT)) {
    fs.copyFileSync(path.join(FIXTURE_PROJECT, entry), path.join(dir, entry));
  }
  return dir;
}

/** Remove a directory tree, ignoring failures — cleanup must never fail a test. */
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** @returns {string[]} every sessions/*.json across every plugin data dir */
function listSessionFiles() {
  const found = [];
  let dataDirs = [];
  try {
    dataDirs = fs.readdirSync(PLUGIN_DATA_ROOT);
  } catch {
    return found;
  }
  for (const dataDir of dataDirs) {
    const sessionsDir = path.join(PLUGIN_DATA_ROOT, dataDir, "sessions");
    let names = [];
    try {
      names = fs.readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".json")) {
        found.push(path.join(sessionsDir, name));
      }
    }
  }
  return found;
}

function readJsonQuiet(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Plant a session file with a backdated mtime so the SessionStart TTL sweep has
 * something to reclaim. Returns the path so the caller can assert on it.
 * @param {string} dataDir
 * @param {string} name - file stem
 * @param {number} ageMs - how far in the past to backdate mtime
 * @returns {string} the planted file's path
 */
function plantSessionFile(dataDir, name, ageMs) {
  const sessionsDir = path.join(dataDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ sessionId: name, plantedByE2E: true }));
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  }
  return file;
}

/**
 * Pull the result envelope out of stdout. Scans from the end because the CLI can
 * emit warnings ahead of it.
 * @param {string} stdout
 * @returns {Object|null}
 */
function parseResultJson(stdout) {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === "result") {
        return parsed;
      }
    } catch {
      /* not the envelope — keep scanning */
    }
  }
  return null;
}

/**
 * Locate the runtime state file for a session, wherever it landed.
 * @param {string} sessionId
 * @returns {string|null}
 */
function findSessionStateFile(sessionId) {
  return listSessionFiles().find((file) => path.basename(file) === `${sessionId}.json`) || null;
}

/**
 * Locate the transcript Claude Code wrote for a session. Found by scanning
 * rather than by re-deriving the project-directory encoding, which is an
 * implementation detail of the CLI.
 * @param {string} sessionId
 * @returns {string|null}
 */
function findTranscript(sessionId) {
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(PROJECTS_ROOT);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = path.join(PROJECTS_ROOT, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * @param {string} file
 * @returns {Object[]} parsed transcript records, unparseable lines dropped
 */
function readTranscript(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Build the argv for a headless run. Shared by both runners, so a flag added for
 * one tier cannot silently drift out of the other.
 * @param {Object} options
 * @returns {string[]}
 */
function buildArgs({
  prompt = null,
  projectDir,
  debugFile,
  model = DEFAULT_MODEL,
  pluginDirs = [PLUGIN_DIR],
  disallowedTools = DEFAULT_DISALLOWED_TOOLS,
  sessionId = null,
  streamJson = false,
  extraArgs = [],
}) {
  const args = ["-p"];
  // In stream-json mode the prompts arrive on stdin, so `-p` takes no argument.
  if (prompt !== null) {
    args.push(prompt);
  }
  if (streamJson) {
    // --verbose is required for stream-json output to emit per-turn events.
    args.push("--input-format", "stream-json", "--verbose");
  }
  for (const dir of pluginDirs) {
    args.push("--plugin-dir", dir);
  }
  args.push(
    "--settings",
    path.join(projectDir, "settings.json"),
    "--debug-file",
    debugFile,
    "--output-format",
    streamJson ? "stream-json" : "json",
    "--model",
    model
  );
  // Fixing the id up front lets a test plant state keyed to the session it is
  // about to run, instead of discovering the id only after the run is over.
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  if (disallowedTools.length > 0) {
    args.push("--disallowed-tools", ...disallowedTools);
  }
  args.push(...extraArgs);
  return args;
}

/**
 * Poll session state so transient fields can be asserted on.
 *
 * Several lifecycle fields exist only mid-session: `firstPromptPending` is armed
 * by SessionStart and cleared by SessionEnd, so the final file cannot show it was
 * ever set. Only files that appear *during* the run are sampled — anything already
 * on disk belongs to another session.
 *
 * @returns {{sample: () => void, samples: Object[]}}
 */
function createSampler() {
  const preexisting = new Set(listSessionFiles());
  const samples = [];
  const seenRevisions = new Map();

  function sample() {
    for (const file of listSessionFiles()) {
      if (preexisting.has(file)) {
        continue;
      }
      const state = readJsonQuiet(file);
      if (!state) {
        continue;
      }
      const revision = `${state.rev}:${state.lastUpdated}`;
      if (seenRevisions.get(file) === revision) {
        continue;
      }
      seenRevisions.set(file, revision);
      samples.push({ at: Date.now(), file, state });
    }
  }

  return { sample, samples };
}

/** One stream-json user message, as the CLI expects it on stdin. */
function streamUserMessage(text) {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

/**
 * Run one headless Claude Code session against the plugin in this working tree,
 * sampling session state throughout so mid-session values can be asserted on.
 *
 * Sampling matters: several lifecycle fields are transient by design.
 * `firstPromptPending` is armed by SessionStart and cleared by SessionEnd, so
 * the final file cannot show it was ever set — only a sample taken while the
 * session was live can.
 *
 * @param {Object} options
 * @param {string} options.projectDir - cwd for the run
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @param {string} [options.pluginDir] - defaults to gutt-core in this repo
 * @param {string[]} [options.disallowedTools]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs] - state sampling interval
 * @param {string} [options.sessionId] - fix the session id up front
 * @param {string[]} [options.pluginDirs] - load more than one plugin (R23)
 * @param {string} [options.debugLabel] - debug log filename stem
 * @returns {Promise<Object>} the run record
 */
function runClaude(options) {
  const {
    projectDir,
    prompt,
    model = DEFAULT_MODEL,
    pluginDir = PLUGIN_DIR,
    pluginDirs = [pluginDir],
    disallowedTools = DEFAULT_DISALLOWED_TOOLS,
    timeoutMs = 240000,
    pollMs = 40,
    sessionId: fixedSessionId = null,
    debugLabel = "claude-debug",
    extraArgs = [],
  } = options;

  const debugFile = path.join(projectDir, `${debugLabel}.log`);
  const args = buildArgs({
    prompt,
    projectDir,
    debugFile,
    model,
    pluginDirs,
    disallowedTools,
    sessionId: fixedSessionId,
    extraArgs,
  });

  const { sample, samples } = createSampler();

  // Built once and returned with the result, so the R36 assertion can inspect
  // the environment the child was actually given rather than re-deriving one.
  const childEnv = subscriptionSafeEnv();

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("claude", args, {
      cwd: projectDir,
      env: childEnv,
      // stdin closed: the CLI otherwise waits 3s for piped input.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const poller = setInterval(sample, pollMs);
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearInterval(poller);
      clearTimeout(killer);
      reject(err);
    });

    child.on("close", (code) => {
      clearInterval(poller);
      clearTimeout(killer);
      // SessionEnd is the last hook to write; give it a beat to land, then take
      // a final sample so the finalised state is always captured.
      setTimeout(() => {
        sample();
        const result = parseResultJson(stdout);
        const sessionId = result ? result.session_id : null;
        const stateFile = sessionId ? findSessionStateFile(sessionId) : null;
        const transcriptFile = sessionId ? findTranscript(sessionId) : null;
        resolve({
          code,
          stdout,
          stderr,
          args,
          childEnv,
          result,
          sessionId,
          durationMs: Date.now() - startedAt,
          debugFile,
          debug: fs.existsSync(debugFile) ? fs.readFileSync(debugFile, "utf8") : "",
          stateFile,
          state: stateFile ? readJsonQuiet(stateFile) : null,
          dataDir: stateFile ? path.dirname(path.dirname(stateFile)) : null,
          transcriptFile,
          transcript: transcriptFile ? readTranscript(transcriptFile) : [],
          // Strictly this run's session. `!sessionId || …` used to widen this to
          // every session in every plugin data dir when the id was unknown, so a
          // concurrent local `claude` session could satisfy an assertion about
          // *this* one. With no id there is nothing to attribute: return none and
          // let the assertion fail rather than pass on a stranger's state.
          samples: sessionId
            ? samples.filter((entry) => path.basename(entry.file) === `${sessionId}.json`)
            : [],
          allSamples: samples,
        });
      }, 750);
    });
  });
}

/**
 * Drive several prompts through **one** session, in one CLI invocation.
 *
 * This exists for one reason: `--resume` fires SessionStart again with
 * `source: "resume"`, and every non-`compact` source re-arms
 * `firstPromptPending`. A resumed turn is therefore a *first* prompt, not a later
 * one, so resuming can never demonstrate that later prompts stay silent. Feeding
 * stream-json messages to a single process is the only way to get two prompts
 * under one SessionStart.
 *
 * Turns are strictly sequential: the next message is written only once the
 * previous turn's `result` envelope has been seen, so the turn boundaries in the
 * debug log are unambiguous.
 *
 * @param {Object} options
 * @param {string} options.projectDir
 * @param {string[]} options.prompts - one per turn, sent in order
 * @param {string} [options.sessionId]
 * @param {string} [options.model]
 * @param {string[]} [options.pluginDirs]
 * @param {string[]} [options.disallowedTools]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 * @param {string} [options.debugLabel]
 * @returns {Promise<Object>} the run record, with one entry per turn in `turns`
 */
function runClaudeStream(options) {
  const {
    projectDir,
    prompts,
    sessionId: fixedSessionId = null,
    model = DEFAULT_MODEL,
    pluginDirs = [PLUGIN_DIR],
    disallowedTools = DEFAULT_DISALLOWED_TOOLS,
    timeoutMs = 300000,
    pollMs = 40,
    debugLabel = "claude-stream",
  } = options;

  const debugFile = path.join(projectDir, `${debugLabel}.log`);
  const args = buildArgs({
    projectDir,
    debugFile,
    model,
    pluginDirs,
    disallowedTools,
    sessionId: fixedSessionId,
    streamJson: true,
  });

  const { sample, samples } = createSampler();
  const childEnv = subscriptionSafeEnv();

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("claude", args, {
      cwd: projectDir,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let buffer = "";
    const events = [];
    const turns = [];
    let sent = 0;

    /**
     * Send the next prompt when the previous turn has finished, and close stdin
     * once every prompt has been answered. Closing matters: the CLI keeps the
     * session (and so SessionEnd) open while stdin is readable.
     */
    function pump() {
      if (sent < prompts.length && turns.length === sent) {
        child.stdin.write(streamUserMessage(prompts[sent]));
        sent += 1;
      } else if (turns.length === prompts.length) {
        try {
          child.stdin.end();
        } catch {
          /* already closed */
        }
      }
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      buffer += chunk;
      // Line-buffered: a chunk boundary can land mid-JSON.
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
          continue;
        }
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }
        events.push(event);
        if (event.type === "result") {
          turns.push(event);
          pump();
        }
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const poller = setInterval(sample, pollMs);
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.on("error", (err) => {
      clearInterval(poller);
      clearTimeout(killer);
      reject(err);
    });

    child.on("close", (code) => {
      clearInterval(poller);
      clearTimeout(killer);
      // SessionEnd is the last hook to write; give it a beat, then sample again.
      setTimeout(() => {
        sample();
        const sessionId = fixedSessionId || (turns[0] ? turns[0].session_id : null);
        const stateFile = sessionId ? findSessionStateFile(sessionId) : null;
        const transcriptFile = sessionId ? findTranscript(sessionId) : null;
        resolve({
          code,
          stdout,
          stderr,
          args,
          childEnv,
          turns,
          events,
          sessionId,
          durationMs: Date.now() - startedAt,
          debugFile,
          debug: fs.existsSync(debugFile) ? fs.readFileSync(debugFile, "utf8") : "",
          stateFile,
          state: stateFile ? readJsonQuiet(stateFile) : null,
          dataDir: stateFile ? path.dirname(path.dirname(stateFile)) : null,
          transcriptFile,
          transcript: transcriptFile ? readTranscript(transcriptFile) : [],
          samples: sessionId
            ? samples.filter((entry) => path.basename(entry.file) === `${sessionId}.json`)
            : [],
          allSamples: samples,
        });
      }, 900);
    });

    pump();
  });
}

// ---------------------------------------------------------------------------
// Reading the CLI's own account of what it did, out of the debug log.
//
// These parse debug output rather than inferring behaviour from side effects,
// because for a `type: "prompt"` hook there *are* no side effects: the verdict
// never touches disk and a hook that was never evaluated is indistinguishable
// from one that returned ok:true.
// ---------------------------------------------------------------------------

/**
 * Every prompt-hook verdict the CLI logged, in order.
 *
 * A verdict of `{ok: true}` is logged as "condition was met" — Claude Code wraps
 * the configured prompt as a *stopping condition*, so `ok:true` means "satisfied,
 * allow the stop". Any `reason` alongside `ok:true` is discarded by the CLI.
 *
 * @param {string} debug
 * @returns {Array<{raw: string, parsed: Object|null}>}
 */
function stopVerdicts(debug) {
  return debug
    .split("\n")
    .filter((line) => line.includes("Hooks: Model response"))
    .map((line) => {
      const match = /Model response:\s*(\{.*)$/.exec(line);
      if (!match) {
        return { raw: line, parsed: null };
      }
      const text = match[1].trim();
      // The logger can close the payload with a stray quote of its own.
      for (const candidate of [text, text.replace(/"$/, "")]) {
        try {
          return { raw: candidate, parsed: JSON.parse(candidate) };
        } catch {
          /* try the next shape */
        }
      }
      return { raw: text, parsed: null };
    });
}

/** How many times a prompt hook was evaluated, regardless of verdict. */
function promptHookEvaluations(debug) {
  return debug.split("\n").filter((line) => /Hooks: Processing prompt hook/.test(line)).length;
}

/**
 * The `stop_hook_active` values the CLI passed to the Stop hook, in order. True
 * means "you already asked once" — the platform's own loop breaker.
 * @param {string} debug
 * @returns {boolean[]}
 */
function stopHookActiveStates(debug) {
  return [...debug.matchAll(/stop_hook_active\\?":\s*(true|false)/g)].map((m) => m[1] === "true");
}

/** Every `additionalContext` injection the CLI accepted. */
function additionalContextEvents(debug) {
  return debug.split("\n").filter((line) => /provided additionalContext \(\d+ chars\)/.test(line));
}

/**
 * The SessionStart matchers that fired, one entry per SessionStart event.
 *
 * Needed because `hookCompletions()` cannot see this event: the CLI logs a
 * "completed with status" line for `session-end.cjs` but **never** for the
 * synchronous `session-start.cjs` — verified across every probe run. The async
 * sibling's registration line is the only per-event record, and it names the
 * matcher, which is what distinguishes a fresh start from a resume.
 *
 * @param {string} debug
 * @returns {string[]} e.g. ["startup"] or ["startup", "resume"]
 */
function sessionStartEvents(debug) {
  return [...debug.matchAll(/Registering async hook \S+ \(SessionStart:([a-z]+)\)/g)].map(
    (m) => m[1]
  );
}

/**
 * Exit statuses the CLI recorded for a given hook script.
 *
 * Only hooks the CLI reports on: see sessionStartEvents() for why SessionStart is
 * not one of them.
 *
 * @param {string} debug
 * @param {string} script - e.g. "session-end.cjs"
 * @returns {number[]}
 */
function hookCompletions(debug, script) {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[[^\\]]*${escaped}[^\\]]*\\] completed with status (\\d+)`, "g");
  return [...debug.matchAll(re)].map((m) => Number(m[1]));
}

/**
 * Run `fn` with a planted `${CLAUDE_PLUGIN_DATA}/config.json`, then put the file
 * back exactly as it was.
 *
 * config.json is **global** — every Claude Code session on the machine shares the
 * one file — so a test that plants a snooze is mutating the developer's own
 * runtime config. Restoring is not politeness; without it a failed run leaves the
 * user snoozed.
 *
 * `fn` receives the file path so it can inspect what the hooks did to the config
 * before it is restored.
 *
 * @param {Object} config
 * @param {(file: string) => any} fn
 * @returns {any} whatever `fn` returned (awaited if it is a promise)
 */
function withPlantedConfig(config, fn) {
  const file = path.join(inlineDataDir(), "config.json");
  const existed = fs.existsSync(file);
  const backup = existed ? fs.readFileSync(file) : null;

  const restore = () => {
    try {
      if (existed) {
        fs.writeFileSync(file, backup);
      } else {
        fs.rmSync(file, { force: true });
      }
    } catch {
      /* best effort — cleanup must not mask the test's own failure */
    }
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config));

  let out;
  try {
    out = fn(file);
  } catch (err) {
    restore();
    throw err;
  }
  if (out && typeof out.then === "function") {
    return out.then(
      (value) => {
        restore();
        return value;
      },
      (err) => {
        restore();
        throw err;
      }
    );
  }
  restore();
  return out;
}

/**
 * Hook records Claude Code wrote into the session transcript.
 * @param {Object[]} transcript
 * @returns {Object[]} the attachment payloads for hook events
 */
function hookAttachments(transcript) {
  return transcript
    .filter((row) => row.type === "attachment" && row.attachment)
    .map((row) => row.attachment)
    .filter((attachment) => String(attachment.type || "").startsWith("hook_"));
}

module.exports = {
  BILLABLE_ENV_KEYS,
  DEFAULT_DISALLOWED_TOOLS,
  DEFAULT_MODEL,
  PLUGIN_DATA_ROOT,
  PLUGIN_DIR,
  PROJECTS_ROOT,
  REPO_ROOT,
  additionalContextEvents,
  buildArgs,
  claudeVersion,
  createProject,
  findSessionStateFile,
  findTranscript,
  hookAttachments,
  hookCompletions,
  inlineDataDir,
  listSessionFiles,
  parseResultJson,
  plantSessionFile,
  pluginName,
  promptHookEvaluations,
  readJsonQuiet,
  readTranscript,
  removeDir,
  runClaude,
  runClaudeStream,
  sessionStartEvents,
  stopHookActiveStates,
  stopVerdicts,
  subscriptionSafeEnv,
  withPlantedConfig,
};
