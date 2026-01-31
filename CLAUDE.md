# GUTT Claude Code Plugin

## Project Overview

This is a Claude Code plugin that integrates GUTT (Graph-based Unified Thinking Tool) memory capabilities into Claude Code workflows. The plugin provides:

- **Memory Integration**: Connect Claude Code to GUTT's knowledge graph for persistent organizational memory
- **Skills & Hooks**: Custom skills and hooks for enhanced agent workflows
- **MCP Tools**: Additional MCP server configurations for extended capabilities

## Architecture

```
gutt-claude-code-plugin/
├── src/
│   ├── hooks/          # Claude Code hooks (PreToolUse, PostToolUse, etc.)
│   ├── skills/         # Custom skills for Claude Code
│   ├── mcp/            # MCP server configurations
│   └── utils/          # Shared utilities
├── .claude/
│   └── settings.json   # Project Claude settings (MCP, permissions)
└── package.json
```

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

- **gutt-pro-memory**: GUTT memory graph for organizational knowledge
- **atlassian**: Jira/Confluence integration
- **github**: GitHub API integration

## Memory Integration

When working on this project, use the GUTT memory graph to:

- Store architectural decisions
- Track lessons learned
- Capture user preferences
- Record project patterns

### Memory Group ID

Use `gutt-claude-code-plugin` as the group_id for all memory operations in this project.

## Related Tickets

- GP-421: Create GUTT Plugin for Claude Code (parent story)
- GP-435: Repository Tooling Setup
