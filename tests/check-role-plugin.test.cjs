#!/usr/bin/env node
/**
 * The role-plugin review step, exercised both ways.
 *
 * Green: a plugin scaffolded from `templates/role-plugin` passes the review step and the
 * platform's own validator, and registers in the marketplace — the template is only worth
 * having if what comes out of it is loadable.
 *
 * Red: each gate is fed a violation and asserted to fail. `tests/check-role-plugin.cjs`
 * runs against this repository in `npm run test:all` and in CI, where it must always pass,
 * so nothing else in the suite ever sees it go red. A gate whose failure path has never
 * been executed is not yet a gate: it can be broken into a permanent no-op and every run
 * stays green.
 *
 * Run: node --test tests/check-role-plugin.test.cjs
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CHECK = path.join(__dirname, "check-role-plugin.cjs");
const TEMPLATE = path.join(ROOT, "templates", "role-plugin");

const PLUGIN = "gutt-sample";
const AGENT = "sample-agent";
const SKILL = "sample-activity";

/**
 * Values for the placeholders whose shape the gates actually constrain. Everything else is
 * prose, and gets a generic filler below — the point is to prove the scaffold is
 * completable, not to write a real plugin here.
 */
const SUBSTITUTIONS = {
  "{{PLUGIN_NAME}}": PLUGIN,
  "{{AGENT_NAME}}": AGENT,
  "{{SKILL_NAME}}": SKILL,
  "{{ROLE}}": "sample",
  "{{UPSTREAM_SHA}}": "0123456789abcdef0123456789abcdef01234567",
  "{{UPSTREAM_LICENCE}}": "Apache License 2.0",
  "{{UPSTREAM_REPO}}": "example-org/example-plugin",
  "{{OTHER_AGENT}}": "some-other-agent",
  "{{OTHER_SKILL}}": "some-other-skill",
};

/** Scaffold the template into a throwaway directory, exactly as the doc says to. */
function scaffold() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "role-plugin-")));
  const target = path.join(dir, PLUGIN);
  fs.cpSync(TEMPLATE, target, { recursive: true });

  // Step 1 of the doc: rename the component file and directory, and their `name:` fields.
  fs.renameSync(
    path.join(target, "agents", "AGENT_NAME.md"),
    path.join(target, "agents", `${AGENT}.md`)
  );
  fs.renameSync(path.join(target, "skills", "SKILL_NAME"), path.join(target, "skills", SKILL));

  for (const file of walk(target)) {
    let text = fs.readFileSync(file, "utf8");
    // Step 2 of the doc: drop the paragraphs addressed to whoever fills the template in.
    // They are instructions for this edit, and what survives becomes a prompt the agent
    // reads at call time.
    text = text.replace(/^SCAFFOLD NOTE[^\n]*(?:\n(?!\n)[^\n]*)*\n\n/gm, "");
    // The bare frontmatter names, which carry no braces so the files stay shell-safe.
    text = text.replace(/^name: AGENT_NAME$/m, `name: ${AGENT}`);
    text = text.replace(/^name: SKILL_NAME$/m, `name: ${SKILL}`);
    text = text.replace(/^(\s*)- SKILL_NAME$/m, `$1- ${SKILL}`);
    for (const [from, to] of Object.entries(SUBSTITUTIONS)) {
      text = text.split(from).join(to);
    }
    // Whatever prose placeholders remain: the scaffold must end up with none left.
    text = text.replace(/\{\{[A-Z][A-Z0-9_]*\}\}/g, "the thing this describes");
    fs.writeFileSync(file, text);
  }
  return { dir, target };
}

/** Every file under a directory, recursively. */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

/** Run the review step against one directory. */
const review = (dir) => spawnSync(process.execPath, [CHECK, dir], { cwd: ROOT, encoding: "utf8" });

/** Scaffold, apply one mutation, review. Used by every red case. */
function withMutation(mutate) {
  const { dir, target } = scaffold();
  mutate(target);
  return { dir, out: review(target) };
}

const agentFile = (target) => path.join(target, "agents", `${AGENT}.md`);
const skillFile = (target) => path.join(target, "skills", SKILL, "SKILL.md");
const manifestFile = (target) => path.join(target, ".claude-plugin", "plugin.json");

const patch = (file, from, to) => {
  const text = fs.readFileSync(file, "utf8");
  assert.ok(
    text.includes(from),
    `fixture is stale — "${from}" not found in ${path.basename(file)}`
  );
  fs.writeFileSync(file, text.split(from).join(to));
};

// ── green: the scaffold is loadable ────────────────────────────────────────────

describe("a plugin scaffolded from the template", () => {
  it("passes the review step", (t) => {
    const { dir, target } = scaffold();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const out = review(target);
    assert.equal(out.status, 0, `expected a pass, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stdout, /1 plugin\(s\), 1 agent\(s\), 1 skill\(s\)/);
  });

  it("leaves no template placeholder behind once filled in", (t) => {
    const { dir, target } = scaffold();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    for (const file of walk(target)) {
      const text = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(
        text,
        /\{\{[A-Z][A-Z0-9_]*\}\}/,
        `${path.basename(file)} still holds a placeholder`
      );
      // The bare frontmatter names have to be renamed too, and they carry no braces to
      // make them obvious — so assert on them separately rather than trusting the sweep.
      assert.doesNotMatch(
        text,
        /^name: (AGENT|SKILL)_NAME$/m,
        `${path.basename(file)} was not renamed`
      );
    }
  });

  it("keeps placeholders in a form `npm run format` will not rewrite", () => {
    // `__LIKE_THIS__` is markdown bold. Prettier turns it into `**LIKE_THIS**` in prose,
    // which silently converts a placeholder the review step catches into one it cannot.
    for (const file of walk(TEMPLATE)) {
      const text = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(
        text,
        /__[A-Z][A-Z0-9_]*__/,
        `${path.basename(file)} uses a format-unsafe placeholder`
      );
    }
  });

  it("declares the manifest fields a standalone install needs", (t) => {
    const { dir, target } = scaffold();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const m = JSON.parse(fs.readFileSync(manifestFile(target), "utf8"));
    assert.equal(m.name, PLUGIN);
    assert.deepEqual(m.dependencies, ["gutt-pro"], "must name the core plugin it degrades without");
    // `true` matches the platform default, so this asserts uniformity, not behaviour: the
    // suite is on as soon as it is installed, and it is written out so that is visible in
    // the manifest rather than implied by the field's absence.
    assert.equal(m.defaultEnabled, true, "the suite is on as soon as it is installed");
    assert.match(
      m.version,
      /^\d+\.\d+\.\d+/,
      "an omitted version makes every commit read as an update"
    );
    assert.ok(m.license, "the licence is stated per plugin");
  });

  it("registers in a marketplace manifest that the platform accepts", (t) => {
    const { dir, target } = scaffold();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude-plugin", "marketplace.json"),
      JSON.stringify(
        {
          name: "scaffold-probe",
          owner: { name: "iBRAIN BV", email: "support@gutt.pro" },
          plugins: [
            {
              name: PLUGIN,
              source: `./${PLUGIN}`,
              description: "A plugin scaffolded from the role-plugin template",
              category: "productivity",
            },
          ],
        },
        null,
        2
      )
    );

    // The platform's own validator is the real gate for "installs standalone". It is not
    // installed in CI, so this asserts when it is to hand and says so when it is not,
    // rather than passing quietly either way.
    const cli = spawnSync("claude", ["plugin", "validate", dir], { encoding: "utf8" });
    if (cli.error) {
      t.skip("claude CLI not on PATH — platform validation not exercised in this run");
      return;
    }
    assert.equal(cli.status, 0, `marketplace validation failed:\n${cli.stdout}${cli.stderr}`);

    const plugin = spawnSync("claude", ["plugin", "validate", target, "--strict"], {
      encoding: "utf8",
    });
    assert.equal(plugin.status, 0, `plugin validation failed:\n${plugin.stdout}${plugin.stderr}`);
  });
});

// ── red: each gate catches its violation ──────────────────────────────────────

describe("the licensing gate", () => {
  it("catches a fork from the product repository rather than the official plugins repo", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(
        agentFile(target),
        "# ",
        "# \n\nAdapted from https://github.com/anthropics/claude-code.\n\n"
      )
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /official plugins repository/);
  });

  it("catches the same forbidden repository in nonstandard casing", (t) => {
    // GitHub resolves owner/repo names case-insensitively, so a capitalized form names
    // exactly the same prohibited source.
    const { dir, out } = withMutation((target) =>
      patch(
        skillFile(target),
        "## When to use",
        "Adapted from https://github.com/Anthropics/Claude-Code.\n\n## When to use"
      )
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /official plugins repository/);
  });

  it("catches a no-derivatives baseline", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(
        skillFile(target),
        "## When to use",
        "Baselined on a CC BY-NC-ND work.\n\n## When to use"
      )
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /non-commercial|no-derivatives/);
  });

  it("catches a trademarked baseline name left unrenamed", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(skillFile(target), "## When to use", "Derived from the BMAD method.\n\n## When to use")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /must ship under a renamed identity/);
  });

  it("catches attribution that names a source but pins no commit", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(path.join(target, "ATTRIBUTION.md"), SUBSTITUTIONS["{{UPSTREAM_SHA}}"], "main")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /pins no 40-character commit SHA/);
  });

  it("catches a claimed borrowing with no attribution file at all", (t) => {
    const { dir, out } = withMutation((target) => {
      fs.rmSync(path.join(target, "ATTRIBUTION.md"));
      patch(
        skillFile(target),
        "## When to use",
        "Adapted from an upstream plugin.\n\n## When to use"
      );
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /no ATTRIBUTION\.md/);
  });
});

describe("the delivery-context gate", () => {
  it("catches a skill treating a code-host issue tracker as the system of record", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(
        skillFile(target),
        "## Step 1 — ",
        "## Step 0 — file a GitHub Issue for anything unclear\n\n## Step 1 — "
      )
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /not the system of record/);
  });

  it("catches the same thing reached through the CLI", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(skillFile(target), "## Degradation", "Run `gh issue list` first.\n\n## Degradation")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /not the system of record/);
  });
});

describe("the identity gate", () => {
  it("catches a writer registering a bare, unsuffixed name", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(agentFile(target), `name="${AGENT}--<scope>"`, `name="${AGENT}"`)
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /must carry a `--<scope>` suffix/);
  });

  it("catches a scope baked in at scaffold time instead of resolved at runtime", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(agentFile(target), `name="${AGENT}--<scope>"`, `name="${AGENT}--acme-web"`)
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /bakes in a resolved scope/);
  });

  it("catches a bare resolved name on a scoped call", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(
        agentFile(target),
        `agent_id="${AGENT}--<scope>", include_related`,
        `agent_id="${AGENT}", include_related`
      )
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /bare resolved name/);
  });

  it("catches a missing identity section", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(agentFile(target), "## Agent identity", "## Who I am")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /missing a `## Agent identity` section/);
  });

  it("catches a hardcoded MCP server prefix", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(
        agentFile(target),
        "search_memory_nodes(query=",
        "mcp__gutt_pro_memory__search_memory_nodes(query="
      )
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /hardcodes the MCP server prefix/);
  });
});

describe("the frontmatter gate", () => {
  it("catches the unquoted colon-space that silently drops a whole frontmatter block", (t) => {
    const { dir, out } = withMutation((target) => {
      const file = agentFile(target);
      const text = fs.readFileSync(file, "utf8");
      // Same shape as a real prose description that grew a colon: unquoted, and holding one.
      fs.writeFileSync(
        file,
        text.replace(/^description: ".*"$/m, "description: Triage, not repair: the brief")
      );
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /an unquoted value holding a colon/);
  });

  it("catches a name that no longer matches its filename", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(agentFile(target), `name: ${AGENT}`, "name: renamed-agent")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /must equal the filename/);
  });

  it("catches a model tier that does not exist", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(agentFile(target), "model: sonnet", "model: turbo")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /"model" must be one of/);
  });
});

describe("the manifest gate", () => {
  it("catches a role plugin that does not depend on the core plugin", (t) => {
    const { dir, out } = withMutation((target) => {
      const m = JSON.parse(fs.readFileSync(manifestFile(target), "utf8"));
      delete m.dependencies;
      fs.writeFileSync(manifestFile(target), JSON.stringify(m, null, 2));
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /"dependencies" must name/);
  });

  it("catches a plugin opting itself out of the suite's install behaviour", (t) => {
    const { dir, out } = withMutation((target) => {
      const m = JSON.parse(fs.readFileSync(manifestFile(target), "utf8"));
      m.defaultEnabled = false;
      fs.writeFileSync(manifestFile(target), JSON.stringify(m, null, 2));
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /"defaultEnabled" must be true/);
  });

  it("catches a role plugin shipping hooks", (t) => {
    const { dir, out } = withMutation((target) => {
      fs.mkdirSync(path.join(target, "hooks"), { recursive: true });
      fs.writeFileSync(path.join(target, "hooks", "hooks.json"), "{}\n");
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /ships no hooks/);
  });

  it("catches components filed inside .claude-plugin instead of at the root", (t) => {
    const { dir, out } = withMutation((target) =>
      fs.mkdirSync(path.join(target, ".claude-plugin", "skills"), { recursive: true })
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /belongs at the plugin root/);
  });

  it("refuses to report success on a directory that is not a plugin", (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "role-plugin-empty-")));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const out = review(dir);
    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /nothing was inspected/);
  });
});

describe("the marketplace-wide pass", () => {
  it("reads every agent in the marketplace, not just the role plugins'", () => {
    // The identity rules bind the core plugin too — it is the one that teaches them. This
    // asserts on the reported count rather than by mutating the repository, because the
    // number is the only thing that distinguishes a real widened pass from a no-op.
    const out = spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: "utf8" });
    assert.equal(out.status, 0, `the repository itself must be clean:\n${out.stdout}${out.stderr}`);

    const { plugins } = JSON.parse(
      fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8")
    );
    let expected = 0;
    for (const entry of plugins) {
      const agents = path.join(ROOT, String(entry.source).replace(/^\.\//, ""), "agents");
      if (fs.existsSync(agents)) {
        expected += fs.readdirSync(agents).filter((f) => f.endsWith(".md")).length;
      }
    }
    assert.ok(expected > 0, "no agents were found to check, which is not a pass");
    assert.match(
      out.stdout,
      new RegExp(`\\b${expected} agent\\(s\\)`),
      `expected all ${expected} marketplace agents to be inspected, got: ${out.stdout.trim()}`
    );
  });
});

/**
 * A throwaway marketplace with the checker copied in at the path it expects.
 *
 * Target mode takes a directory, so most red cases above drive it that way. The
 * marketplace-mode branch — classification, the core-name anchor, cross-plugin collisions —
 * has no directory to point at, and mutating the real repository to test it is not an
 * option. The checker resolves its ROOT as its own parent's parent, so copying it into a
 * fixture is what makes that branch reachable at all.
 */
function tempMarketplace({ plugins } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "role-plugin-market-")));
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.copyFileSync(CHECK, path.join(dir, "tests", "check-role-plugin.cjs"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "gutt-pro", version: "9.9.9" })
  );

  const entries = plugins || [
    { name: "gutt-pro", dir: "core", skills: ["memory-search"], manifest: { version: "9.9.9" } },
    { name: "gutt-role", dir: "role", skills: ["some-activity"] },
  ];
  for (const p of entries) {
    const base = path.join(dir, p.dir);
    fs.mkdirSync(path.join(base, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(base, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: p.name,
        version: "0.1.0",
        dependencies: ["gutt-pro"],
        defaultEnabled: true,
        license: "MIT",
        ...(p.manifest || {}),
      })
    );
    for (const skill of p.skills || []) {
      const sd = path.join(base, "skills", skill);
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(
        path.join(sd, "SKILL.md"),
        `---\nname: ${skill}\ndescription: "A fixture skill for the marketplace-mode tests."\n---\n\n# ${skill}\n\nNothing here.\n`
      );
    }
  }

  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "fixture",
      owner: { name: "fixture", email: "fixture@example.invalid" },
      plugins: entries.map((p) => ({ name: p.name, source: `./${p.dir}`, description: p.name })),
    })
  );
  const run = () =>
    spawnSync(process.execPath, [path.join(dir, "tests", "check-role-plugin.cjs")], {
      cwd: dir,
      encoding: "utf8",
    });
  return { dir, run };
}

describe("marketplace mode", () => {
  it("passes on a well-formed marketplace", (t) => {
    const { dir, run } = tempMarketplace();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const out = run();
    assert.equal(out.status, 0, `expected a pass, got:\n${out.stdout}${out.stderr}`);
  });

  it("catches a role plugin that dropped the core dependency", (t) => {
    // The rule requiring the dependency used to be unreachable here, because the same
    // dependency was what selected which plugins got checked — so the one manifest edit
    // that most needs catching removed the plugin from every gate instead of failing.
    const { dir, run } = tempMarketplace({
      plugins: [
        { name: "gutt-pro", dir: "core", skills: ["memory-search"] },
        {
          name: "gutt-role",
          dir: "role",
          skills: ["some-activity"],
          manifest: { dependencies: [] },
        },
      ],
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const out = run();
    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /"dependencies" must name "gutt-pro"/);
  });

  it("catches two plugins declaring the same skill name", (t) => {
    const { dir, run } = tempMarketplace({
      plugins: [
        { name: "gutt-pro", dir: "core", skills: ["shared-activity"] },
        { name: "gutt-role", dir: "role", skills: ["shared-activity"] },
      ],
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const out = run();
    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /skill "shared-activity" is already declared by/);
  });

  it("refuses to run when no manifest carries the core plugin's name", (t) => {
    // Every other plugin is classified as a role plugin by not matching this name, so a
    // stale anchor would silently reclassify the marketplace rather than fail.
    const { dir, run } = tempMarketplace({
      plugins: [
        { name: "gutt-renamed", dir: "core", skills: ["memory-search"] },
        { name: "gutt-role", dir: "role", skills: ["some-activity"] },
      ],
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const out = run();
    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /no plugin manifest is named "gutt-pro"/);
  });

  it("catches a marketplace entry whose source does not resolve", (t) => {
    const { dir, run } = tempMarketplace();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const file = path.join(dir, ".claude-plugin", "marketplace.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.plugins.push({ name: "gutt-ghost", source: "./gutt-ghost", description: "missing" });
    fs.writeFileSync(file, JSON.stringify(manifest));

    const out = run();
    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /points at a missing directory/);
  });
});

describe("the dedupe gate", () => {
  // A skill name is global to a session, so a collision is checked against what the
  // marketplace already registers — including the core plugin's names. Both cases run a real
  // scaffold through the checker; an earlier version of this suite re-implemented the scan
  // instead, which meant deleting the gate left every test green.
  it("catches a skill name the core plugin already owns", (t) => {
    const { dir, out } = withMutation((target) => {
      fs.renameSync(
        path.join(target, "skills", SKILL),
        path.join(target, "skills", "memory-search")
      );
      patch(
        path.join(target, "skills", "memory-search", "SKILL.md"),
        `name: ${SKILL}`,
        "name: memory-search"
      );
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /skill "memory-search" is already declared by/);
  });

  it("catches an agent name another role plugin already owns", (t) => {
    const { dir, out } = withMutation((target) => {
      fs.renameSync(
        path.join(target, "agents", `${AGENT}.md`),
        path.join(target, "agents", "pr-reviewer.md")
      );
      patch(path.join(target, "agents", "pr-reviewer.md"), `name: ${AGENT}`, "name: pr-reviewer");
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /agent "pr-reviewer" is already declared by/);
  });
});

describe("the one-owner-per-skill gate", () => {
  it("catches a skill naming raw graph tools without referencing the skill that owns them", (t) => {
    const { dir, out } = withMutation((target) => {
      const f = skillFile(target);
      // Strip every reference to a core skill, then name a raw tool: the shape of a skill
      // that has restated tool guidance instead of pointing at its owner.
      let text = fs.readFileSync(f, "utf8");
      for (const s of [
        "memory-search",
        "memory-capture",
        "graph-traversal",
        "agent-memory-protocol",
        "output-style",
      ]) {
        text = text.split(s).join("recall");
      }
      fs.writeFileSync(f, `${text}\n\nCall search_memory_nodes directly.\n`);
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /without referencing the core skill that owns/);
  });

  it("does not accept an unrelated core-skill mention on a raw tool's behalf", (t) => {
    // The scaffold references memory-search and its siblings but not agent-memory-protocol,
    // which owns register_agent — any core-skill mention used to satisfy the rule.
    const { dir, out } = withMutation((target) =>
      fs.appendFileSync(skillFile(target), "\nRegister first with register_agent, then proceed.\n")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(
      out.stderr,
      /names register_agent without referencing the core skill that owns it \(agent-memory-protocol\)/
    );
  });

  it("catches a skill whose name no longer matches its directory", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(skillFile(target), `name: ${SKILL}`, "name: something-else")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /must equal the directory name/);
  });

  it("catches a skill directory with no SKILL.md at all", (t) => {
    const { dir, out } = withMutation((target) => fs.rmSync(skillFile(target)));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /has no SKILL\.md/);
  });

  it("scans nested reference material, not just SKILL.md", (t) => {
    // references/ is where a forked baseline's habits survive longest, because it is the
    // half nobody re-reads.
    const { dir, out } = withMutation((target) => {
      const refs = path.join(target, "skills", SKILL, "references");
      fs.mkdirSync(refs, { recursive: true });
      fs.writeFileSync(path.join(refs, "worked-example.md"), "Open a GitHub Issue for each gap.\n");
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /references\/worked-example\.md/);
    assert.match(out.stderr, /not the system of record/);
  });
});

describe("the scaffold-completeness gate", () => {
  it("catches paragraphs the template addressed to whoever filled it in", (t) => {
    const { dir, target } = scaffold();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    // The template ships these; scaffold() strips them, so put one back.
    const f = agentFile(target);
    fs.writeFileSync(f, `SCAFFOLD NOTE — rename this.\n\n${fs.readFileSync(f, "utf8")}`);
    const out = review(target);
    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /SCAFFOLD NOTE/);
  });

  it("catches a template that was filled in but never renamed", (t) => {
    // Both halves of the name check still agree here — on the placeholder — which is the one
    // case where matching filename and `name:` is not evidence of anything.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "role-plugin-raw-")));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, "gutt-unrenamed");
    fs.cpSync(TEMPLATE, target, { recursive: true });

    const out = review(target);
    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /placeholder filename \(AGENT_NAME\.md\)/);
    assert.match(out.stderr, /placeholder directory name \(SKILL_NAME\/\)/);
  });

  it("catches a placeholder left in the manifest, where the marketplace would show it", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(manifestFile(target), '"description": "', '"description": "{{PLUGIN_DESCRIPTION}} ')
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /unreplaced template placeholder \{\{PLUGIN_DESCRIPTION\}\}/);
  });
});

describe("the licensing gate, on the upstream paragraph specifically", () => {
  it("catches a copyleft upstream licence", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(path.join(target, "ATTRIBUTION.md"), SUBSTITUTIONS["{{UPSTREAM_LICENCE}}"], "GPL-3.0")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(
      out.stderr,
      /copyleft or source-available|does not name a permissive upstream licence/
    );
  });

  it("does not accept a licence token from elsewhere in the file on the upstream's behalf", (t) => {
    // The failure this covers: the template's own boilerplate about this repository's licence
    // used to satisfy the permissive-upstream rule, so no upstream licence was ever checked.
    const { dir, out } = withMutation((target) => {
      const f = path.join(target, "ATTRIBUTION.md");
      patch(f, SUBSTITUTIONS["{{UPSTREAM_LICENCE}}"], "some bespoke licence");
      fs.appendFileSync(f, "\nUnrelated note: this repository is MIT.\n");
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /does not name a permissive upstream licence/);
  });

  // The file's documented shape is one `##` section per baseline, so every rule here is
  // per-borrowing. A whole-file scan let the first section satisfy the rule on behalf of
  // every later one — and a second borrowing is the normal case, not an exotic one.
  const SECOND_SECTION = (licence, sha) => `
## another-skill — what was borrowed

Adapted from the **other-thing** plugin in
[\`other-org/other-repo\`](https://github.com/other-org/other-repo) (\`plugins/other\`),
${licence}, © Someone Else.

Pinned at commit **\`${sha}\`** — the commit that was read.
`;

  it("catches a second borrowing whose licence is not permissive", (t) => {
    // Share-alike carries none of the deny-list tokens, so this reaches the allow-list alone.
    const { dir, out } = withMutation((target) =>
      fs.appendFileSync(
        path.join(target, "ATTRIBUTION.md"),
        SECOND_SECTION("CC BY-SA 4.0", "abcdef0123456789abcdef0123456789abcdef01")
      )
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /"another-skill[^"]*" does not name a permissive upstream licence/);
  });

  it("catches a second borrowing that pins no commit", (t) => {
    const { dir, out } = withMutation((target) =>
      fs.appendFileSync(
        path.join(target, "ATTRIBUTION.md"),
        SECOND_SECTION("MIT", "main").replace(/^Pinned at commit.*$/m, "Tracks the default branch.")
      )
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /"another-skill[^"]*" pins no 40-character commit SHA/);
  });

  it("accepts a second borrowing that is properly attributed", (t) => {
    const { dir, out } = withMutation((target) =>
      fs.appendFileSync(
        path.join(target, "ATTRIBUTION.md"),
        SECOND_SECTION("Apache License 2.0", "abcdef0123456789abcdef0123456789abcdef01")
      )
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(
      out.status,
      0,
      `a well-formed second borrowing must pass:\n${out.stdout}${out.stderr}`
    );
  });

  it("does not accept a stray checksum on the pin statement's behalf", (t) => {
    // Any 40-hex anywhere in the section used to satisfy the pin rule, so an attribution
    // tracking a branch passed as long as some unrelated identifier looked like a commit.
    const { dir, out } = withMutation((target) => {
      const f = path.join(target, "ATTRIBUTION.md");
      let text = fs.readFileSync(f, "utf8");
      text = text.replace(/^Pinned at commit[^\n]*/m, "Tracks the upstream default branch.");
      text += "\nUnrelated integrity checksum: fedcba9876543210fedcba9876543210fedcba98.\n";
      fs.writeFileSync(f, text);
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /pins no 40-character commit SHA in a "Pinned at commit" statement/);
  });

  it("catches an attribution file that describes no borrowing at all", (t) => {
    // An empty attribution reads as a completed check where none happened.
    const { dir, out } = withMutation((target) =>
      fs.writeFileSync(
        path.join(target, "ATTRIBUTION.md"),
        "# Attribution\n\nNothing to declare.\n"
      )
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /describes no borrowing/);
  });

  it("still lets an attribution name a trademarked upstream honestly", (t) => {
    // Renaming binds what the plugin ships as, not whether the borrowing may be described —
    // and gate 1 requires the upstream repository to be named, so the two rules would
    // otherwise contradict each other whenever the upstream's own name carries the mark.
    const { dir, out } = withMutation((target) =>
      patch(path.join(target, "ATTRIBUTION.md"), "example-org/example", "bmad-org/BMAD-METHOD")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(
      out.status,
      0,
      `attribution must be allowed to name its source:\n${out.stdout}${out.stderr}`
    );
  });

  it("still rejects the same trademarked name in a shipped skill body", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(skillFile(target), "## When to use", "Derived from BMAD.\n\n## When to use")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /must ship under a renamed identity/);
  });
});

describe("the identity gate, remaining branches", () => {
  it("catches a register_agent call with no literal name to check", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(agentFile(target), `name="${AGENT}--<scope>",`, "name=resolved_elsewhere,")
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /no literal name= argument/);
  });

  it("catches a second register_agent call that the first one's correctness would hide", (t) => {
    const { dir, out } = withMutation((target) =>
      fs.appendFileSync(agentFile(target), '\n```\nregister_agent(\n  name="an-example")\n```\n')
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /registers as the bare name "an-example"/);
  });

  it("catches a writer with no agent_id on any call", (t) => {
    const { dir, out } = withMutation((target) => {
      const f = agentFile(target);
      fs.writeFileSync(
        f,
        fs.readFileSync(f, "utf8").replace(/agent_id\s*=\s*"[^"]*"/g, "scoped=true")
      );
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /no call passes agent_id/);
  });

  it("catches a reader carrying a Learning Protocol it cannot use", (t) => {
    const { dir, out } = withMutation((target) => {
      const f = agentFile(target);
      // Remove the registration but leave the write-side section behind.
      fs.writeFileSync(
        f,
        fs.readFileSync(f, "utf8").replace(/register_agent\s*\(/g, "no_registration(")
      );
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /registers no identity/);
  });

  it("catches a scoped call naming a different agent's identity", (t) => {
    // Containment of `--` was enough before, so a suffixed literal pointing at some other
    // agent — a typo'd own name included — read and wrote the wrong scope silently.
    const { dir, out } = withMutation((target) =>
      patch(
        agentFile(target),
        `agent_id="${AGENT}--<scope>", include_related`,
        `agent_id="other-agent--<scope>", include_related`
      )
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /names a different identity than this agent registers/);
  });

  it("catches a registered name carrying the tokens but not as its suffix", (t) => {
    const { dir, out } = withMutation((target) =>
      patch(agentFile(target), `name="${AGENT}--<scope>"`, `name="<scope>--${AGENT}"`)
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /does not end with `--<scope>`/);
  });

  it("catches an identity block that never states the group-wide recall pass", (t) => {
    const { dir, out } = withMutation((target) => {
      const f = agentFile(target);
      let text = fs.readFileSync(f, "utf8");
      text = text.replace(/Group-wide/g, "Second pass").replace(/group-wide/g, "second");
      text = text.replace(/without\n\s*`agent_id`/g, "with no scoping");
      fs.writeFileSync(f, text);
    });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /never states the group-wide recall pass/);
  });
});

describe("the frontmatter gate, on quoted values", () => {
  // Opening a quote is not an escape from the parse hazard — a quote helps only when it
  // terminates the value. Each of these is invalid YAML that an earlier rule waved through.
  const CASES = [
    ["unclosed by inner quotes", `"prose with "a phrase" inside"`, /does not close cleanly/],
    ["a quoted key followed by a mapping", `"a label": value`, /does not close cleanly/],
    ["a trailing colon with nothing after it", `ends with a colon:`, /holding a colon/],
    ["a flow collection that never closes", `[unterminated`, /does not close on its line/],
  ];
  for (const [label, value, expected] of CASES) {
    it(`catches ${label}`, (t) => {
      const { dir, out } = withMutation((target) => {
        const f = agentFile(target);
        const text = fs.readFileSync(f, "utf8");
        fs.writeFileSync(f, text.replace(/^description: .*$/m, `description: ${value}`));
      });
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

      assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
      assert.match(out.stderr, expected);
    });
  }

  // Pinning the rule against a real YAML parser would need either a duplicate of the rule
  // here or the checker restructured into an importable module. The cases above bound it
  // on the exact hazards, and the repository-clean run bounds the other direction, which
  // is proportionate for a hand-rolled stand-in this narrow.
});
