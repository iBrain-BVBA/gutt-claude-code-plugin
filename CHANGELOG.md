# Changelog

## [Unreleased]

### Added

- `memory-search` skill (gutt-core): the shallow-first, summary-first memory-search discipline — search ladder (rung 1 shallow → rung 2 filters → rung 3 traversal handoff), summary-first episode rules, a pagination prohibition, and tool-tier degradation; exact tool contracts live in `skills/memory-search/references/tools.md` (GP-856, E2 core memory curriculum)

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
