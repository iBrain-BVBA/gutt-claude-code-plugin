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

### 3. Check the statusline

The plugin manifest carries no `statusLine`, and must not — Claude Code accepts one
only from the user's own settings, so a key here would be inert. Look in
`~/.claude/settings.json` instead and report one of:

- **installed** — a `statusLine` whose command points at `statusline.cjs` under the
  plugin's data directory. This is the healthy state.
- **installed, but stale** — a `statusLine` pointing at `statusline.cjs` somewhere
  under a plugin _cache_ path. That is a version-scoped directory an upgrade
  replaces, so it will break. Tell them `/gutt-pro:statusline` repoints it at a
  stable path.
- **someone else's** — a `statusLine` pointing anywhere else. Leave it alone and say
  so; the gutt HUD cannot be installed without removing theirs first.
- **not installed** — no `statusLine` at all. Mention `/gutt-pro:statusline` if they
  want one; do not treat its absence as a fault.

If it is absent but the runtime config records that they installed it, say the key
was dropped from settings — Claude Code does that when it rewrites the file — and
that the next session restores it.

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

Statusline (user settings, not a hook)
  HUD:               [installed / stale / someone else's / not installed]

Session
  Connection:        [status]
  Session started:   [timestamp]

Agents
  Total agent definitions: [N]

═══════════════════════════════════════════
```
