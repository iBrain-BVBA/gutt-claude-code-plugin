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

  // Last in the chain, not merely present in it. `test:all` is a shell `&&` sequence,
  // so anything appended after the gate can discard what it returns: appending
  // `|| true` reaches the gate, prints every broken suite, and still exits 0. Being
  // reached is not the property worth asserting; deciding the exit code is.
  it("`test:all` ends with `check:evals`, so the gate decides its exit code", () => {
    assert.match(
      (pkg.scripts?.["test:all"] ?? "").trim(),
      /&&\s*npm run check:evals$/,
      "the aggregate either no longer reaches the gate, or something after it can " +
        "swallow the exit code"
    );
  });

  // A step that runs, not the string being present. Commenting a step out or hanging a
  // condition on it is the ordinary way one stops running, and both leave the name in
  // the file. Parsed by shape rather than with a YAML library because this repository
  // ships no dependencies, and the file's shape is ours to keep — but the whole step is
  // read, on both sides of `run:`, because a mapping's keys are unordered in YAML and
  // `if:` is as valid below the key it guards as above it.
  it("CI runs `check:evals` on a step nothing disables", () => {
    const lines = workflow.split("\n");
    const live = lines.some((line, i) => {
      if (line.trimStart().startsWith("#")) {
        return false;
      }
      if (!/^\s*(-\s*)?run:\s*npm run check:evals\s*$/.test(line)) {
        return false;
      }
      let start = i;
      while (start > 0 && !lines[start].trim().startsWith("- ")) {
        start--;
      }
      const openerIndent = lines[start].length - lines[start].trimStart().length;
      let end = start + 1;
      while (end < lines.length) {
        const stripped = lines[end].trim();
        const indent = lines[end].length - lines[end].trimStart().length;
        if (stripped && !stripped.startsWith("#") && indent <= openerIndent) {
          break;
        }
        end++;
      }
      return !lines
        .slice(start, end)
        .some((l) => !l.trimStart().startsWith("#") && /^\s*(-\s*)?if:\s/.test(l));
    });
    assert.ok(
      live,
      "no CI job runs `check:evals` on an unconditional step — the gate is off every " +
        "pull request, and a green `test:all` locally would not report it"
    );
  });
});
