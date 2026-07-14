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

| File                            | Written by                                       | Notes                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions/<session_id>.json`    | `session-state.cjs`                              | Per-session counters/flags, keyed on the stdin `session_id` (not the date) so concurrent sessions don't collide. Swept >24h at SessionStart.            |
| `memory-cache.json`             | `memory-cache.cjs`                               | Memory results cache. Still one global file; the per-session split (ADR D3) is **GP-863**.                                                              |
| `seed-registry.json`            | `seed-registry.cjs`                              | Agent-seed scan cache (own 5-min TTL).                                                                                                                  |
| `hook-errors.log`               | `debug.cjs`                                      | Best-effort error log.                                                                                                                                  |
| `hook-invocations.log`          | `user-prompt-submit`, `stop-lessons`             | Prompt/stop breadcrumbs.                                                                                                                                |
| `<session_id>.lessons-prompted` | `stop-lessons` (cleared by `user-prompt-submit`) | One-shot "already prompted this session" marker. Swept >24h. Folding this into the session JSON (R37 "prefer JSON over markers") is a later E3 cleanup. |
| `config.json`                   | _(reserved — E3)_                                | Runtime on/off, mode, snooze-until, group_id. **Distinct from** the static, git-ignored plugin `config.json` at the repo/plugin root (org group_id).    |
| `capture-queue.jsonl`           | _(reserved — GP-873)_                            | Append-only capture queue. GP-855 only reserves the name; write/drain/overflow is GP-873's.                                                             |

## The shared lib — `shared/plugin-state.cjs`

| Function                             | Purpose                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `stateRoot()` / `statePath(...segs)` | Resolve `${CLAUDE_PLUGIN_DATA}` (or a file under it). `null` when unset.                                                             |
| `readJson(path, fallback)`           | Read + parse; `fallback` on missing/unparseable.                                                                                     |
| `writeJson(path, data)`              | **The one atomic-write idiom**: unique temp (`PID+timestamp+counter`) → delete-before-rename (Windows-safe). No non-atomic fallback. |
| `appendLine(path, line)`             | Append a line to a log.                                                                                                              |
| `remove(path)` / `exists(path)`      | Delete / test a state file (null-safe).                                                                                              |
| `sweep(dir, { maxAgeMs, match })`    | The SessionStart TTL cleanup.                                                                                                        |

### Fail-safe when `${CLAUDE_PLUGIN_DATA}` is unset

Local `--plugin-dir` dev and some test contexts don't set the variable. Then every
path helper returns `null` and **every write is a no-op** — the lib never falls back
to the project tree. State is simply unavailable that run; it is never misplaced.
(Tests that need persistence point `CLAUDE_PLUGIN_DATA` at a temp dir.)

## Exemption

`gutt-core/hooks/sessionstart-setup.cjs` writes the user's real
`~/.claude/settings.json` (and a sibling marker) to install the HUD statusline.
That is **one-time IDE configuration, not runtime state**, so it stays put and is
allowlisted in the guard. No other write outside `${CLAUDE_PLUGIN_DATA}` is allowed.

## CI guard — `tests/check-state-location.cjs` (`npm run check:state`)

Structural, zero-dep (like `check:shared`). Scans `shared/` and every plugin's
`hooks/` and **fails on any direct `fs` write call** outside a small, reasoned
allowlist (`plugin-state.cjs`, `debug.cjs`, `sessionstart-setup.cjs`). This is how
"state escapes to the project tree" is caught: writes must route through the lib.
As a second layer, the lib's own writers refuse any path outside `${CLAUDE_PLUGIN_DATA}`,
so even a stray path handed to `writeJson`/`appendLine` is a no-op (returns `false`).

## Adding new state

1. Use `plugin-state.cjs` — never join your own path or call `fs.write*` directly.
2. If a new shared lib needs it, keep both in `shared/` (Node realpaths symlinked
   modules, so co-dependent libs must sit together) and symlink the new lib into
   each consuming plugin's `hooks/lib/` (`npm run check:shared` enforces this).
3. Add the file to the table above.
