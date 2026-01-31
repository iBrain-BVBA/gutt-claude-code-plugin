# GUTT Setup Command

Setup wizard for configuring the GUTT MCP server connection.

## Trigger

- `/gutt-setup` or `/setup-gutt`
- First-run detection (no .mcp.json with gutt-pro-memory)

## Setup Flow

### Step 1: Check Existing Configuration

```bash
# Check if GUTT MCP is already configured
if [ -f ".mcp.json" ]; then
  grep -q "gutt-pro-memory" .mcp.json && echo "GUTT already configured"
fi
```

### Step 2: Get Configuration from Admin

Ask user:

```
GUTT MCP Server Setup

To configure GUTT memory, you need:
- Your organization's MCP server URL (HTTP endpoint)

Contact your organization admin to get this URL.

Do you have the endpoint URL?
1. Yes, I have it
2. No, I need to contact my admin
3. Skip for now (manual setup later)
```

### Step 3: Enter Endpoint

1. **Get Endpoint URL**

   ```
   Enter your GUTT MCP endpoint URL:
   (Example: https://your-org-mcp-server.a.run.app/mcp)
   ```

2. **Validate Connection**
   Test the connection works:
   ```javascript
   // Call a simple MCP tool to verify
   mcp__gutt_pro_memory__search_memory_nodes({
     query: "test connection",
     max_nodes: 1,
   });
   ```

### Step 4: Configure MCP

Create or update `.mcp.json`:

```json
{
  "gutt-pro-memory": {
    "type": "http",
    "url": "[user-provided-endpoint]"
  }
}
```

### Step 5: Verify Setup

Run verification:

```
Verifying GUTT connection...
✓ MCP server responding
✓ Memory graph accessible

Setup complete! GUTT memory is now available.
```

### Step 6: Next Steps

```
GUTT Setup Complete!

You can now use:
- /memory-retrieval - Search organizational memory
- /memory-capture - Capture lessons and decisions

The UserPromptSubmit hook will remind you to check memory before tasks.
The Stop hook will prompt you to capture learnings after significant work.
```

## Error Handling

### Network Error

```
Could not connect to GUTT servers.

Please check:
1. Internet connection
2. Firewall settings (allow your GUTT endpoint)
3. VPN configuration
4. Endpoint URL is correct

Retry? (yes/no)
```

### MCP Server Error

```
MCP server connection failed.

Please check:
1. Endpoint URL is correct
2. MCP server is running
3. Network can reach the endpoint

Contact your organization admin to verify the server status.
```

## Manual Configuration

For users who skip the wizard:

1. Create `.mcp.json` in project root
2. Add gutt-pro-memory configuration
3. Restart Claude Code

```json
{
  "gutt-pro-memory": {
    "type": "http",
    "url": "https://your-org-mcp-server.a.run.app/mcp"
  }
}
```

## Security Notes

- `.mcp.json` contains your server endpoint (add to .gitignore)
- Never commit `.mcp.json` to version control
- Use `.mcp.json.template` for sharing configuration structure
- Contact your admin for endpoint URL updates
