# Runtime-state convention (R37)

**Ticket:** GP-855 (S1.5) · Epic E1 · Program GP-841 (Plugin 3.0)
**Design input:** GP-862 spike ADR, decision **D3** (state contract).

## The rule (R37)

> ALL plugin runtime state lives in ONE namespaced location under
> `${CLAUDE_PLUGIN_DATA}` — **never the project/repo tree**. A bounded, documented
> file set (prefer one JSON state file over marker files), with a cheap TTL cleanup
> at every SessionStart.

`${CLAUDE_PLUGIN_DATA}` is the per-plugin data directory Claude Code assigns each
plugin (`~/.claude/plugins/data/<id>/`). It is **deleted on uninstall** (unless
`--keep-data`), so nothing irreplaceable may live only there — everything below is
a counter, cache, or transient flag that rebuilds itself.

This supersedes the pre-3.0 convention (project `.claude/hooks/.state/`). GP-855 is
that migration.

## Where state lives

All access goes through **`gutt-core/hooks/lib/plugin-state.cjs`**. Paths are resolved from
`${CLAUDE_PLUGIN_DATA}`; no code joins its own `.state` path anymore.

| File                                               | Written by                                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions/<session_id>.json`                       | `session-state.cjs`                                                                      | Per-session lifecycle flags, keyed on the stdin `session_id` (not the date) so concurrent sessions don't collide. Holds the GP-863 lifecycle fields, the GP-864 recall counter, and the connectivity result the statusline reads. Swept >24h at SessionStart.                                                                                                                                                                                           |
| `config.json`                                      | `runtime-config.cjs` for everything but `migrationsVersion`, which is `migrations.cjs`'s | Runtime on/off, mode, snooze, the integer `migrationsVersion` recording which one-time cleanups this machine has had, and the per-project `projects` space (GP-922 — see below). **Distinct from** the static, git-ignored plugin `config.json` at the repo/plugin root (org group_id) that `hooks/lib/config.cjs` reads.                                                                                                                               |
| `statusline.cjs`                                   | `statusline-install.cjs` (GP-867)                                                        | A generated `require` of the current plugin root's renderer, plus the `${CLAUDE_PLUGIN_DATA}` a status line is launched without and a guard for the case where the renderer has gone. The user's `settings.json` names **this** path, which is stable, rather than `${CLAUDE_PLUGIN_ROOT}`, which is version-scoped and moves on every update. Rewritten at SessionStart whenever the root has moved; not swept, since the settings entry points at it. |
| `hook-errors.log`                                  | `debug.cjs`                                                                              | Best-effort error log. Trimmed to the newest 200 lines once it passes 256KB.                                                                                                                                                                                                                                                                                                                                                                            |
| `hook-invocations.log`                             | `user-prompt-submit`                                                                     | Prompt/stop breadcrumbs. Same 256KB/200-line bound.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `migrations/settings-backup-<ms>.json`             | `migrations.cjs` (GP-895)                                                                | The user's `~/.claude/settings.json`, verbatim, taken immediately before the one-time 2.x cleanup edits it. Written at most once per machine and **never swept** — it is the undo for an edit to a file the plugin does not own, so a TTL on it would be a TTL on someone's ability to recover.                                                                                                                                                         |
| `migrations/builtin-memory-<projectKey>-<ms>.json` | `builtin-memory-store.cjs` (GP-922)                                                      | Every fact in a project's Claude Code memory store, captured verbatim before the store is migrated into gutt, plus the `verified` map that authorises each deletion. **Never swept**, same reasoning as the row above: it is the only remaining copy's undo. One per migration attempt per project.                                                                                                                                                     |

The artifacts named by the R37 state contract are the first two rows; the rest are
caches, logs, and backups that rebuild themselves or are written once.

The contract used to name a third, `capture-queue.jsonl`, for a Stop-time capture
queue drained at the next SessionStart. It never had a writer, and it never will:
GP-866 moved the judge inline at Stop, where it fails open rather than deferring
work, so GP-873 closed as not needed and the file was removed from the sweep, from
`plugin-state.cjs`, and from this table.

### Keys in `sessions/<session_id>.json`

| Key                                              | Producer                                                                        | Consumer                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------- |
| `sessionId`, `startedAt`, `rev`, `lastUpdated`   | `session-state.cjs` on every write                                              | bookkeeping; `rev` counts serialized writes   |
| `source`                                         | SessionStart (the matcher that fired)                                           | diagnostics                                   |
| `firstPromptPending`                             | SessionStart (`startup`/`resume`/`clear`)                                       | UserPromptSubmit row 2 — consumed on read     |
| `compacted`                                      | SessionStart (`compact`)                                                        | UserPromptSubmit row 3 — consumed on read     |
| `turnsSinceSearch`                               | PostToolUse resets to 0; UserPromptSubmit and a compaction each advance it      | UserPromptSubmit row 4 — see below            |
| `mcpConfigured`, `mcpUrl`, `connectionCheckedAt` | `session-connectivity.cjs` (async)                                              | `statusline.cjs`, read-only                   |
| `mcpError`                                       | `session-connectivity.cjs` (async)                                              | nobody — written for a human reading the file |
| `connectionStatus`, `connectionObservedAt`       | `noteConnection()` from PostToolUse — only an observed round trip               | `statusline.cjs`, read-only                   |
| `mcpToolsAvailable`, `mcpToolsAvailableAt`       | UserPromptSubmit every prompt; PostToolUse when stale; SessionStart if known    | `statusline.cjs`, and PostToolUse's debounce  |
| `statuslineReassert`                             | `session-connectivity.cjs` (async), every repair — `null` when it succeeded     | `/gutt-pro:statusline status`                 |
| `statuslineShim`                                 | `session-connectivity.cjs` (async), `null` unless the shim could not be written | `/gutt-pro:statusline status`                 |
| `endedAt`, `endReason`                           | SessionEnd                                                                      | the statusline and the next SessionStart      |

`turnsSinceSearch` is `null` until a recall call is seen, and `null` is not the same
as `0`: it means "nothing recalled in this conversation" and gates nothing, where
`0` means a recall just happened and gates. A `startup` or `clear` resets it to
`null` because those begin with an empty context; `resume` and `compact` keep it,
because they keep the transcript the recall is still sitting in.

The two statusline fields carry different shapes, and both are rewritten on every
SessionStart rather than only on failure — the event fires again on resume, `/clear`
and compaction against the same record, so a field written only when something goes
wrong is written once and never corrected:

- `statuslineReassert` — `null`, or `{status, detail}`. The `detail` is what
  `/gutt-pro:statusline status` prints, and on the `settings-lost` path it is the only
  copy of the sentence naming where the user's `settings.json` went: running the
  install again finds no file, takes the "create one" branch, and reports success.
- `statuslineShim` — `null`, or a string naming the shim that could not be written.

### Keys in `config.json`

| Key                              | Producer                             | Written by                    | Scope           |
| -------------------------------- | ------------------------------------ | ----------------------------- | --------------- |
| `enabled`                        | `/gutt-pro:disable` / `/gutt-pro:on` | `runtime-config.cjs` (GP-866) | machine-global  |
| `mode`                           | `/gutt-pro:mode`                     | `runtime-config.cjs` (GP-866) | machine-global  |
| `snoozeUntil`, `snoozeSessionId` | `/gutt-pro:off [N\|session]`, sweeps | `runtime-config.cjs` (GP-863) | machine-global  |
| `migrationsVersion`              | `migrations.cjs` (GP-895)            | `migrations.cjs`              | machine-global  |
| `projects`                       | migration offer (GP-922)             | `runtime-config.cjs` (GP-922) | **per project** |
| `statusline`                     | `/gutt-pro:statusline` (GP-867)      | `runtime-config.cjs` (GP-867) | machine-global  |

`runtime-config.cjs` may mutate only the keys in its `OWNED_KEYS` list — the two
preference keys, the two snooze keys, `projects`, and `statusline`.
`migrationsVersion` is the one key in this file it must not touch.

Until GP-866 the rule here was stronger: `enabled` and `mode` were declared in
`DEFAULTS`, read by nobody, and documented as "must not be written from a hook". That
could not survive the command surface, because the command surface **is** a hook —
`/gutt-pro:<verb>` is parsed and applied on `UserPromptSubmit`, the only event whose process is
given `${CLAUDE_PLUGIN_DATA}`. What the old rule protected is still enforced, by
scope rather than by prohibition: every mutator touches only the keys it names, so a
SessionStart sweep cannot clobber a preference and `/gutt-pro:on` cannot clobber a
migration record. `PREFERENCE_KEYS`, `SNOOZE_KEYS` and `RESTORE_KEYS` exist to keep
those scopes separate — notably `RESTORE_KEYS` omits `mode`, so `/gutt-pro:on` does not
silently reset a `hitl` choice.

**`enabled` is read as `false` only on a strict boolean `false`.** A hand-edited
`"enabled": "no"` therefore does nothing, the same way an unrecognised
`memoryMigration.status` reads as unrecorded. `/gutt-pro:config` prints the raw stored
value so a hand-edit that has no effect is visible rather than assumed to be working.

#### The `projects` key space (GP-922)

Every key above `projects` is machine-global, which was the whole shape of this file
until GP-922. That shape cannot hold a migration decision: a machine-wide `declined`
would silence a repo where migration is wanted, and a machine-wide `migrated` would
skip a repo still holding a full local store.

```jsonc
{
  "projects": {
    "-Users-me-projects-app": {
      "memoryMigration": { "status": "migrated", "at": "2026-07-29T18:00:00.000Z" },
    },
  },
}
```

**Keyed by the encoded Claude Code project-directory name** — the basename of the
directory holding the session transcript, e.g. `-Users-me-projects-app`. Derived from
the hook payload's `transcript_path` (whose parent _is_ that directory, so no encoding
is reproduced); `cwd` with `/`, `.` and `_` flattened to `-` is the fallback for
payloads that carry no transcript.

Keyed on the **store**, not the project. The encoding is lossy — `/a/b-c` and `/a/b/c`
both encode to `-a-b-c` — but that is inherited from Claude Code rather than
introduced here: two such directories already share one built-in memory store, so
sharing one answer about that store is correct.

`status` is one of `migrated`, `declined` or `later`. Only the first two are terminal;
`later` records that the user was asked and deferred, and the offer returns. An
unrecognised stored value is read as "unrecorded" rather than trusted, so a corrupt
file cannot become a permanent silence.

This record is machine-local while the store it describes is not, which is why it is
not the only gate on the offer — see `hooks/lib/builtin-memory.cjs` for the structural
second one.

### Retired locations

GP-863 removed the last state that lived outside `${CLAUDE_PLUGIN_DATA}`. These
are now banned outright by `tests/check-state-location.cjs`, not merely discouraged:

| Retired                                          | Replaced by                                             |
| ------------------------------------------------ | ------------------------------------------------------- |
| project-tree `PROJECT_STATE_DIR`                 | `${CLAUDE_PLUGIN_DATA}` (GP-855)                        |
| `<session_id>.lessons-prompted` marker files     | `lessonsPromptedAt` in the session JSON                 |
| `~/.claude/.gutt-statusline-configured` marker   | nothing — the statusline auto-setup it guarded is gone  |
| _unprompted_ writes to `~/.claude/settings.json` | `/gutt-pro:statusline`, which the user runs — see below |

`sessionstart-setup.cjs` used to write the HUD statusline into the user's
`settings.json` on first run. Besides violating R37, it wrote the **plugin's
current cache path**, which for plugin installs is session-scoped and dead as
soon as that session ends — so the entry it left behind rotted immediately.

### Writing `settings.json`, and the line that replaced the ban (GP-867)

The ban was briefly absolute, and could not stay that way: Claude Code accepts a
`statusLine` only from the user's own settings, never from a plugin's, so an
absolute ban is a decision to have no HUD. What survives is the property the ban was
protecting, stated directly — **nothing writes `settings.json` unless the user asked
for it.**

`statusline-install.cjs` is the only steady-state writer, and it is narrow in four
ways: it touches exactly one key; it runs only from `/gutt-pro:statusline`; it backs
the whole file up to `migrations/settings-backup-<ms>.json` first; and it refuses
outright on a status line it did not write or a file it could not parse.

It writes once without being asked again, and only in one case. Claude Code rewrites
`settings.json` mid-session and drops keys it is not currently serialising —
`statusLine`, `enabledPlugins` and `hooks` among them
([anthropics/claude-code#62486](https://github.com/anthropics/claude-code/issues/62486),
closed as not planned). The consent is therefore persisted under the `statusline`
key of the runtime config, and the async SessionStart hook restores the entry when,
and only when, consent is on file and the entry has gone. A hook that configured
settings for someone who never asked would still be the violation GP-863 deleted.

The other half of the mechanism is why the entry stays valid: it points at
`${CLAUDE_PLUGIN_DATA}/statusline.cjs`, not at the versioned plugin root. That is the
row in the table above, and it is what stops this entry rotting the way the 2.x one
did.

### The one-time 2.x cleanup (GP-895)

Deleting the offending code fixed future writes and nothing else. Anyone who ran a
2.x version still carried its leftovers, and 3.0 had no reason to look at those
paths — so a stale `statusLine` kept firing on every render, dumping a Node
`MODULE_NOT_FOUND` stack trace into the debug log for a file that no longer exists.

`hooks/lib/migrations.cjs` clears that, gated by `session-start.cjs`:

| Removed                                                    | Only when                                                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `statusLine` in the user's `~/.claude/settings.json`       | its directory has a whole path segment naming this plugin, its basename is one of ours, **and** that file no longer exists |
| `~/.claude/.gutt-statusline-configured`                    | present                                                                                                                    |
| `~/.claude/gutt-{memory-cache,seed-registry,session}.json` | present — the `gutt` prefix is the whole attribution rule                                                                  |
| `{memory-cache,seed-registry,gutt-*}.json` in the data dir | present                                                                                                                    |

Rules this follows, each one because the alternative is worse than leaving the
damage in place:

- **The gate lives in the hook, not the module.** Migrating is a lifecycle
  decision. A sibling hook deciding for itself could never be told "not this
  session" — siblings run in parallel with no channel between them.
- **An integer version, compared with `>=`.** The retired marker got this wrong
  twice, first with an existence check that never re-ran on upgrade, then with a
  semver comparison. A non-numeric recorded value reads as 0, so a machine carrying
  the old semver string still gets cleaned.
- **A live target is never touched.** A working status line is someone's working
  status line, even if this plugin installed it.
- **Only `gutt`-prefixed names in `~/.claude`.** That directory is shared with
  Claude Code and every other plugin; an unprefixed 2.x name is not provably ours.
- **Verbatim backup before any edit**, to `migrations/settings-backup-<ms>.json`.
- **Never re-run**, even if the damage reappears — that would fight a user who
  deliberately restored something.
- **It says what it did, and that it did not do everything.** A clean report with no
  stated exclusions reads as a claim to have covered everything.

Deliberately **not** covered: state 2.x wrote into a project tree; unprefixed
caches in `~/.claude`; the inert `gutt: {statusline: {}}` key some `settings.json`
files carry (no reader, no attribution); data belonging to the separately-installed
`gutt-subagent-hooks-plugin` (GP-868); and any `statusLine` whose target resolves.

This re-opens the settings.json write ban that GP-863 closed, narrowly and by name
in `tests/check-state-location.cjs`'s allowlist. The steady-state rule is unchanged
and is what the e2e tier now asserts: **no hook ever adds a key to the user's
settings** — the one sanctioned write is a removal of the plugin's own dead key.

## The state lib — `hooks/lib/plugin-state.cjs`

| Function                                              | Purpose                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stateRoot()` / `statePath(...segs)`                  | Resolve `${CLAUDE_PLUGIN_DATA}` (or a file under it). `null` when unset.                                                                                                                                                                                                             |
| `readJson(path, fallback)`                            | Read + parse; `fallback` on missing/unparseable.                                                                                                                                                                                                                                     |
| `readJsonOrUnreadable(path, fallback)` / `UNREADABLE` | Same, but returns the `UNREADABLE` sentinel instead of `fallback` when the file exists and won't parse. **The distinction is load-bearing**: `updateConfig` uses it to refuse to overwrite a config it could not read, rather than silently replacing the user's keys with defaults. |
| `writeJson(path, data)`                               | **The one atomic-write idiom**: unique temp (`PID+timestamp+counter`) → rename over the target. No non-atomic fallback.                                                                                                                                                              |
| `appendLine(path, line)`                              | Append a line to a log.                                                                                                                                                                                                                                                              |
| `remove(path)` / `exists(path)`                       | Delete / test a state file (null-safe).                                                                                                                                                                                                                                              |
| `atomicWrite(path, text)`                             | Same idiom for non-JSON contents (backs `writeJson` and `trimLog`). Module-private — not exported; listed because it is the idiom, not because it is callable.                                                                                                                       |
| `withLock(path, fn)`                                  | Run `fn` holding an exclusive `open(…,"wx")` lock at `<path>.lock`. Fails open after 250ms; reclaims a lock left by a dead holder after 5s.                                                                                                                                          |
| `updateJson(path, updater)`                           | Read-modify-write under `withLock` — **the only safe way to mutate shared state**. Returns `{state, written}`.                                                                                                                                                                       |
| `sweep(dir, { maxAgeMs, match })`                     | Age-based file cleanup — backs the sessions, debris, and legacy-marker steps.                                                                                                                                                                                                        |
| `trimLog(path, { maxBytes, keepLines })`              | Bounds a breadcrumb log: one `stat` when it's small, tail-trim when it isn't.                                                                                                                                                                                                        |

### Why writes are locked, and why rename-first

Claude Code runs **sibling hooks on one event in parallel** — the SessionStart
pair (`session-start.cjs` and the `async: true` `session-connectivity.cjs`) both
write the session record at once. Confining each hook to disjoint fields is not
enough: an unguarded read-then-write still drops the other process's update when
the two interleave. Nor can a writer verify its own write afterwards — one that
started later can overwrite it immediately. There is no filesystem
compare-and-swap, so mutual exclusion is the only primitive that works, and every
read-modify-write goes through `withLock`.

`atomicWrite` renames **over** the target rather than unlinking first. POSIX
`rename` replaces atomically; unlinking first opens a window where the path does
not exist, and any parallel reader that looks in that window falls back to its
defaults and writes those back — wiping live state. (Windows cannot always
rename onto an existing file, so it alone keeps an unlink fallback.)

Past 4MB `trimLog` stops parsing and keeps only the file's tail — reading a
runaway file whole would blow the SessionStart budget (R25). It does **not**
discard the file: erasing a log is how a hook destroys the evidence of whatever
made it run away.

## SessionStart TTL sweep (R37, GP-863)

`gutt-core/hooks/session-start.cjs` runs the whole sweep on the synchronous path;
`hooks/lib/session-sweep.cjs` holds the steps and their TTL constants, which are the
single place the policy is written down (E8-S8.4 / GP-893 verifies them):

| Artifact                     | TTL / bound                    |
| ---------------------------- | ------------------------------ |
| `sessions/<session_id>.json` | 24h                            |
| `hook-*.log`                 | 256KB, newest 200 lines        |
| `config.json` snooze         | cleared once past its deadline |
| `*.lock`, `*.tmp.*`          | 1h                             |
| `*.lessons-prompted`         | dropped on sight (TTL 0)       |

The 1h debris TTL covers locks and atomic-write temps orphaned by a hook killed
mid-write. They need their own step because the `.json` match above never sees
them, and their own (short) TTL because no legitimate lock is held for more than
a few hundred milliseconds and no temp outlives its own call. Without it an
abandoned lock sits there forever: session ids are never reused, so nothing ever
contends for that lock again to trigger `withLock`'s stale reclamation.

There was one more step, pruning `capture-queue.jsonl` by entry age and count. It was
implemented ahead of its writer on the reasoning that the retention policy was R37's
and a sweep step appearing only alongside its first writer is a step nobody notices
is missing. The writer never arrived — GP-866 put the judge inline at Stop, GP-873
closed as not needed — so the step, its `QUEUE_TTL_MS` / `QUEUE_MAX_ENTRIES` /
`QUEUE_FILE` constants, and the `pruneJsonl` helper it was the only caller of are all
gone. Nothing else in the state contract is line-oriented JSON; should something
become so, that function is recoverable from `hooks/lib/plugin-state.cjs`'s history
(removed in GP-873) rather than carried unused.

Every step is guarded independently: a step that throws is logged and skipped, so it
can neither fail the session nor stop the remaining steps. The isolation is per step,
not per file — `logs` trims both breadcrumb logs inside one guard and relies on
`trimLog` catching its own errors to reach the second.

### Fail-safe when `${CLAUDE_PLUGIN_DATA}` is unset

Local `--plugin-dir` dev and some test contexts don't set the variable. Then every
path helper returns `null` and **every write is a no-op** — the lib never falls back
to the project tree. State is simply unavailable that run; it is never misplaced.
(Tests that need persistence point `CLAUDE_PLUGIN_DATA` at a temp dir.)

## Exemptions

None. GP-863 removed the last one (`sessionstart-setup.cjs`) — every write the
suite performs now lands under `${CLAUDE_PLUGIN_DATA}`.

## CI guard — `tests/check-state-location.cjs` (`npm run check:state`)

Structural, zero-dep (like `check:no-symlinks`). Scans the `hooks/` tree of every plugin
that ships hooks — libs included, since each plugin now owns its own — and fails if a
listed directory is missing rather than skipping it, so a rename cannot silently retire
the guard. It enforces two rules:

1. **No direct `fs` write calls** outside a named allowlist (`plugin-state.cjs`,
   `debug.cjs`, plus the two one-shot migration modules), each of which writes only
   under `${CLAUDE_PLUGIN_DATA}`. This is how
   "state escapes to the project tree" is caught: writes must route through the lib.
2. **No retired state paths** (the table above). These would otherwise come back
   quietly — handed to `plugin-state.cjs` they no-op rather than fail, so the guard
   catches them at CI instead. This is GP-863 AC3's "grep-verified", kept honest.

As a second layer, the lib's own writers refuse any path outside `${CLAUDE_PLUGIN_DATA}`,
so even a stray path handed to `writeJson`/`appendLine` is a no-op (returns `false`).

## Adding new state

1. Use `plugin-state.cjs` — never join your own path or call `fs.write*` directly.
2. If a new lib needs it, add the real file under that plugin's own `hooks/lib/`.
   Never a symlink and never a reference into another plugin — `npm run check:no-symlinks`
   enforces the first, and the second does not survive installation anyway.
3. Add the file to the table above.
