# Changelog

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
