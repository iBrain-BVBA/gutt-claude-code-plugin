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

/** The name the generated companion plugin registers under. */
const COMPANION_PLUGIN_NAME = "e2e-companion-plugin";

/**
 * Build a throwaway second plugin, for runs that need gutt to share a session.
 *
 * Coexistence tests need *another* plugin loaded; they do not need a particular one.
 * Generating a minimal plugin keeps that requirement covered without the suite
 * depending on some other plugin continuing to exist and continuing to ship hooks.
 *
 * Its handler is on `SessionEnd`, and the event choice is load-bearing twice over. A
 * tool event never fires, because the coexistence run denies every tool — so the
 * companion would load and sit idle, proving only that two plugins can be registered
 * side by side. `SessionStart` does fire, but the CLI registers it as a single opaque
 * async hook and never writes the command string to the debug log, so a run cannot tell
 * whose SessionStart handler ran. `SessionEnd` fires on every run *and* is logged as
 * `[<command>] completed with status N`, which is the only channel that attributes a
 * completion to a specific plugin's script.
 * @returns {string} absolute path to the new plugin directory
 */
function createCompanionPlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-companion-"));
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: COMPANION_PLUGIN_NAME,
        version: "0.0.0",
        description: "Throwaway second plugin, used only to prove gutt coexists with one.",
      },
      null,
      2
    )
  );
  const handler = { type: "command", command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/noop.cjs"` };
  fs.writeFileSync(
    path.join(dir, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { SessionEnd: [{ matcher: "", hooks: [handler] }] } }, null, 2)
  );
  fs.writeFileSync(path.join(dir, "hooks", "noop.cjs"), "process.exit(0);\n");
  return dir;
}

/**
 * Remove a directory tree. Cleanup must never fail a test, but it must not be silent
 * either — a swallowed failure here leaks a temp directory with nothing to show for it.
 */
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`cleanup: could not remove ${dir} (${err.message})`);
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
  // Before anything spawns: the invocation log is append-only, so this is the
  // watermark that makes `stopOutcomes` this run's rather than every run's.
  const logSizesAtStart = invocationLogSizes();
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
          logOffset: stateFile
            ? logSizesAtStart.get(realDir(path.dirname(path.dirname(stateFile)))) || 0
            : 0,
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
  // Before anything spawns: the invocation log is append-only, so this is the
  // watermark that makes `stopOutcomes` this run's rather than every run's.
  const logSizesAtStart = invocationLogSizes();
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
          logOffset: stateFile
            ? logSizesAtStart.get(realDir(path.dirname(path.dirname(stateFile)))) || 0
            : 0,
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
// These parse debug output rather than inferring behaviour from side effects.
// That was the only option while the Stop handler was a `type: "prompt"` hook:
// the verdict never touched disk, so a hook that was never evaluated could not be
// told apart from one that returned ok:true.
//
// GP-866 made the Stop handler a command hook, which inverted that. It has side
// effects — it writes a deterministic outcome line per turn — and it emits none of
// the prompt-hook debug lines the three Stop observers below match on. Those
// observers therefore return `[]` and `0` for every run now, which is why the
// assertions built on them were passing vacuously rather than failing loudly.
// Anything about Stop must use `stopOutcomes()` instead; the observers below are
// kept only for events that still dispatch a prompt hook, of which there are
// currently none.
// ---------------------------------------------------------------------------

/**
 * Every Stop outcome the hook recorded, in order, read from its own log.
 *
 * The command hook writes one `Stop: …` line per turn — `skipped, already active`,
 * `suppressed`, `deferred, N agent task(s) …`, or a judge outcome followed by
 * `(mode=…)`. That is a stronger signal than the debug log ever gave us: it survives
 * the CLI changing its logging, and it distinguishes a judge that passed from one
 * that could not answer.
 *
 * Scoped to the lines *this run* appended, via the byte offset the run recorded before
 * it started. The log is append-only and shared by every run that ever used the same
 * data dir, so reading it whole attributes months of history to the run in hand: it
 * reported 78 judgements for a two-turn session and failed a run on a four-week-old
 * timeout, while in the other direction a bound that should have caught a real
 * regression passed on a total nobody could interpret. A count over the wrong
 * denominator is not a weak signal, it is not a signal.
 *
 * Takes the run record rather than a bare data dir so the offset cannot be left
 * behind. A caller still passing a path gets no outcomes and an assertion that fails
 * loudly, which is the right direction: the alternative silently resurrects the whole
 * log.
 *
 * Byte offsets rather than timestamps, because the log stamps whole seconds and a line
 * written in the same second the run began is unattributable by time alone — and
 * because sizes are exact where a local-clock comparison is a judgement call.
 *
 * @param {Object|null} run the run record from `runClaude`/`runClaudeStream`
 * @returns {Array<{outcome: string, line: string}>}
 */
function stopOutcomes(run) {
  const dataDir = run && run.dataDir;
  if (!dataDir) {
    return [];
  }
  let log;
  try {
    log = fs.readFileSync(path.join(dataDir, "hook-invocations.log"));
  } catch {
    return []; // no log is a real answer: the hook never ran
  }
  // The log is NOT append-only, which is the premise a watermark would like to rest
  // on. `session-start.cjs` runs a TTL sweep that trims every breadcrumb log to the
  // last 200 lines once it passes 256KB — and that sweep runs inside the *child*
  // session a test spawns, after the watermark was taken. So the file can be smaller
  // than the offset recorded for it.
  //
  // That case has to be loud. Returning the empty tail would report "the hook left no
  // record of running" on a perfectly healthy run, and it self-heals next run as the
  // log regrows, so it reads as flake rather than as a broken assumption.
  const offset = run.logOffset || 0;
  if (log.length < offset) {
    throw new Error(
      `hook-invocations.log shrank below this run's watermark (${log.length}B < ${offset}B) — ` +
        `the TTL sweep trimmed it mid-run, so its lines can no longer be attributed. ` +
        `Re-run; if it persists, the sweep threshold and this suite are in conflict.`
    );
  }
  // Bytes, not string indices: an outcome line may carry an em dash, so slicing the
  // decoded string by a byte offset would cut in the wrong place.
  const text = log.subarray(offset).toString("utf8");
  return [...text.matchAll(/^.*?\bStop: (.+)$/gm)].map((match) => ({
    outcome: match[1].split(/ \(mode=| — /)[0].trim(),
    line: match[0],
  }));
}

/**
 * Byte length of every plugin data dir's invocation log, as of now.
 *
 * Sampled before a run starts, because which data dir the run resolves to is not known
 * until after it finishes — the dir is derived from the session state file the run
 * writes. Sampling all of them costs one `stat` per dir and removes the ordering
 * problem entirely.
 *
 * @returns {Map<string, number>} absolute data dir → current log size in bytes
 */
function invocationLogSizes() {
  const sizes = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(PLUGIN_DATA_ROOT);
  } catch {
    return sizes; // no data root yet: every run starts from zero
  }
  for (const entry of entries) {
    const dir = path.join(PLUGIN_DATA_ROOT, entry);
    try {
      sizes.set(realDir(dir), fs.statSync(path.join(dir, "hook-invocations.log")).size);
    } catch {
      /* this dir has no log yet, which reads the same as offset 0 */
    }
  }
  return sizes;
}

/**
 * A data dir in canonical form, for use as a map key.
 *
 * Both sides of the watermark lookup have to normalise the same way or the lookup
 * misses and the offset silently falls back to zero — which reads the whole log and
 * restores the very bug the watermark exists to fix, with nothing to show it happened.
 * On macOS the temp and data roots resolve through `/private`, and a symlinked HOME
 * does the same, so the sampled key and the resolved key can differ by prefix alone
 * while naming one directory.
 *
 * Falls back to the path as given when it cannot be resolved: an unresolvable dir has
 * no log to measure either, so both sides miss consistently.
 *
 * @param {string} dir
 * @returns {string}
 */
function realDir(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * How many times the judge was actually convened for a run — i.e. how many turns got
 * past every pre-judge row. Only the judge-outcome line carries `(mode=…)`, so this
 * counts model calls rather than Stop dispatches.
 *
 * This is the livelock bound's replacement. The P1 it guards re-fired 16 times on one
 * turn.
 *
 * @param {Object|null} run the run record from `runClaude`/`runClaudeStream`
 * @returns {number}
 */
function stopJudgements(run) {
  return stopOutcomes(run).filter((entry) => /\(mode=/.test(entry.line)).length;
}

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

/**
 * Every tool call the model made, optionally filtered to one tool.
 *
 * This is how a test sees what the model *did* rather than what it said. For a skill
 * the distinction is the whole point: the reply is prose the model composed, while a
 * tool call is evidence the skill's instructions were actually acted on.
 *
 * @param {Object[]} transcript
 * @param {string} [name] - tool name, e.g. "Bash"
 * @returns {Object[]} the tool_use blocks
 */
function toolUses(transcript, name = null) {
  return transcript
    .filter((row) => row.message && Array.isArray(row.message.content))
    .flatMap((row) => row.message.content)
    .filter((block) => block && block.type === "tool_use")
    .filter((block) => !name || block.name === name);
}

/**
 * Whether this row is the Stop hook's fired reason entering the conversation.
 *
 * Two signals, either of which is enough, because they fail differently. The
 * attachment is structural and survives any rewording of what we feed back; the
 * injected user message is the text the agent actually reads, and survives the CLI
 * reclassifying the attachment. Requiring both would make this answer "no" — and
 * every assertion built on it vacuous — the first time the platform stops emitting
 * one of them.
 *
 * Naming the hook is *not* enough on the attachment arm, and matching on that alone
 * was a defect. Four attachment types carry `hookName: "Stop"` and only two are
 * fires: measured over the local transcript corpus, ~520 `hook_blocking_error` rows
 * and 4 `hook_additional_context` rows carry feedback, while ~17 `hook_cancelled`
 * and 5 `hook_success` rows carry none — the hook ran and deliberately said nothing.
 * Treating those 22 as fires opens a window on a quiet turn, and since the turn then
 * ends with nothing after it, the observer reports a fire the agent ignored. That is
 * the exact defect it exists to detect, manufactured out of correct behaviour.
 *
 * So each arm tests for *feedback*, not for provenance. Testing the blocking payload
 * alone would be the obvious fix and the wrong one: it silences the non-blocking
 * channel, which is the one that matters as the hook moves off `decision: "block"`.
 *
 * @param {Object} row
 * @returns {boolean}
 */
function isStopFeedback(row) {
  const text = stopFeedbackText(row);
  return text !== null && OUR_CAPTURE_REASON.test(text);
}

/** Our Stop handler's script, as it appears in the attachment's recorded command. */
const OUR_STOP_HOOK = /stop-capture\.cjs/;

/** What our judge always asks for. Pinned by `hook-architecture.test.cjs`. */
const OUR_CAPTURE_REASON = /memory-capture/;

/**
 * The feedback text this row carried, or null if it carried none or came from
 * somebody else's Stop hook.
 *
 * Attribution matters and its absence was a defect. `hookName: "Stop"` is on *every*
 * plugin's Stop hook, and a session can carry several: a real run recorded two fires
 * back to back with no assistant turn between them, one from a 2.x `stop-lessons.cjs`
 * and one from ours. Scoring a foreign plugin's fire as ours makes it an ignored fire
 * the moment our own is the one the agent acts on — a false failure produced by
 * another plugin doing its job.
 *
 * The recorded `command` is the definitive discriminator and is used wherever it
 * appears. The non-blocking channel does not carry one, so that arm and the injected
 * message fall back to the reason text naming the skill we ask for. Both paths stay
 * alive on purpose: the command survives any rewording, and the text survives the CLI
 * dropping or reclassifying the attachment.
 *
 * @param {Object} row
 * @returns {string|null}
 */
function stopFeedbackText(row) {
  if (row.type === "attachment" && row.attachment && row.attachment.hookName === "Stop") {
    const { type, blockingError, content } = row.attachment;
    if (type === "hook_blocking_error" && blockingError) {
      if (blockingError.command && !OUR_STOP_HOOK.test(blockingError.command)) {
        return null; // another plugin's Stop hook fired here
      }
      return String(blockingError.blockingError || "") || null;
    }
    if (type === "hook_additional_context") {
      return [].concat(content || []).join("") || null;
    }
    return null; // hook_success / hook_cancelled — the hook ran and fed nothing back
  }
  if (row.type !== "user" || !row.message) {
    return null;
  }
  const content = row.message.content;
  const blocks = Array.isArray(content) ? content : [{ text: content }];
  const text = blocks
    .map((block) => (block && typeof block.text === "string" ? block.text : ""))
    .join("");
  return text.startsWith("Stop hook feedback:") ? text : null;
}

/**
 * Every index at which the Stop hook fed a reason back, one per fire, in order.
 *
 * All of them, not the first: a session that fired on several turns has to be scored
 * per fire. Crediting a later turn's capture to an earlier fire is how an observer
 * reports a routing path as live while one of its fires went unanswered.
 *
 * One fire produces *both* signals `isStopFeedback` recognises — the injected message
 * and the attachment — so counting rows would report one fire as two and hand the
 * first an empty window ending where the second begins. It would then read as a fire
 * the agent ignored, which is the exact defect this observer exists to detect,
 * manufactured out of a fire that was answered.
 *
 * The pair is coalesced on **adjacency**, which is what the transcripts actually
 * show: across the local corpus, 528 attachment/message pairings sit at a gap of
 * zero, and every larger gap observed is 13 rows or more with assistant turns inside
 * it — a different fire, not a split pair. So two signals merge only when they are
 * neighbours and of different kinds.
 *
 * An earlier rule here merged instead on "the agent has spoken since the last
 * signal". That is unsafe in the direction that matters: a turn which returned an
 * empty answer produces two fires with no assistant turn between them, and the rule
 * would silently fold the second into the first — hiding an ignored fire, the one
 * outcome this must never miss. It is also the negation of the livelock the sibling
 * assertion guards, so the invariant it assumed is one the suite exists to disprove.
 *
 * @param {Object[]} transcript
 * @returns {number[]}
 */
function stopFeedbackIndices(transcript) {
  const kind = (row) => (row.type === "attachment" ? "attachment" : "message");
  const hits = [];
  let last = -2;
  let lastKind = null;
  let alreadyPaired = false;
  for (const [i, row] of transcript.entries()) {
    if (!isStopFeedback(row)) {
      continue;
    }
    // A fire absorbs at most one partner. Without that cap, a run of adjacent signals
    // from consecutive fires chains into a single window — each row pairing with the
    // one before it — and the fires after the first disappear.
    const partner = i === last + 1 && kind(row) !== lastKind && !alreadyPaired;
    if (partner) {
      alreadyPaired = true;
    } else {
      hits.push(i);
      alreadyPaired = false;
    }
    last = i;
    lastKind = kind(row);
  }
  return hits;
}

/**
 * Whether this tool call is the agent acting on a fired capture reason.
 *
 * Deliberately wider than "wrote to the graph", because declining is a correct
 * outcome and leaves no write behind. Two shapes produce that, and measurement on
 * real fires found both: a confirmation-mode fire ends at `AskUserQuestion` when the
 * user skips the subject, and a deduplication ends at a graph *search* that finds the
 * point already recorded. Neither writes, both are the agent doing exactly what the
 * reason asked.
 *
 * The dedup arm also has to accept a bare search with no `Skill` call in front of it.
 * The capture skill is usually already loaded in context by the time a fire lands, so
 * the agent runs the dedup directly and no `Skill` row is ever emitted — an observer
 * requiring one scores a correct decline as a dead routing path.
 *
 * @param {Object} block
 * @returns {boolean}
 */
function actedOnCapture(block) {
  const target = `${block.name || ""} ${(block.input && block.input.skill) || ""}`;
  return (
    /memory-capture/.test(target) ||
    /add_(?:personal_)?memory/.test(target) ||
    /search_memory_(?:nodes|facts)/.test(target) ||
    block.name === "AskUserQuestion"
  );
}

/** Whether this tool call reached the graph. Strictly a write — the skill is not one. */
function wroteToGraph(block) {
  return /add_(?:personal_)?memory/.test(block.name || "");
}

/**
 * What the agent did after each Stop fire, one entry per fire, in order.
 *
 * This is the outcome `stopOutcomes()` cannot see. The hook's own log records that a
 * verdict fired and what its reason said; neither says whether the agent then did
 * anything. A reason naming two Insights, answered with a fresh verdict and no tool
 * call at all, is indistinguishable in that log from one that captured — which is the
 * whole of GP-924.
 *
 * Two counts rather than one, because two different questions are asked of this and
 * only one of them tolerates being pooled. `acted` answers "did the routing path do
 * anything", which is the regression guard and is true of a correct decline. `wrote`
 * answers "how often does a fire reach the graph", which is the baseline a change to
 * the hook's output channel has to be measured against — and a fraction cannot be
 * recovered from a pooled boolean, so the per-fire split is the point.
 *
 * Each window ends at the next fire or the next genuine user prompt, whichever comes
 * first. Without the fire bound, a later turn's capture is credited to an earlier fire
 * and a fire that went unanswered disappears. Without the prompt bound, the same
 * mis-credit survives across a turn boundary: an ignored fire followed by the user
 * moving on inherits the next turn's organic memory work and reads as answered.
 *
 * @param {Object[]} transcript
 * @returns {Array<{fired: number, acted: Object[], wrote: Object[]}>}
 */
function captureOutcomes(transcript) {
  const fires = stopFeedbackIndices(transcript);
  const prompts = userPromptIndices(transcript);
  return fires.map((fired, i) => {
    const nextFire = fires[i + 1] ?? transcript.length;
    const nextPrompt = prompts.find((index) => index > fired) ?? transcript.length;
    const uses = toolUses(transcript.slice(fired + 1, Math.min(nextFire, nextPrompt)));
    return { fired, acted: uses.filter(actedOnCapture), wrote: uses.filter(wroteToGraph) };
  });
}

/**
 * Every index at which the user themselves speaks — a prompt, not machinery.
 *
 * Exists as `captureOutcomes`'s second window bound. Three user-typed shapes are not
 * prompts, and each is excluded by what the transcript records rather than by guesswork:
 * tool results arrive as user rows whose blocks carry `content` rather than `text`, so
 * their text joins to the empty string; CLI-injected rows (hook feedback, compaction
 * notes) are marked `isMeta`; and any Stop hook's fired reason — not only ours — opens
 * with the "Stop hook feedback:" prefix, which covers an injected fire even where the
 * marker is missing.
 *
 * @param {Object[]} transcript
 * @returns {number[]}
 */
function userPromptIndices(transcript) {
  const indices = [];
  for (const [i, row] of transcript.entries()) {
    if (row.type !== "user" || !row.message || row.isMeta) {
      continue;
    }
    const content = row.message.content;
    const blocks = Array.isArray(content) ? content : [{ text: content }];
    const text = blocks
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .join("");
    if (text && !text.startsWith("Stop hook feedback:")) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Every tool call in which the agent acted on a fired reason, across all fires.
 *
 * Scoped to after a fire deliberately: work the agent began on its own initiative
 * beforehand is real, but it is not evidence that the routing path did anything, and
 * counting it would let a guard pass on precisely the session it exists to fail.
 *
 * @param {Object[]} transcript
 * @returns {Object[]}
 */
function captureAttempts(transcript) {
  return captureOutcomes(transcript).flatMap((outcome) => outcome.acted);
}

/**
 * Everything the tools handed back, as one string.
 *
 * Needed to assert that a documented command *worked*, not merely that it was run —
 * a wrong path or an unexpanded `${CLAUDE_PLUGIN_DATA}` still produces a tool_use.
 * The content is a string on some rows and an array of parts on others, so both are
 * flattened here rather than at each call site.
 *
 * @param {Object[]} transcript
 * @returns {string}
 */
function toolResultText(transcript) {
  return transcript
    .filter((row) => row.message && Array.isArray(row.message.content))
    .flatMap((row) => row.message.content)
    .filter((block) => block && block.type === "tool_result")
    .flatMap((block) => {
      const content = block.content;
      if (typeof content === "string") {
        return [content];
      }
      if (Array.isArray(content)) {
        return content.map((part) => (part && typeof part.text === "string" ? part.text : ""));
      }
      return [];
    })
    .join("\n");
}

module.exports = {
  BILLABLE_ENV_KEYS,
  COMPANION_PLUGIN_NAME,
  DEFAULT_DISALLOWED_TOOLS,
  DEFAULT_MODEL,
  PLUGIN_DATA_ROOT,
  PLUGIN_DIR,
  PROJECTS_ROOT,
  REPO_ROOT,
  additionalContextEvents,
  buildArgs,
  captureAttempts,
  captureOutcomes,
  claudeVersion,
  createCompanionPlugin,
  createProject,
  findSessionStateFile,
  findTranscript,
  hookAttachments,
  hookCompletions,
  invocationLogSizes,
  isStopFeedback,
  inlineDataDir,
  listSessionFiles,
  parseResultJson,
  plantSessionFile,
  pluginName,
  promptHookEvaluations,
  realDir,
  readJsonQuiet,
  readTranscript,
  removeDir,
  runClaude,
  runClaudeStream,
  sessionStartEvents,
  stopFeedbackIndices,
  stopHookActiveStates,
  stopJudgements,
  stopOutcomes,
  stopVerdicts,
  subscriptionSafeEnv,
  toolResultText,
  toolUses,
  withPlantedConfig,
};
