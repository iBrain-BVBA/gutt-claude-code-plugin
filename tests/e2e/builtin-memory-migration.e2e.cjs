#!/usr/bin/env node
/**
 * GP-922 end-to-end: prove the built-in-memory migration offer reaches a real
 * conversation, from a real SessionStart, in a project that really has a store.
 *
 * This is the tier that can catch what unit tests structurally cannot: that
 * SessionStart's `additionalContext` is a channel the CLI actually accepts (the
 * GP-864 matrix uses UserPromptSubmit's, which is a different one), and that the
 * store path this plugin derives is the store path Claude Code actually uses.
 *
 * The empty-store half of the acceptance criterion is asserted in
 * `session-lifecycle.e2e.cjs` rather than here: its fixture project has no built-in
 * store, so that run already *is* the negative case, and a second `claude -p` run to
 * re-observe it would cost money to learn nothing new.
 *
 * Cost: one run of a few cents on Haiku. Not part of `npm test`; see tests/e2e/README.md.
 *
 * Run with: npm run test:e2e
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const {
  additionalContextEvents,
  claudeVersion,
  createProject,
  findTranscript,
  hookAttachments,
  removeDir,
  runClaude,
} = require("./lib/claude-run.cjs");

const { storeDir, MIGRATE_SKILL } = require("../../gutt-core/hooks/lib/builtin-memory.cjs");

/** Two facts in the shape Claude Code's own memory writer produces. */
const FACTS = {
  "MEMORY.md": "- [Deploys are gated](deploy-gate.md) — the staging soak is mandatory.\n",
  "deploy-gate.md": [
    "---",
    "name: deploy-gate",
    "description: Deploys wait on a staging soak",
    "metadata:",
    "  type: project",
    "---",
    "",
    "Every deploy waits on a 30-minute staging soak.",
  ].join("\n"),
  "prefers-terse-replies.md": [
    "---",
    "name: prefers-terse-replies",
    "description: This user prefers short answers",
    "metadata:",
    "  type: feedback",
    "---",
    "",
    "Keep replies short. **Why:** long preambles get skimmed.",
  ].join("\n"),
};

const version = claudeVersion();

if (!version && process.env.GUTT_E2E_REQUIRED === "1") {
  throw new Error(
    "GUTT_E2E_REQUIRED=1 but the `claude` CLI is unusable — refusing to report a green " +
      "run that asserted nothing"
  );
}

describe(
  "GP-922 built-in memory migration: real claude -p session",
  { skip: version ? false : "the `claude` CLI is not available on PATH", timeout: 360000 },
  () => {
    let projectDir;
    let seededStore;
    let run;

    /** Everything the hooks injected into this conversation, as one string. */
    const injectedContext = () =>
      hookAttachments(run.transcript)
        .filter((a) => a.type === "hook_additional_context")
        .flatMap((a) => [].concat(a.content))
        .join("\n");

    before(
      async () => {
        projectDir = createProject("migrate-memory");

        // The store has to exist before the CLI launches: detection runs on
        // SessionStart, which is the first thing that fires.
        //
        // This writes into the developer's real ~/.claude/projects — there is nowhere
        // else it *can* go, since the whole point is to be found where Claude Code
        // looks. The directory name derives from a fresh mkdtemp path, so it cannot
        // collide with a real project, and `after()` removes it.
        //
        // Derived through `storeDir()` rather than by encoding the path here. A test
        // that reimplements the derivation can agree with itself while both copies are
        // wrong — which is exactly what happened: this encoded the unresolved
        // `/var/folders/…` mkdtemp path while Claude Code encoded the resolved
        // `/private/var/folders/…` one, so the store was planted where nothing looked.
        seededStore = storeDir({ cwd: projectDir });
        fs.mkdirSync(seededStore, { recursive: true });
        for (const [name, body] of Object.entries(FACTS)) {
          fs.writeFileSync(path.join(seededStore, name), body);
        }

        run = await runClaude({ projectDir, prompt: "Reply with exactly: pong" });
      },
      { timeout: 340000 }
    );

    after(() => {
      // Only the memory dir we planted. The sibling transcript is Claude Code's and
      // the other e2e suites read it, so the project directory itself is left alone.
      if (seededStore) {
        removeDir(seededStore);
      }
      if (projectDir) {
        removeDir(projectDir);
      }
    });

    it("completes successfully", () => {
      assert.equal(run.code, 0, `claude exited ${run.code}\nstderr: ${run.stderr}`);
      assert.ok(run.result, `no result envelope in stdout:\n${run.stdout.slice(0, 800)}`);
      assert.equal(run.result.is_error, false);
    });

    // Self-validation, and the reason a wrong path guess fails loudly instead of
    // quietly asserting nothing: if Claude Code does not encode the cwd the way
    // `encodeProjectDir` does, the store was planted somewhere the hook never looks,
    // every assertion below would fail for a reason that had nothing to do with the
    // feature, and this names it.
    it("planted the store where Claude Code actually keeps this project's files", () => {
      const transcript = findTranscript(run.sessionId);
      assert.ok(transcript, `no transcript found for ${run.sessionId}`);
      assert.equal(
        path.join(path.dirname(transcript), "memory"),
        seededStore,
        "the seeded store is not a sibling of the transcript — the encoding is wrong"
      );
      assert.equal(fs.existsSync(seededStore), true, "the run removed the seeded store");
    });

    it("the CLI accepts additionalContext from SessionStart", () => {
      const accepted = additionalContextEvents(run.debug).filter((line) =>
        /session-start\.cjs/.test(line)
      );
      assert.ok(
        accepted.length > 0,
        `the CLI recorded no additionalContext from session-start.cjs. ` +
          `All injections it accepted:\n${additionalContextEvents(run.debug).join("\n")}`
      );
    });

    it("the offer reaches the conversation, naming a resolvable skill", () => {
      const injected = injectedContext();
      assert.match(injected, /file-based memory store for this project/i);
      assert.match(injected, new RegExp(MIGRATE_SKILL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      // The count is computed from the store, so a broken filter shows up as a wrong
      // number rather than as a missing pointer. Two facts, never the index.
      assert.match(injected, /holds 2 notes/);
    });

    // R23/GP-868: out-of-band command framing gets surfaced to the user instead of
    // consumed. The offer is new prose on a new channel, so it gets the same check.
    it("the offer is not framed as an out-of-band system command", () => {
      assert.doesNotMatch(
        injectedContext(),
        /MANDATORY|you MUST|NOT optional|CRITICAL|NEVER skip/i
      );
    });

    // The offer explicitly asks not to interrupt the user's actual request, so the
    // answer they asked for must still be the answer they get. Deliberately the only
    // assertion here about what the model *said*: whether it also puts the choice via
    // AskUserQuestion is a judgement call the prose asks for but cannot guarantee —
    // and in `-p` mode with no tools allowed it has no way to, which is exactly why
    // nothing here is asserted about the offer surfacing.
    it("does not derail the reply the user actually asked for", () => {
      assert.match(
        String(run.result.result),
        /pong/i,
        `the model answered something else entirely: ${run.result.result}`
      );
    });

    it("does not migrate or delete anything on its own", () => {
      // Detection is read-only. Nothing may touch the store until the user accepts,
      // and the offer being injected is not acceptance.
      assert.deepEqual(
        fs.readdirSync(seededStore).sort(),
        Object.keys(FACTS).sort(),
        "the store was modified by a session that only saw the offer"
      );
    });
  }
);
