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
 * @returns {Promise<Object>} the run record
 */
function runClaude(options) {
  const {
    projectDir,
    prompt,
    model = DEFAULT_MODEL,
    pluginDir = PLUGIN_DIR,
    disallowedTools = DEFAULT_DISALLOWED_TOOLS,
    timeoutMs = 240000,
    pollMs = 40,
  } = options;

  const debugFile = path.join(projectDir, "claude-debug.log");
  const settingsFile = path.join(projectDir, "settings.json");
  const args = [
    "-p",
    prompt,
    "--plugin-dir",
    pluginDir,
    "--settings",
    settingsFile,
    "--debug-file",
    debugFile,
    "--output-format",
    "json",
    "--model",
    model,
  ];
  if (disallowedTools.length > 0) {
    args.push("--disallowed-tools", ...disallowedTools);
  }

  // Files present before the run are not ours; only newly appearing session
  // files get sampled.
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
  claudeVersion,
  createProject,
  findSessionStateFile,
  findTranscript,
  hookAttachments,
  inlineDataDir,
  listSessionFiles,
  parseResultJson,
  plantSessionFile,
  pluginName,
  readJsonQuiet,
  readTranscript,
  removeDir,
  runClaude,
  subscriptionSafeEnv,
};
