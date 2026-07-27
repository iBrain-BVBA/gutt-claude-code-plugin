#!/usr/bin/env node
/**
 * Architectural guards over the hook set (GP-844).
 *
 * The 3.0 rebuild collapsed 13 hook scripts into 5 thin routers plus one prompt
 * hook. Nothing in the runtime enforces that shape, and every constraint below
 * is one the platform will happily let us violate — silently, and in a way that
 * only shows up as a stalled session or a destroyed prompt in someone's
 * terminal. These are cheap static checks that fail the build instead.
 *
 * Run: node --test tests/hook-architecture.test.cjs
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PLUGIN_DIRS = ["gutt-core", "auto-lint-plugin"];

/** Every handler in a plugin's hooks.json, flattened and tagged with its event. */
function handlers(pluginDir) {
  const file = path.join(ROOT, pluginDir, "hooks", "hooks.json");
  if (!fs.existsSync(file)) {
    return [];
  }
  const { hooks = {} } = JSON.parse(fs.readFileSync(file, "utf8"));
  return Object.entries(hooks).flatMap(([event, matchers]) =>
    matchers.flatMap((m) => (m.hooks || []).map((h) => ({ ...h, event, pluginDir })))
  );
}

const ALL = PLUGIN_DIRS.flatMap(handlers);

/**
 * Lines that are neither blank nor comment. Total line count is the wrong
 * metric for this codebase — the house style is comment-heavy on purpose, and a
 * cap on it would push explanation out of the files that most need it.
 *
 * Naive about `//` and block delimiters inside string literals. That can only
 * ever *under*count, so the cap stays conservative; a hook that trips it is
 * over the limit either way.
 */
function codeLines(file) {
  let inBlock = false;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((raw) => {
      const line = raw.trim();
      if (inBlock) {
        inBlock = !line.includes("*/");
        return false;
      }
      if (line.startsWith("/*")) {
        inBlock = !line.includes("*/");
        return false;
      }
      return line !== "" && !line.startsWith("//");
    }).length;
}

describe("hook architecture guards", () => {
  it("discovers the hook set (a silent zero would vacuously pass everything below)", () => {
    assert.ok(ALL.length >= 5, `expected the full hook set, found ${ALL.length}`);
  });

  // docs/hooks.md: "Agent hooks are experimental. Behavior and configuration may
  // change... For production workflows, prefer command hooks." One fire can also
  // burn up to 50 subagent turns.
  it("ships no experimental agent hooks", () => {
    const agents = ALL.filter((h) => h.type === "agent");
    assert.deepEqual(agents, [], `agent hooks are not production-safe: ${JSON.stringify(agents)}`);
  });

  // A prompt hook's only channel back is {ok, reason}. On UserPromptSubmit,
  // ok:false means the prompt is "prevented from being processed and erased from
  // context", the turn ends regardless of `continue`, and `reason` is shown to
  // the user but never added to context. So the two available outcomes there are
  // "silently allow" and "destroy the user's prompt" — routing has to be a
  // command hook emitting additionalContext instead.
  it("uses no prompt hook on UserPromptSubmit, where blocking erases the prompt", () => {
    const bad = ALL.filter((h) => h.event === "UserPromptSubmit" && h.type === "prompt");
    assert.deepEqual(bad, [], "a prompt hook on UserPromptSubmit can only allow or destroy");
  });

  // Stop is the inverse: on ok:false "the reason is fed back to Claude as its
  // next instruction and the turn continues" — routing with no lost work. If
  // this ever becomes a command hook again we are back to judging in regex (R11).
  it("keeps the Stop judgement in a prompt hook, not a script", () => {
    const stop = ALL.filter((h) => h.event === "Stop");
    assert.equal(stop.length, 1, "exactly one Stop handler");
    assert.equal(stop[0].type, "prompt");
  });

  // The whole point of the rebuild: procedure lives in skills, hooks only route.
  // 60 is set just above session-start.cjs, the largest surviving router — tight
  // enough that behavior creeping back into a hook trips it.
  it("keeps every gutt-core hook a thin router (≤60 code lines)", () => {
    const dir = path.join(ROOT, "gutt-core", "hooks");
    const oversized = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".cjs"))
      .map((f) => ({ file: f, lines: codeLines(path.join(dir, f)) }))
      .filter((h) => h.lines > 60);
    assert.deepEqual(
      oversized,
      [],
      `behavior belongs in a skill, not a hook: ${JSON.stringify(oversized)}`
    );
  });

  // Every command handler must name a file that exists. hooks.json is data, so a
  // renamed script fails at session start with no build-time warning.
  it("points every command handler at a script that exists", () => {
    const missing = ALL.filter((h) => h.type === "command").flatMap((h) => {
      const rel = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/.exec(h.command);
      const abs = rel && path.join(ROOT, h.pluginDir, rel[1]);
      return abs && fs.existsSync(abs) ? [] : [h.command];
    });
    assert.deepEqual(missing, []);
  });
});
