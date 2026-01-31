# GUTT Claude Code Plugin

Persistent organizational memory for Claude Code via GUTT (Graph-based Unified Thinking Tool).

## Overview

This plugin provides a memory backbone for Claude Code, enabling:

- **Automatic memory retrieval** before every task
- **Lesson capture prompts** after significant work
- **Auto-linting** after file edits
- **Multi-hop graph exploration** for deep organizational insights

## Quick Start

### Installation

```bash
# Install via Claude Code plugin command
/plugin add https://github.com/iBrain-BVBA/gutt-claude-code-plugin
```

### Setup

Run the setup wizard to configure your GUTT connection:

```
/gutt-setup
```

Or configure manually by creating `.mcp.json`:

```json
{
  "mcpServers": {
    "gutt-mcp-remote": {
      "command": "npx",
      "args": ["-y", "@gutt/mcp-remote"],
      "env": {
        "GUTT_API_KEY": "your-api-key",
        "GUTT_ENDPOINT": "https://api.gutt.io"
      }
    }
  }
}
```

## Features

### Hooks

| Hook                     | Event            | Purpose                               |
| ------------------------ | ---------------- | ------------------------------------- |
| `user-prompt-submit.cjs` | UserPromptSubmit | Reminds to search memory before tasks |
| `stop-lessons.cjs`       | Stop             | Prompts for lesson capture after work |
| `post-tool-lint.cjs`     | PostToolUse      | Auto-lints files after Edit/Write     |

### Skills

| Skill            | Command             | Purpose                                      |
| ---------------- | ------------------- | -------------------------------------------- |
| memory-retrieval | `/memory-retrieval` | 3-part memory search (facts, nodes, lessons) |
| memory-capture   | `/memory-capture`   | Structured lesson capture with 4 patterns    |

### Agents

| Agent              | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `gutt-pro-memory`  | Multi-hop graph exploration and search strategies |
| `memory-keeper`    | Autonomous lesson capture after significant work  |
| `config-discovery` | Scan repos for Claude Code config drift           |

## Usage

### Memory Retrieval

Search organizational memory before starting work:

```
/memory-retrieval "authentication patterns"
```

Returns:

- Related facts (relationships between entities)
- Relevant nodes (Lessons, Decisions, People, WorkItems)
- Domain-specific lessons

### Memory Capture

Capture learnings using one of 4 patterns:

```
/memory-capture "We decided to use relative paths instead of env vars for cross-platform compatibility"
```

**Patterns:**

- **Negation**: "X does NOT work because Y"
- **Replacement**: "Instead of X, use Y"
- **Decision**: "We decided X because Y"
- **Lesson**: "Learned that X when Y"

## Integration with oh-my-claudecode

This plugin works seamlessly alongside oh-my-claudecode:

1. GUTT hooks fire **before** OMC hooks
2. Memory context is available when OMC orchestration starts
3. OMC sub-agents can call GUTT MCP tools

## File Structure

```
gutt-claude-code-plugin/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── hooks/
│   ├── user-prompt-submit.cjs
│   ├── stop-lessons.cjs
│   └── post-tool-lint.cjs
├── skills/
│   ├── memory-retrieval/SKILL.md
│   └── memory-capture/SKILL.md
├── agents/
│   ├── gutt-pro-memory.md
│   ├── memory-keeper.md
│   └── config-discovery.md
├── commands/
│   └── setup.md
├── .mcp.json                 # MCP server template
└── README.md
```

## Requirements

- Claude Code CLI
- Node.js 18+
- GUTT account (sign up at https://app.gutt.io)

## Cross-Platform Support

This plugin works on:

- macOS (ARM and Intel)
- Linux (Ubuntu, etc.)
- Windows (PowerShell, Git Bash)

**Note:** Hooks use relative paths for cross-platform compatibility.

## Troubleshooting

### Hook not firing

1. Check `.claude/settings.json` includes the hooks
2. Verify Node.js is in PATH
3. Check hook file permissions

### MCP connection failed

1. Verify API key at https://app.gutt.io/settings/api-keys
2. Check network connectivity to api.gutt.io
3. Try: `npx -y @gutt/mcp-remote --version`

### Memory search returns no results

1. Ensure you're using the correct group_id
2. Try broader search terms
3. Check if memory has been populated

## Contributing

1. Fork the repository
2. Create a feature branch
3. Follow conventional commits
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE)

## Links

- [GUTT Documentation](https://docs.gutt.io)
- [Claude Code](https://claude.ai/code)
- [oh-my-claudecode](https://github.com/anthropics/oh-my-claudecode)
- [Report Issues](https://github.com/iBrain-BVBA/gutt-claude-code-plugin/issues)
