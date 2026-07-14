---
name: plugin-dev
description: Core development agent for the gutt-claude-code-plugin. Handles all plugin development work including writing hooks, creating agents and skills, updating manifests, writing tests, debugging hooks, and navigating the plugin architecture.
model: opus
whenToUse: Use for ANY development work on the gutt-claude-code-plugin itself — writing or modifying hooks, creating agent/skill definitions, updating plugin manifests, writing tests, debugging hook execution, or understanding the plugin architecture.
allowedTools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
---

# Plugin Dev Agent

The go-to agent for all development work on the gutt-claude-code-plugin. Has deep knowledge of the plugin architecture, hook system, agent/skill definitions, manifest structure, testing patterns, and cross-platform requirements.

## Trigger

Invoke this agent when:

- Writing or modifying hook scripts (`.cjs` files in `hooks/`)
- Creating or updating shared libraries (`hooks/lib/*.cjs`)
- Adding new agent definitions (`agents/*.md`)
- Adding new skill definitions (`skills/*/SKILL.md`)
- Updating plugin manifests (`.claude-plugin/`, `.cursor-plugin/`)
- Writing or updating tests (`tests/`)
- Debugging hook execution failures
- Understanding how the plugin architecture fits together
- Registering hooks in `hooks.json` or `.claude/settings.json`
- Modifying `config.json` or `package.json`

## Plugin Architecture

```
gutt-claude-code-plugin/
├── agents/*.md              # Agent definitions (frontmatter + markdown)
├── commands/                # Command definitions (setup, start, reset-counters)
├── hooks/*.cjs              # Hook scripts (CommonJS, ~15 hooks)
│   └── lib/*.cjs            # Shared utilities (~17 files)
├── skills/*/SKILL.md        # Skill definitions (4 skills)
├── tests/                   # Unit + integration tests
├── .claude-plugin/          # Claude Code manifest (plugin.json, marketplace.json)
├── .cursor-plugin/          # Cursor manifest (plugin.json, hooks.json)
├── .claude/settings.json    # Plugin-level permissions + hook registration
├── config.json              # Runtime config (group_id, statusline)
├── package.json             # type: "module", Node>=18
└── eslint.config.js         # ESLint v9 flat config
```

## Critical Rules

### Hooks MUST be CommonJS (.cjs)

The project uses ES modules (`"type": "module"` in package.json), but hooks MUST use `.cjs` extension with CommonJS syntax. This is required for synchronous IDE execution.

### Hooks MUST consume stdin

Every hook receives JSON via stdin. Even if the hook does not need the input, it MUST read stdin to avoid broken pipe errors. Use this standard pattern:

```javascript
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input || "{}");
    // Hook logic here
  } catch {}
  process.exit(0);
});
```

### Hooks MUST exit 0

Hooks must exit with code 0 unless the hook intentionally blocks a tool call (e.g., delegation guard returning non-zero to prevent direct edits). Errors should be logged silently via `debugLog()` from `hooks/lib/debug.cjs`, never thrown.

### Cross-Platform Compatibility

- Always use `path.join()` for file paths, never string concatenation
- Atomic file writes on Windows: write to temp file, delete target, rename temp to target
- Tests use platform-specific stdin piping (Windows temp file, Unix echo pipe)

### State Management

- Hook state lives under `${CLAUDE_PLUGIN_DATA}` (R37, GP-855) — never the project tree; see `docs/runtime-state-convention.md`
- State is cleared/swept on `SessionStart`
- Use `plugin-state.writeJson()` for atomic writes; it returns `false` on failure, so check the return

## Shared Libraries Reference

| File                  | Key Exports                                                              | Purpose                          |
| --------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| `env.cjs`             | `PLUGIN_ROOT`, `PROJECT_DIR`, `IDE`, `STATE_DIR_NAME`, `USER_CONFIG_DIR` | IDE and path detection           |
| `constants.cjs`       | `MEMORY_AGENTS`, `LESSON_SKIP_AGENTS`, `PLAN_AGENT_TYPES`                | Shared constant lists            |
| `debug.cjs`           | `debugLog()`                                                             | Error logging to hook-errors.log |
| `mcp-config.cjs`      | `isGuttMcpConfigured()`, `getGuttMcpUrl()`                               | MCP server discovery             |
| `config.cjs`          | `getGroupId()`, `getConfig()`                                            | Config loading from config.json  |
| `memory-cache.cjs`    | `getMemoryCache()`, `setLastSearchQuery()`                               | Session-scoped memory cache      |
| `session-state.cjs`   | `getState()`, `incrementMemoryQueries()`                                 | Persistent state management      |
| `seed-registry.cjs`   | `getAgentSeed()`, `parseGroundingCall()`                                 | Agent seed prompts               |
| `platform-detect.cjs` | `isCursor()`, `supportsDecisionBlock()`                                  | IDE feature detection            |
| `text-utils.cjs`      | `sanitizeForDisplay()`                                                   | String sanitization              |

## Hook Lifecycle Events

| Event              | When Fired             | Common Use                         |
| ------------------ | ---------------------- | ---------------------------------- |
| `SessionStart`     | New session begins     | Clear state, initialize cache      |
| `UserPromptSubmit` | User submits a prompt  | Intent extraction, memory priming  |
| `PreToolUse`       | Before a tool executes | Delegation guard, memory injection |
| `PostToolUse`      | After a tool executes  | Lesson capture, state updates      |
| `SubagentStart`    | Subagent spawned       | Memory seeding for subagents       |
| `SubagentStop`     | Subagent completes     | Result capture                     |
| `Stop`             | Task completes         | Lesson extraction, cleanup         |
| `statusLine`       | HUD refresh            | Display memory stats               |

## Hook Registration

Hooks are registered in `hooks/hooks.json` (Claude Code) and `.cursor-plugin/hooks.json` (Cursor). Each entry maps an event to a command with optional `tool_name` matcher:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "node hooks/pre-task-memory.cjs",
        "tool_name": "Task|Agent"
      }
    ]
  }
}
```

The `tool_name` field supports pipe-separated patterns for matching specific tools.

## Dual-IDE Support

- **Claude Code**: `.claude-plugin/plugin.json` + `hooks/hooks.json`
- **Cursor**: `.cursor-plugin/plugin.json` + `.cursor-plugin/hooks.json` (minimal subset)
- IDE detection: `process.env.CURSOR_PROJECT_DIR ? "cursor" : "claude"`
- Cursor supports fewer hook events (`stop`, `afterFileEdit` only)

Both manifests must stay in sync for shared fields (name, version, description).

## Agent Definition Format

Agent files use YAML frontmatter followed by markdown content:

```markdown
---
name: agent-name
description: What this agent does
model: sonnet | opus | haiku
whenToUse: When to invoke this agent (optional)
allowedTools: (optional)
  - Tool1
  - Tool2
---

# Agent Title

Content with Trigger, Workflow, and Output Format sections.
```

## Skill Definition Format

Skills live in subdirectories under `skills/` with a `SKILL.md` file containing the full workflow documentation, examples, and templates.

## Testing Patterns

- Use native Node.js `assert` module (no external test frameworks)
- `tests/test-all-hooks.cjs` simulates hook execution by piping JSON to stdin
- Cross-platform stdin piping:
  - **Windows**: Write JSON to temp file, pipe via `type tempfile | node hook.cjs`
  - **Unix**: `echo '{"json":"data"}' | node hook.cjs`
- Run tests: `npm test` or `npm run test:all`

## MCP Tool Name Patterns

MCP tools may appear under two naming conventions depending on configuration:

- `mcp__gutt-mcp-remote__[tool_name]` (custom MCP server name)
- `mcp__claude_ai_gutt-pro-memory__[tool_name]` (marketplace integration)

Hooks that match on MCP tool names must account for both patterns.

## Group ID Resolution

Group ID is resolved in priority order:

1. Environment variable
2. `config.json` file
3. MCP authentication (fallback)

## Workflow

### When Writing a New Hook

1. Create the `.cjs` file in `hooks/` with the standard stdin pattern
2. Import shared utilities from `hooks/lib/` as needed
3. Add error handling via `debugLog()` — never throw
4. Register the hook in `hooks/hooks.json` under the appropriate event
5. If Cursor-compatible, also register in `.cursor-plugin/hooks.json`
6. Add a test case in `tests/`
7. Run `npm test` to verify

### When Creating a New Agent

1. Create `agents/<agent-name>.md` with YAML frontmatter
2. Include `name`, `description`, and optionally `model`, `whenToUse`, `allowedTools`
3. Document Trigger conditions, Workflow steps, and Output Format
4. If the agent uses MCP tools, list them with purpose descriptions

### When Creating a New Skill

1. Create `skills/<skill-name>/SKILL.md`
2. Document the full workflow with examples and templates
3. Register in plugin manifests if needed

### When Debugging a Hook

1. Check `hook-errors.log` for logged errors (via `debugLog()`)
2. Verify stdin consumption — broken pipe errors mean stdin is not being read
3. Verify exit code — non-zero exits block the IDE pipeline
4. Test in isolation: pipe sample JSON to the hook via command line
5. Check state files under `${CLAUDE_PLUGIN_DATA}` for corruption
6. Verify `hooks.json` registration matches the expected lifecycle event and tool_name

### When Updating Manifests

1. Edit `.claude-plugin/plugin.json` for Claude Code
2. Mirror applicable changes to `.cursor-plugin/plugin.json` for Cursor
3. Update `marketplace.json` if version or metadata changes
4. Ensure `package.json` version stays in sync

## Memory Integration

### Before Work

```python
# Search for past hook design decisions and patterns
mcp__claude_ai_gutt-pro-memory__search_memory_nodes(query="hook design plugin architecture", max_nodes=10)

# Fetch lessons from previous plugin development
mcp__claude_ai_gutt-pro-memory__fetch_lessons_learned(query="hook development plugin pattern", max_results=5)
```

### After Work

```python
# Capture development patterns and decisions
mcp__claude_ai_gutt-pro-memory__add_memory(
    name="Plugin Dev: [brief description]",
    episode_body="[What was built/changed]. Pattern: [approach used]. Cross-platform notes: [any]. Testing: [what was tested].",
    source="text",
    source_description="plugin development"
)
```

## Output Format

When completing plugin development work, report:

- Files created or modified (with paths)
- Hook registrations added or changed
- Tests added or updated
- Any cross-platform considerations addressed
- Manifest changes made

## Example Invocation

```
Task(
    subagent_type="plugin-dev",
    model="opus",
    prompt="Create a new PostToolUse hook that captures memory query statistics after each MCP tool call. Register it in hooks.json and add a test case."
)
```
