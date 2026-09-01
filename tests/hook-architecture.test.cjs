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
const PLUGIN_DIRS = ["gutt-core"];

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
 * The Stop judge's condition text, and where it now lives.
 *
 * It used to be the `prompt` field of a `type: "prompt"` entry in hooks.json, so the
 * guards below read `stop.prompt`. GP-866 moved the handler to a command hook and the text
 * to `hooks/lib/stop-judge.cjs`; every assertion on its wording moved with it, unchanged.
 *
 * Reading it from the same path the hook requires is deliberate: a lib that has gone
 * missing fails these guards rather than surfacing later as a judge that never fires.
 */
const STOP_JUDGE_LIB = path.join(ROOT, "gutt-core", "hooks", "lib", "stop-judge.cjs");
const STOP_JUDGE = require(STOP_JUDGE_LIB);
const JUDGE_CONDITION = STOP_JUDGE.JUDGE_CONDITION;

/**
 * Plugin directories as the marketplace actually lists them, so adding a plugin
 * there covers it here without editing a second list. `PLUGIN_DIRS` above stays
 * hand-written on purpose — it drives the hook-shape guards, and a plugin that
 * ships no hooks has no hook shape to constrain.
 * @returns {string[]}
 */
function marketplacePluginDirs() {
  const file = path.join(ROOT, ".claude-plugin", "marketplace.json");
  const { plugins = [] } = JSON.parse(fs.readFileSync(file, "utf8"));
  return plugins.map((p) => String(p.source || "").replace(/^\.\//, "")).filter(Boolean);
}

/**
 * Drop comment and blank lines, keeping the code. Line-oriented and naive about
 * `//` inside string literals, which can only ever keep *more* than it should —
 * safe for both callers here (a conservative line cap, and a scan that would
 * rather see an extra line than miss a real reference).
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  let inBlock = false;
  return text
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
    })
    .join("\n");
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

  // Stop was a prompt hook until GP-866 and is now a command hook, which inverts this
  // guard. The move was forced, not chosen: a prompt hook's `prompt` takes one
  // substitution and no shell expansion, so it cannot read config.json and could honour
  // neither `/gutt off` nor `mode`; and a command sibling cannot gate a prompt sibling's
  // dispatch. See docs/hook-platform-capabilities.md §6 and §7.
  //
  // R11 — never judge a turn with a regex — is preserved by shelling out to a model, not
  // by the hook type, so the assertion that matters now is that the handler still asks a
  // model. Both halves are checked: the type, and that the script spawns the judge.
  it("keeps the Stop judgement with a model, now via a command hook", () => {
    const stop = ALL.filter((h) => h.event === "Stop");
    assert.equal(stop.length, 1, "exactly one Stop handler");
    assert.equal(stop[0].type, "command");
    const src = stripComments(fs.readFileSync(STOP_JUDGE_LIB, "utf8"));
    assert.match(
      src,
      /"claude"/,
      "the Stop handler no longer spawns a model judge — R11 forbids scoring a turn in regex"
    );
  });

  // The hook must outlive the child it waits on, or the platform kills the handler
  // mid-judge and every verdict is lost with the tier still green. Worse than losing the
  // verdict: a platform kill emits no outcome line, so it is invisible where our own
  // `timeout` classification is at least logged.
  //
  // A strict `>` was the original assertion and it is too weak — 1ms of slack satisfies it,
  // and the handler has its own work either side of the spawn: node startup, reading config,
  // taking the closing message off the payload, composing, and two log writes. The margin is
  // asserted so that raising `JUDGE_TIMEOUT_MS` to just under the handler's cap fails here
  // rather than in production. A `command` hook's platform default is 600s, so the explicit
  // `timeout` in hooks.json is a deliberate tightening and there is room to move both.
  const HANDLER_SLACK_MS = 10_000;
  it("gives the Stop hook longer than the judge child it spawns, with room to spare", () => {
    const [stop] = ALL.filter((h) => h.event === "Stop");
    const { JUDGE_TIMEOUT_MS } = require(STOP_JUDGE_LIB);
    assert.ok(stop.timeout, "the Stop hook declares no timeout, so the default may cut the judge");
    const slack = stop.timeout * 1000 - JUDGE_TIMEOUT_MS;
    assert.ok(
      slack >= HANDLER_SLACK_MS,
      `hook timeout ${stop.timeout}s leaves ${slack}ms over the judge's ${JUDGE_TIMEOUT_MS}ms, ` +
        `under the ${HANDLER_SLACK_MS}ms the handler needs for its own work`
    );
  });

  // The alias hazard this replaces is *retired*, not relocated, and the distinction is
  // the point. A prompt hook's `model` went to the API unmodified, so `"sonnet"` answered
  // 404 `not_found_error {"message": "model: sonnet"}` and killed the judge silently —
  // dispatched, retried 11 times, no verdict, turn ends normally, trace only in
  // --debug-file. On argv the CLI resolves the alias: measured 2026-07-30, `--model
  // sonnet` and `--model claude-sonnet-5` both returned a clean reply.
  //
  // The old guard had an early `return` when `model` was absent, which a command hook
  // would have satisfied — it would have gone green while asserting nothing. So this one
  // asserts the model is passed at all, with no escape hatch.
  // See docs/hook-platform-capabilities.md §5.
  it("passes the judge an explicit model rather than inheriting a default", () => {
    const src = stripComments(fs.readFileSync(STOP_JUDGE_LIB, "utf8"));
    assert.match(src, /"--model"/, "the judge child inherits whatever model the CLI defaults to");
    const { JUDGE_MODEL } = require(STOP_JUDGE_LIB);
    assert.match(
      JUDGE_MODEL,
      /^claude-[a-z]+-\d/,
      `"${JUDGE_MODEL}" is not a model id; pin the id so the judge does not follow the CLI`
    );
  });

  // A ≤60 code-line cap on every gutt-core hook used to live here, and it was the
  // only thing keeping procedure out of the hooks — it is what pushed GP-922's
  // pointer prose into hooks/lib/builtin-memory.cjs. It was removed deliberately in
  // GP-866 rather than worked around: the router needed a config-command row and
  // was at 58 of 60. Nothing enforces the shape now, so it is reviewer judgement.
  // The guards that remain still catch the failures the cap never did — a pointer
  // at a skill that does not exist, a prompt hook on UserPromptSubmit, a handler
  // path that is not on disk.

  // Every skill in every marketplace plugin, not just gutt-core's. A skill is
  // loaded through its frontmatter, so a missing or malformed block — or a `name`
  // that disagrees with the directory the loader found it in — leaves the model
  // told to invoke something that will not resolve. Nothing else in this suite
  // reads a plugin outside gutt-core, so before this test a whole plugin's skills
  // could drift with CI green.
  it("every marketplace plugin's skills have frontmatter naming their directory", () => {
    const defects = [];
    for (const plugin of marketplacePluginDirs()) {
      const skillsDir = path.join(ROOT, plugin, "skills");
      if (!fs.existsSync(skillsDir)) {
        continue;
      }
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const where = `${plugin}/skills/${entry.name}`;
        const file = path.join(skillsDir, entry.name, "SKILL.md");
        if (!fs.existsSync(file)) {
          defects.push(`${where}: no SKILL.md`);
          continue;
        }
        const front = fs.readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/);
        if (!front) {
          defects.push(`${where}: no frontmatter block`);
          continue;
        }
        const declared = front[1].match(/^name:[ \t]*(.+)$/m);
        if (!declared) {
          defects.push(`${where}: frontmatter has no name`);
        } else if (declared[1].trim().replace(/^["']|["']$/g, "") !== entry.name) {
          defects.push(`${where}: frontmatter name is "${declared[1].trim()}"`);
        }
        if (!/^description:/m.test(front[1])) {
          defects.push(`${where}: frontmatter has no description`);
        }
      }
    }
    assert.deepEqual(defects, [], `skill frontmatter defects: ${defects.join("; ")}`);
  });

  // An org-graph write is permanent and cannot be reassigned from a normal session, so
  // prose that tells an agent to make one must also tell it which group the write lands
  // in. Omitting `group_id` is not "no group": the server picks an unspecified one of the
  // caller's groups, which is how a finding meant for one engagement ends up in a graph
  // nobody working on it reads.
  //
  // Repo-wide with a named exemption list rather than scoped to the newest plugin — a
  // guard that only inspects one directory reports success about every other one.
  it("prose that instructs an org-graph write names the group it lands in", () => {
    // These predate the guard: each names the write tool without naming a scope. Whether
    // that is a real gap in each is not this guard's call and nothing here changes them.
    // They are listed so the divergence is recorded rather than silently tolerated.
    const PRE_EXISTING = [
      "gutt-core/skills/migrate-memory/SKILL.md",
      "gutt-core/skills/onboard/SKILL.md",
      "gutt-core/skills/skills-discovery/SKILL.md",
    ];
    // `add_memory` bare, or the per-group alias form, or `register_agent` — registration
    // creates the agent's node in a group and is the gateway every tagged write goes
    // through. `add_personal_memory` is a different tool and takes no group — personal
    // scope is derived from the login.
    const ORG_WRITE = /\badd_memory\b|\badd_memory_to_|\bregister_agent\b/;
    const promptFiles = (plugin) => {
      const out = [];
      const push = (dir, depth) => {
        if (!fs.existsSync(dir)) {
          return;
        }
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory() && depth > 0) {
            push(full, depth - 1);
          } else if (e.isFile() && e.name.endsWith(".md")) {
            out.push(path.relative(ROOT, full).split(path.sep).join("/"));
          }
        }
      };
      push(path.join(ROOT, plugin, "skills"), 2); // skills/<name>/{SKILL.md,references/*.md}
      push(path.join(ROOT, plugin, "agents"), 0);
      return out;
    };

    const defects = [];
    const unusedExemptions = new Set(PRE_EXISTING);
    let inspected = 0;
    for (const plugin of marketplacePluginDirs()) {
      for (const rel of promptFiles(plugin)) {
        const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
        if (!ORG_WRITE.test(text)) {
          continue;
        }
        inspected += 1;
        if (text.includes("group_id")) {
          unusedExemptions.delete(rel);
          if (PRE_EXISTING.includes(rel)) {
            defects.push(`${rel}: names a group now — remove it from PRE_EXISTING`);
          }
          continue;
        }
        if (PRE_EXISTING.includes(rel)) {
          unusedExemptions.delete(rel);
          continue;
        }
        defects.push(`${rel}: instructs an org-graph write without naming group_id`);
      }
    }

    // A guard that matched nothing must fail rather than pass: the write-tool names could
    // change under it and every assertion above would go quiet.
    assert.ok(inspected >= 5, `expected several files naming an org write, saw ${inspected}`);
    for (const stale of unusedExemptions) {
      defects.push(`${stale}: exempted but no longer names an org write — drop the entry`);
    }
    assert.deepEqual(defects, [], `org-write scope defects: ${defects.join("; ")}`);
  });

  // A thin router's whole output is a pointer at a skill. If the skill is renamed
  // the pointer still ships, the model is told to run something that does not
  // exist, and nothing anywhere reports an error — the quietest failure the
  // rebuild introduced.
  it("names only skills that exist", () => {
    const skillsDir = path.join(ROOT, "gutt-core", "skills");
    const available = new Set(
      fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")))
        .map((e) => e.name)
    );

    // Everywhere a skill can be named: the router sources, the libs they call, and
    // the manifest that registers them.
    //
    // Comments are stripped from the .cjs sources first. This file's own house
    // style explains the wrong forms alongside the right ones — a comment reading
    // "not `memory-search`" is documentation, not a pointer, and scanning it flagged
    // correct code. hooks.json is scanned whole instead, because JSON has no comment
    // syntax to strip and a command path can be shaped like a skill pointer. Nothing
    // in it reaches the model today: only a `type: "prompt"` entry's `prompt` field
    // ever did, and no entry is one — the Stop judge's condition was the last, and it
    // moved into `hooks/lib/stop-judge.cjs` when that handler became a command hook,
    // where the lib scan described below covers it.
    // `hooks/lib/` is scanned alongside the hooks themselves because GP-922 moved
    // pointer prose into a lib for the first time: the SessionStart migration offer
    // is policy, so the thin-router cap above pushed it out of the hook and into
    // `builtin-memory.cjs`. Scanning only the hook directory — `readdirSync` does not
    // descend — would leave that pointer unguarded, precisely the quiet failure this
    // test exists to catch.
    const hookDir = path.join(ROOT, "gutt-core", "hooks");
    const libDir = path.join(hookDir, "lib");
    const cjsIn = (dir) =>
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".cjs"))
        .map((f) => stripComments(fs.readFileSync(path.join(dir, f), "utf8")));
    const sources = cjsIn(hookDir)
      .concat(cjsIn(libDir))
      .concat(fs.readFileSync(path.join(hookDir, "hooks.json"), "utf8"));

    // Three shapes, because one is not enough. This guard was briefly decorative:
    // it only scanned "<name> skill" prose, so hoisting the name into a
    // `${SEARCH_SKILL}` template made the reference invisible to a source scan and
    // the test kept passing with a bare, unusable stem. Caught by re-injecting the
    // bug, not by reading the code.
    const referenced = new Set();
    const add = (prefix, stem) => referenced.add(`${prefix || ""}:${stem}`);

    for (const source of sources) {
      // 1. Prose: "`<plugin>:<stem>` skill" / "<stem> skill". Requiring the hyphen
      //    keeps "this skill" out; requiring the adjacent word "skill" keeps
      //    filenames and state keys out.
      for (const m of source.matchAll(
        /`?\b(?:([a-z][a-z0-9-]*):)?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`?\s+skill\b/g
      )) {
        add(m[1], m[2]);
      }
      // 2. A quoted namespaced literal, e.g. const X = "plugin:skill" — the shape
      //    that prose scanning misses entirely.
      for (const m of source.matchAll(
        /["'`]([a-z][a-z0-9-]*):([a-z][a-z0-9]*(?:-[a-z0-9]+)+)["'`]/g
      )) {
        add(m[1], m[2]);
      }
      // 3. A quoted bare literal that happens to name a real skill directory.
      //    Catches the un-namespaced regression specifically: the stem resolves, so
      //    only the missing prefix distinguishes it from a working pointer.
      for (const m of source.matchAll(/["'`]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)["'`]/g)) {
        if (available.has(m[1])) {
          add("", m[1]);
        }
      }
    }

    assert.ok(referenced.size > 0, "no hook names a skill — the routing text has gone missing");

    const pluginName = JSON.parse(
      fs.readFileSync(path.join(ROOT, "gutt-core", ".claude-plugin", "plugin.json"), "utf8")
    ).name;

    // A skill is only reachable if BOTH halves resolve: the stem must be a real
    // skill directory, and the namespace must be the plugin that ships it. At
    // runtime `skill_listing` shows `<plugin>:<stem>`, so a bare stem or a wrong
    // prefix points the model at something it cannot invoke — and nothing reports
    // an error when it fails.
    const dangling = [...referenced].filter((ref) => {
      const [prefix, stem] = ref.split(":");
      return !available.has(stem) || (prefix !== "" && prefix !== pluginName);
    });
    assert.deepEqual(
      dangling,
      [],
      `hooks name unreachable skills: ${dangling.join(", ")} ` +
        `(plugin "${pluginName}" ships: ${[...available].join(", ")})`
    );

    // And the namespace must actually be present. The bare stem is not invocable;
    // shipping it made the model guess the prefix, which is what prompted this.
    const bare = [...referenced].filter((ref) => ref.startsWith(":"));
    assert.deepEqual(
      bare,
      [],
      `these skill references are missing the "${pluginName}:" namespace: ${bare.map((r) => r.slice(1)).join(", ")}`
    );
  });

  // The `/gutt-pro:*` config surface (GP-866, GP-931). Every guard below covers a
  // failure that is silent at runtime: nothing logs, nothing errors, the command just
  // stops working.
  describe("the /gutt-pro config command surface", () => {
    const ROUTER = path.join(ROOT, "gutt-core", "hooks", "user-prompt-submit.cjs");
    const LIB = path.join(ROOT, "gutt-core", "hooks", "lib", "config-command.cjs");

    // Row order is load-bearing and invisible. Put the config branch below the
    // suppression check and `/gutt-pro:on` can never un-stick a plugin that is off:
    // the off switch becomes one-way, with hand-editing config.json the only way
    // back. A source-order check is crude but catches exactly the edit that would
    // do it — moving the branch, or wrapping it in the suppression guard.
    it("applies a config command before it checks for suppression", () => {
      const src = stripComments(fs.readFileSync(ROUTER, "utf8"));
      const command = src.indexOf("configCommandResult(");
      const suppressed = src.indexOf("isSuppressed(");
      assert.ok(command > -1, "the router no longer applies config commands");
      assert.ok(suppressed > -1, "the router no longer checks suppression");
      assert.ok(
        command < suppressed,
        "the config-command row must run first, or `/gutt-pro:on` cannot reach a plugin that is off"
      );
    });

    // The parser hardcodes the namespace so it does not read plugin.json on a 50ms
    // path. That trade only holds while the constant is right: rename the plugin and
    // the autocompleted `/gutt-pro:<verb>` spelling — the one the `/` menu inserts,
    // and so the common case — silently stops parsing, while the bare forms keep
    // working and hide it. GP-931 is the rename that proved the guard earns its keep.
    it("hardcodes the plugin namespace the manifest actually declares", () => {
      const pluginName = JSON.parse(
        fs.readFileSync(path.join(ROOT, "gutt-core", ".claude-plugin", "plugin.json"), "utf8")
      ).name;
      const src = fs.readFileSync(LIB, "utf8");
      assert.match(
        src,
        new RegExp(`const PLUGIN_PREFIX = "${pluginName}";`),
        `config-command.cjs must declare PLUGIN_PREFIX = "${pluginName}"`
      );
    });

    // A command file is what makes the token a recognised command with autocomplete;
    // without it the hook may never be dispatched at all. One file per verb since
    // GP-931 dissolved the stem, so the guard iterates the parser's own list — a verb
    // added to `VERBS` with no command file is the failure this catches.
    it("ships a command file for every verb the parser accepts", () => {
      const { VERBS } = require(path.join(ROOT, "gutt-core", "hooks", "lib", "config-command.cjs"));
      assert.ok(VERBS.length > 0, "the parser accepts no verbs");
      for (const verb of VERBS) {
        const file = path.join(ROOT, "gutt-core", "commands", `${verb}.md`);
        assert.ok(fs.existsSync(file), `gutt-core/commands/${verb}.md is missing`);
        const body = fs.readFileSync(file, "utf8");
        // Model-invoked, there is no UserPromptSubmit event and so no result in
        // context — and `/gutt-pro:disable` must never be something Claude decides to
        // do.
        assert.match(body, /^disable-model-invocation: true$/m, verb);
        // Claude Code resolves the typed token from the frontmatter `name`, not from
        // the filename. A drift between them makes `/gutt-pro:<verb>` unresolvable
        // while the parser, the hook and every test here stay green — the silent
        // no-op shape this whole section exists to catch.
        assert.match(
          body,
          new RegExp(`^name: ${verb}$`, "m"),
          `${verb}.md declares a name that is not "${verb}"`
        );
        assert.match(
          body,
          /already been (applied|read)/,
          `${verb}.md must not re-run the command itself`
        );
      }
      // And the stem is gone: leaving it would keep a `/gutt-pro:gutt config` path
      // alive that the parser no longer recognises (GP-931 D1/D2).
      assert.equal(
        fs.existsSync(path.join(ROOT, "gutt-core", "commands", "gutt.md")),
        false,
        "the retired /gutt stem command is still shipped"
      );
    });
  });

  // Migration is a bulk *caller* of the memory skills, not a second implementation of
  // them. It writes a whole store in batches and then deletes the local copy, so any
  // dedup or conflict rule it fails to honour is multiplied by every fact in the store
  // and the original is gone. GP-922's flow shipped naming only `memory-capture` and
  // `memory-search`: a local note that *contradicted* the graph would have been
  // written as the newest word on its subject, in bulk, rather than going to the
  // `conflict-adjudication` skill GP-861 exists to provide. Nothing at runtime notices
  // a missing delegation — the migration just quietly does its own thing.
  //
  // The three are asserted as identifiers rather than sentences: dropping a delegation
  // fails the first assertion, renaming a skill directory fails the second, and
  // rewording the prose around them fails neither.
  it("migrate-memory delegates to the memory skills instead of reimplementing them", () => {
    const skillsDir = path.join(ROOT, "gutt-core", "skills");
    const body = fs.readFileSync(path.join(skillsDir, "migrate-memory", "SKILL.md"), "utf8");
    const required = ["memory-capture", "memory-search", "conflict-adjudication"];

    const missing = required.filter((stem) => !body.includes(`\`${stem}\``));
    assert.deepEqual(
      missing,
      [],
      `migrate-memory names no delegation to: ${missing.join(", ")} — a store is the ` +
        `largest batch of writes this plugin makes, and these skills are what bound it`
    );

    const dangling = required.filter(
      (stem) => !fs.existsSync(path.join(skillsDir, stem, "SKILL.md"))
    );
    assert.deepEqual(
      dangling,
      [],
      `migrate-memory delegates to skills that do not exist: ${dangling.join(", ")}`
    );
  });

  // The Stop judge re-fires every time it answers ok:false, because the reason is
  // fed back and the turn continues. Without an explicit stopping rule it re-asks
  // on every re-entry: measured at 16 consecutive ok:false verdicts on one turn,
  // 16 model calls, and an empty answer for the user. Claude Code passes
  // `stop_hook_active` precisely so the prompt can break its own loop — this
  // asserts the prompt actually uses it.
  it("gives the Stop judge a termination condition", () => {
    assert.ok(JUDGE_CONDITION, "no Stop judge condition to check");
    assert.match(
      JUDGE_CONDITION,
      /stop_hook_active/,
      "the Stop prompt ignores stop_hook_active, so nothing stops it re-judging the same turn"
    );
  });

  // `stop_hook_active` reaches the judge through exactly one channel: the
  // interpolated hook payload. It is not in the transcript and there is no other
  // variable carrying it. Most of that payload IS dead weight — `last_assistant_message`
  // duplicates the transcript's final message, and session_id/cwd/prompt_id/effort
  // bear on nothing — which makes "drop $ARGUMENTS, it brings no value" a reasonable
  // and very nearly correct instinct. Acting on it silently removes the loop
  // breaker's only data source and the 16-iteration livelock returns, with no test
  // failing and no error logged. So the interpolation is pinned here, next to the
  // clause that depends on it.
  // Claude Code wraps the prompt as "has the following stopping condition been
  // satisfied?", and maps satisfied to ok:true, which ALLOWS the stop. So the
  // condition has to read as a proposition that is true when the turn should just
  // end. It was originally phrased as a task — "You are deciding whether this turn
  // produced anything worth writing" — under which finding something worth writing
  // makes "satisfied" the literal answer, i.e. ok:true, i.e. allow. Measured
  // consequence: the judge emitted the same finding twice minutes apart, once as a
  // correct ok:false that reached Claude and once as a fire-shaped reason attached
  // to ok:true, which the CLI discarded unread. Accurate reasoning, inverted field,
  // silent dropped capture. This asserts the polarity is stated, not the wording.
  it("deviates from the prompt-hook wording only in the two documented ways", () => {
    // GP-866 claimed the condition text was carried over byte-identically and verified it
    // by hand at review time, so nothing pinned it: the claim would have decayed the first
    // time the prompt was reworded, silently. This is that check, committed.
    //
    // The fixture is the `prompt` field of the `type: "prompt"` Stop entry as it stood on
    // release/3.0. Exactly three deviations are allowed, and all three are forced by
    // the new mechanism rather than chosen:
    //   1. `$ARGUMENTS` → `__PAYLOAD__`, substituted by buildJudgePrompt instead of by the
    //      platform.
    //   2. "on the conversation above" → "on the turn quoted below", because
    //      buildJudgePrompt puts the condition first and appends the turn, so "above"
    //      pointed the judge at nothing but the condition's own opening sentence.
    //   3. `gutt-claude-code-plugin:memory-capture` → `gutt-pro:memory-capture`, because
    //      GP-931 renamed the plugin and a skill id is namespaced by its plugin's `name`.
    //      Keeping the old id would name a skill that cannot be resolved — the failure
    //      the namespace guard above exists to prevent. The fixture is left alone on
    //      purpose: it is the historical artifact, and rewriting it would erase the
    //      evidence this test compares against.
    // A fourth difference fails here and has to be argued for — which is the point.
    const fixture = path.join(__dirname, "fixtures", "stop-judge-condition-prompt-hook.txt");
    const original = fs.readFileSync(fixture, "utf8");
    const rebuilt = JUDGE_CONDITION.replace("__PAYLOAD__", "$ARGUMENTS")
      .replace("on the turn quoted below", "on the conversation above")
      .replaceAll("`gutt-pro:memory-capture`", "`gutt-claude-code-plugin:memory-capture`");
    assert.equal(
      rebuilt,
      original,
      "the judge condition drifted from the prompt-hook text in a way GP-866 did not document"
    );
  });

  it("points the judge at the turn in the direction the prompt actually places it", () => {
    // The retained "conversation above" wording was true of a prompt hook, where the
    // transcript preceded the condition. buildJudgePrompt appends the turn, so the phrase
    // has to follow the text it describes or the judge is told to score nothing.
    const assembled = require(STOP_JUDGE_LIB).buildJudgePrompt(
      { stop_hook_active: false },
      "THE-TURN"
    );
    const pointer = assembled.indexOf("quoted below");
    assert.ok(pointer > -1, "the condition no longer says where the turn is");
    assert.ok(
      assembled.indexOf("THE-TURN") > pointer,
      "the condition points at the turn in the wrong direction"
    );
  });

  it("states the stopping condition in the direction the CLI reads it", () => {
    assert.ok(JUDGE_CONDITION, "no Stop judge condition to check");
    // The opening sentence — everything before the first blank line — is what the
    // CLI presents as "Condition:".
    const condition = JUDGE_CONDITION.split("\n\n")[0];
    assert.match(
      condition,
      /^Nothing\b/,
      `the condition must be true when the turn should end; it currently opens "${condition.slice(0, 60)}…"`
    );
    assert.doesNotMatch(
      condition,
      /you are deciding|decide whether/i,
      "a task description is not a proposition — 'satisfied' has no defined direction against it"
    );
  });

  // Their §2 addendum: narrowing the tiers did not stop a wasted turn, because the
  // judge classed a finding about throwaway test scaffolding as an Insight — the
  // tier the narrowing keeps — and the continuation still declined it. Tier and
  // durability are independent conditions, so the prompt has to state both.
  it("requires the subject to be durable for the team, not just correctly typed", () => {
    assert.ok(JUDGE_CONDITION, "no Stop judge condition to check");
    assert.match(
      JUDGE_CONDITION,
      /durable for the team|throwaway|scaffolding/i,
      "nothing stops the judge firing on a real finding about a sandbox or test harness"
    );
  });

  // The condition tells the judge to read `stop_hook_active` from the payload, so the
  // payload has to arrive. Under the prompt hook that was the platform substituting
  // `$ARGUMENTS`; now it is `buildJudgePrompt` substituting `__PAYLOAD__`.
  //
  // Asserted on the assembled prompt rather than on the template, which is a stronger
  // guard than the one it replaces: a `$ARGUMENTS` match only proved the placeholder was
  // *present*, and would have passed just as happily if nothing ever replaced it. This
  // fails if the placeholder goes missing, if it survives unsubstituted, or if the value
  // stops being forwarded.
  it("delivers the payload the termination condition is told to read", () => {
    const { buildJudgePrompt } = require(STOP_JUDGE_LIB);
    const assembled = buildJudgePrompt({ stop_hook_active: true }, "a closing summary");
    assert.match(
      assembled,
      /"stop_hook_active"\s*:\s*true/,
      "the judge is told to read stop_hook_active but the assembled prompt does not carry it"
    );
    assert.doesNotMatch(
      assembled,
      /__PAYLOAD__|\$ARGUMENTS/,
      "a placeholder reached the judge unsubstituted, so it reads a literal instead of a value"
    );
    assert.match(assembled, /a closing summary/, "the turn being scored is not in the prompt");
  });

  // Observed in a real session: the judge answered {"ok": true} with a 400-character
  // `reason` attached, which Claude Code logged and discarded. Harmless today, but
  // it is a paragraph written to be thrown away on the common path — every turn —
  // and it is the exact shape that would nag if an allow verdict's reason ever did
  // get routed back. The prompt described how to write a reason without saying when
  // not to, so the judge filled the field in.
  it("tells the Stop judge not to write a reason it allows the turn with", () => {
    assert.ok(JUDGE_CONDITION, "no Stop judge condition to check");
    assert.match(
      JUDGE_CONDITION,
      /omit `reason`|no other field/i,
      "the Stop prompt never tells the judge to drop `reason` on an allow, so it writes one"
    );
  });

  // A fired verdict costs the user their view of the turn. Stop runs after the work
  // is done and the answer is written, so whatever Claude says next is what they are
  // left looking at — and a continuation spent entirely on memory bookkeeping buries
  // the work beneath it, leaving them to scroll back for what they asked for.
  //
  // These guards used to read `memory-capture/SKILL.md` for both halves of the fix, and
  // the comment here argued that the fired reason was the wrong home for either: the
  // reason is a payload read on every firing, so procedure written there is duplicated by
  // the moment it applies. GP-927 kept that argument and narrowed it. It is about
  // *duplication*, and it never reached text that exists in exactly one place and is
  // loaded on no other path — which is what the closing style now is. Nothing on the
  // capture path loads `output-style`, so a rule left only in that file would be written
  // down and inert precisely when it is needed.
  //
  // So the two halves now have two homes, and each is guarded where it lives: the length
  // of the capture *account* stays with `memory-capture`, and everything below it belongs
  // to `output-style`, whose injected region is the single source the hook reads. The
  // reason's own shape is guarded separately below.
  //
  // Anchored on the terms that carry the meaning rather than the sentences around them.
  // Reword the prose freely; keep those. The artifact these once named was a "TL;DR", and
  // the guard matched that literal until the label was deliberately dropped — a fixed
  // heading reads as boilerplate. Note the shape of that near-miss: had the rename landed
  // without touching this file the assertion would have failed loudly, which is the good
  // case. The bad case is a guard whose string survives a rewrite while the property it
  // stood for quietly leaves.
  describe("closing the reply on the work rather than the bookkeeping", () => {
    const CAPTURE_MD = path.join(ROOT, "gutt-core", "skills", "memory-capture", "SKILL.md");
    const STYLE_MD = path.join(ROOT, "gutt-core", "skills", STOP_JUDGE.STYLE_SKILL_DIR, "SKILL.md");

    it("caps the capture account, where that rule still lives", () => {
      // A brief closing block under a long capture report is still a buried one, so the
      // account above it needs a bound and that bound is capture's own business.
      assert.match(
        fs.readFileSync(CAPTURE_MD, "utf8"),
        /a few lines, not a report/i,
        "nothing caps the length of the capture account the closing block has to follow"
      );
    });

    // The rule used to *be* the payload, and these guards read it out of the injected region.
    // It is now stated in the skill body with a one-line pointer shipping in its place, so the
    // guards follow the rule rather than the region. The property they defend is unchanged and
    // was never about the delivery mechanism: the closing rule is stated, in full, in exactly
    // one place. What the payload must now contain is guarded separately, below.
    //
    // Both slices are computed by locating the markers rather than by `split(END)[1]`, so
    // neither depends on where in the file the markers sit. The earlier version took the tail
    // after the end marker; when the markers moved below the rules it would have gone empty
    // and passed every `doesNotMatch` in this describe for the wrong reason.
    const outsideMarkers = () => {
      const md = fs.readFileSync(STYLE_MD, "utf8");
      const begin = md.indexOf(STOP_JUDGE.STYLE_BEGIN);
      const end = md.indexOf(STOP_JUDGE.STYLE_END, begin + STOP_JUDGE.STYLE_BEGIN.length);
      assert.ok(begin !== -1 && end !== -1, "the skill lost its injection markers");
      return md.slice(0, begin) + md.slice(end + STOP_JUDGE.STYLE_END.length);
    };

    // Narrower than `outsideMarkers`: just the section that states the rule. The ordering
    // assertions below locate phrases by index, and against the whole file another section
    // using the same words could satisfy them without the rule itself being in order.
    const rulesSection = () => {
      const md = fs.readFileSync(STYLE_MD, "utf8");
      const start = md.indexOf("## The rules");
      assert.notEqual(start, -1, "the skill has no `## The rules` section stating the rule");
      const next = md.indexOf("\n## ", start + 1);
      return md.slice(start, next === -1 ? undefined : next);
    };

    // The phrases that carry the closing rule, in one list, asserted **present** in the skill
    // body and **absent** from the payload by the two tests below. They are the same claim
    // seen from both sides — the rule is stated here and only here — and keeping two
    // hand-maintained literal lists is what let the recap exclusion be checked in the body
    // while the payload guard omitted it, which review caught. Add a phrase here and both
    // directions enforce it.
    //
    // Every pattern is whitespace-tolerant. Prettier owns line breaks in markdown and reflows
    // this section freely, and moving the rule out of the payload is what exposed it: inside
    // the markers the rule was three unwrapped lines, so literal spaces matched. The sibling
    // test further down already learned this once — a guard that breaks on reformatting
    // teaches people to loosen the guard.
    const RULE_PHRASES = [
      // Both accounts are required, in order. Demanding only the summary invites a reply that
      // silently drops the fact a capture was written; demanding only the capture account is
      // the defect itself.
      [/two\s+parts,\s+in\s+this\s+order/i, "the two-part demand"],
      [/closing\s+summary\s+of\s+the\s+turn/i, "the closing summary named"],
      [/whatever\s+sits\s+at\s+the\s+bottom/i, "the bottom-of-the-reply rule"],
      // The capture is part of finishing a turn. Framing it as a detour makes the reply read
      // as an apology for having done the bookkeeping, and puts the emphasis on the
      // interruption rather than on the work the user came for.
      [/not\s+an\s+interruption/i, "the not-an-interruption clause"],
      // GP-927's definition question. "Repeat the output" read literally produces a verbatim
      // echo, which doubles a long reply; read loosely it produces "I did X then captured Y",
      // which is the recap that is roughly the defect. Both have to be excluded where the rule
      // is stated, not only in the commentary around it.
      [/not\s+a\s+verbatim\s+echo/i, "the verbatim-echo exclusion"],
      [/not\s+an\s+account\s+of\s+what\s+you\s+just\s+did/i, "the recap exclusion"],
    ];

    it("states the closing rule in the skill that owns it", () => {
      const rules = rulesSection();
      const missing = RULE_PHRASES.filter(([re]) => !re.test(rules)).map(([, name]) => name);
      assert.deepEqual(
        missing,
        [],
        `the \`## The rules\` section no longer states: ${missing.join("; ")} — the payload is ` +
          `a pointer now, so a rule missing here is missing everywhere`
      );
    });

    // The payload's side of the same split. A pointer is only worth shipping if it routes
    // somewhere, and it stops being a pointer the moment someone pastes the rule back beside
    // it — that would restore the duplication on every fire while still passing the guard
    // above, since the rule would be in both places.
    it("injects a pointer to the skill, not a copy of the rule", () => {
      const block = STOP_JUDGE.readStyleBlock();
      assert.ok(block, "the style skill's injected region is empty or unreadable");
      assert.match(
        block,
        new RegExp(`\`[\\w.-]+:${STOP_JUDGE.STYLE_SKILL_DIR}\``),
        `the injected region does not name \`<plugin>:${STOP_JUDGE.STYLE_SKILL_DIR}\`, so a ` +
          `reply that follows it has no way to reach the rule`
      );
      const restated = RULE_PHRASES.filter(([re]) => re.test(block)).map(([, name]) => name);
      assert.deepEqual(
        restated,
        [],
        `the injected region restates the rule (${restated.join(", ")}) instead of pointing at ` +
          `it, so it ships on every fire and there are two copies to keep in step`
      );
    });

    // Every assertion above matches a *phrase*, and a phrase cannot tell an instruction from
    // its own inverse. Rewriting "it is the summary, never the bookkeeping" the other way
    // round leaves all six matching while the block now prescribes exactly the defect GP-927
    // exists to fix. This is the hazard named further down this file — a guard whose string
    // survives a rewrite while the property it stood for quietly leaves — so the two
    // orderings that carry the meaning are asserted as relations instead.
    it("orders the two parts, and gives the bottom of the reply to the summary", () => {
      const block = rulesSection().toLowerCase();
      const account = block.indexOf("account for it first");
      const summary = block.indexOf("closing summary of the turn");
      assert.ok(
        account !== -1 && summary !== -1,
        "neither part is named in the words this guard can locate — reword the guard with the block"
      );
      assert.ok(
        account < summary,
        "the block puts the closing summary before the bookkeeping account, which buries the answer"
      );
      // "Whatever sits at the bottom … is the summary, never the bookkeeping" — whichever of
      // the two words comes first after that clause is the one being assigned to the bottom.
      const bottom = block.slice(block.indexOf("whatever sits at the bottom"));
      const claimsSummary = bottom.indexOf("summary");
      const claimsBookkeeping = bottom.indexOf("bookkeeping");
      assert.ok(
        claimsSummary !== -1 && claimsSummary < claimsBookkeeping,
        "the bottom of the reply is assigned to the bookkeeping rather than the closing summary"
      );
    });

    // The whole-reply style list was the first thing measured on the in-payload question:
    // `capture_close` **round 4** scored it inside the markers at 67% against 96% for the
    // 878-character block without it, n=24 — 335 characters that made the payload worse rather
    // than merely longer, retracting the earlier reading of it as merely a cost. Quote that
    // pair as round 4's and not as a standing fact: the 96% describes an 878-character block
    // the skill no longer contains, and round 5 put the same arm at 54%. Since the pointer
    // change, the only thing this file contributes to a fired reason is the pointer itself, so
    // the list's position is no longer what is at stake here — its *survival* is.
    //
    // Being unshipped is what made it the easiest thing in this change to lose by accident: no
    // hook reads it, so deleting it would break nothing at runtime and — before the test below
    // existed — no test either, and the skill would quietly stop stating the style AC1 asks
    // for. The test below is what closes that gap; the hazard is past tense because of it.
    it("keeps the whole-reply style in the skill, outside the injected region", () => {
      const outside = outsideMarkers();
      // Every pattern is whitespace-tolerant, because Prettier owns line breaks in markdown
      // and reflows this paragraph freely. An earlier version used literal spaces and failed
      // the moment "Concrete estimates" landed either side of a wrap — a guard that breaks on
      // reformatting teaches people to loosen the guard.
      const required = [
        [/no\s+preamble/i, "substance first, no preamble"],
        [/closing\s+pleasantry/i, "no closing pleasantry"],
        [/restate\s+state/i, "restate state rather than assuming it carried"],
        [/cap\s+lists\s+at\s+five/i, "capped and ranked lists"],
        [/concrete\s+estimates/i, "concrete estimates"],
        [/cause,\s+then\s+fix/i, "matter-of-fact about failures"],
        [/one\s+next\s+action/i, "one next action"],
      ];
      const missing = required.filter(([re]) => !re.test(outside)).map(([, name]) => name);
      assert.deepEqual(
        missing,
        [],
        `the skill no longer states: ${missing.join("; ")} — these moved out of the injected ` +
          `region on purpose, they did not stop being the style`
      );
      // And they must not have been left inside it as well, which would be the duplication
      // moving them was meant to avoid paying for.
      assert.doesNotMatch(
        STOP_JUDGE.readStyleBlock(),
        /no preamble/i,
        "the style list is inside the markers again, so it ships on every fire"
      );
    });

    it("holds the closing style in exactly one place", () => {
      const capture = fs.readFileSync(CAPTURE_MD, "utf8");
      // The reference has to survive, or the skill that owns the rule is unreachable from
      // the one file the capture path does load.
      assert.match(
        capture,
        new RegExp(`\`${STOP_JUDGE.STYLE_SKILL_DIR}\``),
        "memory-capture no longer points at the skill that owns how the reply closes"
      );
      // And the rule must not have been left behind as a second copy. These are the
      // phrases that carried it while it lived there; any of them still in that file
      // means the repo ships both positions, which is what GP-927 forbids.
      const moved = [
        /summary of\s+(that|the)\s+work/i,
        /last, after everything|after everything else/i,
        /whatever sits at\s+the bottom/i,
        /no "returning to"/i,
      ].filter((re) => re.test(capture));
      assert.deepEqual(
        moved,
        [],
        `memory-capture still restates the closing rule (${moved.join(", ")}) — one source, ` +
          `and it is the output-style skill's injected region`
      );
    });

    it("keeps the injected region a delimited slice, not the whole skill", () => {
      const md = fs.readFileSync(STYLE_MD, "utf8");
      assert.ok(md.includes(STOP_JUDGE.STYLE_BEGIN), "the skill lost its opening marker");
      assert.ok(md.includes(STOP_JUDGE.STYLE_END), "the skill lost its closing marker");
      // The bound that matters is the reason budget, not a share of the file: the block is
      // appended to every fired reason, and what it may not do is crowd out the judge's
      // bullets. Expressed as the slack the composed cap leaves once both constants are
      // present, which is the `hitl` worst case.
      const block = STOP_JUDGE.readStyleBlock();
      // The `- 2` is the "\n\n" `composeReason` puts between the tail and the block. Omitting
      // it made this guard permit 1261 where the other one permitted 1259, so a block of
      // either intervening length passed here and failed there.
      const room =
        STOP_JUDGE.MAX_COMPOSED_REASON_CHARS -
        STOP_JUDGE.MAX_REASON_CHARS -
        STOP_JUDGE.HITL_TAIL.length -
        2;
      assert.ok(
        block.length <= room,
        `the injected region is ${block.length} chars and only ${room} fit beside a full ` +
          `judge reason and HITL_TAIL — shorten it, or raise MAX_COMPOSED_REASON_CHARS ` +
          `deliberately`
      );
      // Rationale and attribution are what must stay outside the markers: they argue from
      // the hook that interposes, which is background the agent reading a fired reason does
      // not need, and it would ship on every fire. They live in references/origin.md.
      assert.doesNotMatch(
        block,
        /ayghri|MIT|baseline/i,
        "attribution or rationale is inside the markers, so it ships in every fired reason"
      );
    });

    // The reason is fed back and lands in the conversation, so more text in it is more
    // surface for GP-921 — a payload reaching the user as the assistant's answer.
    // `VERDICT_SHAPE` screens the judge's half; nothing screens ours, because ours is a
    // constant. This is that screen, run once at build time instead.
    it("gives the leak detectors nothing to catch in the injected region", () => {
      const block = STOP_JUDGE.readStyleBlock();
      assert.doesNotMatch(
        block,
        STOP_JUDGE.VERDICT_SHAPE,
        "the style block is verdict-shaped, so composing it would trip the GP-921 screen"
      );
      // The same alphabet `tests/e2e/session-lifecycle.e2e.cjs` uses on injected context:
      // imperative out-of-band framing is documented to trigger Claude's prompt-injection
      // defenses, which surfaces the text to the user instead of being consumed.
      assert.doesNotMatch(
        block,
        /MANDATORY|you MUST|NOT optional|CRITICAL violation|NEVER skip/i,
        "the style block reads as an out-of-band system command"
      );
    });
  });

  // The reason's shape is the counterpart. It is generated fresh on every firing and
  // lands in Claude's context ahead of the skill, so it has to stay a payload: which
  // subjects this turn produced, and nothing the skill already covers. The word cap
  // is what keeps a judge from re-deriving a briefing in the bullets.
  it("keeps the fired reason a payload — skill reference plus capped bullets", () => {
    assert.ok(JUDGE_CONDITION, "no Stop judge condition to check");
    assert.match(
      JUDGE_CONDITION,
      /10 words/,
      "nothing bounds a bullet, so the reason grows back into the briefing it replaced"
    );
    assert.match(
      JUDGE_CONDITION,
      /one bullet per subject|bullet per subject/i,
      "the reason no longer specifies a bullet per subject, leaving its shape to the judge"
    );
  });

  // Both halves of this were live for the length of one commit, and the failure is the
  // loudest one this hook has: in a `claude -p` run against this repo, "Reply with
  // exactly: up" returned ```json {"ok": true}``` — the hook's verdict printed as the
  // user's answer — 4 times out of 4, and once as a full ok:false whose reason carried
  // the example's own two bullets as though they were findings from that turn.
  //
  // Two causes, one commit. The prompt shrink dropped the closing anti-restatement
  // clause as rationale; it was load-bearing, and it names this exact outcome. And the
  // shrunk prompt *ended* on a filled-in example of the firing branch, so the last thing
  // the judge read was a completed fire verdict — which it reproduced, contents and all.
  //
  // No unit test covered either property, and `npm run test:all` excludes the e2e tier
  // where the pong-fixture detector lives, so nothing failed before this shipped.
  it("stops the judge's own format leaking into the answer", () => {
    assert.ok(JUDGE_CONDITION, "no Stop judge condition to check");
    assert.match(
      JUDGE_CONDITION,
      /do not restate this response format|quotes the JSON gets echoed/i,
      "the clause naming the echo failure is gone; the verdict prints as the user's answer"
    );
    assert.match(
      JUDGE_CONDITION,
      /format sample, not findings|never carry them/i,
      "nothing marks the example as a sample, so the judge fires carrying its bullets"
    );
    // The example must not be the last thing read: a completed fire verdict in final
    // position is what the judge copies.
    const tail = JUDGE_CONDITION.trim().split("\n").slice(-1)[0];
    assert.doesNotMatch(
      tail,
      /^-\s*(Insight|Incident):/,
      `the prompt ends on an example bullet, biasing the judge toward firing: "${tail}"`
    );
  });

  // The defect this guards: a fired verdict became the user's answer. A `type: "prompt"`
  // hook's fire injected the whole judge template into the main conversation as
  // `Stop hook feedback:\n[<template>]: <reason>`, and the main agent read "respond
  // with exactly {"ok": true}" as an instruction to itself. Two wordings were tried
  // against it and both cost more than they saved; they are recorded in
  // evals/suites/stop_judge/FINDINGS.md — a clause in the template (0/6 leaks, but the
  // judge applied the prohibition to itself and fire rate fell to 3/15), and a mandated
  // final line in the reason (0/6 leaks, but verdicts stopped parsing as the judge wrote
  // the line outside the JSON, and a fire began reading as an R23 block).
  //
  // Neither was needed in the end. GP-866 made the Stop handler a command hook, and a
  // command hook feeds back only what the router writes to stdout — the `reason`, never
  // the template. The structural half is pinned deterministically: the type assertion
  // above ("keeps the Stop judgement with a model, now via a command hook") forbids the
  // one hook shape that echoes its template, and the assertion below pins the router's
  // stdout to the two-field verdict routing with the template out of its scope. The
  // behavioural halves live where output is observed: `and the fire reaches a capture
  // attempt` in tests/e2e/hook-routing.e2e.cjs asserts every fire draws a response, its
  // sibling `never leaks the judge protocol into the reply` asserts the reply is not
  // verdict-shaped, and the deterministic detector is
  // evals/suites/stop_judge/leak_probe.py (`--shape command` since the conversion).
  it("feeds a fire back as the reason alone, with the template out of the router's reach", () => {
    const src = stripComments(
      fs.readFileSync(path.join(ROOT, "gutt-core", "hooks", "stop-capture.cjs"), "utf8")
    );
    // Exactly one stdout write, of exactly the two-field routing object. A second
    // write, or a wider object, is a new channel back into the conversation and has to
    // be reviewed as one. Openings are counted separately from the payload because a
    // write reformatted across lines must still count — a single-line pattern would
    // wave a multiline second write straight through.
    const opens = [...src.matchAll(/process\s*\.\s*stdout\s*\.\s*write\s*\(/g)];
    assert.equal(opens.length, 1, `expected exactly one stdout write, found ${opens.length}`);
    // The payload check pins the *entire* argument of the one write it just counted:
    // exactly the serialized two-field object and a newline, in the template-literal
    // form the router uses. Any prefix or suffix smuggled into the same call — leaked
    // template text included — breaks the match, as does a switch to a different
    // output form, which is the review this guard exists to force.
    assert.match(
      src,
      /process\s*\.\s*stdout\s*\.\s*write\s*\(\s*`\$\{JSON\.stringify\(\{\s*decision:\s*"block",\s*reason,?\s*\}\)\}\\n`\s*\)/,
      "the router's stdout is no longer exactly the {decision, reason} pair plus newline"
    );
    // The write above must also be the only *route* to stdout. A call-shape count
    // alone misses an alias (`const out = process.stdout`) and misses console's
    // stdout half — but any alias still needs the token, and the console calls that
    // print to stdout are banned outright. console.error/warn go to stderr and stay
    // out of the fire channel, so they stay legal.
    const stdoutTokens = [...src.matchAll(/\bstdout\b/g)];
    assert.equal(stdoutTokens.length, 1, "a second route to stdout appeared in the router");
    assert.doesNotMatch(
      src,
      /console\.(log|info|debug)\(/,
      "console's stdout half writes to the fire channel behind the guard's back"
    );
    // The template must not even be in scope: a router that never holds it cannot echo
    // it, whatever later happens to the write above.
    assert.doesNotMatch(
      src,
      /JUDGE_CONDITION|buildJudgePrompt/,
      "the router holds the judge template — one stray interpolation reopens GP-921"
    );
  });

  // Measured on the `evals/` bench (see evals/suites/stop_judge/FINDINGS.md): the
  // prompt that enumerated activities to stay quiet about — "routine edits, answering a
  // question, reading or searching code, formatting" — missed 11 of 21 turns that had
  // produced a recorded finding, rejecting them as "routine validation and testing
  // work". Verifying, testing and debugging are how findings get made, so an activity
  // list is a list of the routes to the thing being looked for. Stating the property
  // and disclaiming the route took missed fires to 6 of 21 and accuracy on confidently
  // labelled cases from 73% to 90%.
  //
  // The negative half is the load-bearing one: re-adding any activity enumeration
  // reinstates the regression, and it reads as a harmless clarification.
  it("judges the finding rather than the activity that produced it", () => {
    assert.ok(JUDGE_CONDITION, "no Stop judge condition to check");
    assert.match(
      JUDGE_CONDITION,
      /judge the finding|not what it \*?did\*?/i,
      "the prompt no longer separates the finding from the activity, so verification reads as routine"
    );
    assert.doesNotMatch(
      JUDGE_CONDITION,
      /routine edits|reading or searching code|answering a question/i,
      "an activity list is back: these describe how findings get made, not what to ignore"
    );
  });

  // Also from the bench: the shortest variant left the judge's role implicit, and eight
  // of its calls stopped judging and started capturing — "the memory server is
  // unreachable, so per the skill's degradation rule I will surface the episode
  // drafts". The transcript it scores is often *about* memory capture, so without an
  // explicit role the judge joins the work instead of scoring it, and emits prose where
  // a verdict belongs. Anchored on the terms that carry it; reword the sentence freely.
  it("tells the Stop judge it is scoring the turn, not doing the work", () => {
    assert.ok(JUDGE_CONDITION, "no Stop judge condition to check");
    assert.match(
      JUDGE_CONDITION,
      /not continuing it|capture nothing yourself|call no tool/i,
      "nothing states the judge's role, so it can answer as the agent doing the capture"
    );
  });

  // The reason has to open by naming the skill, and showing that line in the example is
  // not enough to get it: variants that only demonstrated it produced it in 14% and 0%
  // of their fired reasons. Models reproduce the repeated element — the bullets — and
  // drop the single header line above them. Saying the reason *opens with* the line
  // took that to 100%.
  it("asks for the skill line rather than only showing it in the example", () => {
    assert.ok(JUDGE_CONDITION, "no Stop judge condition to check");
    assert.match(
      JUDGE_CONDITION,
      /opens with the line/i,
      "the skill reference is only illustrated, so the judge will copy the bullets and drop it"
    );
  });

  /**
   * The capture types `memory-capture` will write unprompted, and the ones it holds
   * behind an explicit human signal — read out of the skill itself rather than
   * duplicated here, so the assertions below track the skill instead of a snapshot
   * of it.
   * @returns {{auto: string[], gated: string[]}}
   */
  function captureTiers() {
    const md = fs.readFileSync(
      path.join(ROOT, "gutt-core", "skills", "memory-capture", "SKILL.md"),
      "utf8"
    );
    // Each tier is a bolded lead-in followed by a `- **Type** — …` list, and ends at
    // the next bolded lead-in. Slicing to that boundary keeps the two lists apart;
    // scanning the whole file would merge them and make every assertion vacuous.
    const section = (heading) => {
      const start = md.indexOf(heading);
      if (start < 0) {
        return [];
      }
      const rest = md.slice(start + heading.length);
      const end = rest.search(/\n\*\*[A-Z]/);
      const body = end < 0 ? rest : rest.slice(0, end);
      return [...body.matchAll(/^- \*\*([A-Za-z]+)\*\*/gm)].map((m) => m[1]);
    };
    return {
      auto: section("**Auto-write — no confirmation needed:**"),
      gated: section("**Gated — write only on an explicit human signal"),
    };
  }

  it("reads the capture tiers out of the skill (a silent empty list passes everything)", () => {
    const { auto, gated } = captureTiers();
    assert.ok(auto.length > 0, "found no auto-write types in memory-capture/SKILL.md");
    assert.ok(gated.length > 0, "found no gated types in memory-capture/SKILL.md");
  });

  // The decision (2026-07-28): a trigger must be a subset of what its action can
  // complete. The judge used to be able to fire on a Decision — and did, live — which
  // at best spends an entire continuation turn on Claude explaining why it declined
  // to write one, and re-fires Stop while doing it. That is the pressure that
  // produced the 16-iteration livelock; the termination fix made the loop end, not
  // stop starting.
  //
  // The rejected softer fix was telling the judge to name a subject without a type.
  // That does not narrow anything: it leaves the classifier to guess, and a guess
  // that lands on Insight has written a gated class under the wrong label — the
  // mitigation succeeding by defeating the gate it was protecting.
  it("lets the Stop judge fire only on what memory-capture can write unprompted", () => {
    assert.ok(JUDGE_CONDITION, "no Stop judge condition to check");
    const { auto, gated } = captureTiers();

    // The fire condition is the prompt's bulleted list of bolded type names.
    //
    // Anchored on that structure rather than on the prose around it. The first
    // version sliced between the literal phrases "Worth capturing means" and
    // "Allow the stop", and a later rewrite that changed neither the types nor the
    // policy — only the wording — broke the guard. A guard coupled to prose
    // punishes legitimate editing and teaches people to reword the test instead of
    // rechecking the claim. The bullet shape is the part that carries meaning.
    const bulleted = [...JUDGE_CONDITION.matchAll(/^- (?:an?|the) \*\*([A-Za-z]+)\*\*/gm)].map(
      (m) => m[1]
    );
    assert.deepEqual(
      [...new Set(bulleted)].sort(),
      [...auto].sort(),
      "the judge's fire condition and the skill's auto-write tier have diverged"
    );

    // And every gated class must still be named somewhere — in the prohibition. If
    // the skill adds a fourth gated type, this fails until the prompt rules it out,
    // rather than leaving the judge free to ask for something new and unwritable.
    const unmentioned = gated.filter((t) => !JUDGE_CONDITION.includes(t));
    assert.deepEqual(
      unmentioned,
      [],
      `the Stop prompt never rules out these gated capture types: ${unmentioned.join(", ")}`
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

/**
 * Hook libs must be real files on disk, in every plugin.
 *
 * `tests/check-no-symlinks.cjs` guards the *cause* — git mode 120000 in the index — and
 * that is the right thing to block, because it is recorded identically on every
 * platform. This guards the *symptom*: a lib whose bytes are a path string rather than
 * JavaScript, which is what a Windows checkout of such a commit actually produces and
 * what killed every hook at require() time in 3.0.0. The two are worth keeping separate,
 * since CI runs on Linux where the cause is present but the symptom never appears.
 */
describe("every plugin ships its hook libs as real files", () => {
  // Every plugin the marketplace lists, not the hand-written PLUGIN_DIRS above: that
  // list is scoped to plugins with hook *shape* to constrain, whereas any plugin that
  // grows a hooks/lib needs its files checked from the first one.
  const libDirs = marketplacePluginDirs()
    .map((d) => path.join(ROOT, d, "hooks", "lib"))
    .filter((d) => fs.existsSync(d));

  it("found at least one hooks/lib directory to check", () => {
    assert.ok(
      libDirs.length > 0,
      "no plugin has a hooks/lib directory — this suite would pass vacuously"
    );
  });

  for (const dir of libDirs) {
    const rel = path.relative(ROOT, dir);
    const libs = fs.readdirSync(dir).filter((f) => f.endsWith(".cjs"));

    it(`${rel} contains libs to check`, () => {
      assert.ok(libs.length > 0, `${rel} exists but holds no .cjs files`);
    });

    for (const name of libs) {
      it(`${rel}/${name} is a real file holding JavaScript`, () => {
        const abs = path.join(dir, name);
        assert.ok(!fs.lstatSync(abs).isSymbolicLink(), `${abs} is a symlink`);
        assert.match(
          fs.readFileSync(abs, "utf8"),
          /module\.exports/,
          `${abs} does not look like JavaScript — a Windows checkout of a committed ` +
            `symlink leaves the link target path here as the file's contents`
        );
      });
    }
  }
});
