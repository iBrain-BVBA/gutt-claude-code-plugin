#!/usr/bin/env node
/**
 * The eval gate's wiring, asserted from outside the eval gate.
 *
 * `evals/self_check.py` checks its own wiring — that `check:evals` exists, runs it, is
 * chained into `test:all`, and has a live CI step. That check is worth having, but it
 * cannot be the only one: it runs only when the wiring it is checking is intact. Remove
 * the script and the assertion goes with it, and every other gate in `test:all` keeps
 * passing. Every sibling checker already has a counterpart here for the same reason.
 *
 * This file runs under `node --test tests/*.test.cjs`, which is the *first* link of the
 * `test:all` chain and a separate CI job — so it executes before `check:evals` would,
 * and still executes when `check:evals` no longer would at all.
 *
 * Run: node --test tests/check-evals-wiring.test.cjs
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const GATE = path.join(ROOT, "evals", "self_check.py");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

describe("eval bench gate wiring", () => {
  it("the gate script the wiring points at is actually present", () => {
    assert.ok(
      fs.existsSync(GATE),
      "evals/self_check.py is gone, so nothing runs the bench's offline checks"
    );
  });

  // Anchored, not a substring. The filename appearing somewhere in the value is
  // satisfied by a wrapper that discards the exit code — `... || true` keeps the name,
  // keeps the gate printing which suites are broken, and makes it incapable of ever
  // failing the build.
  it("`check:evals` runs the gate and nothing that could swallow its exit code", () => {
    const script = (pkg.scripts?.["check:evals"] ?? "").trim();
    assert.match(
      script,
      /^python3? evals\/self_check\.py$/,
      `check:evals must be exactly the gate invocation, got ${JSON.stringify(script)}`
    );
  });

  it("`test:all` chains through `check:evals`", () => {
    assert.match(
      pkg.scripts?.["test:all"] ?? "",
      /npm run check:evals/,
      "the aggregate a developer runs by hand no longer reaches the gate"
    );
  });

  // A step that runs, not the string being present. Commenting a step out or hanging a
  // condition on it is the ordinary way one stops running, and both leave the name in
  // the file. Parsed by shape rather than with a YAML library because this repository
  // ships no dependencies, and the file's shape is ours to keep.
  it("CI runs `check:evals` on a step nothing disables", () => {
    const lines = workflow.split("\n");
    const live = lines.some((line, i) => {
      if (line.trimStart().startsWith("#")) {
        return false;
      }
      if (!/^\s*(-\s*)?run:\s*npm run check:evals\s*$/.test(line)) {
        return false;
      }
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j];
        const stripped = prev.trim();
        if (!stripped || stripped.startsWith("#")) {
          continue;
        }
        if (/^\s*if:\s/.test(prev)) {
          return false;
        }
        if (stripped.startsWith("- ")) {
          break;
        }
      }
      return true;
    });
    assert.ok(
      live,
      "no CI job runs `check:evals` on an unconditional step — the gate is off every " +
        "pull request, and a green `test:all` locally would not report it"
    );
  });
});
