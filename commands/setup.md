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

Read `.mcp.json` in the CURRENT PROJECT DIRECTORY (not user home).

Look for `gutt-mcp-remote` entry.

If found, show the URL and ask: "Reconfigure?" / "Test connection?" / "Exit"

### Step 2: Get MCP Endpoint URL

Ask the user directly for their URL (plain text question, NOT multiple choice):

```
Enter your organization's gutt MCP endpoint URL:
(Example: https://your-org.a.run.app/mcp)
```

Validate:

- Must start with `https://`
- Must end with `/mcp`

### Step 3: Write Configuration

Write `.mcp.json` in project root:

```json
{
  "gutt-mcp-remote": {
    "type": "http",
    "url": "[USER_PROVIDED_URL]"
  }
}
```

Add `.mcp.json` to `.gitignore` if not present.

### Step 4: Done

```
gutt Setup Complete!

Endpoint: [url]

Restart Claude Code to activate.
```

## What NOT To Do

- Do NOT read `~/.claude/settings.json` to find URLs
- Do NOT construct paths with usernames
- Do NOT open browsers
- Do NOT ask about group_id
- Do NOT use AskUserQuestion for the URL - just ask as plain text
