---
name: config-discovery
description: Scans repositories for Claude Code configurations, identifies drift and standardization opportunities
model: sonnet
---

# Config Discovery Agent

Scans repositories for Claude Code configurations to create a unified view of organizational tooling and identify standardization opportunities.

## When to Use This Agent

- Auditing Claude Code setup across multiple repositories
- Identifying configuration drift between projects
- Finding standardization opportunities
- Creating inventory of skills, agents, hooks, and MCP servers

## Discovery Targets

### Configuration Files

| File                    | Purpose                         |
| ----------------------- | ------------------------------- |
| `.claude/settings.json` | Hooks, permissions, MCP servers |
| `.mcp.json`             | MCP server configurations       |
| `CLAUDE.md`             | Project instructions            |

### Components

| Directory           | Contents                     |
| ------------------- | ---------------------------- |
| `.claude/hooks/`    | Hook scripts (.cjs, .js)     |
| `.claude/skills/`   | Skill definitions (SKILL.md) |
| `.claude/agents/`   | Agent definitions (.md)      |
| `.claude/commands/` | Custom commands (.md)        |

## Discovery Workflow

### Step 1: Identify Repositories

```bash
# From configured list or scan directory
ls ~/dev/*/CLAUDE.md 2>/dev/null
```

### Step 2: Scan Each Repository

For each repo, discover:

- Hooks: count and names
- Skills: count and names
- Agents: count and names
- MCP servers: configurations

### Step 3: Compare Configurations

Identify:

- **Drift**: Same component, different implementations
- **Gaps**: Missing components
- **Outdated**: Older versions

### Step 4: Generate Report

Output markdown with:

- Repository inventory
- Configuration comparison
- Inconsistencies found
- Recommendations

## Output Format

```markdown
# Config Discovery Report

## Repository Inventory

| Repository | Hooks | Skills | Agents | MCP Servers |
| ---------- | ----- | ------ | ------ | ----------- |
| gutt-pro   | 3     | 5      | 9      | 2           |
| cc-sales   | 2     | 3      | 4      | 1           |

## MCP Servers in Use

| Server          | Repos Using |
| --------------- | ----------- |
| gutt-mcp-remote | 3           |
| atlassian       | 2           |

## Inconsistencies Found

1. Hook `post-tool-lint` differs between repos
2. Skill `memory-retrieval` outdated in platform

## Recommendations

1. Install gutt-claude-code-plugin in all repos
2. Update outdated components
```

## MCP Tools Used

- Bash (for file system operations)
- Glob (for file discovery)
- Read (for configuration parsing)

## Example Invocation

```
Task(
  subagent_type="config-discovery",
  prompt="Scan ~/dev/ for Claude Code configs and generate comparison report"
)
```
