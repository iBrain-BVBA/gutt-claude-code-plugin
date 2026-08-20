#!/usr/bin/env node
/**
 * The two diagnostics collectors must stay one tool.
 *
 * `collect-diagnostics.sh` and `collect-diagnostics.ps1` are written twice because
 * neither language runs on the other's platform — the repository bans sharing code
 * between plugins for the same reason it bans symlinks, and there is no third
 * runtime a support script may depend on. Duplication is the accepted cost; drift
 * is not, and drift here is worse than an inconvenience:
 *
 *   - A redaction pattern that exists on one platform only is a leak on the other.
 *   - An artifact collected on one platform only makes a bundle unreadable by the
 *     same procedure, which is the whole point of writing one layout twice.
 *   - A flag documented on one platform only sends the user to a script that
 *     rejects the option the docs told them to pass.
 *
 * So this asserts the three surfaces that must match — redaction word list,
 * bundle artifact set, option set — plus that each script parses, and that the
 * skill and the doc point at both by name.
 *
 * Run: node --test tests/diagnostics-scripts.test.cjs
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKILL_DIR = path.join(ROOT, "gutt-core", "skills", "collect-diagnostics");
const SCRIPTS = path.join(SKILL_DIR, "scripts");
const SH = path.join(SCRIPTS, "collect-diagnostics.sh");
const PS1 = path.join(SCRIPTS, "collect-diagnostics.ps1");

const shText = fs.readFileSync(SH, "utf8");
const psText = fs.readFileSync(PS1, "utf8");

/** First PowerShell on PATH, or null. `powershell` is Windows-only, `pwsh` is both. */
function powershell() {
  for (const exe of ["pwsh", "powershell"]) {
    const probe = spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return exe;
    }
  }
  return null;
}

describe("diagnostics collectors", () => {
  it("both ship as real files with content", () => {
    for (const file of [SH, PS1]) {
      const stat = fs.lstatSync(file);
      assert.ok(stat.isFile(), `${path.basename(file)} is not a regular file`);
      assert.ok(stat.size > 2000, `${path.basename(file)} is suspiciously small (${stat.size}B)`);
    }
  });

  it("the bash collector parses", (t) => {
    const probe = spawnSync("bash", ["-n", SH], { encoding: "utf8" });
    if (probe.error) {
      t.skip("bash not available");
      return;
    }
    assert.equal(probe.status, 0, `bash -n failed:\n${probe.stderr}`);
  });

  // Run through the AST parser rather than by executing the script: a syntax error
  // is what has to be caught, and executing it would write a bundle.
  it("the PowerShell collector parses", (t) => {
    const exe = powershell();
    if (!exe) {
      t.skip("no PowerShell on PATH");
      return;
    }
    const script = [
      "$errs = $null",
      `$null = [System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(PS1)}, [ref]$null, [ref]$errs)`,
      'if ($errs) { $errs | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }; exit 1 }',
    ].join("; ");
    const probe = spawnSync(exe, ["-NoProfile", "-Command", script], { encoding: "utf8" });
    assert.equal(probe.status, 0, `PowerShell parse errors:\n${probe.stdout}${probe.stderr}`);
  });

  // The lists are spelled differently — bash builds a case-insensitive character
  // class per word, PowerShell relies on -replace being case-insensitive — but the
  // words themselves are plain in both, one per platform's list, so they compare
  // directly.
  it("redact the same set of credential-shaped key names", () => {
    const shList = shText.match(/^SECRET_KEY_WORDS="([^"]+)"/m);
    assert.ok(shList, "bash collector has no SECRET_KEY_WORDS assignment");
    const shWords = shList[1].trim().split(/\s+/).sort();

    const psList = psText.match(/\$SecretKeyWords = @\(([\s\S]*?)\)/);
    assert.ok(psList, "PowerShell collector has no $SecretKeyWords array");
    const psWords = psList[1]
      .split(",")
      .map((entry) => entry.replace(/[\s'"]/g, ""))
      .filter(Boolean)
      .sort();

    assert.deepEqual(psWords, shWords, "credential-shaped word lists differ between collectors");
    assert.ok(shWords.length >= 10, `word list is implausibly short (${shWords.length})`);
  });

  it("redact the same set of value shapes", () => {
    // Each entry names one non-key pattern both collectors must carry. Matched on a
    // distinctive fragment rather than the whole expression, because the two dialects
    // spell the surrounding syntax differently — but not the shape being matched.
    const shapes = [
      { what: "bearer values", sh: "earer", ps: "Bearer" },
      { what: "signed three-part tokens", sh: "eyJ", ps: "eyJ" },
      { what: "URL userinfo", sh: "://", ps: "://" },
      { what: "secret query parameters", sh: "access_token", ps: "access_token" },
      { what: "provider key prefixes", sh: "github_pat_", ps: "github_pat_" },
    ];
    const missing = [];
    for (const shape of shapes) {
      if (!shText.includes(shape.sh)) {
        missing.push(`bash: ${shape.what}`);
      }
      if (!psText.includes(shape.ps)) {
        missing.push(`PowerShell: ${shape.what}`);
      }
    }
    assert.deepEqual(missing, [], `redaction shapes missing: ${missing.join("; ")}`);
  });

  it("write the same bundle artifacts", () => {
    assert.deepEqual(
      [...bundleArtifacts(psText)].sort(),
      [...bundleArtifacts(shText)].sort(),
      "the collectors do not write the same bundle layout"
    );
    assert.ok(
      bundleArtifacts(shText).size >= 20,
      "artifact extraction found implausibly few paths"
    );
  });

  it("declare the same bundle schema", () => {
    const shSchema = shText.match(/BUNDLE_SCHEMA="([^"]+)"/);
    const psSchema = psText.match(/\$BundleSchema = "([^"]+)"/);
    assert.ok(shSchema && psSchema, "one of the collectors declares no bundle schema");
    assert.equal(psSchema[1], shSchema[1], "bundle schema strings differ");
  });

  it("offer the same options", () => {
    assert.deepEqual(
      [...psOptions()].sort(),
      [...shOptions()].sort(),
      "the collectors accept different options"
    );
  });

  // A flag that works but is not in --help is a flag nobody finds; one that is in
  // --help but does not work is worse. Each script's usage text is checked against
  // its own parser, since the two spell their flags differently.
  it("document every option they accept", () => {
    const shUsage = shText.slice(shText.indexOf("usage() {"), shText.indexOf("USAGE\n}"));
    const undocumentedSh = [...shOptions()].filter((opt) => !normalizedIn(shUsage, opt));
    assert.deepEqual(undocumentedSh, [], `bash options missing from --help: ${undocumentedSh}`);

    const psUsage = psText.slice(
      psText.indexOf("function Show-Usage"),
      psText.indexOf("if ($Help)")
    );
    const undocumentedPs = [...psOptions()].filter((opt) => !normalizedIn(psUsage, opt));
    assert.deepEqual(
      undocumentedPs,
      [],
      `PowerShell options missing from -Help: ${undocumentedPs}`
    );
  });

  it("are both reachable from the skill and the doc", () => {
    const readers = {
      "SKILL.md": fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8"),
      "docs/diagnostics.md": fs.readFileSync(path.join(ROOT, "docs", "diagnostics.md"), "utf8"),
    };
    const defects = [];
    for (const [where, text] of Object.entries(readers)) {
      for (const script of ["collect-diagnostics.sh", "collect-diagnostics.ps1"]) {
        if (!text.includes(script)) {
          defects.push(`${where} never names ${script}`);
        }
      }
    }
    assert.deepEqual(defects, [], defects.join("; "));
  });
});

/**
 * Bundle-relative destinations named as string literals in a collector.
 *
 * Interpolations are collapsed to `*` so the two dialects' spellings of the same
 * destination compare equal — `"$prefix/sessions/$name"` and
 * `"$prefix/sessions/$($record.Name)"` are one artifact. `$prefix` is resolved
 * first, to its literal value in both scripts, so the per-install destinations
 * carry the top-level segment the filter below requires; without that they would
 * be dropped as unrooted and the most important artifacts would go unchecked.
 *
 * Anchoring on the bundle's own top-level segments is what keeps source paths out:
 * a bash `"$CLAUDE_DIR/settings.json"` collapses to a wildcard-rooted path, which no
 * bundle segment matches, so it is not mistaken for a destination.
 */
function bundleArtifacts(text) {
  const ROOTED =
    /^(summary\.txt$|manifest\.json$|plugin-data($|\/)|host\/|project\/|installed\/|transcripts\/)/;
  const found = new Set();
  for (const match of text.matchAll(/["']([^"'\n]*)["']/g)) {
    const value = match[1]
      .replace(/\$\(\$?prefix\)/g, "plugin-data/*")
      .replace(/\$\{?prefix\}?/g, "plugin-data/*")
      .replace(/\$\([^)]*\)/g, "*")
      .replace(/\$\{[^}]*\}/g, "*")
      .replace(/\$[A-Za-z_][A-Za-z0-9_.]*/g, "*");
    if (!/^[A-Za-z0-9_.*-]+(\/[A-Za-z0-9_.*-]+)*$/.test(value)) {
      continue;
    }
    if (!ROOTED.test(value)) {
      continue;
    }
    found.add(value);
  }
  return found;
}

/** An option name reduced to letters, so `--no-prompts` and `-NoPrompts` compare equal. */
function normalize(option) {
  return option.replace(/[^A-Za-z]/g, "").toLowerCase();
}

/**
 * Single-letter names are short aliases (`-h`), not options in their own right —
 * PowerShell resolves those from a unique prefix rather than declaring them, so
 * comparing them across the pair would fail on a difference that is not one.
 */
function isOption(name) {
  return name.length > 1;
}

function normalizedIn(text, option) {
  return [...text.matchAll(/-{1,2}[A-Za-z][A-Za-z-]*/g)].some((m) => normalize(m[0]) === option);
}

/** Long options the bash collector's own argument parser accepts. */
function shOptions() {
  const parser = shText.slice(
    shText.indexOf("while [ $# -gt 0 ]"),
    shText.indexOf('case "$SESSIONS"')
  );
  const found = new Set();
  for (const match of parser.matchAll(
    /^\s{4}(--?[a-z][a-z-]*)(?:\s*\|\s*(--?[a-z][a-z-]*))?\)/gm
  )) {
    for (const flag of [match[1], match[2]]) {
      if (flag && isOption(normalize(flag))) {
        found.add(normalize(flag));
      }
    }
  }
  return found;
}

/** Parameters the PowerShell collector's param() block declares. */
function psOptions() {
  const block = psText.slice(psText.indexOf("param("), psText.indexOf("$ErrorActionPreference"));
  const found = new Set();
  for (const match of block.matchAll(/\$([A-Za-z]+)/g)) {
    if (isOption(normalize(match[1]))) {
      found.add(normalize(match[1]));
    }
  }
  // Aliases count: an option the bash collector spells one way and this one
  // accepts under both names is the same option, not a missing one.
  for (const match of block.matchAll(/Alias\(\s*'([^']+)'/g)) {
    for (const alias of match[1].split(",")) {
      const name = normalize(alias);
      if (isOption(name)) {
        found.add(name);
      }
    }
  }
  return found;
}
