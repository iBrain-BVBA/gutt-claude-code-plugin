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
 * Lines that are neither blank nor comment. Total line count is the wrong
 * metric for this codebase — the house style is comment-heavy on purpose, and a
 * cap on it would push explanation out of the files that most need it.
 *
 * Naive about `//` and block delimiters inside string literals. That can only
 * ever *under*count, so the cap stays conservative; a hook that trips it is
 * over the limit either way.
 */
function codeLines(file) {
  return stripComments(fs.readFileSync(file, "utf8")).split("\n").filter(Boolean).length;
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
    const hookDir = path.join(ROOT, "gutt-core", "hooks");
    const sources = fs
      .readdirSync(hookDir)
      .filter((f) => f.endsWith(".cjs"))
      .map((f) => stripComments(fs.readFileSync(path.join(hookDir, f), "utf8")))
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
