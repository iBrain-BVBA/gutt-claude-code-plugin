---
description: "Initialize gutt memory integration - configure MCP server connection"
---

# gutt Setup Wizard

Configure gutt MCP server connection. The MCP server handles authentication (OAuth) and authorization automatically.

## Step 1: Check Existing Configuration

Read `.mcp.json` in project root. Look for `gutt-mcp-remote` entry.

If already configured:

- Show current endpoint URL
- Ask: "Reconfigure?" / "Test connection?" / "Exit"

## Step 2: Get MCP Endpoint URL

**Ask for text input directly** (no multiple choice):

```
Enter your organization's gutt MCP endpoint URL:
(Example: https://your-org.a.run.app/mcp)
```

**Validation:**

- Must start with `https://`
- Must end with `/mcp`
- If invalid, show error and ask again

## Step 3: Detect Existing Statusline (Optional)

Read `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`).

If `statusLine.command` exists:

- Ask: "Chain with existing?" (Recommended) / "Replace?"
- If chain: Store in `config.json` → `gutt.statusline.passthroughCommand`

## Step 4: Write Configuration

Create `.mcp.json` in project root:

```json
{
  "gutt-mcp-remote": {
    "type": "http",
    "url": "[USER_PROVIDED_URL]"
  }
}
```

If chaining statusline, create `config.json`:

```json
{
  "gutt": {
    "statusline": {
      "passthroughCommand": "[EXISTING_COMMAND]"
    }
  }
}
```

Add `.mcp.json` to `.gitignore` if not already present.

## Step 5: Test Connection

Call `mcp__gutt-mcp-remote__search_memory_nodes` with query "connection test".

**IMPORTANT: DO NOT manually open browser or construct auth URLs!**
The MCP transport layer handles OAuth automatically. Just call the tool.

- Success: Show "Connected!"
- Auth needed: The MCP server response will contain the auth URL. Show that URL to the user and say "Please open this URL in your browser to authenticate, then say 'retry'."
- Other failure: Show error message from MCP response

## Step 6: Success

```
gutt Setup Complete!

Endpoint: [endpoint]
Auth: Handled automatically by MCP server

Restart Claude Code to activate hooks and statusline.

Available commands:
  /gutt-claude-code-plugin:memory-retrieval - Search memory
  /gutt-claude-code-plugin:memory-capture - Capture lessons
```

## Error Handling

### Invalid URL

```
Invalid endpoint URL.

Requirements:
- Must start with https://
- Must end with /mcp

Example: https://your-org.a.run.app/mcp
```

### Connection Failed

```
Could not connect to gutt MCP server.

Please check:
1. Endpoint URL is correct
2. Network can reach the endpoint
3. MCP server is running

Contact your organization admin if the problem persists.
```
