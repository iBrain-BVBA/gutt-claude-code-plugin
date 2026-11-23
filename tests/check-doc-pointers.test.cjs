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
 * scanned-nothing floor turns on. The tree starts in sync — a main README with the plugin
 * table, a plugin README listing what ships, an onboarding guide holding the install
 * commands, and the root docs the READMEs link to — so each case breaks only what it names.
 */
const ONBOARDING = [
  "# Onboarding",
  "",
  "```",
  "claude plugin marketplace add example/repo",
  "claude plugin install p1@m1   # the core",
  "```",
  "",
].join("\n");

const ROOT_README = [
  "# Plugins",
  "",
  "| Plugin                 | Install                          |",
  "| ---------------------- | -------------------------------- |",
  "| [p1](p1/README.md)     | `claude plugin install p1@m1`    |",
  "| p2                     | Coming                           |",
  "",
  "```",
  "claude plugin marketplace add example/repo",
  "```",
  "",
].join("\n");

const PLUGIN_README = [
  "# p1",
  "",
  "## Skills",
  "",
  "| Skill           | What |",
  "| --------------- | ---- |",
  "| `memory-search` | x    |",
  "",
  "## Commands",
  "",
  "| Command                   | Effect |",
  "| ------------------------- | ------ |",
  "| `/p1:setup [url\\|none]` | x      |",
  "| `/p1:on`                  | x      |",
  "",
  "## Agents",
  "",
  "| Agent         | What |",
  "| ------------- | ---- |",
  "| `placeholder` | x    |",
  "",
].join("\n");

// Required by the guard alongside the onboarding guide; each starts empty of references.
const ROOT_DOCS = ["CONTRIBUTING.md", "docs/hooks.md", "docs/statusline.md"];

function tempTree(opts = {}) {
  const { ships = true } = opts;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doc-pointer-guard-")));

  write(
    path.join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "m1", plugins: [{ name: "p1", source: "./p1" }] })
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

  write(path.join(dir, "README.md"), ROOT_README);
  write(path.join(dir, "p1", "README.md"), PLUGIN_README);
  write(path.join(dir, "docs", "team-onboarding.md"), ONBOARDING);
  for (const doc of ROOT_DOCS) {
    write(path.join(dir, doc), "# doc\n");
  }

  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.copyFileSync(GUARD, path.join(dir, "tests", "check-doc-pointers.cjs"));

  return {
    dir,
    prose: (text) => write(path.join(dir, "p1", "skills", "memory-search", "SKILL.md"), text),
    docs: (text) => write(path.join(dir, "docs", "team-onboarding.md"), `${ONBOARDING}${text}`),
    file: (rel, text) => write(path.join(dir, rel), text),
    remove: (rel) => fs.rmSync(path.join(dir, rel), { recursive: true, force: true }),
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

describe("the README drift check", () => {
  it("passes when the READMEs list exactly what ships", () => {
    const t = tempTree();
    const { code, out } = t.run();
    assert.equal(code, 0, out);
    assert.match(out, /READMEs match what ships/);
  });

  it("fails when a skill directory is removed but its README still lists it", () => {
    const t = tempTree();
    t.file("p1/skills/old-skill/SKILL.md", "# old\n");
    t.file(
      "p1/README.md",
      PLUGIN_README.replace(
        "| `memory-search` | x    |",
        "| `memory-search` | x |\n| `old-skill` | x |"
      )
    );
    assert.equal(t.run().code, 0, "the tree with the extra skill starts in sync");
    t.remove("p1/skills/old-skill");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /lists skill `old-skill`, which p1 does not ship/);
  });

  it("fails when a shipped skill is missing from its README", () => {
    const t = tempTree();
    t.file("p1/skills/new-skill/SKILL.md", "# new\n");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /p1 ships skill `new-skill`, but its skills table does not list it/);
  });

  it("fails when a shipped command or agent is missing from its README", () => {
    const t = tempTree();
    t.file("p1/commands/health.md", "# health\n");
    t.file("p1/agents/explorer.md", "# explorer\n");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /ships command `health`/);
    assert.match(out, /ships agent `explorer`/);
  });

  it("fails when a plugin has no README of its own", () => {
    const t = tempTree();
    t.remove("p1/README.md");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /p1[\\/]README\.md: missing/);
  });

  it("fails when the main README's plugin table leaves a plugin out", () => {
    const t = tempTree();
    t.file("README.md", ROOT_README.replace("[p1](p1/README.md)", "p1"));
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /plugin table has no row linking \[p1\]\(p1\/README\.md\)/);
  });

  it("fails when the plugin table links a plugin the marketplace does not list", () => {
    const t = tempTree();
    t.file("README.md", `${ROOT_README}\n| [gone](gone/README.md) | x |\n`);
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /links gone\/README\.md, which the marketplace does not list/);
  });

  it("fails when the main README does not give a plugin's install command", () => {
    const t = tempTree();
    t.file("README.md", ROOT_README.replace("`claude plugin install p1@m1`", "see below"));
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /the plugin table's p1 row does not give `claude plugin install p1@m1`/);
  });

  it("fails when the install command is only outside the plugin table's row", () => {
    const t = tempTree();
    t.file(
      "README.md",
      `${ROOT_README.replace("`claude plugin install p1@m1`", "see below")}` +
        "\n```\nclaude plugin install p1@m1\n```\n"
    );
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /the plugin table's p1 row does not give `claude plugin install p1@m1`/);
  });

  it("fails when two plugins' Install cells are swapped", () => {
    const t = tempTree();
    t.file(
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        name: "m1",
        plugins: [
          { name: "p1", source: "./p1" },
          { name: "p2", source: "./p2" },
        ],
      })
    );
    t.file("p2/.claude-plugin/plugin.json", JSON.stringify({ name: "p2", version: "1.0.0" }));
    t.file("p2/README.md", "# p2\n");
    t.file("docs/team-onboarding.md", `${ONBOARDING}\n\`claude plugin install p2@m1\`\n`);
    t.file(
      "README.md",
      ROOT_README.replace(
        "| p2                     | Coming                           |",
        "| [p2](p2/README.md)     | `claude plugin install p2@m1`    |"
      )
    );
    assert.equal(t.run().code, 0, "the two-plugin tree starts in sync");
    t.file(
      "README.md",
      ROOT_README.replace("`claude plugin install p1@m1`", "`claude plugin install p2@m1`").replace(
        "| p2                     | Coming                           |",
        "| [p2](p2/README.md)     | `claude plugin install p1@m1`    |"
      )
    );
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /p1 row does not give `claude plugin install p1@m1`/);
    assert.match(out, /p2 row does not give `claude plugin install p2@m1`/);
  });

  it("reads a plugin-table link with an anchor or a title", () => {
    const t = tempTree();
    t.file(
      "README.md",
      `${ROOT_README.replace("[p1](p1/README.md)", '[p1](p1/README.md#skills "p1")')}` +
        "\n| [gone](gone/README.md#skills) | x |\n"
    );
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.doesNotMatch(out, /no row linking/);
    assert.match(out, /links gone\/README\.md, which the marketplace does not list/);
  });

  it("fails when a README writes an install command differently from onboarding", () => {
    const t = tempTree();
    t.file(
      "p1/README.md",
      `${PLUGIN_README}\nRun \`claude plugin add p1@m1\`, or \`claude plugin install p1\`.\n`
    );
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /`claude plugin add p1@m1` is not written this way in docs/);
    assert.match(out, /`claude plugin install p1` is not written this way in docs/);
  });

  it("scans the READMEs for slash references too", () => {
    const t = tempTree();
    t.file("README.md", `${ROOT_README}\nThen run \`/p1:no-such-thing\`.\n`);
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /README\.md: `\/p1:no-such-thing` resolves to nothing shipped/);
  });

  it("fails a table row whose command carries the wrong plugin name", () => {
    const t = tempTree();
    t.file(
      "p1/README.md",
      PLUGIN_README.replace("`/p1:setup [url\\|none]`", "`/p2:setup [url\\|none]`")
    );
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /lists `\/p2:setup`, but the plugin is p1 — write `\/p1:setup`/);
  });

  it("checks a reference that carries arguments", () => {
    const t = tempTree();
    t.prose("Snooze with `/p2:on 30`, or `/p1:nope auto\\|hitl`.\n");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /`\/p2:on` resolves to nothing shipped/);
    assert.match(out, /`\/p1:nope` resolves to nothing shipped/);
  });

  for (const doc of ROOT_DOCS) {
    it(`scans ${doc} for slash references`, () => {
      const t = tempTree();
      t.file(doc, "Run `/p1:no-such-thing`.\n");
      const { code, out } = t.run();
      assert.equal(code, 1, out);
      const shown = doc.split("/").join("[\\\\/]").replace(".", "\\.");
      assert.match(out, new RegExp(`${shown}: \`/p1:no-such-thing\` resolves to nothing shipped`));
    });
  }

  it("scans a doc under docs/ that is not on any list", () => {
    const t = tempTree();
    t.file("docs/hooks-renamed.md", "Run `/p1:no-such-thing`.\n");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /hooks-renamed\.md: `\/p1:no-such-thing` resolves to nothing shipped/);
  });

  it("fails when a doc the READMEs link to is missing", () => {
    const t = tempTree();
    t.remove("docs/hooks.md");
    t.remove("CONTRIBUTING.md");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /docs\/hooks\.md: missing/);
    assert.match(out, /CONTRIBUTING\.md: missing/);
  });

  it("reads a singular `## Agent` heading as the agents table", () => {
    const t = tempTree();
    t.file("p1/README.md", PLUGIN_README.replace("## Agents", "## Agent"));
    assert.equal(t.run().code, 0, "the singular heading lists the agent");
    t.remove("p1/agents/placeholder.md");
    t.file("p1/agents/other.md", "# other\n");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /lists agent `placeholder`, which p1 does not ship/);
  });

  it("does not read a `###` subsection's table as a listing", () => {
    const t = tempTree();
    t.file(
      "p1/README.md",
      PLUGIN_README.replace(
        "| `/p1:on`                  | x      |\n",
        "| `/p1:on`                  | x      |\n\n### Settings keys\n\n| Key | x |\n| --- | - |\n| `recall_minutes` | x |\n"
      )
    );
    const { code, out } = t.run();
    assert.equal(code, 0, out);
  });

  it("lets a bare host command share a stem with a shipped one", () => {
    const t = tempTree();
    t.file("p1/commands/config.md", "# config\n");
    t.file("p1/README.md", PLUGIN_README.replace("| `/p1:on`", "| `/p1:config` | x |\n| `/p1:on`"));
    t.file("README.md", `${ROOT_README}\nBare \`/config\` is Claude Code's own.\n`);
    const { code, out } = t.run();
    assert.equal(code, 0, out);
  });

  it("reports drift in the same run as a broken slash reference", () => {
    const t = tempTree();
    t.file("README.md", `${ROOT_README}\nThen run \`/p1:no-such-thing\`.\n`);
    t.file("p1/skills/new-skill/SKILL.md", "# new\n");
    const { code, out } = t.run();
    assert.equal(code, 1, out);
    assert.match(out, /resolves to nothing shipped/);
    assert.match(out, /ships skill `new-skill`/);
  });

  it("ignores table rows and headings inside a fenced code block", () => {
    const t = tempTree();
    t.file(
      "p1/README.md",
      `${PLUGIN_README}\n\`\`\`\n## Skills\n| \`gone-skill\` | an example, not a listing |\n\`\`\`\n`
    );
    const { code, out } = t.run();
    assert.equal(code, 0, out);
  });
});
