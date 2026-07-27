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

// Skipping is the default because this tier needs a working CLI and a logged-in
// subscription, which a contributor may not have. But a skip that reports
// `tests 0 / pass 0 / fail 0` and exit 0 is indistinguishable from a suite that
// ran and passed — so anywhere this is meant to be a gate (CI, a release check),
// set GUTT_E2E_REQUIRED=1 and an unusable CLI becomes a hard failure instead of
// silence. `claudeVersion()` returns null for a missing binary *and* for one
// that exits non-zero or hangs, so this also catches a broken install.
if (!version && process.env.GUTT_E2E_REQUIRED === "1") {
  throw new Error(
    "GUTT_E2E_REQUIRED=1 but the `claude` CLI is unusable (missing from PATH, " +
      "non-zero exit, or timed out) — refusing to report a green run that asserted nothing"
  );
}

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
      // Asserts against the environment the child was actually handed. Calling
      // subscriptionSafeEnv() here instead would be a tautology: it would check
      // that the scrubber scrubs, and stay green even if runClaude spawned with
      // process.env untouched.
      assert.ok(run.childEnv, "the harness must record the env it spawned with");
      for (const key of BILLABLE_ENV_KEYS) {
        assert.equal(run.childEnv[key], undefined, `${key} must not reach the child process`);
      }
      // And the scrub list has to still cover the vars that cost money.
      for (const key of [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
      ]) {
        assert.ok(BILLABLE_ENV_KEYS.includes(key), `${key} dropped out of the scrub list`);
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

    it("leaves a trivial turn alone and writes nothing for it", () => {
      // The Stop judgement is a prompt hook now (GP-844): it does no file I/O at
      // all, and on a turn worth nothing durable — this one asks for the word
      // "pong" — it must answer ok:true and stay silent. A Stop hook that fires
      // on everything is the 2.x nag in new wording, so the silence *is* the
      // assertion here, not the absence of one.
      const blocked = hookAttachments(run.transcript).filter(
        (a) => a.hookEvent === "Stop" && a.blockingError
      );
      assert.deepEqual(blocked, [], "the Stop hook interrupted a turn that produced nothing");

      // The retired marker formats stay retired, and the state contract no longer
      // carries the lesson-capture field they used to migrate into.
      const markers = walk(run.dataDir).filter(
        (rel) => rel.endsWith(".lessons-prompted") || rel.includes("statusline-configured")
      );
      assert.deepEqual(markers, [], `retired marker files reappeared: ${markers.join(", ")}`);
      assert.equal(run.state.lessonsPromptedAt, undefined, "a retired field is back in state");
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

    it("injects the memory pointer as context, not as text the model surfaces", () => {
      assert.ok(run.transcriptFile, `no transcript found for session ${run.sessionId}`);
      const attachments = hookAttachments(run.transcript);
      assert.ok(attachments.length > 0, "the transcript recorded no hook activity");

      const prompt = attachments.find((a) => a.hookEvent === "UserPromptSubmit");
      assert.ok(prompt, "UserPromptSubmit left no record in the transcript");
      // Not `hook_success`: a hook returning additionalContext is recorded under
      // its own attachment type, whose payload is {type, content, hookName,
      // toolUseID, hookEvent} — no exitCode, no stdout, no durationMs. `content`
      // is an array of strings here, where hook_success carried a bare string.
      assert.equal(prompt.type, "hook_additional_context");
      const injected = [].concat(prompt.content).join("\n");
      assert.match(injected, /organizational memory available through gutt/i);

      // The CLI's own account of what it did with the hook's stdout. Without
      // this, a hook whose JSON was rejected outright would still leave a
      // plausible-looking transcript row.
      assert.match(
        run.debug,
        /Hook UserPromptSubmit \([^)]*user-prompt-submit\.cjs[^)]*\) provided additionalContext \(\d+ chars\)/,
        "the CLI did not accept the hook's output as additionalContext"
      );

      // GP-868, and why the phrasing is load-bearing rather than cosmetic: the
      // docs warn that imperative out-of-band-command framing "can trigger
      // Claude's prompt-injection defenses, which causes Claude to surface the
      // text to you instead of treating it as context."
      assert.doesNotMatch(
        injected,
        /MANDATORY|you MUST|NOT optional|CRITICAL violation|NEVER skip/i,
        "the injected context reads as an out-of-band system command"
      );

      // The check itself. The fixture prompt asks for one word, so a model that
      // treated the injection as an instruction — or flagged it as suspicious —
      // would answer with something about memory instead. This is the failure
      // mode the 2.x phrasing was plausibly hitting.
      const reply = String(run.result.result);
      assert.match(reply, /pong/i, `the model answered something else entirely: ${reply}`);
      assert.doesNotMatch(
        reply,
        /memory|gutt|skill|instruction/i,
        `the model surfaced the injected context instead of consuming it: ${reply}`
      );
    });

    // There is deliberately no R25 assertion at this tier any more. Claude Code's
    // own per-hook `durationMs` only ever arrived on `hook_success` attachments,
    // and a hook returning additionalContext produces `hook_additional_context`
    // instead, which has no timing field. The debug log has none either: its four
    // UserPromptSubmit lines cover response *handling* and span ~5ms, so a budget
    // check against them would pass no matter how slow the hook actually was.
    //
    // R25 is measured in-process by tests/session-lifecycle.test.cjs, which is the
    // only tier that can subtract Node's interpreter floor (~47ms p50 on this
    // machine, already over the 50ms budget before any of our code runs).
  }
);
