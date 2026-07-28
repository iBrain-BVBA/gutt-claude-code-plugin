# Changelog

## [Unreleased]

### Removed

- **BREAKING — statusline `passthroughCommand` is gone.** The statusline no
  longer chains to a user-supplied command, and `gutt.statusline.passthroughCommand`,
  `showTicker`, and `multiLine` are all ignored. Anyone relying on passthrough
  loses their custom statusline silently on upgrade and should register that
  command directly in `~/.claude/settings.json` instead. Chaining ran the command
  through `spawn(…, {shell: true})`, so a config pointing back at the plugin
  fork-bombed the machine; it was guarded by a `GUTT_STATUSLINE_DEPTH` counter,
  and removing the mechanism removes the whole bug class. GP-844 defers all
  statusline extras (GP-844)
- **HUD counters (`mem:` / `lessons:`) and the toast ticker.** The `PostToolUse`
  hooks that fed them (`post-memory-ops.cjs`, `cowork-periodic-capture.cjs`) are
  removed along with `memory-cache.cjs` and `seed-registry.cjs`; the
  `/gutt-claude-code-plugin:reset-counters` command is deleted (GP-844)
- **The subagent hooks plugin** (`plugins/gutt-subagent-hooks-plugin/`), which was
  never listed in `marketplace.json` and therefore never shipped. Decision O4
  keeps subagent hooks out of 3.0 (GP-868)

### Added

- `memory-search` skill (gutt-core): the adaptive, relevance-gated memory-search discipline — rung 1 = one `search_memory_nodes` + `search_memory_facts` pass, judged for relevance and reformulated (not paginated) when weak; a relevance gate that reports "no relevant memory found" rather than stretching a distractor; rung 2 narrowing filters; rung 3 traversal handoff to `graph-traversal`; summary-first episode rules and tool-tier degradation. Rung-1 shape validated on a 50-query live-graph benchmark (top-3 hit-rate 86% vs 58% for a fixed single pass; zero false answers on absent-topic queries). Exact tool contracts live in `skills/memory-search/references/tools.md` (GP-856, E2 core memory curriculum)

### Deprecated

- `memory-retrieval` skill redirected to `memory-search`: its trigger phrases moved to `memory-search` so it no longer auto-fires, and the `/gutt-claude-code-plugin:memory-retrieval` command remains only as an alias (GP-856)

### Removed

- Dead routing/intent-extraction engine and orphaned libs with no live callers: `agent-discovery`, `router`, `memory-routing`, `intent-extractor`, `transcript-parser`, `lesson-builder`, `plan-feedback-detector`, root `text-utils`, and the write-only `cross-session-learner` analytics (nothing reads `gutt-analytics.json`) — ~1,840 lines (GP-851, part of the 3.0 E1 foundation)
- Stale `docs/hook-test-plan.md` (described the pre-split hook layout)

## [2.7.1] - 2026-04-14

### Changed

- Centralized session-id sanitization; added subagent-skip logging

### Fixed

- Stop hook skips subagent stops and uses consistent session-id handling

## [2.7.0] - 2026-04-14

### Changed

- Simplified the stop hook to a block-once pattern

## [2.6.0] - 2026-04-14

### Fixed

- Stop hook no longer fires on subagent completions
- Silent failures and error logging hardened across hooks

## [2.5.0] - 2026-04-14

### Changed

- Extracted lint and subagent hooks into standalone plugins
- Moved plugin-dev agents and dev-only commands to repo-only (unshipped)

## [2.4.0] - 2026-04-14

### Changed

- Trimmed marketplace skills and removed prescriptive hooks

## [2.3.0] - 2026-04-08

### Fixed

- Statusline fork-bomb from self-referential passthrough; general hook hardening
- Switched Python formatting from black to ruff; stopped auto-removing unused imports

## [2.2.0] - 2026-04-02

### Fixed

- Hook matcher regex syntax and `connectionStatus` on startup (#33)
- Removed hooks from project settings to prevent double-firing (#32)
- Lessons counter mismatch from an MCP tool-name change (#37)
- Re-run statusline setup on plugin version upgrade (#35)
- Hide empty `group_id` from the statusline (#34)
- Moved memory quality gate into an agent; removed dead playbook code (#36)
- Removed the delegation-guard hook from pre-tool-use

## [2.1.0] - 2026-04-02

### Added

- Debug logging across hooks; memory-search reminder on first prompt

### Fixed

- Case-insensitive / flexible MCP server-name matching (#30, #31)
- Corrected marketplace install command in README
- Enforced dedup in the memory-capture skill; fixed MCP tool names

## [2.0.0] - 2026-04-01

### Added

- Memory classifier framework (5 capture types with trust scoping)
- Lesson builder for consolidated platform output
- Seed registry mtime cache invalidation
- Behavioral tests for memory classifier and decision authority

### Fixed

- Decision authority case sensitivity in claim_type lookup

## [1.6.0] - 2026-04-01

### Added

- /onboard skill with 7-step first-use flow
- diagnoseGuttMcp() for MCP connectivity diagnostics
- Ported external-tool-docs and skills-discovery skills
- Ported commit-push-pr and lint-test commands
- Frontmatter for memory-capture and memory-retrieval skills

### Changed

- README Quick Start rewritten with clear install paths
- Session-start hook uses structured MCP diagnostics

## [1.5.1] - 2026-04-01

### Added

- WORKFLOW_PREFIXES for git/gh commands in delegation guard
- Plan file write exception in delegation guard
- 34 unit tests for delegation guard

### Fixed

- Counter timing in post-task-lessons (increment after output)
- Fallback score reduced from 0.5 to 0.25

### Removed

- diagnostic-capture.cjs (orphan with credential exposure risk)

## [1.5.0] - Previous

- Initial release with memory integration, hooks, skills, agents
