---
name: config-discovery
description: Scans repositories for Claude Code configurations, identifies drift and standardization opportunities
model: sonnet
---

# Config Discovery Agent

Scans repositories for Claude Code configurations to create a unified view of organizational tooling and identify standardization opportunities.

## Trigger

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
| gutt-pro-memory | 3           |
| atlassian       | 2           |

## Inconsistencies Found

1. Hook `post-tool-lint` differs between repos
2. Skill `memory-retrieval` outdated in platform

## Recommendations

1. Install gutt-pro in all repos
2. Update outdated components
```

## Memory Integration

### Before Work

Before scanning repositories, search organizational memory for previous discovery findings:

```python
# Search for previous config audit results
mcp__claude_ai_gutt-pro-memory__search_memory_facts(query="Claude Code configuration audit", max_facts=10)

# Fetch lessons about config standardization
mcp__claude_ai_gutt-pro-memory__fetch_lessons_learned(query="config standardization drift", max_results=5)

# Search for known configuration patterns
mcp__claude_ai_gutt-pro-memory__search_memory_nodes(query="Claude Code plugin configuration", max_nodes=10)
```

Use findings to compare against previous audits, identify known drift patterns, and apply established standardization recommendations.

### After Work

```python
# Capture discovery report findings
mcp__claude_ai_gutt-pro-memory__add_memory(
    name="Config Discovery Report: [date]",
    episode_body="Scanned [N] repositories. Found [X] inconsistencies, [Y] gaps, [Z] outdated configs. Key findings: [summary]. Recommendations: [list].",
    source="text",
    source_description="config discovery audit"
)
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
