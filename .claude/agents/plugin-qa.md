---
name: plugin-qa
description: Unified quality gate that validates plugin structure, agent definitions, hook execution, IDE compatibility, and MCP integration in a single pass
model: sonnet
whenToUse: Use before releases, after structural changes, or when verifying overall plugin health. Consolidates checks from plugin-validator, agent-linter, hook-tester, cross-ide-tester, and mcp-integration-tester.
allowedTools:
  - Read
  - Bash
  - Grep
  - Glob
---

# Plugin QA Agent

Unified quality gate for the gutt-claude-code-plugin. Runs five validation passes covering structure, agent definitions, hooks, IDE compatibility, and MCP integration, then produces a single consolidated report with pass/fail verdicts.

## Trigger

Invoke this agent when:

- Preparing a release or version bump
- After adding/removing hooks, agents, or skills
- After modifying manifests or hook registration
- After changing MCP configuration or hook shared libraries
- When CI reports plugin loading errors
- When user asks "validate the plugin", "run QA checks", or "is the plugin healthy?"

## Workflow

### Pass 1: Structure Validation

Validate that the plugin is structurally sound with valid manifests and consistent cross-references.

#### 1a. JSON Manifest Validation

Parse each manifest and verify required fields:

| File                              | Required Fields                  |
| --------------------------------- | -------------------------------- |
| `.claude-plugin/plugin.json`      | `name`, `version`, `description` |
| `.cursor-plugin/plugin.json`      | `name`, `version`, `description` |
| `.claude-plugin/marketplace.json` | Valid JSON                       |
| `package.json`                    | `name`, `version`                |

```bash
node -e "const m = require('./.claude-plugin/plugin.json'); console.log(JSON.stringify(m, null, 2))"
node -e "const m = require('./.cursor-plugin/plugin.json'); console.log(JSON.stringify(m, null, 2))"
node -e "const m = require('./.claude-plugin/marketplace.json'); console.log(JSON.stringify(m, null, 2))"
node -e "const m = require('./package.json'); console.log(m.name, m.version)"
```

#### 1b. Version Sync

Compare version across all manifests — all must match exactly:

| File                         | Field     |
| ---------------------------- | --------- |
| `.claude-plugin/plugin.json` | `version` |
| `.cursor-plugin/plugin.json` | `version` |
| `package.json`               | `version` |

#### 1c. Hook Registration Cross-Reference

Read `hooks/hooks.json` and verify every referenced script exists on disk. Also check `.claude/settings.json` for any additional hook registrations.

#### 1d. Orphan Detection

- List `.cjs` files in `hooks/` not referenced in `hooks/hooks.json`
- List `.md` files in `agents/` not referenced anywhere (informational)

---

### Pass 2: Agent & Skill Linting

Validate all agent and skill definition files for correctness and consistency.

#### 2a. Agent Frontmatter Validation

For every `.md` file in `agents/`, parse YAML frontmatter and check:

| Field             | Required | Valid Values              |
| ----------------- | -------- | ------------------------- |
| `name`            | Yes      | Non-empty, kebab-case     |
| `description`     | Yes      | Non-empty string          |
| `model`           | No       | `haiku`, `sonnet`, `opus` |
| `whenToUse`       | No       | Non-empty string          |
| `allowedTools`    | No       | Array of strings          |
| `disallowedTools` | No       | Array of strings          |

#### 2b. Name-Filename Consistency

Verify `name` field matches the filename stem exactly:

```
agents/plugin-qa.md  ->  name: plugin-qa     OK
agents/hook-expert.md -> name: hook_expert    MISMATCH (ERROR)
```

#### 2c. Duplicate Detection

No two agent files may share the same `name` value.

#### 2d. MCP Tool Reference Validation

If `allowedTools` or `disallowedTools` are specified, verify tool names follow known patterns:

| Pattern                             | Example                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| `mcp__gutt-mcp-remote__*`           | `mcp__gutt-mcp-remote__add_memory`                      |
| `mcp__claude_ai_gutt-pro-memory__*` | `mcp__claude_ai_gutt-pro-memory__search_memory_nodes`   |
| Built-in tools                      | `Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob`, `Task` |

Flag any tool name that does not match a known pattern.

#### 2e. Markdown Structure Check

Each agent file should have at minimum:

- A top-level heading (`# Agent Name`)
- A description paragraph
- A `## Trigger` or `## When to Use` section
- A `## Workflow` section with concrete steps

Warn (do not fail) if sections are missing.

#### 2f. Skill Directory Validation

For every subdirectory in `skills/`:

- Verify `SKILL.md` exists
- Parse frontmatter: `name` and `description` required
- Check skill name matches directory name

#### 2g. Severity Classification

| Severity | Meaning                                                             |
| -------- | ------------------------------------------------------------------- |
| ERROR    | Missing required field, invalid YAML, duplicate name, name mismatch |
| WARNING  | Missing sections, unknown tool reference                            |
| INFO     | Optional field missing, no model specified                          |

---

### Pass 3: Hook Testing

Simulate hook lifecycle events to verify hooks execute correctly.

#### 3a. Identify All Registered Hooks

Read `hooks/hooks.json` and catalog every hook by lifecycle event.

#### 3b. Construct Test Payloads

Build representative JSON payloads for each lifecycle event:

| Event           | Key Payload Fields                                     |
| --------------- | ------------------------------------------------------ |
| `SessionStart`  | `session_id`, `cwd`                                    |
| `PreToolUse`    | `session_id`, `tool_name`, `tool_input`                |
| `PostToolUse`   | `session_id`, `tool_name`, `tool_input`, `tool_result` |
| `SubagentStart` | `session_id`, `agent_type`, `agent_prompt`             |
| `Stop`          | `session_id`, `stop_hook_output`                       |

#### 3c. Execute Each Hook

Pipe payload via stdin and capture output:

```bash
echo '{"session_id":"qa-001","tool_name":"Task","tool_input":{"prompt":"test"}}' | node hooks/pre-task-memory.cjs
```

#### 3d. Verify Output & Exit Code

| Hook Type               | Expected                                            |
| ----------------------- | --------------------------------------------------- |
| PreToolUse (blocking)   | JSON with `decision` field, exit 0 or non-zero      |
| PreToolUse (enrichment) | JSON with `additionalContext` or plain text, exit 0 |
| PostToolUse             | `followup_message` or empty, exit 0                 |
| Stop                    | Summary or empty, exit 0                            |
| statusLine              | Single-line string, exit 0                          |
| SessionStart            | Setup messages or empty, exit 0                     |

#### 3e. Verify State Changes

Check `.claude/hooks/.state/` for expected state mutations:

- State files created/updated as expected
- JSON state files are valid JSON
- Timestamps are recent
- No stale `.tmp` files (failed atomic writes)

#### 3f. Run Test Suite

```bash
node tests/test-all-hooks.cjs
```

---

### Pass 4: IDE Compatibility

Verify the plugin works correctly in both Claude Code and Cursor.

#### 4a. Manifest Parity

Compare `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json`:

- Both valid JSON
- `name`, `version`, `description` match
- Version matches `package.json`

#### 4b. Hook Event Support

Cursor only supports these lifecycle events:

- `stop`
- `afterFileEdit`

Verify `.cursor-plugin/hooks.json` only registers hooks for supported events. Flag any unsupported events (`SessionStart`, `PreToolUse`, `SubagentStart`, etc.).

#### 4c. IDE Detection Logic

Review `hooks/lib/env.cjs` and verify:

- `IDE` export correctly detects `"claude"` vs `"cursor"`
- `PLUGIN_ROOT` resolves correctly for both IDEs
- `PROJECT_STATE_DIR` uses IDE-appropriate state directory

Test detection:

```bash
CLAUDE_PLUGIN_ROOT="/test" node -e "const e=require('./hooks/lib/env.cjs');console.log('IDE:',e.IDE,'ROOT:',e.PLUGIN_ROOT)"
```

#### 4d. Conditional Code Paths

Search for IDE-conditional behavior in hooks:

```bash
grep -rn "supportsDecisionBlock\|IDE.*===\|isCursor" hooks/*.cjs hooks/lib/*.cjs
```

Verify:

- `supportsDecisionBlock()` returns `true` for Claude Code, `false` for Cursor
- Cursor fallbacks use `followup_message` instead of `decision: "block"`
- No hardcoded `.claude/` paths (should use `env.cjs` exports)

#### 4e. Cross-Platform Execution

- `path.join()` used for all file paths (no string concatenation)
- Atomic writes use temp+delete+rename pattern (Windows compatibility)
- No Unix-only shell commands without fallback

---

### Pass 5: MCP Integration

Test MCP server connectivity, tool availability, and memory operations.

#### 5a. Configuration Check

Read MCP configuration from `.claude/settings.json` and verify:

- MCP server URL is configured (gutt-pro-memory or gutt-mcp-remote)
- Authentication method is present
- No hardcoded `group_id`

#### 5b. MCP URL Extraction

Test that `hooks/lib/mcp-config.cjs` can extract the server URL:

```bash
node -e "const c=require('./hooks/lib/mcp-config.cjs');console.log('configured:',c.isGuttMcpConfigured());if(c.getGuttMcpUrl)console.log('url:',c.getGuttMcpUrl())"
```

#### 5c. Tool Availability

Verify referenced MCP tools exist by testing connectivity:

```
search_memory_nodes(query="connectivity test", max_nodes=1)
```

If successful (even with 0 results), connectivity is confirmed.

#### 5d. Tool Reference Audit

Cross-reference all MCP tool names used in hooks and agents against actual available tools:

```bash
grep -rn "mcp__gutt-mcp-remote__\|mcp__claude_ai_gutt-pro-memory__" agents/*.md skills/*/SKILL.md hooks/*.cjs hooks/lib/*.cjs
```

#### 5e. End-to-End Smoke Test

Run a memory round-trip if connectivity is available:

1. `add_memory` — store a test entry
2. `search_memory_nodes` — verify it appears
3. `fetch_lessons_learned` — general connectivity check

#### 5f. Parameter Schema Validation

Verify critical tools accept expected parameters:

| Tool                    | Required Params                  |
| ----------------------- | -------------------------------- |
| `add_memory`            | `name`, `episode_body`, `source` |
| `search_memory_nodes`   | `query`                          |
| `fetch_lessons_learned` | `query`                          |

---

## Memory Integration

### Before Work

```python
# Fetch past QA findings to compare against
mcp__claude_ai_gutt-pro-memory__search_memory_nodes(query="plugin QA validation report", max_nodes=5)

# Fetch lessons from previous QA runs
mcp__claude_ai_gutt-pro-memory__fetch_lessons_learned(query="plugin QA hook validation", max_results=5)
```

### After Work

```python
# Store QA report summary
mcp__claude_ai_gutt-pro-memory__add_memory(
    name="Plugin QA Report: [date]",
    episode_body="QA run completed. Structure: [PASS/FAIL]. Agent linting: [PASS/FAIL] ([N] errors, [M] warnings). Hook testing: [PASS/FAIL]. IDE compatibility: [PASS/FAIL]. MCP integration: [PASS/FAIL]. Overall: [PASS/FAIL] with [N] issues.",
    source="text",
    source_description="plugin QA validation"
)
```

## Output Format

```markdown
## Plugin QA Report

### Pass 1: Structure Validation

- [ ] All manifests valid JSON with required fields
- [ ] Versions in sync: [version]
- [ ] All hook scripts referenced in hooks.json exist
- [ ] All settings.json hook scripts exist
- [ ] Orphan hooks: [list or "none"]
      **Verdict:** PASS / FAIL

### Pass 2: Agent & Skill Linting

- Files scanned: [N] agents, [N] skills
- Errors: [N]
- Warnings: [N]
- [ ] All frontmatter valid
- [ ] Names match filenames
- [ ] No duplicate names
- [ ] MCP tool references valid
- [ ] Skill directories complete
      **Verdict:** PASS / FAIL

### Pass 3: Hook Testing

- Hooks tested: [N]
- [ ] All hooks exit 0
- [ ] Output formats match expected schemas
- [ ] State files written correctly
- [ ] Test suite passes
      **Verdict:** PASS / FAIL

### Pass 4: IDE Compatibility

- [ ] Manifest parity confirmed
- [ ] Cursor hooks use only supported events
- [ ] IDE detection works for both environments
- [ ] No hardcoded .claude/ paths in hooks
- [ ] Cross-platform path handling correct
      **Verdict:** PASS / FAIL

### Pass 5: MCP Integration

- [ ] MCP server configured
- [ ] URL extraction works
- [ ] Server reachable
- [ ] All referenced tools available
- [ ] Smoke test passed
      **Verdict:** PASS / FAIL

---

### Overall Verdict: PASS / FAIL ([N] issues)
```

## Example Invocation

```
Task(
    subagent_type="plugin-qa",
    model="sonnet",
    prompt="Run a full QA check on the plugin. Validate structure, lint agents, test hooks, check IDE compatibility, and verify MCP integration. Give me a unified report with pass/fail for each category."
)
```
