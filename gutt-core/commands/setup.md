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

- If environment variable `CURSOR_PROJECT_DIR` or `CURSOR_VERSION` is set → **Cursor**
- Otherwise → **Claude Code** (also the backward-compatible default when nothing is set)

`CURSOR_PLUGIN_ROOT` is not a Cursor variable and must not be treated as a signal;
`CLAUDE_PLUGIN_ROOT` is set by Claude Code but says nothing on its own, since Cursor
leaves it unset rather than contradicting it.

## Setup Flow

### Step 1: Check Existing Configuration

#### Claude Code

The plugin ships two servers itself (`gutt-core/.mcp.json`): `gutt-closed-beta`, fixed at the
gutt shared stage server `https://mcp.stage.gutt.pro/mcp`, and `gutt-enterprise`, whose URL is
the plugin option `mcp_url`, which defaults to that same stage server. So the servers are
normally present; the question is which endpoint `gutt-enterprise` points at. Read it, do not
assume it:

1. Run `claude plugin configure gutt-pro@gutt-plugins --json`. If it lists a value for
   `mcp_url`, that is the plugin's endpoint; if it lists `mcp_url` as unset, the plugin uses
   the stage default above.
2. Run `claude mcp list` and look for every server whose name contains `gutt` (other than the
   plugin's own, which the list attributes to the gutt-pro plugin). For each, `claude mcp get <name>` shows
   its URL and scope. These are leftovers from an earlier setup and run alongside the plugin's
   server.

If neither command gives an endpoint, say the endpoint could not be determined; do not show
the stage default as the configured one.

#### Cursor

Read `~/.cursor/mcp.json` and look for a `gutt-enterprise` entry, or a `gutt-mcp-remote` one
that an earlier setup wrote.

If an endpoint is found, show it and ask: "Reconfigure?" / "Test connection?" / "Exit"

### Step 2: Get MCP Endpoint URL

Ask the user directly for their URL (plain text question, NOT multiple choice):

```
Enter your organization's gutt MCP endpoint URL:
(Example: https://your-org.a.run.app/mcp)
```

Validate:

- Must start with `https://`
- Must end with `/mcp`

### Step 3: Set the Endpoint (IDE-specific)

#### Claude Code

Set the plugin's `mcp_url` option, which is `gutt-enterprise`'s URL. Do not add another server
with `claude mcp add`: a user-scope server at a different URL runs alongside the plugin's, and
memory tools from yet another endpoint are then live. `gutt-closed-beta` stays on the shared
stage server beside `gutt-enterprise`; if the user wants only their organization's memory, tell
them to disable `gutt-closed-beta` in `/mcp`.

Tell the user to run `/plugin`, open **gutt-pro**, choose **Configure**, and enter the URL. From
a shell, set it on the installed plugin:

```bash
echo '{"mcp_url":"[USER_PROVIDED_URL]"}' | claude plugin configure gutt-pro@gutt-plugins --values-stdin
```

or when installing for the first time:

```bash
claude plugin install gutt-pro@gutt-plugins --config mcp_url="[USER_PROVIDED_URL]"
```

Then verify it was saved: run `claude plugin configure gutt-pro@gutt-plugins --json` and
confirm `mcp_url` equals the URL the user gave. If the command fails (for example the plugin
is installed under a different marketplace id; `claude plugin list` shows the id) or the value
differs, show the error and the manual `/plugin` → gutt-pro → Configure path, and stop: do
not show the Step 4 message.

An earlier setup may have registered a gutt server with `claude mcp add`, which stores it in
`~/.claude.json`, usually as `gutt-mcp-remote` but possibly under another name containing
`gutt`. Remove every one Step 1 found, using the name and scope `claude mcp get` shows, so
only the plugin's server is left:

```bash
claude mcp remove gutt-mcp-remote --scope user
```

After the restart in Step 4, `/gutt-pro:health` reports any registration still running next
to the plugin's server.

#### Cursor

Cursor has **no `mcp add` CLI command**. Register the MCP server by editing the Cursor MCP config file directly:

1. Read `~/.cursor/mcp.json` (create with `{"mcpServers":{}}` if it doesn't exist)
2. Add or update the `gutt-enterprise` entry. If an earlier setup left a `gutt-mcp-remote`
   entry, replace it with `gutt-enterprise` rather than keeping both:

```json
{
  "mcpServers": {
    "gutt-enterprise": {
      "url": "[USER_PROVIDED_URL]"
    }
  }
}
```

3. Write the updated JSON back to `~/.cursor/mcp.json`
4. Preserve any other MCP server entries — only add/update `gutt-enterprise` (and remove a
   `gutt-mcp-remote` entry it replaces)

Use `$HOME/.cursor/mcp.json` on Unix or `%USERPROFILE%\.cursor\mcp.json` on Windows.

### Step 4: Done - Next Steps

#### Claude Code

Show the user:

```
gutt endpoint set!

Endpoint: [url]

NEXT STEPS:
1. Restart Claude Code (Ctrl+C, then run `claude` again)
2. After restart, run `/mcp`
3. Select `gutt-enterprise`
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
3. Find `gutt-enterprise` and click "Connect"
4. Complete OAuth login in the browser

After authentication, memory features will be active.
```

## What NOT To Do

- Do NOT read `~/.claude/settings.json` to find URLs
- Do NOT construct paths with usernames
- Do NOT open browsers manually (OAuth popup opens automatically)
- Do NOT ask about group_id
- Do NOT use AskUserQuestion for the URL - just ask as plain text
- In Claude Code: Do NOT write `.mcp.json` files or run `claude mcp add` - set the plugin's `mcp_url` option instead
- In Cursor: Do NOT use `claude mcp add` - edit `~/.cursor/mcp.json` directly
