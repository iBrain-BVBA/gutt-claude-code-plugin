---
description: "Initialize gutt memory integration - configure MCP server connection"
---

# gutt Setup Wizard

Configure gutt MCP server connection.

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

### Step 3: Add MCP Server

Run the `claude mcp add` command:

```bash
claude mcp add gutt-mcp-remote --transport http --scope user "[USER_PROVIDED_URL]"
```

This registers the MCP server in Claude Code's user settings.

### Step 4: Done - Next Steps

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

## What NOT To Do

- Do NOT read `~/.claude/settings.json` to find URLs
- Do NOT construct paths with usernames
- Do NOT open browsers manually (OAuth popup opens automatically)
- Do NOT ask about group_id
- Do NOT use AskUserQuestion for the URL - just ask as plain text
- Do NOT write `.mcp.json` files - use `claude mcp add` instead
