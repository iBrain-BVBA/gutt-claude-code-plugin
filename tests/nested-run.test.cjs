/**
 * The nested-run guard (GP-866).
 *
 * The judge subprocess is non-bare, so it loads this plugin and re-enters these
 * hooks. These tests spawn each hook for real with the guard set and assert it
 * produces nothing and touches nothing — the unit-tier half of the claim.
 *
 * The other half — that the env var actually survives into a non-bare child which
 * really would re-enter these hooks — needs an *installed* plugin to reproduce and
 * is **not asserted anywhere yet**. This comment previously said it was covered in
 * the e2e tier; it is not, and `docs/headless-cli-reference.md` Follow-up 2 says as
 * much ("Still untested"). A reader who checked the reference found reassurance
 * instead of the gap, which is worse than no citation. The run that would settle it
 * is sketched as run 7 in `docs/e2e-hook-test-plan.md`.
 *
 * Note the trap that makes this easy to fake: under `--plugin-dir` the child has no
 * copy of the hook to re-enter, so the guard never fires and a test built that way
 * passes while asserting nothing.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { NESTED_ENV_VAR, isNestedRun, childEnv } = require("../gutt-core/hooks/lib/nested-run.cjs");

const HOOKS = path.join(__dirname, "..", "gutt-core", "hooks");

/** Every gutt-core hook registered as a `command`. The guard must cover all of them. */
const COMMAND_HOOKS = [
  "session-start.cjs",
  "session-connectivity.cjs",
  "session-end.cjs",
  "user-prompt-submit.cjs",
  "post-memory-search.cjs",
  // Stop became a command hook in GP-866. It is the hook the guard exists for: it is the
  // one that spawns the child, so an unguarded copy of it in the child spawns another.
  "stop-capture.cjs",
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

  it("strips the host authentication handover when the descriptor is present", () => {
    // A host holding the session credential tells its direct child to read the token from
    // a descriptor and not to log in. One hop down, neither is true: the descriptor is not
    // in this process, and the instruction not to log in is all that is left — so the child
    // waits for a token that cannot arrive and exits without judging anything.
    //
    // The names are written out here rather than imported from the module on purpose. They
    // are a contract with the platform, and a test that imported the list would pass just
    // as happily if the wrong variable were added to it.
    const env = childEnv(
      {},
      {
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
        CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
        CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: "1",
        CLAUDE_CONFIG_DIR: "/tmp/per-session-root",
        HOME: "/home/x",
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-test",
      }
    );
    for (const key of [
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
      "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
      "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
      "CLAUDE_CONFIG_DIR",
    ]) {
      assert.equal(env[key], undefined, `${key} must not reach the child`);
    }
    // Removing the handover is only useful because the child can then authenticate on its
    // own, which these are what it needs to do that.
    assert.equal(env.HOME, "/home/x", "HOME is how the child finds its own credentials");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-test", "R36's exception still applies");
    assert.equal(env[NESTED_ENV_VAR], "1", "the recursion guard must survive the strip");
  });

  it("removes nothing when the descriptor variable is absent", () => {
    // This is the case that protects the surface where nothing is broken. A host whose
    // handover *does* survive a spawn still sets CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, and
    // automatic capture works there — so an unconditional strip would break the one place
    // that needs no fixing. Keying on the descriptor is what keeps this change away from it.
    const base = {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CONFIG_DIR: "/somewhere/real",
      PATH: "/usr/bin",
    };
    assert.deepEqual(childEnv({}, base), { ...base, [NESTED_ENV_VAR]: "1" });
  });

  it("reads an empty descriptor value as no handover at all", () => {
    // A variable that is set but empty names no descriptor. Stripping a configuration root
    // on the strength of that would be acting on noise.
    const env = childEnv(
      {},
      { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "", CLAUDE_CONFIG_DIR: "/somewhere/real" }
    );
    assert.equal(env.CLAUDE_CONFIG_DIR, "/somewhere/real");
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

// The real-file assertion that used to sit here covered this one lib. It now runs over
// every lib in every plugin, in tests/hook-architecture.test.cjs — a per-file spot check
// left the other twelve unasserted.
