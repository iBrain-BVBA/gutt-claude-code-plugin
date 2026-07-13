# gutt Claude Code Plugin

## Project Overview

This is a Claude Code plugin that integrates gutt (Graph-based Unified Thinking Tool) memory capabilities into Claude Code workflows. The plugin provides:

- **Memory Integration**: Connect Claude Code to gutt's knowledge graph for persistent organizational memory
- **Skills & Hooks**: Custom skills and hooks for enhanced agent workflows
- **MCP Tools**: Additional MCP server configurations for extended capabilities

## Architecture

```
gutt-plugins/               # marketplace repo (root is NOT a plugin)
├── .claude-plugin/         # marketplace.json — lists gutt-core + auto-lint-plugin
├── gutt-core/              # core plugin (name: gutt-claude-code-plugin, displayName: gutt-core)
│   ├── .claude-plugin/     # plugin.json
│   ├── hooks/              # Claude Code hooks (.cjs) + lib/ shared utilities
│   ├── skills/ agents/ commands/
│   └── rules/ mcp.json config.json.example
├── auto-lint-plugin/       # standalone lint-on-edit plugin (no gutt dependency)
├── plugins/
│   └── gutt-subagent-hooks-plugin/  # legacy subagent hooks (retired in a later 3.0 story)
├── .claude/                # repo-dev tooling (agents, commands, settings) — not shipped
├── tests/                  # Unit and E2E tests
├── docs/                   # Documentation and assets
└── package.json
```

## Shared Lib File Propagation

Hook lib files now live in `gutt-core/hooks/lib/*.cjs` and are copied into each other plugin that needs them (`auto-lint-plugin/hooks/lib/`, `plugins/gutt-subagent-hooks-plugin/hooks/lib/`). Each plugin must be self-contained for independent installation. (GP-853 will replace these copies with in-repo symlinks and retire the table below.)

**When modifying a lib file, changes MUST be propagated to all plugins that contain a copy:**

| Lib file                | auto-lint-plugin | gutt-subagent-hooks-plugin |
| ----------------------- | ---------------- | -------------------------- |
| `env.cjs`               | YES              | YES                        |
| `debug.cjs`             | YES              | YES                        |
| `platform-detect.cjs`   | YES              | YES                        |
| `session-state.cjs`     | —                | YES                        |
| `memory-cache.cjs`      | —                | YES                        |
| `config.cjs`            | —                | YES                        |
| `constants.cjs`         | —                | YES                        |
| `text-utils.cjs`        | —                | YES                        |
| `seed-registry.cjs`     | —                | YES                        |
| `memory-classifier.cjs` | —                | YES                        |

## Development Guidelines

### Code Style

- Use ES modules (`type: "module"` in package.json)
- Follow ESLint configuration for linting
- Use Prettier for formatting
- Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/)

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`

### Running Locally

```bash
npm install          # Install dependencies
npm run lint         # Run ESLint
npm run format       # Format with Prettier
```

## MCP Servers

This project is configured to use:

- **gutt-pro-memory**: gutt memory graph for organizational knowledge
- **atlassian**: Jira/Confluence integration
- **github**: GitHub API integration

## Memory Integration

When working on this project, use the gutt memory graph to:

- Store architectural decisions
- Track lessons learned
- Capture user preferences
- Record project patterns

Note: The MCP server determines the group_id automatically from authentication. Do not specify group_id manually.

## Related Tickets

- GP-421: Create gutt Plugin for Claude Code (parent story)
- GP-435: Repository Tooling Setup
