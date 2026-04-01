---
name: health
description: "Show plugin health status — MCP connectivity, hook registration, memory stats, agent count. Use for quick diagnostics."
---

# Plugin Health Dashboard

Run a quick diagnostic of the gutt-claude-code-plugin and display a status report.

## Steps

### 1. Check MCP Connectivity

Use the `diagnoseGuttMcp()` function from `hooks/lib/mcp-config.cjs`:

```javascript
const { diagnoseGuttMcp } = require("./hooks/lib/mcp-config.cjs");
const diag = diagnoseGuttMcp();
```

Report:

- **configured**: whether gutt MCP server is found in settings
- **url**: the resolved HTTP URL (or "N/A — stdio transport")
- **error**: any configuration error message

### 2. List Registered Hooks

Read `hooks/hooks.json` from the plugin root. For each hook event (SessionStart, UserPromptSubmit, Stop, PostToolUse, PreToolUse, SubagentStart, SubagentStop), list:

- Event name
- Number of registered hook commands
- Matcher patterns (if any)

Also check if `statusLine` is registered.

### 3. Check Seed Registry

Read the seed registry cache file at `<project>/.claude/hooks/.state/gutt-seed-registry.json` (or `.cursor/hooks/.state/` for Cursor).

Report:

- **Agents cached**: number of agents in the registry
- **Cache age**: how old the cache is (or "stale" / "missing")
- **Scan paths**: which directories are scanned for agent seeds

### 4. Show Session Metrics

Read session state from `hooks/lib/session-state.cjs`:

```javascript
const { getState } = require("./hooks/lib/session-state.cjs");
const state = getState();
```

Report:

- **memoryQueries**: number of memory searches this session
- **lessonsCaptured**: number of lessons stored this session
- **significantOps**: number of significant operations tracked
- **connectionStatus**: current connection status
- **Session started**: timestamp

### 5. Count Agents

List the `agents/` directory in the plugin root. Count `.md` files (excluding any starting with `_`).

### 6. Format Report

Output a clean status report:

```
═══════════════════════════════════════════
  gutt Plugin Health Dashboard
═══════════════════════════════════════════

MCP Connectivity
  Status:     [configured / not configured]
  URL:        [url or N/A]
  Error:      [error or none]

Registered Hooks
  SessionStart:      [N] hook(s)
  UserPromptSubmit:  [N] hook(s)
  Stop:              [N] hook(s)
  PostToolUse:       [N] hook(s) across [M] matcher(s)
  PreToolUse:        [N] hook(s) across [M] matcher(s)
  SubagentStart:     [N] hook(s)
  SubagentStop:      [N] hook(s)
  StatusLine:        [registered / not registered]

Seed Registry
  Agents cached:  [N]
  Cache status:   [fresh (Xm old) / stale / missing]

Session Metrics
  Memory queries:    [N]
  Lessons captured:  [N]
  Significant ops:   [N]
  Connection:        [status]
  Session started:   [timestamp]

Agents
  Total agent definitions: [N]

═══════════════════════════════════════════
```
