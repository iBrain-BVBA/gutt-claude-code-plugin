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

  // Stop is the inverse: on ok:false "the reason is fed back to Claude as its
  // next instruction and the turn continues" — routing with no lost work. If
  // this ever becomes a command hook again we are back to judging in regex (R11).
  it("keeps the Stop judgement in a prompt hook, not a script", () => {
    const stop = ALL.filter((h) => h.event === "Stop");
    assert.equal(stop.length, 1, "exactly one Stop handler");
    assert.equal(stop[0].type, "prompt");
  });

  // A prompt hook's `model` is passed straight to the API, so a CLI alias is not a
  // model id: `"sonnet"` answers 404 `not_found_error {"message": "model: sonnet"}`.
  // Measured, and the failure is silent — the hook dispatches, the evaluator retries
  // 11 times, no verdict is ever produced, the turn ends normally, and the only trace
  // is in --debug-file. That disables the judge outright with every tier green: the
  // command-hook runner skips this entry (type: prompt) and the e2e verdict
  // assertions need a verdict to bite on. Hence a shape check here.
  // See docs/hook-platform-capabilities.md §5.
  it("pins the Stop judge to a full model id, never a CLI alias", () => {
    const [stop] = ALL.filter((h) => h.event === "Stop");
    if (stop.model === undefined) {
      return; // unpinned is valid — the platform picks a fast default
    }
    assert.match(
      stop.model,
      /^claude-[a-z]+-\d/,
      `"${stop.model}" is not a model id; an alias 404s and silently kills the judge`
    );
  });

  // A ≤60 code-line cap on every gutt-core hook used to live here, and it was the
  // only thing keeping procedure out of the hooks — it is what pushed GP-922's
  // pointer prose into shared/builtin-memory.cjs. It was removed deliberately in
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

    // Everything a hook can say to the model: the router sources and the prompt
    // text in hooks.json.
    //
    // Comments are stripped from the .cjs sources first. This file's own house
    // style explains the wrong forms alongside the right ones — a comment reading
    // "not `memory-search`" is documentation, not a pointer, and scanning it flagged
    // correct code. hooks.json is scanned whole: its Stop prompt is prose the model
    // actually receives.
    // `shared/` is scanned alongside the hooks because GP-922 moved pointer prose
    // there for the first time: the SessionStart migration offer is policy, so the
    // thin-router cap above pushed it out of the hook and into
    // `shared/builtin-memory.cjs`. Scanning only the hook directory would have left
    // that pointer unguarded — precisely the quiet failure this test exists to catch.
    const hookDir = path.join(ROOT, "gutt-core", "hooks");
    const sharedDir = path.join(ROOT, "shared");
    const cjsIn = (dir) =>
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".cjs"))
        .map((f) => stripComments(fs.readFileSync(path.join(dir, f), "utf8")));
    const sources = cjsIn(hookDir)
      .concat(cjsIn(sharedDir))
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
    const stop = ALL.find((h) => h.event === "Stop");
    assert.ok(stop, "no Stop handler to check");
    assert.match(
      stop.prompt,
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
  it("states the stopping condition in the direction the CLI reads it", () => {
    const stop = ALL.find((h) => h.event === "Stop");
    assert.ok(stop, "no Stop handler to check");
    // The opening sentence — everything before the first blank line — is what the
    // CLI presents as "Condition:".
    const condition = stop.prompt.split("\n\n")[0];
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
    const stop = ALL.find((h) => h.event === "Stop");
    assert.ok(stop, "no Stop handler to check");
    assert.match(
      stop.prompt,
      /durable for the team|throwaway|scaffolding/i,
      "nothing stops the judge firing on a real finding about a sandbox or test harness"
    );
  });

  it("keeps the payload interpolation that the termination condition reads", () => {
    const stop = ALL.find((h) => h.event === "Stop");
    assert.ok(stop, "no Stop handler to check");
    assert.match(
      stop.prompt,
      /\$ARGUMENTS/,
      "the prompt names stop_hook_active but no longer interpolates the payload that carries it"
    );
  });

  // Observed in a real session: the judge answered {"ok": true} with a 400-character
  // `reason` attached, which Claude Code logged and discarded. Harmless today, but
  // it is a paragraph written to be thrown away on the common path — every turn —
  // and it is the exact shape that would nag if an allow verdict's reason ever did
  // get routed back. The prompt described how to write a reason without saying when
  // not to, so the judge filled the field in.
  it("tells the Stop judge not to write a reason it allows the turn with", () => {
    const stop = ALL.find((h) => h.event === "Stop");
    assert.ok(stop, "no Stop handler to check");
    assert.match(
      stop.prompt,
      /omit `reason`|no other field/i,
      "the Stop prompt never tells the judge to drop `reason` on an allow, so it writes one"
    );
  });

  // A fired verdict costs the user their view of the turn. Stop runs after the work
  // is done and the answer is written, so whatever Claude says next is what they are
  // left looking at — and a continuation spent entirely on memory bookkeeping buries
  // the work it interrupted, leaving them to scroll back for what they asked for.
  //
  // Both halves of the fix live in `memory-capture/SKILL.md`, not in the fired reason.
  // The reason is read on every firing and is a payload — a skill name and a bullet
  // per subject — so procedure written there is duplicated by the moment it applies.
  // These assertions therefore target the skill; the reason's own shape is guarded
  // separately below.
  //
  // Anchored on the terms that carry the meaning rather than the sentences around
  // them: the artifact is named "TL;DR" and its position is the requirement. Reword
  // the prose freely; keep those.
  it("makes a capture hand the turn back with a TL;DR, last", () => {
    const md = fs.readFileSync(
      path.join(ROOT, "gutt-core", "skills", "memory-capture", "SKILL.md"),
      "utf8"
    );
    assert.match(
      md,
      /TL;DR/,
      "the skill never asks for a summary of the interrupted work, so the capture becomes the turn"
    );
    assert.match(
      md,
      /last, after everything|after everything else/i,
      "a TL;DR that is not required to come last can be buried by the capture account above it"
    );
    // The other half of the same problem: a brief TL;DR under a long capture report
    // is still a buried TL;DR.
    assert.match(
      md,
      /a few lines, not a report/i,
      "nothing caps the length of the capture account the TL;DR has to follow"
    );
  });

  // The reason's shape is the counterpart. It is generated fresh on every firing and
  // lands in Claude's context ahead of the skill, so it has to stay a payload: which
  // subjects this turn produced, and nothing the skill already covers. The word cap
  // is what keeps a judge from re-deriving a briefing in the bullets.
  it("keeps the fired reason a payload — skill reference plus capped bullets", () => {
    const stop = ALL.find((h) => h.event === "Stop");
    assert.ok(stop, "no Stop handler to check");
    assert.match(
      stop.prompt,
      /10 words/,
      "nothing bounds a bullet, so the reason grows back into the briefing it replaced"
    );
    assert.match(
      stop.prompt,
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
    const stop = ALL.find((h) => h.event === "Stop");
    assert.ok(stop, "no Stop handler to check");
    assert.match(
      stop.prompt,
      /do not restate this response format|quotes the JSON gets echoed/i,
      "the clause naming the echo failure is gone; the verdict prints as the user's answer"
    );
    assert.match(
      stop.prompt,
      /format sample, not findings|never carry them/i,
      "nothing marks the example as a sample, so the judge fires carrying its bullets"
    );
    // The example must not be the last thing read: a completed fire verdict in final
    // position is what the judge copies.
    const tail = stop.prompt.trim().split("\n").slice(-1)[0];
    assert.doesNotMatch(
      tail,
      /^-\s*(Insight|Incident):/,
      `the prompt ends on an example bullet, biasing the judge toward firing: "${tail}"`
    );
  });

  // NOT guarded here, deliberately: that a fired verdict must not become the user's
  // answer. It is a real defect — a fire injects this whole template into the main
  // conversation as `Stop hook feedback:\n[<template>]: <reason>`, and the main agent
  // reads "respond with exactly {"ok": true}" as an instruction to itself. Measured on
  // live sessions: 3 of 5 fires returned a reply that was nothing but `{"ok": true}`.
  //
  // No wording tested fixes it without costing more than it saves, so asserting the
  // property here would only make the suite red against the best available prompt. Both
  // attempts are recorded in evals/suites/stop_judge/FINDINGS.md: a clause in the template
  // (0/6 leaks, but the judge applied the prohibition to itself and fire rate fell to
  // 3/15), and a mandated final line in the reason (0/6 leaks, but verdicts stopped
  // parsing as the judge wrote the line outside the JSON, and a fire began reading as an
  // R23 block). The live detector is `never leaks the judge protocol into the reply` in
  // tests/e2e/hook-routing.e2e.cjs, and the deterministic one is
  // evals/suites/stop_judge/leak_probe.py. Add the guard here with the fix.

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
    const stop = ALL.find((h) => h.event === "Stop");
    assert.ok(stop, "no Stop handler to check");
    assert.match(
      stop.prompt,
      /judge the finding|not what it \*?did\*?/i,
      "the prompt no longer separates the finding from the activity, so verification reads as routine"
    );
    assert.doesNotMatch(
      stop.prompt,
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
    const stop = ALL.find((h) => h.event === "Stop");
    assert.ok(stop, "no Stop handler to check");
    assert.match(
      stop.prompt,
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
    const stop = ALL.find((h) => h.event === "Stop");
    assert.ok(stop, "no Stop handler to check");
    assert.match(
      stop.prompt,
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
    const stop = ALL.find((h) => h.event === "Stop");
    assert.ok(stop, "no Stop handler to check");
    const { auto, gated } = captureTiers();

    // The fire condition is the prompt's bulleted list of bolded type names.
    //
    // Anchored on that structure rather than on the prose around it. The first
    // version sliced between the literal phrases "Worth capturing means" and
    // "Allow the stop", and a later rewrite that changed neither the types nor the
    // policy — only the wording — broke the guard. A guard coupled to prose
    // punishes legitimate editing and teaches people to reword the test instead of
    // rechecking the claim. The bullet shape is the part that carries meaning.
    const bulleted = [...stop.prompt.matchAll(/^- (?:an?|the) \*\*([A-Za-z]+)\*\*/gm)].map(
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
    const unmentioned = gated.filter((t) => !stop.prompt.includes(t));
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
