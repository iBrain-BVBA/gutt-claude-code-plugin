# GUTT Setup Command

Setup wizard for configuring the GUTT MCP server connection.

## Trigger

- `/gutt-setup` or `/setup-gutt`
- First-run detection (no .mcp.json with gutt-pro-memory OR no config.json with groupID)

## Setup Flow

### Step 1: Check Existing Configuration

Check for both MCP endpoint and groupID configuration:

```bash
# Check if GUTT MCP is already configured
if [ -f ".mcp.json" ]; then
  grep -q "gutt-pro-memory" .mcp.json && echo "GUTT MCP endpoint already configured"
fi

# Check if groupID is already configured
if [ -f "config.json" ]; then
  grep -q "group_id" config.json && echo "GUTT groupID already configured"
fi
```

If both exist and are valid:

- Show summary of current configuration
- Ask if user wants to reconfigure or skip

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

2. **OAuth Authentication Flow**

   Open the OAuth login page in the user's browser:

   ```
   Opening OAuth authentication page...
   URL: https://[endpoint-domain]/auth/login

   Please complete the authentication in your browser.
   This will authorize Claude Code to access your GUTT memory graph.

   Press Enter when authentication is complete...
   ```

   **Implementation Notes:**
   - Extract domain from endpoint URL (e.g., `https://your-org.a.run.app/mcp` → `https://your-org.a.run.app`)
   - Open `${domain}/auth/login` in default browser
   - Wait for user confirmation before proceeding
   - OAuth tokens are managed by the MCP server, not stored locally

3. **Validate Connection**
   Test the connection works after OAuth:

   ```javascript
   // Call a simple MCP tool to verify authentication succeeded
   mcp__gutt_pro_memory__search_memory_nodes({
     query: "test connection",
     max_nodes: 1,
   });
   ```

   If authentication failed, show error and retry OAuth flow.

### Step 4: Get GroupID

Ask user for their memory graph groupID:

```
Enter your GUTT memory graph groupID:
(Default: gutt_pro_v1)
(Leave blank to use default)

What is a groupID?
- Organizes memories into separate graphs
- Use project-specific IDs for project isolation
- Use team/org IDs for shared knowledge
- Default is gutt_pro_v1 for general use

Your groupID: _
```

**Validation:**

- groupID should be alphanumeric with underscores/hyphens
- No spaces allowed
- Minimum 3 characters

### Step 5: Write Configuration Files

Write both configuration files:

**1. Create/update `.mcp.json`:**

```json
{
  "gutt-pro-memory": {
    "type": "http",
    "url": "[user-provided-endpoint]"
  }
}
```

**2. Create/update `config.json`:**

```json
{
  "gutt": {
    "group_id": "[user-provided-groupID]"
  }
}
```

**Implementation Notes:**

- If files exist, merge with existing content (don't overwrite other configs)
- Create files with proper permissions (644)
- Validate JSON syntax before writing
- Add `.mcp.json` to `.gitignore` if not already present

### Step 6: Validate Complete Setup

Run comprehensive verification with the configured groupID:

```
Verifying GUTT setup...

1. Testing MCP server connection...
   ✓ MCP server responding

2. Testing authentication...
   ✓ OAuth credentials valid

3. Testing memory graph access with groupID: [groupID]...
   ✓ Memory graph accessible

4. Testing read permissions...
   ✓ Can search memory facts

5. Testing write permissions...
   ✓ Can add memories

Setup complete! GUTT memory is now available.
```

**Validation Implementation:**

```javascript
// Test search with configured groupID
const searchResult = await mcp__gutt_pro_memory__search_memory_facts({
  query: "test",
  group_id: configuredGroupID,
  max_results: 1,
});

// Test write capability (optional, only if user confirms)
const addResult = await mcp__gutt_pro_memory__add_memory({
  content: "GUTT setup test - can be deleted",
  group_id: configuredGroupID,
  metadata: { test: true, timestamp: Date.now() },
});

// Show results
if (searchResult.success && addResult.success) {
  console.log("✓ All tests passed!");
} else {
  console.log("✗ Validation failed - check configuration");
}
```

### Step 7: Show Summary & Next Steps

```
GUTT Setup Complete!

Configuration Summary:
- MCP Endpoint: [configured-endpoint]
- GroupID: [configured-groupID]
- Config Files: .mcp.json, config.json

You can now use:
- /memory-retrieval - Search organizational memory
- /memory-capture - Capture lessons and decisions

The UserPromptSubmit hook will remind you to check memory before tasks.
The Stop hook will prompt you to capture learnings after significant work.

To reconfigure later, run /gutt-setup again.
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

### OAuth Authentication Error

```
OAuth authentication failed.

Possible issues:
1. Browser did not complete authentication
2. Session expired during setup
3. User denied access permissions
4. OAuth service temporarily unavailable

Solutions:
- Retry the setup process
- Check browser for authentication page
- Clear browser cookies and retry
- Contact admin if problem persists
```

### GroupID Validation Error

```
Invalid groupID format.

Requirements:
- Alphanumeric characters only (a-z, A-Z, 0-9)
- Underscores (_) and hyphens (-) allowed
- No spaces
- Minimum 3 characters
- Maximum 64 characters

Examples:
✓ gutt_pro_v1
✓ my-team-2024
✓ project_abc_123
✗ my group (has space)
✗ ab (too short)

Please enter a valid groupID.
```

### Memory Graph Access Error

```
Could not access memory graph with groupID: [groupID]

Possible issues:
1. GroupID does not exist in your organization
2. You do not have permissions for this groupID
3. GroupID was mistyped

Solutions:
- Verify groupID with your admin
- Check for typos in groupID
- Use default groupID (gutt_pro_v1)
- Contact admin to grant access
```

## Manual Configuration

For users who skip the wizard:

1. Create `.mcp.json` in project root
2. Create `config.json` in project root
3. Add configurations as shown below
4. Complete OAuth authentication manually
5. Restart Claude Code

**`.mcp.json`:**

```json
{
  "gutt-pro-memory": {
    "type": "http",
    "url": "https://your-org-mcp-server.a.run.app/mcp"
  }
}
```

**`config.json`:**

```json
{
  "gutt": {
    "group_id": "your-group-id-here"
  }
}
```

**OAuth Authentication:**

1. Visit: `https://[your-server-domain]/auth/login`
2. Complete authentication in browser
3. Restart Claude Code to activate authenticated session

## Security Notes

### Configuration Files

- **`.mcp.json`**: Contains server endpoint (add to .gitignore)
- **`config.json`**: Contains groupID (may be project-specific, check with team)
- Never commit authentication credentials
- Use `.mcp.json.template` for sharing configuration structure

### OAuth Security

- OAuth tokens are managed server-side, not stored locally
- Authentication session tied to browser cookies
- No API keys or tokens stored in config files
- Re-authentication required if session expires

### GroupID Security

- GroupIDs control memory graph isolation
- Use project-specific groupIDs for sensitive projects
- Team groupIDs allow shared knowledge access
- Verify groupID permissions with admin before using

### Best Practices

```
DO:
✓ Add .mcp.json to .gitignore
✓ Verify groupID before capturing sensitive information
✓ Use OAuth instead of API keys
✓ Complete authentication in trusted browser
✓ Contact admin for endpoint/groupID questions

DON'T:
✗ Commit .mcp.json to version control
✗ Share OAuth session cookies
✗ Use production groupIDs for testing
✗ Store credentials in config files
✗ Skip OAuth authentication step
```
