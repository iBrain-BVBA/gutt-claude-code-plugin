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
 * So this asserts the surfaces that must match — redaction word list, environment
 * value allowlist, bundle artifact set, option set — plus that each script parses,
 * and that the skill and the doc point at both by name.
 *
 * The highest-consequence rule is deliberately NOT duplicated: files the plugin
 * does not own are reduced to their shape by `summarize-json.cjs`, which both
 * collectors call. Two assertions guard that arrangement — that neither collector
 * copies one of those files raw, and that a bundle built from fixtures seeded with
 * planted credentials contains none of them.
 *
 * Run: node --test tests/diagnostics-scripts.test.cjs
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKILL_DIR = path.join(ROOT, "gutt-core", "skills", "collect-diagnostics");
const SCRIPTS = path.join(SKILL_DIR, "scripts");
const SH = path.join(SCRIPTS, "collect-diagnostics.sh");
const PS1 = path.join(SCRIPTS, "collect-diagnostics.ps1");
const SUMMARIZER = path.join(SCRIPTS, "summarize-json.cjs");

const shText = fs.readFileSync(SH, "utf8");
const psText = fs.readFileSync(PS1, "utf8");
const summarizerText = fs.readFileSync(SUMMARIZER, "utf8");

const { shapeOf, KEEP_STRING_VALUES } = require(SUMMARIZER);

/**
 * Credential-shaped strings planted in the fixtures below. Each is distinctive
 * enough that finding it anywhere in a bundle is unambiguous, and each sits in a
 * different place a real one does: an `env` block, an `apiKeyHelper`, a hook
 * command, an MCP header, a URL query parameter, a marketplace URL's userinfo —
 * and one under a key name nothing would think to match, which is the case a
 * pattern-matching redactor cannot cover.
 */
const PLANTED = [
  "PLANTEDenvAPIKEY0001",
  "PLANTEDhelperCMD0002",
  "PLANTEDinnocentKEY03",
  "PLANTEDhookBEARER004",
  "PLANTEDmcpHEADER0005",
  "PLANTEDmcpQUERY0006",
  "PLANTEDgitUSERINFO7",
  "PLANTEDprojectENV008",
];

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
      // The summarizer scrubs the strings it does keep — a path or a marketplace
      // source URL can carry a credential — so it needs the same shapes.
      if (!summarizerText.includes(shape.ps)) {
        missing.push(`summarize-json: ${shape.what}`);
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

  // The parity assertions above all compare two duplicated lists. This one asserts
  // the arrangement that makes duplication unnecessary for the rule that matters
  // most: a file the plugin does not own must never reach the raw copier.
  it("never copy a file they do not own", () => {
    const notOurs = ["settings.json", "settings.local.json", ".mcp.json", "installed_plugins.json"];
    const rawCopier = { sh: "copy_text ", ps: "Copy-TextArtifact " };
    const defects = [];
    for (const [dialect, text] of [
      ["sh", shText],
      ["ps", psText],
    ]) {
      for (const line of text.split("\n")) {
        if (!line.includes(rawCopier[dialect])) {
          continue;
        }
        for (const name of notOurs) {
          if (line.includes(name)) {
            defects.push(`${dialect}: raw copy of ${name} — ${line.trim()}`);
          }
        }
      }
    }
    assert.deepEqual(defects, [], defects.join("; "));
  });

  it("read the same environment variables by value", () => {
    const shList = shText.match(/^ENV_VALUE_NAMES="([^"]+)"/m);
    assert.ok(shList, "bash collector has no ENV_VALUE_NAMES assignment");
    const psList = psText.match(/\$EnvValueNames = @\(([\s\S]*?)\n\)/);
    assert.ok(psList, "PowerShell collector has no $EnvValueNames array");
    const psNames = psList[1]
      .split(",")
      .map((entry) => entry.replace(/[\s'"]/g, ""))
      .filter(Boolean)
      .sort();
    assert.deepEqual(
      psNames,
      shList[1].trim().split(/\s+/).sort(),
      "the collectors read different environment variables by value"
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

describe("summarize-json: withheld by default", () => {
  it("withholds a string under a key nobody allowlisted", () => {
    const shaped = shapeOf({ somethingNobodyThoughtOf: "a-credential-goes-here" }, null, 0);
    assert.equal(shaped.somethingNobodyThoughtOf, "<string:22>");
  });

  it("keeps key names, which are the diagnostic", () => {
    const shaped = shapeOf({ env: { ANTHROPIC_API_KEY: "secret" } }, null, 0);
    assert.deepEqual(Object.keys(shaped.env), ["ANTHROPIC_API_KEY"]);
    assert.equal(shaped.env.ANTHROPIC_API_KEY, "<string:6>");
  });

  it("keeps booleans and numbers, which cannot be credentials", () => {
    const shaped = shapeOf({ enabled: true, count: 41, missing: null }, null, 0);
    assert.deepEqual(shaped, { enabled: true, count: 41, missing: null });
  });

  it("keeps an allowlisted value, scrubbed", () => {
    assert.ok(KEEP_STRING_VALUES.has("command"), "command must stay allowlisted");
    const shaped = shapeOf({ command: "curl -H 'Authorization: Bearer abcdefghijkl'" }, null, 0);
    assert.match(shaped.command, /Bearer <redacted>/);
    assert.doesNotMatch(shaped.command, /abcdefghijkl/);
  });

  it("collapses an array of primitives to its length", () => {
    // A permissions list is an array of strings naming paths and commands. Its
    // length is the diagnostic; its entries are the user's filesystem.
    const shaped = shapeOf({ allow: ["Read(/home/me/private/*)", "Bash(*)"] }, null, 0);
    assert.equal(shaped.allow, "<array:2>");
  });

  it("does not allowlist url", () => {
    // An endpoint is not worth a token in a query string.
    assert.equal(KEEP_STRING_VALUES.has("url"), false);
  });
});

describe("diagnostics bundle: planted credentials do not survive", () => {
  /** A host + project tree seeded with PLANTED strings everywhere one really lands. */
  function seedFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-diag-leak-"));
    const claude = path.join(root, "claude");
    const project = path.join(root, "project");
    const data = path.join(claude, "plugins", "data", "gutt-plugins-gutt-pro");
    fs.mkdirSync(path.join(data, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(project, ".claude"), { recursive: true });

    const write = (file, value) => fs.writeFileSync(file, value);

    write(
      path.join(claude, "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: PLANTED[0], MY_OWN_NAME: PLANTED[2] },
        apiKeyHelper: `echo ${PLANTED[1]}`,
        statusLine: { type: "command", command: "node /x/statusline.cjs" },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "command", command: `curl -H 'Authorization: Bearer ${PLANTED[3]}' x` },
              ],
            },
          ],
        },
      })
    );
    write(
      path.join(claude, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: [
          {
            name: "gutt-pro",
            version: "9.9.9",
            source: `https://x-access-token:${PLANTED[6]}@github.com/o/r`,
          },
        ],
      })
    );
    write(
      path.join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "gutt-pro-memory": {
            type: "http",
            url: `https://org.example.com/mcp?token=${PLANTED[5]}`,
            headers: { Authorization: `Bearer ${PLANTED[4]}` },
          },
        },
      })
    );
    write(
      path.join(project, ".claude", "settings.json"),
      JSON.stringify({ env: { INNOCENT_LOOKING: PLANTED[7] } })
    );
    // The plugin's own state IS copied, so its logs are seeded too: prompt text is
    // off by default, and a user who types a credential into a prompt must not have
    // it collected by a run nobody asked for content in.
    write(
      path.join(data, "hook-invocations.log"),
      `[2026-01-01 00:00:00] Prompt: my key is ${PLANTED[0]}\n`
    );
    write(
      path.join(data, "hook-errors.log"),
      "2026-01-01T00:00:00.000Z [Stop] judge: spawn ENOENT\n"
    );
    return { root, claude, project };
  }

  /** Every planted string still findable anywhere under `dir`. */
  function leaksIn(dir) {
    const found = new Set();
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const text = fs.readFileSync(full, "utf8");
        for (const secret of PLANTED) {
          if (text.includes(secret)) {
            found.add(`${secret} in ${path.relative(dir, full)}`);
          }
        }
      }
    };
    walk(dir);
    return [...found].sort();
  }

  it("the bash collector leaks none of them", (t) => {
    const probe = spawnSync("bash", ["-n", SH], { encoding: "utf8" });
    if (probe.error) {
      t.skip("bash not available");
      return;
    }
    const { root, claude, project } = seedFixture();
    const out = path.join(root, "bundle");
    const run = spawnSync("bash", [SH, "--out", out, "--no-archive"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CLAUDE_PROJECT_DIR: project },
    });
    assert.equal(run.status, 0, `collector failed: ${run.stderr}`);
    assert.deepEqual(leaksIn(out), []);
    // And the guard is not vacuous: the fixture really does hold them.
    assert.ok(leaksIn(claude).length > 0, "fixture planted nothing — the assertion above is empty");
  });

  it("the PowerShell collector leaks none of them", (t) => {
    const exe = powershell();
    if (!exe) {
      t.skip("no PowerShell on PATH");
      return;
    }
    const { root, claude, project } = seedFixture();
    const out = path.join(root, "bundle");
    const run = spawnSync(exe, ["-NoProfile", "-File", PS1, "-OutputPath", out, "-NoArchive"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CLAUDE_PROJECT_DIR: project },
    });
    assert.equal(run.status, 0, `collector failed: ${run.stderr}`);
    assert.deepEqual(leaksIn(out), []);
    assert.ok(leaksIn(claude).length > 0, "fixture planted nothing — the assertion above is empty");
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
