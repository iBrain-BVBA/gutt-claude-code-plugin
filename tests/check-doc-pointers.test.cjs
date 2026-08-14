#!/usr/bin/env node
/**
 * The doc-pointer guard's own red paths.
 *
 * `tests/check-doc-pointers.cjs` runs against this repository in `npm run test:all`
 * and in CI, where it must always pass — so nothing else in the suite ever sees it
 * fail. A guard whose failure path has never been executed is not yet a guard: it can
 * be broken into a permanent no-op and every run stays green. These build throwaway
 * plugin trees and assert it goes red on each way it is supposed to.
 *
 * Run: node --test tests/check-doc-pointers.test.cjs
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const GUARD = path.join(__dirname, "check-doc-pointers.cjs");

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/**
 * A throwaway marketplace with one plugin, and the guard copied in at the path it
 * expects.
 *
 * The guard resolves its ROOT as its own parent directory, so it has to be copied into
 * the fixture rather than invoked from this checkout — otherwise every case would read
 * the real repository and pass.
 *
 * `opts.ships` controls whether the plugin ships anything invocable, which is what the
 * scanned-nothing floor turns on.
 */
function tempTree(opts = {}) {
  const { ships = true } = opts;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doc-pointer-guard-")));

  write(
    path.join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ plugins: [{ name: "p1", source: "./p1" }] })
  );
  write(
    path.join(dir, "p1", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "p1", version: "1.0.0" })
  );

  if (ships) {
    write(path.join(dir, "p1", "commands", "setup.md"), "# setup\n");
    write(path.join(dir, "p1", "commands", "on.md"), "# on\n");
    write(path.join(dir, "p1", "skills", "memory-search", "SKILL.md"), "# memory-search\n");
  }

  // At least one scanned file must always exist, or the floor fires for the wrong
  // reason and a case would pass without exercising what it names.
  write(path.join(dir, "p1", "agents", "placeholder.md"), "# an agent\n");

  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.copyFileSync(GUARD, path.join(dir, "tests", "check-doc-pointers.cjs"));

  return {
    dir,
    prose: (text) => write(path.join(dir, "p1", "skills", "memory-search", "SKILL.md"), text),
    docs: (text) => write(path.join(dir, "docs", "team-onboarding.md"), text),
    run: () => {
      const r = spawnSync(process.execPath, [path.join(dir, "tests", "check-doc-pointers.cjs")], {
        encoding: "utf8",
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    },
  };
}

describe("the doc-pointer guard's red paths", () => {
  it("passes when every reference names its plugin", () => {
    const t = tempTree();
    t.prose("Run `/p1:setup`, then `/p1:memory-search` when you need context.\n");
    const { code, out } = t.run();
    assert.equal(code, 0, out);
    assert.match(out, /every slash reference resolves/);
  });

  it("fails a bare reference whose stem is shipped, and names the fix", () => {
    const t = tempTree();
    t.prose("Run `/memory-search` when you need context.\n");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /`\/memory-search` is missing its plugin name/);
    assert.match(out, /write `\/p1:memory-search`/);
  });

  it("fails a namespaced reference that resolves to nothing shipped", () => {
    const t = tempTree();
    t.prose("Run `/p1:no-such-thing` to begin.\n");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /`\/p1:no-such-thing` resolves to nothing shipped/);
  });

  it("scans the install docs, not only the plugins", () => {
    const t = tempTree();
    t.prose("All good here: `/p1:setup`.\n");
    t.docs("First, run `/setup` to connect.\n");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /team-onboarding\.md/);
  });

  it("fails rather than passes when it has nothing to check", () => {
    const t = tempTree({ ships: false });
    t.run(); // the plugin ships no commands or skills at all
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /scanned nothing/);
    assert.match(out, /must not report success/);
  });

  it("leaves the bare config verbs alone", () => {
    const t = tempTree();
    t.prose("Use `/on` and `/off` to toggle, or `/p1:setup` to configure.\n");
    const { code, out } = t.run();
    assert.equal(code, 0, out);
  });

  it("ignores a bare reference that names nothing shipped", () => {
    const t = tempTree();
    // `/tmp` is a filesystem path and `/mcp` is the host's. Flagging these produced
    // four false positives and no real findings, so the guard deliberately does not.
    t.prose("On macOS `/tmp` is a link, and `/mcp` is Claude Code's. `/p1:setup` works.\n");
    const { code, out } = t.run();
    assert.equal(code, 0, out);
  });
});
