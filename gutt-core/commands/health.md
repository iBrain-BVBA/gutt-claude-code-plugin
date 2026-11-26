---
name: health
description: "Show plugin health status — MCP connectivity, hook registration, memory stats, and component counts. Use for quick diagnostics."
---

# Plugin Health Dashboard

Run a quick diagnostic of the gutt-pro plugin and display a status report.

## Steps

### 1. Check MCP Connectivity

The plugin option `mcp_url` is exported to hooks, but the Bash tool may not see it, and
without it the diagnostic compares every registration against the manifest default (the
gutt shared stage server). So read the saved value first, whatever the diagnostic would
report as its source:

```bash
claude plugin configure gutt-pro@gutt-plugins --json
```

If that lists a value for `mcp_url`, pass it to the diagnostic as
`CLAUDE_PLUGIN_OPTION_MCP_URL`, the variable Claude Code gives hooks. Then run
`diagnoseGuttMcp()` from the plugin's `hooks/lib/mcp-config.cjs`, by absolute path
(leave the variable out when no value is saved):

```bash
CLAUDE_PLUGIN_OPTION_MCP_URL='<saved mcp_url>' \
  node -e 'console.log(JSON.stringify(require(process.argv[1]).diagnoseGuttMcp(), null, 2))' \
  "${CLAUDE_PLUGIN_ROOT}/hooks/lib/mcp-config.cjs"
```

`${CLAUDE_PLUGIN_ROOT}` is this plugin's root, the directory that holds this command's
`commands/` folder; if the shell leaves it empty, use that directory's absolute path. The
module finds its own plugin root, so it does not need `CLAUDE_PLUGIN_ROOT` exported.

Report:

- **configured**: whether gutt MCP server is found in settings
- **url**: the resolved HTTP URL (or "N/A — stdio transport")
- **source**: where the URL came from: a config file path, `plugin-option`
  (`gutt-enterprise`, from the saved `mcp_url`), `plugin-fixed` (`gutt-closed-beta`'s stage
  URL; no `mcp_url` is saved, so `gutt-enterprise` has no URL), or `plugin-default` (the
  manifest default of `mcp_url`, which today ships none).
- **error**: any configuration error message
- **warning**: set when a gutt server registered outside the plugin (for example by an
  older `claude mcp add --scope user`) points at a different URL than the plugin's own
  server, so both run, or when a config file could not be read. Show the warning as
  given, since it names the command that fixes it.

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

### 4. Count Components

List the `agents/` directory in the plugin root and count `.md` files (excluding any
starting with `_`). List `skills/` and count immediate subdirectories containing a
`SKILL.md`.

### 5. Format Report

Output a clean status report:

```
═══════════════════════════════════════════
  gutt Plugin Health Dashboard
═══════════════════════════════════════════

MCP Connectivity
  Status:     [configured / not configured]
  URL:        [url or N/A]
  Source:     [source]
  Error:      [error or none]
  Warning:    [warning or none]

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

Components
  Total skill definitions: [N]
  Total agent definitions: [N]

═══════════════════════════════════════════
```
