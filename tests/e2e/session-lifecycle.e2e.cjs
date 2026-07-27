#!/usr/bin/env node
/**
 * GP-863 end-to-end: prove the session lifecycle hooks work in a real Claude
 * Code session, not just in unit tests.
 *
 * One headless `claude -p` run produces three independent artifacts, and every
 * assertion below reads one of them:
 *
 *   1. the CLI debug log      — which hooks Claude Code registered and ran
 *   2. ${CLAUDE_PLUGIN_DATA}  — the state SessionStart/SessionEnd actually wrote
 *   3. the session transcript — how hook output reached the conversation
 *
 * Cost and prerequisites: one run of a few cents on Haiku, against the machine's
 * logged-in Claude subscription. Not part of `npm test`; see tests/e2e/README.md.
 *
 * Run with: npm run test:e2e
 */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const {
  BILLABLE_ENV_KEYS,
  PLUGIN_DATA_ROOT,
  REPO_ROOT,
  claudeVersion,
  createProject,
  hookAttachments,
  inlineDataDir,
  plantSessionFile,
  removeDir,
  runClaude,
  subscriptionSafeEnv,
} = require("./lib/claude-run.cjs");

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const USER_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

/**
 * Files the fixture project is allowed to contain after a run: the two copied
 * from the fixture, plus the debug log the harness asks for and the `latest`
 * symlink Claude Code drops beside it. The last two are the CLI's own doing —
 * they appear with `--debug-file` and not otherwise — so they say nothing about
 * where the plugin writes.
 */
const EXPECTED_PROJECT_FILES = new Set([
  "CLAUDE.md",
  "settings.json",
  "claude-debug.log",
  "latest",
]);

function hashFile(file) {
  if (!fs.existsSync(file)) {
    return "<absent>";
  }
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Every file under a directory tree, as paths relative to it. */
function walk(dir, base = dir, found = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, found);
    } else {
      found.push(path.relative(base, full));
    }
  }
  return found;
}

const version = claudeVersion();

describe(
  "GP-863 session lifecycle: real claude -p session",
  { skip: version ? false : "the `claude` CLI is not available on PATH", timeout: 360000 },
  () => {
    let projectDir;
    let run;
    let staleBait;
    let freshBait;
    let userSettingsBefore;

    before(
      async () => {
        projectDir = createProject("lifecycle");

        // The TTL sweep runs on SessionStart, before the session record is
        // written, so the bait has to be in place before the CLI launches. It
        // goes in the dir a --plugin-dir load uses; the test below asserts the
        // run actually resolved to that dir, so a convention change fails loudly
        // instead of quietly skipping the check.
        const dataDir = inlineDataDir();
        staleBait = plantSessionFile(dataDir, "e2e-stale-bait", SESSION_TTL_MS * 2);
        freshBait = plantSessionFile(dataDir, "e2e-fresh-bait", 0);

        userSettingsBefore = hashFile(USER_SETTINGS);

        run = await runClaude({
          projectDir,
          prompt: "Reply with exactly: pong",
        });
      },
      { timeout: 340000 }
    );

    after(() => {
      for (const bait of [staleBait, freshBait]) {
        try {
          fs.rmSync(bait, { force: true });
        } catch {
          /* best effort */
        }
      }
      if (projectDir) {
        removeDir(projectDir);
      }
    });

    it("runs on the subscription, never on an API key (R36)", () => {
      const env = subscriptionSafeEnv();
      for (const key of BILLABLE_ENV_KEYS) {
        assert.equal(env[key], undefined, `${key} must not reach the child process`);
      }
    });

    it("completes successfully", () => {
      assert.equal(run.code, 0, `claude exited ${run.code}\nstderr: ${run.stderr}`);
      assert.ok(run.result, `no result envelope in stdout:\n${run.stdout.slice(0, 800)}`);
      assert.equal(run.result.is_error, false);
      assert.ok(run.sessionId, "result envelope carried no session_id");
    });

    it("loads the plugin from this working tree, shadowing any installed copy", () => {
      const loads = run.debug
        .split("\n")
        .filter((line) => /Read hooks\.json for plugin gutt-claude-code-plugin/.test(line));
      assert.equal(
        loads.length,
        1,
        `expected exactly one gutt plugin to load, got ${loads.length}:\n${loads.join("\n")}`
      );
      assert.match(
        loads[0],
        new RegExp(REPO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "the loaded hooks.json is not the one in this repo"
      );
      assert.match(run.debug, /Registered \d+ hooks from \d+ plugins/);
    });

    it("backgrounds the connectivity probe instead of blocking SessionStart", () => {
      // `async: true` in hooks.json — the slow MCP probe must not sit in front of
      // the user's first prompt.
      assert.match(
        run.debug,
        /Hooks: Config-based async hook, backgrounding process async_hook_\d+/,
        "SessionStart's async hook was not backgrounded"
      );
      assert.match(
        run.debug,
        /Registering async hook async_hook_\d+ \(SessionStart:startup\)/,
        "the backgrounded hook was not the SessionStart one"
      );
    });

    it("writes session state under CLAUDE_PLUGIN_DATA, keyed by session id", () => {
      assert.ok(run.stateFile, `no session state file for ${run.sessionId}`);
      assert.equal(path.basename(run.stateFile), `${run.sessionId}.json`);
      assert.equal(
        run.dataDir,
        inlineDataDir(),
        "a --plugin-dir load resolved to an unexpected data dir"
      );
      assert.ok(
        run.stateFile.startsWith(PLUGIN_DATA_ROOT + path.sep),
        "state escaped the plugin data root"
      );
    });

    it("records the SessionStart matcher as the session source", () => {
      assert.equal(run.state.source, "startup");
      assert.equal(run.state.sessionId, run.sessionId);
      assert.ok(
        Number.isFinite(Date.parse(run.state.startedAt)),
        `startedAt is not a timestamp: ${run.state.startedAt}`
      );
    });

    it("arms firstPromptPending during the session for the GP-864 guard", () => {
      // The flag is transient: SessionStart sets it, SessionEnd clears it. Only a
      // sample taken while the session was live can show it was ever set, which
      // is why the harness polls.
      const armed = run.samples.filter((entry) => entry.state.firstPromptPending === true);
      assert.ok(
        armed.length > 0,
        `firstPromptPending was never observed set across ${run.samples.length} samples`
      );
      assert.equal(armed[0].state.compacted, false, "a startup session must not look compacted");
    });

    it("persists the async connectivity probe's verdict", () => {
      // The connectivity hook and session-start.cjs write this file in parallel;
      // before the write lock, the probe's result was silently lost and
      // connectionStatus stayed "unknown" even when the probe had plainly
      // succeeded.
      //
      // This is a smoke check, not the regression guard. The real interleaving is
      // intermittent — measured at roughly 1 run in 4, and a control run with the
      // lock disabled passed this assertion. The deterministic guard is
      // "no update is lost when processes contend for one session file" in
      // tests/session-lifecycle.test.cjs, which forces the window open and fails
      // every time without the lock. What this adds is the confirmation that the
      // lock holds under real hook scheduling.
      assert.ok(
        Number.isFinite(Date.parse(run.state.connectionCheckedAt)),
        "the connectivity hook's write never reached disk"
      );
      assert.equal(typeof run.state.mcpConfigured, "boolean");
      if (run.state.mcpConfigured && run.state.mcpUrl) {
        assert.equal(
          run.state.connectionStatus,
          "ok",
          "MCP is configured but the probe's verdict was clobbered"
        );
      }
      // Both SessionStart writers plus SessionEnd landed, in some order.
      assert.ok(
        run.state.rev >= 3,
        `expected at least 3 serialised writes, saw rev=${run.state.rev}`
      );
    });

    it("finalizes the session on SessionEnd", () => {
      assert.match(
        run.debug,
        /SessionEnd:\w+ \[[^\]]*session-end\.cjs[^\]]*\] completed with status 0/,
        "session-end.cjs did not run cleanly"
      );
      assert.ok(
        Number.isFinite(Date.parse(run.state.endedAt)),
        `endedAt was not set: ${run.state.endedAt}`
      );
      assert.equal(typeof run.state.endReason, "string");
      assert.ok(run.state.endReason.length > 0);
      assert.equal(run.state.firstPromptPending, false, "SessionEnd must disarm the flag");
      assert.equal(run.state.compacted, false);
    });

    it("records the lesson-capture prompt in state rather than a marker file", () => {
      assert.ok(
        Number.isFinite(Date.parse(run.state.lessonsPromptedAt)),
        "the Stop hook did not record its prompt in session state"
      );
      const markers = walk(run.dataDir).filter(
        (rel) => rel.endsWith(".lessons-prompted") || rel.includes("statusline-configured")
      );
      assert.deepEqual(markers, [], `retired marker files reappeared: ${markers.join(", ")}`);
    });

    it("sweeps stale session files on SessionStart and spares fresh ones", () => {
      assert.equal(
        fs.existsSync(staleBait),
        false,
        "a session file older than the 24h TTL survived the sweep"
      );
      assert.equal(fs.existsSync(freshBait), true, "the sweep reclaimed a fresh session file");
    });

    it("leaves no runtime state in the project directory (AC3)", () => {
      const unexpected = walk(projectDir).filter((rel) => !EXPECTED_PROJECT_FILES.has(rel));
      assert.deepEqual(
        unexpected,
        [],
        `the plugin wrote outside CLAUDE_PLUGIN_DATA: ${unexpected.join(", ")}`
      );
    });

    it("never touches the user's settings.json (AC3)", () => {
      // The retired sessionstart-setup.cjs wrote a statusline command into this
      // file, and stored a session-scoped path that died with the session.
      assert.equal(
        hashFile(USER_SETTINGS),
        userSettingsBefore,
        "the session modified the user's global settings.json"
      );
    });

    it("surfaces hook output in the Claude session transcript", () => {
      assert.ok(run.transcriptFile, `no transcript found for session ${run.sessionId}`);
      const attachments = hookAttachments(run.transcript);
      assert.ok(attachments.length > 0, "the transcript recorded no hook activity");

      const prompt = attachments.find((a) => a.hookEvent === "UserPromptSubmit");
      assert.ok(prompt, "UserPromptSubmit left no record in the transcript");
      assert.equal(prompt.type, "hook_success");
      assert.equal(prompt.exitCode, 0);
      assert.match(prompt.content, /search organizational memory/i);

      const stop = attachments.find((a) => a.hookEvent === "Stop");
      assert.ok(stop, "the Stop hook left no record in the transcript");
      assert.match(
        stop.blockingError.blockingError,
        /capturing lessons learned/i,
        "the Stop hook blocked for an unexpected reason"
      );
    });

    it("keeps the prompt hook inside its 2s latency budget (R25)", () => {
      const prompt = hookAttachments(run.transcript).find(
        (a) => a.hookEvent === "UserPromptSubmit" && typeof a.durationMs === "number"
      );
      assert.ok(prompt, "no timed UserPromptSubmit record to measure");
      assert.ok(
        prompt.durationMs < 2000,
        `UserPromptSubmit took ${prompt.durationMs}ms, over the 2s budget`
      );
    });
  }
);
