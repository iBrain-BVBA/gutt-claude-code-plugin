/**
 * The nested-run guard (GP-866).
 *
 * The judge subprocess is non-bare, so it loads this plugin and re-enters these
 * hooks. These tests spawn each hook for real with the guard set and assert it
 * produces nothing and touches nothing — the unit-tier half of the claim. The
 * recursion itself needs an installed plugin to reproduce and is asserted in the
 * e2e tier; see `docs/headless-cli-reference.md` §2.
 */

const { test, describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { NESTED_ENV_VAR, isNestedRun, childEnv } = require("../shared/nested-run.cjs");

const HOOKS = path.join(__dirname, "..", "gutt-core", "hooks");

/** Every gutt-core hook registered as a `command`. The guard must cover all of them. */
const COMMAND_HOOKS = [
  "session-start.cjs",
  "session-connectivity.cjs",
  "session-end.cjs",
  "user-prompt-submit.cjs",
  "post-memory-search.cjs",
];

describe("nested-run: the predicate", () => {
  it('reads only an exact "1"', () => {
    assert.equal(isNestedRun({}), false);
    assert.equal(isNestedRun({ [NESTED_ENV_VAR]: "1" }), true);
    // Anything else is not the guard. A loose truthiness check here would make a
    // stray "0" or "false" in someone's shell profile disable the plugin outright.
    for (const value of ["0", "", "true", "yes", "01", " 1"]) {
      assert.equal(isNestedRun({ [NESTED_ENV_VAR]: value }), false, `"${value}" is not the guard`);
    }
  });

  it("marks the child environment without discarding the parent's", () => {
    const env = childEnv({}, { PATH: "/usr/bin", HOME: "/home/x" });
    assert.equal(env[NESTED_ENV_VAR], "1");
    assert.equal(env.PATH, "/usr/bin", "PATH survives");
    assert.equal(env.HOME, "/home/x", "HOME survives");
  });

  it("keeps the user's own credentials, deliberately", () => {
    // R36's scrubbing belongs to tests/e2e/lib/claude-run.cjs, not here. Someone
    // authenticating *with* an API key and no OAuth needs it to reach the child, and
    // an unauthenticated judge fails silently (hook-platform-capabilities.md §5), so
    // scrubbing would disable the judge for those users rather than save them money.
    const env = childEnv({}, { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: "https://x" });
    assert.equal(env.ANTHROPIC_API_KEY, "sk-test");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://x");
  });

  it("cannot be overridden to off by the extra argument", () => {
    // The guard is the one thing a caller must not be able to unset by accident.
    const env = childEnv({ [NESTED_ENV_VAR]: "0" }, {});
    assert.equal(env[NESTED_ENV_VAR], "1");
  });
});

describe("nested-run: every command hook honours it", () => {
  let dataDir;
  const originalDataDir = process.env.CLAUDE_PLUGIN_DATA;

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-nested-"));
  });

  after(() => {
    if (originalDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = originalDataDir;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  for (const hook of COMMAND_HOOKS) {
    it(`${hook} exits 0, silent, and writes nothing`, () => {
      const scratch = fs.mkdtempSync(path.join(dataDir, "run-"));
      const payload = JSON.stringify({
        session_id: "nested-probe-session",
        source: "startup",
        prompt: "anything at all",
        tool_name: "mcp__gutt__search_memory_nodes",
        reason: "other",
        transcript_path: "/nonexistent",
      });

      const stdout = execFileSync("node", [path.join(HOOKS, hook)], {
        input: payload,
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, CLAUDE_PLUGIN_DATA: scratch, [NESTED_ENV_VAR]: "1" },
      });

      assert.equal(stdout, "", "a nested hook emits no context");
      // The strong claim: not just silent, but no side effects. Anything created here
      // would be a judge subprocess writing into the real session's state directory.
      assert.deepEqual(fs.readdirSync(scratch), [], `${hook} wrote into CLAUDE_PLUGIN_DATA`);
    });
  }
});

describe("nested-run: the guard cannot be forgotten", () => {
  it("every gutt-core command hook in hooks.json checks it", () => {
    // A new hook that skips the guard reintroduces the recursion, and nothing else
    // would notice: the hook would work fine in every ordinary session.
    const registered = [];
    const manifest = JSON.parse(fs.readFileSync(path.join(HOOKS, "hooks.json"), "utf8"));
    for (const entries of Object.values(manifest.hooks || {})) {
      for (const entry of entries) {
        for (const hook of entry.hooks || []) {
          if (hook.type !== "command") {
            continue;
          }
          const match = /([\w-]+\.cjs)/.exec(hook.command || "");
          if (match) {
            registered.push(match[1]);
          }
        }
      }
    }

    assert.ok(registered.length > 0, "found no command hooks to check — parser is wrong");
    assert.deepEqual(
      [...registered].sort(),
      [...COMMAND_HOOKS].sort(),
      "hooks.json and this test's list disagree; add the new hook to both"
    );

    for (const hook of registered) {
      const source = fs.readFileSync(path.join(HOOKS, hook), "utf8");
      assert.match(source, /isNestedRun/, `${hook} does not check the nested-run guard`);
    }
  });
});

test("the shared lib is symlinked, not copied", () => {
  // check:shared enforces this across the repo; asserted here too because this lib
  // is new and a copy would drift silently.
  const link = path.join(HOOKS, "lib", "nested-run.cjs");
  assert.equal(
    fs.realpathSync(link),
    fs.realpathSync(path.join(__dirname, "..", "shared", "nested-run.cjs"))
  );
});
