#!/usr/bin/env node
/**
 * Tests for the built-in-memory migration (GP-922, S3.8):
 * `shared/builtin-memory.cjs` (locate + detect + offer) and
 * `shared/builtin-memory-store.cjs` (back up, verify, delete).
 *
 * Run: node --test tests/builtin-memory.test.cjs
 *
 * The R25 budget for the offer is not re-measured here. It runs inside
 * `session-start.cjs`, whose synchronous path is already timed end-to-end against an
 * empty-hook floor in `session-lifecycle.test.cjs` — a second wall-clock assertion
 * over the same code would measure process startup, not this feature.
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const mem = require("../shared/builtin-memory.cjs");
const store = require("../shared/builtin-memory-store.cjs");
const config = require("../shared/runtime-config.cjs");

const ORIGINAL_DATA = process.env.CLAUDE_PLUGIN_DATA;
const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

function restoreEnv() {
  for (const [key, value] of [
    ["CLAUDE_PLUGIN_DATA", ORIGINAL_DATA],
    ["CLAUDE_CONFIG_DIR", ORIGINAL_CONFIG_DIR],
  ]) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Build a fake Claude Code project directory with a memory store in it, and return a
 * hook payload pointing at it the way a real payload would — via `transcript_path`.
 */
function seedStore(configDir, projectName, files) {
  const projectDir = path.join(configDir, "projects", projectName);
  const memoryDir = path.join(projectDir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(memoryDir, name), body);
  }
  return {
    projectDir,
    memoryDir,
    payload: { transcript_path: path.join(projectDir, "session-abc.jsonl") },
  };
}

const FACT = ["---", "name: a-fact", "description: something learned", "---", "", "The fact."].join(
  "\n"
);

// ---------------------------------------------------------------------------
// Locating the store
// ---------------------------------------------------------------------------

describe("builtin-memory: locating the store", () => {
  it("derives the store from transcript_path, with no cwd encoding involved", () => {
    const payload = { transcript_path: "/home/u/.claude/projects/-home-u-app/s.jsonl" };
    assert.equal(mem.storeDir(payload), "/home/u/.claude/projects/-home-u-app/memory");
    assert.equal(mem.projectKey(payload), "-home-u-app");
  });

  it("prefers transcript_path over cwd when both are present", () => {
    const payload = {
      transcript_path: "/home/u/.claude/projects/-from-transcript/s.jsonl",
      cwd: "/somewhere/else",
    };
    assert.equal(mem.projectKey(payload), "-from-transcript");
  });

  it("falls back to encoding cwd when transcript_path is absent", () => {
    process.env.CLAUDE_CONFIG_DIR = "/cfg";
    try {
      assert.equal(mem.storeDir({ cwd: "/home/u/app" }), "/cfg/projects/-home-u-app/memory");
    } finally {
      restoreEnv();
    }
  });

  // Verified against the real directories on this machine when the encoding was
  // reverse-engineered: `/` `.` and `_` all flatten to `-`. Pinned because the
  // fallback is the only part of the path derivation that can silently drift.
  it("encodes cwd the way Claude Code names its project directories", () => {
    assert.equal(
      mem.encodeProjectDir("/Users/me/DND-AI-gm-tool/.claude-worktrees/import-ch4-plot"),
      "-Users-me-DND-AI-gm-tool--claude-worktrees-import-ch4-plot"
    );
    assert.equal(
      mem.encodeProjectDir("/private/var/folders/96/_7jt_bc/T/gutt-eval-2z"),
      "-private-var-folders-96--7jt-bc-T-gutt-eval-2z"
    );
  });

  // Claude Code encodes the *resolved* cwd. On macOS this is the common case, not an
  // exotic one — `/tmp` and `/var` are symlinks into `/private` — and encoding the
  // unresolved path names a project directory that does not exist. Found by the e2e:
  // it planted a store under the unresolved name and the offer never fired.
  it("resolves symlinks before encoding, the way Claude Code does", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-bm-link-"));
    try {
      const real = path.join(root, "real-project");
      const link = path.join(root, "linked-project");
      fs.mkdirSync(real);
      fs.symlinkSync(real, link);
      assert.equal(
        mem.projectKey({ cwd: link }),
        mem.projectKey({ cwd: real }),
        "a symlinked cwd must resolve to the same store as the real path"
      );
      assert.equal(mem.realPath(link), fs.realpathSync(real));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to plain resolution for a cwd that does not exist", () => {
    assert.equal(mem.realPath("/no/such/path/anywhere"), "/no/such/path/anywhere");
  });

  it("identifies nothing when the payload names neither a transcript nor a cwd", () => {
    assert.equal(mem.storeDir({}), null);
    assert.equal(mem.projectKey({}), null);
    assert.equal(mem.hasMigratableStore({}), false);
  });
});

// ---------------------------------------------------------------------------
// Detection, and the marker exclusion's firing vector
// ---------------------------------------------------------------------------

describe("builtin-memory: detecting what is worth migrating", () => {
  let configDir;

  before(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-bm-detect-"));
  });
  after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  it("lists fact files and never the index", () => {
    const { payload } = seedStore(configDir, "-p-facts", {
      "MEMORY.md": "- [A](a.md) — hook\n",
      "a.md": FACT,
      "b.md": FACT,
    });
    assert.deepEqual(mem.listFacts(mem.storeDir(payload)).sort(), ["a.md", "b.md"]);
    assert.equal(mem.hasMigratableStore(payload), true);
  });

  it("ignores non-markdown files and subdirectories", () => {
    const { memoryDir, payload } = seedStore(configDir, "-p-mixed", {
      "a.md": FACT,
      "notes.txt": "x",
      ".DS_Store": "x",
    });
    fs.mkdirSync(path.join(memoryDir, "archive"), { recursive: true });
    assert.deepEqual(mem.listFacts(mem.storeDir(payload)), ["a.md"]);
  });

  it("reads a missing or unreadable store as empty rather than throwing", () => {
    const payload = { transcript_path: path.join(configDir, "projects", "-nope", "s.jsonl") };
    assert.deepEqual(mem.listFacts(mem.storeDir(payload)), []);
    assert.equal(mem.hasMigratableStore(payload), false);
  });

  // The firing vector the story asks for. A gate whose only evidence is silence
  // proves nothing, so both halves are asserted together: the post-migration store
  // must read empty, AND the same store with one real fact added must still fire.
  //
  // Mutation-tested by hand: dropping `e.name !== INDEX_FILE` from
  // `builtin-memory.listFacts` makes the first assertion below fail. Without the
  // second assertion the exclusion could be widened to "never fire" and stay green.
  describe("the marker exclusion", () => {
    const NOTE = store.MARKER_NOTE;

    it("reads a store holding only the post-migration note as empty", () => {
      const { payload } = seedStore(configDir, "-p-migrated", { "MEMORY.md": NOTE });
      assert.deepEqual(mem.listFacts(mem.storeDir(payload)), []);
      assert.equal(mem.hasMigratableStore(payload), false);
    });

    it("still fires for that same note plus one real fact", () => {
      const { payload } = seedStore(configDir, "-p-migrated-then-used", {
        "MEMORY.md": NOTE,
        "new-fact.md": FACT,
      });
      assert.deepEqual(mem.listFacts(mem.storeDir(payload)), ["new-fact.md"]);
      assert.equal(mem.hasMigratableStore(payload), true);
    });

    it("does not depend on the note's wording", () => {
      const { payload } = seedStore(configDir, "-p-reworded", {
        "MEMORY.md": "# totally different text that no substring match would catch\n",
      });
      assert.equal(mem.hasMigratableStore(payload), false);
    });
  });
});

// ---------------------------------------------------------------------------
// The per-project decision in config.json
// ---------------------------------------------------------------------------

describe("runtime-config: the per-project migration decision", () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-bm-cfg-"));
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
  });
  after(restoreEnv);

  it("round-trips a decision and reports it settled", () => {
    assert.equal(config.readMigrationState("-p-a"), null);
    assert.equal(config.isMigrationSettled("-p-a"), false);
    assert.equal(config.setMigrationState("-p-a", "migrated"), true);
    assert.equal(config.readMigrationState("-p-a"), "migrated");
    assert.equal(config.isMigrationSettled("-p-a"), true);
  });

  it("treats declined as settled and later as unsettled", () => {
    config.setMigrationState("-p-declined", "declined");
    config.setMigrationState("-p-later", "later");
    assert.equal(config.isMigrationSettled("-p-declined"), true);
    assert.equal(config.isMigrationSettled("-p-later"), false, "later defers, it does not settle");
    assert.equal(config.readMigrationState("-p-later"), "later");
  });

  // The reason the key space exists at all: a machine-wide answer would silence a
  // repo where migration is wanted, or skip one still holding a full local store.
  it("keeps projects independent of one another", () => {
    config.setMigrationState("-p-one", "declined");
    assert.equal(config.isMigrationSettled("-p-one"), true);
    assert.equal(config.isMigrationSettled("-p-two"), false);
    config.setMigrationState("-p-two", "migrated");
    assert.equal(config.readMigrationState("-p-one"), "declined", "sibling write did not clobber");
    assert.equal(config.readMigrationState("-p-two"), "migrated");
  });

  it("rejects an unknown status instead of storing it", () => {
    assert.equal(config.setMigrationState("-p-x", "definitely-not-a-status"), false);
    assert.equal(config.readMigrationState("-p-x"), null);
    assert.equal(config.setMigrationState(null, "migrated"), false);
  });

  it("ignores a stored status this version does not recognise", () => {
    config.setMigrationState("-p-future", "migrated");
    const raw = JSON.parse(fs.readFileSync(config.configPath(), "utf8"));
    raw.projects["-p-future"].memoryMigration.status = "quantum-migrated";
    fs.writeFileSync(config.configPath(), JSON.stringify(raw));
    assert.equal(config.readMigrationState("-p-future"), null);
    assert.equal(config.isMigrationSettled("-p-future"), false);
  });

  it("leaves the snooze keys alone, and survives a snooze written alongside", () => {
    config.setSnooze({ untilMs: Date.now() + 60_000 });
    config.setMigrationState("-p-with-snooze", "migrated");
    const raw = JSON.parse(fs.readFileSync(config.configPath(), "utf8"));
    assert.ok(raw.snoozeUntil, "snooze survived the project write");
    assert.equal(raw.projects["-p-with-snooze"].memoryMigration.status, "migrated");
    config.clearExpiredSnooze(Date.now() + 120_000);
    assert.equal(
      config.readMigrationState("-p-with-snooze"),
      "migrated",
      "sweep kept the decision"
    );
  });

  it("reading never creates a config file", () => {
    config.readMigrationState("-p-nothing");
    config.isMigrationSettled("-p-nothing");
    assert.equal(fs.existsSync(config.configPath()), false);
  });

  // `DEFAULTS` is a module-level literal, so a naive spread hands every caller the
  // same nested object and one caller's mutation leaks into every later read.
  it("hands out a fresh projects object per read", () => {
    const first = config.readConfig();
    first.projects.injected = true;
    assert.equal(config.readConfig().projects.injected, undefined);
    assert.deepEqual(config.DEFAULTS.projects, {}, "the shared default was not mutated");
  });

  it("declares the per-project space in the owned-keys whitelist", () => {
    assert.ok(config.OWNED_KEYS.includes(config.PROJECTS_KEY));
    assert.ok(config.OWNED_KEYS.includes("snoozeUntil"));
  });
});

// ---------------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------------

describe("builtin-memory: the SessionStart offer", () => {
  let dataDir;
  let configDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-bm-offer-data-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-bm-offer-cfg-"));
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
  });
  after(restoreEnv);

  const seedTwoFacts = (name) =>
    seedStore(configDir, name, { "MEMORY.md": "- [A](a.md)\n", "a.md": FACT, "b.md": FACT });

  it("offers when the store holds facts and nothing is recorded", () => {
    const { payload } = seedTwoFacts("-p-offer");
    const offer = mem.migrationOffer(payload, "s1");
    assert.ok(offer, "expected an offer");
    assert.match(offer, /2 notes/);
    assert.match(offer, /gutt-claude-code-plugin:migrate-memory/);
  });

  it("names the skill with its plugin prefix, since a bare stem is not invocable", () => {
    assert.equal(mem.MIGRATE_SKILL, "gutt-claude-code-plugin:migrate-memory");
    assert.match(mem.offerContext(3), /`gutt-claude-code-plugin:migrate-memory`/);
  });

  it("counts one note in the singular", () => {
    assert.match(mem.offerContext(1), /holds 1 note\b/);
    assert.match(mem.offerContext(2), /holds 2 notes\b/);
  });

  // The scoping sentence is load-bearing: without it the offer reads as "migrate
  // now" and a session opened to ask one question gets a migration run instead.
  it("scopes itself to an offer rather than an immediate run", () => {
    const offer = mem.offerContext(2);
    assert.match(offer, /only if they accept/);
    assert.match(offer, /do not interrupt/);
  });

  // Collecting the answer in prose leaves accept/decline to be inferred from free
  // text, and `record declined` suppresses the offer permanently on that inference.
  // Both halves are asserted: naming the tool, and ruling out the text-only form the
  // clause replaced — the wording regressed once by keeping the tool name while
  // still saying "in one line at the end of your next reply".
  it("collects the answer with AskUserQuestion rather than in reply text", () => {
    const offer = mem.offerContext(2);
    assert.match(offer, /AskUserQuestion/);
    assert.match(offer, /rather than only mentioning it in your reply text/);
    assert.doesNotMatch(offer, /in one line/);
  });

  it("stays silent once the decision is migrated or declined", () => {
    for (const status of ["migrated", "declined"]) {
      const { payload } = seedTwoFacts(`-p-${status}`);
      assert.ok(mem.migrationOffer(payload, "s1"), "fires before the decision is recorded");
      config.setMigrationState(mem.projectKey(payload), status);
      assert.equal(mem.migrationOffer(payload, "s1"), null, `${status} must not be re-offered`);
    }
  });

  it("still offers after a later, which defers rather than settles", () => {
    const { payload } = seedTwoFacts("-p-later-offer");
    config.setMigrationState(mem.projectKey(payload), "later");
    assert.ok(mem.migrationOffer(payload, "s1"));
  });

  it("stays silent for an empty store, and for a store holding only the note", () => {
    const empty = seedStore(configDir, "-p-empty", {});
    assert.equal(mem.migrationOffer(empty.payload, "s1"), null);
    const marker = seedStore(configDir, "-p-note-only", { "MEMORY.md": store.MARKER_NOTE });
    assert.equal(mem.migrationOffer(marker.payload, "s1"), null);
  });

  it("stays silent while the plugin is snoozed", () => {
    const { payload } = seedTwoFacts("-p-snoozed");
    config.setSnooze({ sessionId: "s1" });
    assert.equal(mem.migrationOffer(payload, "s1"), null);
    assert.ok(mem.migrationOffer(payload, "other-session"), "a session-scoped snooze is scoped");
  });

  it("stays silent when the payload identifies no project", () => {
    assert.equal(mem.migrationOffer({}, "s1"), null);
  });
});

// ---------------------------------------------------------------------------
// Backup, verification, and the deletion gate
// ---------------------------------------------------------------------------

describe("builtin-memory-store: nothing is deleted on an unverified write", () => {
  let dataDir;
  let configDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-bms-data-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-bms-cfg-"));
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
  });
  after(restoreEnv);

  const seed = (name) =>
    seedStore(configDir, name, {
      "MEMORY.md": "- [A](a.md)\n",
      "a.md": FACT,
      "b.md": "second fact",
    });

  it("captures every fact's content into one backup under the data dir", () => {
    const { payload } = seed("-p-backup");
    const result = store.backupStore(payload);
    assert.ok(result, "expected a backup");
    assert.deepEqual(result.files.sort(), ["a.md", "b.md"]);
    assert.ok(result.path.startsWith(dataDir), "backup lives under CLAUDE_PLUGIN_DATA");
    const saved = JSON.parse(fs.readFileSync(result.path, "utf8"));
    assert.equal(saved.files["b.md"], "second fact");
    assert.match(saved.index, /- \[A\]\(a\.md\)/);
    assert.deepEqual(saved.verified, {}, "a fresh backup authorises no deletion");
  });

  it("backs up nothing when there is nothing to migrate", () => {
    const { payload } = seedStore(configDir, "-p-backup-empty", { "MEMORY.md": "x" });
    assert.equal(store.backupStore(payload), null);
  });

  // The property the story names: stub a write that reports success and never lands.
  // The search then returns nothing, so nothing is recorded verified, so this must
  // delete zero files — the local copy is the only one left and it survives.
  it("deletes nothing when the episodes were never confirmed", () => {
    const { memoryDir, payload } = seed("-p-unverified");
    store.backupStore(payload);
    const outcome = store.deleteVerified(payload);
    assert.deepEqual(outcome.deleted, []);
    assert.deepEqual(outcome.kept.sort(), ["a.md", "b.md"]);
    assert.match(outcome.reason, /nothing verified/);
    assert.deepEqual(fs.readdirSync(memoryDir).sort(), ["MEMORY.md", "a.md", "b.md"]);
  });

  it("deletes nothing when no backup was taken", () => {
    const { memoryDir, payload } = seed("-p-no-backup");
    store.recordVerified(mem.projectKey(payload), { "a.md": "ep-1" });
    const outcome = store.deleteVerified(payload);
    assert.deepEqual(outcome.deleted, []);
    assert.match(outcome.reason, /no backup/);
    assert.equal(fs.existsSync(path.join(memoryDir, "a.md")), true);
  });

  it("refuses to record a verification for a file the backup never captured", () => {
    const { payload } = seed("-p-reject");
    store.backupStore(payload);
    const key = mem.projectKey(payload);
    const result = store.recordVerified(key, { "a.md": "ep-1", "never-existed.md": "ep-2" });
    assert.deepEqual(result.recorded, ["a.md"]);
    assert.deepEqual(result.rejected, ["never-existed.md"]);
  });

  it("refuses a verification with no episode id", () => {
    const { payload } = seed("-p-no-id");
    store.backupStore(payload);
    const result = store.recordVerified(mem.projectKey(payload), { "a.md": "" });
    assert.deepEqual(result.recorded, []);
    assert.deepEqual(result.rejected, ["a.md"]);
  });

  it("removes only the verified facts, prunes their pointers, and notes on top", () => {
    const { memoryDir, payload } = seedStore(configDir, "-p-partial", {
      "MEMORY.md": "- [A](a.md) — hook\n- [B](b.md) — hook\n",
      "a.md": FACT,
      "b.md": "second fact",
    });
    store.backupStore(payload);
    store.recordVerified(mem.projectKey(payload), { "a.md": "ep-1" });
    const outcome = store.deleteVerified(payload);
    assert.deepEqual(outcome.deleted, ["a.md"]);
    assert.deepEqual(outcome.kept, ["b.md"]);
    assert.equal(outcome.note, true, "a partial migration still needs the redirect");
    assert.equal(fs.existsSync(path.join(memoryDir, "a.md")), false);
    assert.equal(fs.existsSync(path.join(memoryDir, "b.md")), true);

    const index = fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8");
    // A pointer to a deleted fact is loaded into context every session, advertising a
    // note nobody can open — so the deletion has to take its index line with it.
    assert.doesNotMatch(index, /a\.md/, "the migrated fact's pointer must be gone");
    assert.match(index, /\n\n- \[B\]\(b\.md\)/, "a fact left behind stays listed, as a list");
    assert.ok(
      index.indexOf("gutt is the store of record") < index.indexOf("- [B]"),
      "the note belongs above the surviving pointers, not buried under them"
    );
    // The note must not be what makes the store look finished: facts remain, so the
    // offer has to return.
    assert.equal(mem.hasMigratableStore(payload), true);
  });

  it("leaves the standing note once every fact has gone", () => {
    const { memoryDir, payload } = seed("-p-complete");
    store.backupStore(payload);
    store.recordVerified(mem.projectKey(payload), { "a.md": "ep-1", "b.md": "ep-2" });
    const outcome = store.deleteVerified(payload);
    assert.deepEqual(outcome.deleted.sort(), ["a.md", "b.md"]);
    assert.deepEqual(outcome.kept, []);
    assert.equal(outcome.note, true);
    assert.deepEqual(fs.readdirSync(memoryDir), ["MEMORY.md"]);
    const note = fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8");
    assert.match(note, /gutt is the store of record/);
    // And the store it leaves behind must read as empty, or the offer returns forever.
    assert.equal(mem.hasMigratableStore(payload), false);
  });

  // The case this shipped broken: a partial run had already orphaned 30 pointers, and
  // they outlived it because the rewrite never fired. Survivors are therefore decided by
  // what is on disk, not by what this particular run deleted.
  it("repairs pointers orphaned by an earlier run", () => {
    const { memoryDir, payload } = seedStore(configDir, "-p-orphans", {
      "MEMORY.md": "- [Gone](gone.md) — hook\n- [A](a.md) — hook\n- [B](b.md) — hook\n",
      "a.md": FACT,
      "b.md": "second fact",
    });
    store.backupStore(payload);
    store.recordVerified(mem.projectKey(payload), { "a.md": "ep-1" });
    store.deleteVerified(payload);
    const index = fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8");
    assert.doesNotMatch(index, /gone\.md/, "a pointer this run never deleted is still dead");
    assert.match(index, /- \[B\]\(b\.md\)/, "the surviving fact keeps its pointer");
  });

  it("keeps the backup readable after the local files are gone", () => {
    const { payload } = seed("-p-restore");
    const { path: backup } = store.backupStore(payload);
    store.recordVerified(mem.projectKey(payload), { "a.md": "ep-1", "b.md": "ep-2" });
    store.deleteVerified(payload);
    const saved = JSON.parse(fs.readFileSync(backup, "utf8"));
    assert.equal(saved.files["b.md"], "second fact", "the undo still holds the content");
  });

  it("rejects names that are not plain fact files in the store", () => {
    const dir = "/tmp/store";
    assert.equal(store.isDeletableFact(dir, "a.md"), true);
    assert.equal(store.isDeletableFact(dir, "MEMORY.md"), false, "the index is never a fact");
    assert.equal(store.isDeletableFact(dir, "notes.txt"), false);
    assert.equal(store.isDeletableFact(dir, "../../escape.md"), false);
    assert.equal(store.isDeletableFact(dir, "sub/a.md"), false);
    assert.equal(store.isDeletableFact(dir, ""), false);
  });

  it("keeps the newest backup when a project is backed up twice", () => {
    const { payload } = seed("-p-twice");
    const first = store.backupStore(payload, 1000);
    const second = store.backupStore(payload, 2000);
    assert.equal(store.latestBackup(mem.projectKey(payload)), second.path);
    assert.equal(store.listBackups(mem.projectKey(payload)).length, 2);
    assert.notEqual(first.path, second.path);
  });

  it("takes no backup and deletes nothing when plugin state is unavailable", () => {
    const { memoryDir, payload } = seed("-p-no-state");
    delete process.env.CLAUDE_PLUGIN_DATA;
    try {
      assert.equal(store.backupStore(payload), null);
      const outcome = store.deleteVerified(payload);
      assert.deepEqual(outcome.deleted, []);
      assert.equal(fs.existsSync(path.join(memoryDir, "a.md")), true);
    } finally {
      process.env.CLAUDE_PLUGIN_DATA = dataDir;
    }
  });
});

// ---------------------------------------------------------------------------
// The invocation contract the skill documents
//
// Anchored on the shape of the commands, not on the prose around them: the prose gets
// reworded and a guard that greps for a sentence goes green while asserting nothing.
// What must hold is that every documented invocation is one a Bash tool can actually
// run — no reliance on env it doesn't inherit.
// ---------------------------------------------------------------------------

describe("migrate-memory SKILL.md: the documented commands must be runnable", () => {
  const SKILL = path.join(__dirname, "..", "gutt-core", "skills", "migrate-memory", "SKILL.md");

  /** Bash-fence lines invoking the CLI, with `\`-continuations joined. */
  function documentedInvocations() {
    const text = fs.readFileSync(SKILL, "utf8");
    const blocks = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
    return blocks
      .flatMap((b) => b.replace(/\\\n\s*/g, " ").split("\n"))
      .filter((line) => line.includes("store-cli.cjs"));
  }

  it("documents at least one invocation, so the assertions below can fail", () => {
    assert.ok(documentedInvocations().length >= 2, "expected the status and verified calls");
  });

  it("never asks the shell for env the Bash tool does not inherit", () => {
    for (const line of documentedInvocations()) {
      assert.doesNotMatch(
        line,
        /\$\{?CLAUDE_PLUGIN_ROOT\}?/,
        `CLAUDE_PLUGIN_ROOT is unset in the Bash tool, so this cannot find the script: ${line}`
      );
      assert.doesNotMatch(
        line,
        /\$\{?CLAUDE_PLUGIN_DATA\}?/,
        `CLAUDE_PLUGIN_DATA is unset in the Bash tool, so this silently loses the data dir: ${line}`
      );
    }
  });

  it("passes the data dir explicitly on every call", () => {
    for (const line of documentedInvocations()) {
      assert.match(
        line,
        /--plugin-data=/,
        `without --plugin-data this reports pluginDataAvailable: false and the skill stops: ${line}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The CLI the skill drives
// ---------------------------------------------------------------------------

describe("store-cli: the interface the skill calls", () => {
  const CLI = path.join(
    __dirname,
    "..",
    "gutt-core",
    "skills",
    "migrate-memory",
    "scripts",
    "store-cli.cjs"
  );
  let dataDir;
  let configDir;
  let projectCwd;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-cli-data-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-cli-cfg-"));
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-cli-proj-"));
    // The parent computes where to seed the store and the child computes where to
    // look for it. Both read CLAUDE_CONFIG_DIR, so it has to be set here and not
    // only in the child env — otherwise the seed lands under the real ~/.claude and
    // the CLI correctly reports an empty store.
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });
  after(restoreEnv);

  /** Run a subcommand and parse its JSON. Args are passed exactly as given. */
  function cli(...args) {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
        CLAUDE_CONFIG_DIR: configDir,
      },
    });
    return JSON.parse(out);
  }

  const cwdFlag = () => `--cwd=${projectCwd}`;

  function seedForCli(files) {
    const dir = mem.storeDir({ cwd: projectCwd });
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
  }

  // The flag used to be read as the subcommand, because argv[2] was taken before
  // flags were stripped — so the documented `--cwd=… status` form reported
  // `unknown command "--cwd=…"`. Both orders are asserted; one alone would let the
  // regression back in.
  it("accepts the cwd flag before or after the subcommand", () => {
    seedForCli({ "a.md": "fact" });
    for (const args of [
      [cwdFlag(), "status"],
      ["status", cwdFlag()],
    ]) {
      const result = cli(...args);
      assert.equal(result.error, undefined, `${args.join(" ")} was not understood`);
      assert.deepEqual(result.facts, ["a.md"]);
    }
  });

  it("reports an unknown subcommand without throwing", () => {
    const result = cli("frobnicate", cwdFlag());
    assert.match(result.error, /unknown command/);
    assert.ok(Array.isArray(result.commands));
  });

  it("drives the full backup → verify → delete sequence", () => {
    const dir = seedForCli({ "MEMORY.md": "- [A](a.md)\n", "a.md": "fact a", "b.md": "fact b" });

    assert.equal(cli("backup", cwdFlag()).ok, true);

    // Before any verification: a no-op, and both facts survive.
    assert.deepEqual(cli("delete", cwdFlag()).deleted, []);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["MEMORY.md", "a.md", "b.md"]);

    const recorded = cli("verified", cwdFlag(), "a.md=ep-1", "ghost.md=ep-2");
    assert.deepEqual(recorded.recorded, ["a.md"]);
    assert.deepEqual(recorded.rejected, ["ghost.md"]);

    const deleted = cli("delete", cwdFlag());
    assert.deepEqual(deleted.deleted, ["a.md"]);
    assert.deepEqual(deleted.kept, ["b.md"]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["MEMORY.md", "b.md"]);
  });

  it("records a decision and reflects it in status", () => {
    seedForCli({ "a.md": "fact" });
    assert.equal(cli("status", cwdFlag()).settled, false);
    assert.equal(cli("record", cwdFlag(), "migrated").ok, true);
    const after = cli("status", cwdFlag());
    assert.equal(after.decision, "migrated");
    assert.equal(after.settled, true);
  });

  it("rejects an unknown decision without disturbing the stored one", () => {
    seedForCli({ "a.md": "fact" });
    cli("record", cwdFlag(), "declined");
    assert.equal(cli("record", cwdFlag(), "nonsense").ok, false);
    assert.equal(cli("status", cwdFlag()).decision, "declined");
  });

  it("reports plugin state as unavailable rather than failing", () => {
    seedForCli({ "a.md": "fact" });
    const out = execFileSync(process.execPath, [CLI, "status", cwdFlag()], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_PLUGIN_DATA: "" },
    });
    assert.equal(JSON.parse(out).pluginDataAvailable, false);
  });

  // ---------------------------------------------------------------------------
  // Reproducing the *real* caller (GP-922 follow-up)
  //
  // `cli()` above hands the child CLAUDE_PLUGIN_DATA. The skill can't: it shells out
  // through the Bash tool, which inherits neither that nor CLAUDE_PLUGIN_ROOT. So
  // every test in this file passed while every real run of the skill reported
  // `pluginDataAvailable: false`, hit its own "degrade by stopping" rule and could
  // never migrate anything. These run with the var *absent* from the child env —
  // deleted, not blanked — which is the condition the suite was missing.
  // ---------------------------------------------------------------------------

  /** Run a subcommand with no CLAUDE_PLUGIN_DATA at all, as the Bash tool would. */
  function cliNoEnv(...args) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    delete env.CLAUDE_PLUGIN_DATA;
    delete env.CLAUDE_PLUGIN_ROOT;
    return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env }));
  }

  it("without the flag, says the dir is missing AND why — a bare false reads as the platform's fail-safe", () => {
    seedForCli({ "a.md": "fact" });
    const result = cliNoEnv("status", cwdFlag());
    assert.equal(result.pluginDataAvailable, false);
    assert.match(result.hint, /--plugin-data/);
    assert.match(result.hint, /does not inherit/);
  });

  it("--plugin-data supplies the dir the Bash tool cannot inherit", () => {
    seedForCli({ "a.md": "fact" });
    const result = cliNoEnv("status", cwdFlag(), `--plugin-data=${dataDir}`);
    assert.equal(result.pluginDataAvailable, true);
    assert.equal(result.hint, undefined, "hint is for the failure case only");
  });

  // Availability is only the symptom. This asserts the flag reaches the writers, so
  // the whole skill-driven path works from a shell that has no plugin env at all.
  it("--plugin-data makes the state writers work, not just the status report", () => {
    seedForCli({ "MEMORY.md": "- [A](a.md)\n", "a.md": "fact a" });
    const flag = `--plugin-data=${dataDir}`;

    assert.equal(cliNoEnv("backup", cwdFlag(), flag).ok, true);
    assert.equal(cliNoEnv("record", cwdFlag(), flag, "later").ok, true);
    assert.equal(cliNoEnv("status", cwdFlag(), flag).decision, "later");

    assert.deepEqual(cliNoEnv("verified", cwdFlag(), flag, "a.md=ep-1").recorded, ["a.md"]);
    assert.deepEqual(cliNoEnv("delete", cwdFlag(), flag).deleted, ["a.md"]);
  });

  it("ignores an empty --plugin-data rather than blanking a working env var", () => {
    seedForCli({ "a.md": "fact" });
    assert.equal(cli("status", cwdFlag(), "--plugin-data=").pluginDataAvailable, true);
  });

  it("takes the flag over inherited env, so the skill's value wins", () => {
    seedForCli({ "a.md": "fact" });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-cli-other-"));
    // cli() injects dataDir; the flag names `other`, and the decision must land there.
    assert.equal(cli("record", cwdFlag(), `--plugin-data=${other}`, "declined").ok, true);
    assert.equal(cli("status", cwdFlag(), `--plugin-data=${other}`).decision, "declined");
    assert.equal(cli("status", cwdFlag()).decision, null, "dataDir must be untouched");
  });
});
