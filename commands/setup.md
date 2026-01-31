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

### Step 2: Account Status

Ask user:

```
Do you have a GUTT account?

1. Yes, I have an account (login)
2. No, I need to create one (signup)
3. Skip for now (manual setup later)
```

### Step 3a: Login Flow (Existing Users)

1. **Get API Key**

   ```
   Please enter your GUTT API key:
   (Find it at https://app.gutt.io/settings/api-keys)
   ```

2. **Optional: Custom Endpoint**

   ```
   Use default GUTT endpoint? (https://api.gutt.io)
   - Yes (recommended)
   - No, use custom endpoint
   ```

3. **Validate Connection**
   Test the API key works:
   ```javascript
   // Call a simple MCP tool to verify
   mcp__gutt -
     mcp -
     remote__search_memory_nodes({
       query: "test connection",
       max_nodes: 1,
     });
   ```

### Step 3b: Signup Flow (New Users)

1. **Redirect to Signup**

   ```
   Opening GUTT signup page...
   URL: https://app.gutt.io/signup?ref=claude-code-plugin

   After creating your account:
   1. Go to Settings > API Keys
   2. Create a new API key
   3. Copy the key and paste it here
   ```

2. **Wait for API Key**

   ```
   Paste your new GUTT API key:
   ```

3. **Continue with validation**

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
        "GUTT_ENDPOINT": "https://api.gutt.io"
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

Need help? Visit https://docs.gutt.io/claude-code-plugin
```

## Error Handling

### Invalid API Key

```
API key validation failed.

Please check:
1. Key is copied correctly (no extra spaces)
2. Key hasn't expired
3. Key has correct permissions

Try again or visit https://app.gutt.io/settings/api-keys
```

### Network Error

```
Could not connect to GUTT servers.

Please check:
1. Internet connection
2. Firewall settings (allow api.gutt.io)
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
3. Set GUTT_API_KEY environment variable
4. Restart Claude Code

```bash
# Set API key in environment
export GUTT_API_KEY="your-key-here"

# Or add to .env file
echo "GUTT_API_KEY=your-key-here" >> .env
```

## Security Notes

- API keys are stored in `.mcp.json` (add to .gitignore)
- Never commit API keys to version control
- Use environment variables for CI/CD
- Rotate keys periodically at https://app.gutt.io/settings/api-keys
