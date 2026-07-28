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

All access goes through **`shared/plugin-state.cjs`**. Paths are resolved from
`${CLAUDE_PLUGIN_DATA}`; no code joins its own `.state` path anymore.

| File                                   | Written by                                                                                                  | Notes                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions/<session_id>.json`           | `session-state.cjs`                                                                                         | Per-session lifecycle flags, keyed on the stdin `session_id` (not the date) so concurrent sessions don't collide. Holds the GP-863 lifecycle fields and the connectivity result the statusline reads. Swept >24h at SessionStart.                                                               |
| `config.json`                          | config commands (GP-866); snooze lifecycle by `runtime-config.cjs`; `migrationsVersion` by `migrations.cjs` | Runtime on/off, mode, snooze, and the integer `migrationsVersion` recording which one-time cleanups this machine has had. **Distinct from** the static, git-ignored plugin `config.json` at the repo/plugin root (org group_id) that `shared/config.cjs` reads.                                 |
| `capture-queue.jsonl`                  | _(writer/drain — GP-873)_                                                                                   | Append-only capture queue. GP-863 owns only its TTL: entries >7d, unparseable lines, and overflow past 500 lines are pruned at SessionStart.                                                                                                                                                    |
| `hook-errors.log`                      | `debug.cjs`                                                                                                 | Best-effort error log. Trimmed to the newest 200 lines once it passes 256KB.                                                                                                                                                                                                                    |
| `hook-invocations.log`                 | `user-prompt-submit`                                                                                        | Prompt/stop breadcrumbs. Same 256KB/200-line bound.                                                                                                                                                                                                                                             |
| `migrations/settings-backup-<ms>.json` | `migrations.cjs` (GP-895)                                                                                   | The user's `~/.claude/settings.json`, verbatim, taken immediately before the one-time 2.x cleanup edits it. Written at most once per machine and **never swept** — it is the undo for an edit to a file the plugin does not own, so a TTL on it would be a TTL on someone's ability to recover. |

The three artifacts named by the R37 state contract are the first three rows; the
rest are caches, logs, and one backup that rebuild themselves or are written once.

### Retired locations

GP-863 removed the last state that lived outside `${CLAUDE_PLUGIN_DATA}`. These
are now banned outright by `tests/check-state-location.cjs`, not merely discouraged:

| Retired                                        | Replaced by                                            |
| ---------------------------------------------- | ------------------------------------------------------ |
| project-tree `PROJECT_STATE_DIR`               | `${CLAUDE_PLUGIN_DATA}` (GP-855)                       |
| `<session_id>.lessons-prompted` marker files   | `lessonsPromptedAt` in the session JSON                |
| `~/.claude/.gutt-statusline-configured` marker | nothing — the statusline auto-setup it guarded is gone |
| writes to the user's `~/.claude/settings.json` | nothing — see below                                    |

`sessionstart-setup.cjs` used to write the HUD statusline into the user's
`settings.json` on first run. Besides violating R37, it wrote the **plugin's
current cache path**, which for plugin installs is session-scoped and dead as
soon as that session ends — so the entry it left behind rotted immediately. The
hook is deleted; re-landing the HUD is **GP-867 (S3.6)**.

### The one-time 2.x cleanup (GP-895)

Deleting the offending code fixed future writes and nothing else. Anyone who ran a
2.x version still carried its leftovers, and 3.0 had no reason to look at those
paths — so a stale `statusLine` kept firing on every render, dumping a Node
`MODULE_NOT_FOUND` stack trace into the debug log for a file that no longer exists.

`shared/migrations.cjs` clears that, gated by `session-start.cjs`:

| Removed                                                    | Only when                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| `statusLine` in the user's `~/.claude/settings.json`       | it names a plugin-owned `statusline.cjs` **and** that file no longer exists |
| `~/.claude/.gutt-statusline-configured`                    | present                                                                     |
| `~/.claude/gutt-{memory-cache,seed-registry,session}.json` | present — the `gutt` prefix is the whole attribution rule                   |
| `{memory-cache,seed-registry,gutt-*}.json` in the data dir | present                                                                     |

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

## The shared lib — `shared/plugin-state.cjs`

| Function                                   | Purpose                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `stateRoot()` / `statePath(...segs)`       | Resolve `${CLAUDE_PLUGIN_DATA}` (or a file under it). `null` when unset.                                                                    |
| `readJson(path, fallback)`                 | Read + parse; `fallback` on missing/unparseable.                                                                                            |
| `writeJson(path, data)`                    | **The one atomic-write idiom**: unique temp (`PID+timestamp+counter`) → rename over the target. No non-atomic fallback.                     |
| `appendLine(path, line)`                   | Append a line to a log.                                                                                                                     |
| `remove(path)` / `exists(path)`            | Delete / test a state file (null-safe).                                                                                                     |
| `atomicWrite(path, text)`                  | Same idiom for non-JSON contents (backs `writeJson`).                                                                                       |
| `withLock(path, fn)`                       | Run `fn` holding an exclusive `open(…,"wx")` lock at `<path>.lock`. Fails open after 250ms; reclaims a lock left by a dead holder after 5s. |
| `updateJson(path, updater)`                | Read-modify-write under `withLock` — **the only safe way to mutate shared state**. Returns `{state, written}`.                              |
| `sweep(dir, { maxAgeMs, match })`          | Age-based file cleanup — the sessions sweep.                                                                                                |
| `pruneJsonl(path, { maxAgeMs, maxLines })` | Drops expired, malformed, and overflow entries from a JSONL queue. Rewrites only when something was dropped.                                |
| `trimLog(path, { maxBytes, keepLines })`   | Bounds a breadcrumb log: one `stat` when it's small, tail-trim when it isn't.                                                               |

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

Past 4MB the TTL helpers stop parsing and keep only the file's tail — reading a
runaway file whole would blow the SessionStart budget (R25). They do **not**
discard the file: erasing a log is how a hook destroys the evidence of whatever
made it run away.

## SessionStart TTL sweep (R37, GP-863)

`gutt-core/hooks/session-start.cjs` runs the whole sweep, and its TTL constants are
the single place the policy is written down (E8-S8.4 / GP-893 verifies them):

| Artifact                     | TTL / bound                    |
| ---------------------------- | ------------------------------ |
| `sessions/<session_id>.json` | 24h                            |
| `capture-queue.jsonl`        | 7d, max 500 entries            |
| `hook-*.log`                 | 256KB, newest 200 lines        |
| `config.json` snooze         | cleared once past its deadline |
| `*.lock`, `*.tmp.*`          | 1h                             |

The 1h debris TTL covers locks and atomic-write temps orphaned by a hook killed
mid-write. They need their own step because the `.json` match above never sees
them, and their own (short) TTL because no legitimate lock is held for more than
a few hundred milliseconds and no temp outlives its own call. Without it an
abandoned lock sits there forever: session ids are never reused, so nothing ever
contends for that lock again to trigger `withLock`'s stale reclamation.

Every step is guarded independently: a corrupt queue file must not stop the
session sweep, and no step may fail the session.

### Fail-safe when `${CLAUDE_PLUGIN_DATA}` is unset

Local `--plugin-dir` dev and some test contexts don't set the variable. Then every
path helper returns `null` and **every write is a no-op** — the lib never falls back
to the project tree. State is simply unavailable that run; it is never misplaced.
(Tests that need persistence point `CLAUDE_PLUGIN_DATA` at a temp dir.)

## Exemptions

None. GP-863 removed the last one (`sessionstart-setup.cjs`) — every write the
suite performs now lands under `${CLAUDE_PLUGIN_DATA}`.

## CI guard — `tests/check-state-location.cjs` (`npm run check:state`)

Structural, zero-dep (like `check:shared`). Scans `shared/` and every plugin's
`hooks/` and enforces two rules:

1. **No direct `fs` write calls** outside a two-entry allowlist (`plugin-state.cjs`,
   `debug.cjs`), both of which write only under `${CLAUDE_PLUGIN_DATA}`. This is how
   "state escapes to the project tree" is caught: writes must route through the lib.
2. **No retired state paths** (the table above). These would otherwise come back
   quietly — handed to `plugin-state.cjs` they no-op rather than fail, so the guard
   catches them at CI instead. This is GP-863 AC3's "grep-verified", kept honest.

As a second layer, the lib's own writers refuse any path outside `${CLAUDE_PLUGIN_DATA}`,
so even a stray path handed to `writeJson`/`appendLine` is a no-op (returns `false`).

## Adding new state

1. Use `plugin-state.cjs` — never join your own path or call `fs.write*` directly.
2. If a new shared lib needs it, keep both in `shared/` (Node realpaths symlinked
   modules, so co-dependent libs must sit together) and symlink the new lib into
   each consuming plugin's `hooks/lib/` (`npm run check:shared` enforces this).
3. Add the file to the table above.
