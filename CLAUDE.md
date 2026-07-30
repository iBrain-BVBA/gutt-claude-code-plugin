# gutt Claude Code Plugin

## Project Overview

This is a Claude Code plugin that integrates gutt (Graph-based Unified Thinking Tool) memory capabilities into Claude Code workflows. The plugin provides:

- **Memory Integration**: Connect Claude Code to gutt's knowledge graph for persistent organizational memory
- **Skills & Hooks**: Custom skills and hooks for enhanced agent workflows
- **MCP Tools**: Additional MCP server configurations for extended capabilities

## Architecture

```
gutt-plugins/               # marketplace repo (root is NOT a plugin)
├── .claude-plugin/         # marketplace.json — lists gutt-core + auto-lint-plugin + gutt-mentor
├── shared/                 # single source for hook libs; plugins symlink these (GP-853)
├── gutt-core/              # core plugin (name: gutt-claude-code-plugin, displayName: gutt-core)
│   ├── .claude-plugin/     # plugin.json
│   ├── hooks/              # Claude Code hooks (.cjs); hooks/lib/* symlink → shared/
│   ├── skills/ agents/ commands/
│   └── rules/ mcp.json config.json.example
├── auto-lint-plugin/       # standalone lint-on-edit plugin (no gutt dependency)
├── gutt-mentor/            # mentor plugin (depends on gutt-core) — onboarding agent + personal-scope program design/tracking
├── .claude/                # repo-dev tooling (agents, commands, settings) — not shipped
├── tests/                  # Unit and E2E tests
├── docs/                   # Documentation and assets
└── package.json
```

## Shared Hook Libraries

Hook libraries have a single source in `shared/*.cjs`. Each plugin's `hooks/lib/<name>.cjs` is a **symlink** into `shared/` (`../../../shared/` from `gutt-core` and `auto-lint-plugin`). Edit the file in `shared/` once — every plugin sees it. No manual copying, no propagation table.

- **Guard:** `npm run check:shared` (run in CI) fails if any plugin ships a divergent real copy of a shared lib instead of a symlink.
- **Install-time:** Claude Code dereferences intra-marketplace symlinks when copying a plugin to its cache, so installed plugins get real files and stay self-contained. ([docs](https://code.claude.com/docs/en/plugins-reference#share-files-within-a-marketplace-with-symlinks))
- **Plugin-local libs** with no `shared/` counterpart stay as real files — allowed by the guard.
- **Local dev:** `--plugin-dir` / local-path installs do **not** dereference cross-plugin symlinks. Running from the repo works (the link resolves in place); to exercise a real install, install from the git marketplace source.
- **Windows:** symlinks need `git config core.symlinks true` (or Developer Mode); without it the links check out as plain text files.

When adding a new shared lib: put the real file in `shared/`, then symlink it into each consuming plugin's `hooks/lib/`.

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

Note: pass the group explicitly. Omitting `group_id` on a write targets an unspecified one of your allowed groups, not a fixed default — so pass it whenever you can write to more than one; with exactly one group you may omit it. On reads, pass `group_ids` naming the groups you mean: omitting it includes personal scope. `shared/agent-identity.md` is the normative reference.

## Related Tickets

- GP-421: Create gutt Plugin for Claude Code (parent story)
- GP-435: Repository Tooling Setup
