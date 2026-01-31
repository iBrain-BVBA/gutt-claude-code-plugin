# GUTT Setup Command

Setup wizard for configuring the GUTT MCP server connection.

## Trigger

- `/gutt-setup` or `/setup-gutt`
- First-run detection (no .mcp.json with gutt-mcp-remote)

## Setup Flow

### Step 1: Check Existing Configuration

```bash
# Check if GUTT MCP is already configured
if [ -f ".mcp.json" ]; then
  grep -q "gutt-mcp-remote" .mcp.json && echo "GUTT already configured"
fi
```

### Step 2: Get Configuration from Admin

Ask user:

```
GUTT MCP Server Setup

To configure GUTT memory, you need:
1. GUTT_ENDPOINT - Your organization's MCP server URL
2. GUTT_API_KEY - Your API key for authentication

Contact your organization admin to get these values.

Do you have these credentials?
1. Yes, I have them
2. No, I need to contact my admin
3. Skip for now (manual setup later)
```

### Step 3: Enter Credentials

1. **Get Endpoint URL**

   ```
   Enter your GUTT MCP endpoint URL:
   (Example: https://your-org-graphiti-mcp-server.a.run.app/mcp)
   ```

2. **Get API Key**

   ```
   Enter your GUTT API key:
   ```

3. **Validate Connection**
   Test the connection works:
   ```javascript
   // Call a simple MCP tool to verify
   mcp__gutt -
     mcp -
     remote__search_memory_nodes({
       query: "test connection",
       max_nodes: 1,
     });
   ```

### Step 4: Configure MCP

Create or update `.mcp.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/anthropics/claude-code/main/schemas/mcp.json",
  "mcpServers": {
    "gutt-mcp-remote": {
      "command": "npx",
      "args": ["-y", "@gutt/mcp-remote"],
      "env": {
        "GUTT_API_KEY": "[user-provided-key]",
        "GUTT_ENDPOINT": "[user-provided-endpoint]"
      }
    }
  }
}
```

### Step 5: Verify Setup

Run verification:

```
Verifying GUTT connection...
✓ API key valid
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

### Invalid API Key

```
API key validation failed.

Please check:
1. Key is copied correctly (no extra spaces)
2. Key hasn't expired
3. Key has correct permissions

Contact your organization admin for a new key.
```

### Network Error

```
Could not connect to GUTT servers.

Please check:
1. Internet connection
2. Firewall settings (allow your GUTT endpoint)
3. VPN configuration

Retry? (yes/no)
```

### MCP Server Error

```
MCP server failed to start.

Please check:
1. Node.js is installed (v18+)
2. npx is available
3. Network can reach npm registry

Try: npx -y @gutt/mcp-remote --version
```

## Manual Configuration

For users who skip the wizard:

1. Create `.mcp.json` in project root
2. Add gutt-mcp-remote configuration
3. Set GUTT_API_KEY and GUTT_ENDPOINT environment variables
4. Restart Claude Code

```bash
# Set credentials in environment
export GUTT_API_KEY="your-key-here"
export GUTT_ENDPOINT="https://your-org-mcp-server.run.app/mcp"

# Or add to .env file
echo "GUTT_API_KEY=your-key-here" >> .env
echo "GUTT_ENDPOINT=https://your-org-mcp-server.run.app/mcp" >> .env
```

## Security Notes

- API keys are stored in `.mcp.json` (add to .gitignore)
- Never commit API keys to version control
- Use environment variables for CI/CD
- Contact your admin to rotate keys periodically
