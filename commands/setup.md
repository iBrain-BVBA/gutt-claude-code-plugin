---
description: "Initialize gutt memory integration - configure MCP server connection"
---

# gutt Setup Wizard

Configure gutt MCP server connection for Claude Code or Cursor.

## CRITICAL RULES - READ FIRST

**YOU MUST FOLLOW THESE RULES:**

1. **NO HARDCODED PATHS** - Never use paths like `C:\Users\username`. Always use:
   - Windows: `%USERPROFILE%` or `$env:USERPROFILE` (PowerShell)
   - Unix: `$HOME`

2. **NO MANUAL BROWSER OPENING** - NEVER run Bash commands like:
   - `start "" "https://..."`
   - `open https://...`
   - `xdg-open https://...`

3. **NO CONSTRUCTED AUTH URLs** - NEVER construct URLs like `https://domain/auth/login`. The MCP server returns auth URLs in its response if needed.

4. **NO GROUP_ID QUESTION** - The MCP server handles authorization automatically.

## IDE Detection

Before starting, detect which IDE is running:

- If environment variable `CLAUDE_PLUGIN_ROOT` or `CLAUDE_PROJECT_DIR` is set → **Claude Code**
- If environment variable `CURSOR_PLUGIN_ROOT` or `CURSOR_PROJECT_DIR` is set → **Cursor**
- If neither is set → default to **Claude Code** (backward compatible)

## Setup Flow

### Step 1: Check Existing Configuration

Check if `gutt-mcp-remote` is already configured by attempting to list MCP resources.

If found, show the configured endpoint and ask: "Reconfigure?" / "Test connection?" / "Exit"

### Step 2: Get MCP Endpoint URL

Ask the user directly for their URL (plain text question, NOT multiple choice):

```
Enter your organization's gutt MCP endpoint URL:
(Example: https://your-org.a.run.app/mcp)
```

Validate:

- Must start with `https://`
- Must end with `/mcp`

### Step 3: Add MCP Server (IDE-specific)

#### Claude Code

Run the `claude mcp add` command:

```bash
claude mcp add gutt-mcp-remote --transport http --scope user "[USER_PROVIDED_URL]"
```

This registers the MCP server in Claude Code's user settings.

#### Cursor

Cursor has **no `mcp add` CLI command**. Register the MCP server by editing the Cursor MCP config file directly:

1. Read `~/.cursor/mcp.json` (create with `{"mcpServers":{}}` if it doesn't exist)
2. Add or update the `gutt-mcp-remote` entry:

```json
{
  "mcpServers": {
    "gutt-mcp-remote": {
      "url": "[USER_PROVIDED_URL]"
    }
  }
}
```

3. Write the updated JSON back to `~/.cursor/mcp.json`
4. Preserve any existing MCP server entries — only add/update `gutt-mcp-remote`

Use `$HOME/.cursor/mcp.json` on Unix or `%USERPROFILE%\.cursor\mcp.json` on Windows.

### Step 4: Done - Next Steps

#### Claude Code

Show the user:

```
gutt MCP Server Added!

Endpoint: [url]

NEXT STEPS:
1. Restart Claude Code (Ctrl+C, then run `claude` again)
2. After restart, run `/mcp`
3. Select `gutt-mcp-remote`
4. Choose "Authenticate" to complete OAuth login

After authentication, memory features will be active.
```

#### Cursor

Show the user:

```
gutt MCP Server Added!

Endpoint: [url]

NEXT STEPS:
1. Restart Cursor
2. Go to Settings → Tools & MCP Servers
3. Find `gutt-mcp-remote` and click "Connect"
4. Complete OAuth login in the browser

After authentication, memory features will be active.
```

## What NOT To Do

- Do NOT read `~/.claude/settings.json` to find URLs
- Do NOT construct paths with usernames
- Do NOT open browsers manually (OAuth popup opens automatically)
- Do NOT ask about group_id
- Do NOT use AskUserQuestion for the URL - just ask as plain text
- In Claude Code: Do NOT write `.mcp.json` files - use `claude mcp add` instead
- In Cursor: Do NOT use `claude mcp add` - edit `~/.cursor/mcp.json` directly
