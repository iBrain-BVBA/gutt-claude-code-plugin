---
name: health
description: "Show plugin health status — MCP connectivity, hook registration, memory stats, agent count. Use for quick diagnostics."
---

# Plugin Health Dashboard

Run a quick diagnostic of the gutt-pro plugin and display a status report.

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

Read `hooks/hooks.json` from the plugin root. For each hook event present, list:

- Event name
- Number of registered hook commands
- Matcher patterns (if any)

Also check if `statusLine` is registered.

### 3. Check the statusline is actually ours

A `statusLine` entry in the user's own `~/.claude/settings.json` takes precedence
over the plugin's. The retired 2.x `sessionstart-setup.cjs` wrote one there and
nothing removes it, so an upgraded user can be running a stale statusline while
the plugin's own is registered and ignored. If `~/.claude/settings.json` has a
`statusLine` pointing at a gutt path, report it as **stale — remove it to use
the plugin's**.

### 4. Count Agents

List the `agents/` directory in the plugin root. Count `.md` files (excluding any starting with `_`).

### 5. Format Report

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
  StatusLine:        [registered / not registered]
  User-level override: [none / STALE — ~/.claude/settings.json wins]

Session
  Connection:        [status]
  Session started:   [timestamp]

Agents
  Total agent definitions: [N]

═══════════════════════════════════════════
```
