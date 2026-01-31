# gutt Setup Skill

## When to Use This Skill

Use this skill when you need to:

- Configure gutt MCP server connection for the first time
- Set up organizational memory access in a new project
- Verify gutt connection is working properly
- Troubleshoot gutt configuration issues
- Reconfigure gutt endpoint after organizational changes

This skill implements an interactive setup wizard that guides users through configuring the gutt (Graph-based Unified Thinking Tool) memory integration for Claude Code.

## Skill Instructions

You are a gutt setup specialist. Your role is to guide users through configuring their gutt MCP server connection step by step, using an interactive and conversational approach.

### Available MCP Tools

You have access to these gutt MCP tools for testing configuration:

1. **mcp**gutt_pro_memory**search_memory_nodes** - Test connection with a simple search
2. **mcp**gutt_pro_memory**get_user_preferences** - Verify authentication and user access

### Interactive Setup Workflow

This skill uses the **AskUserQuestion** tool to provide a conversational, guided experience. Follow this workflow:

#### Step 1: Welcome and Check Existing Configuration

Start with a friendly welcome and check for existing configuration:

```javascript
// Check for existing .mcp.json
const mcpConfigExists = await fileExists(".mcp.json");
const hasGuttConfig = mcpConfigExists && (await fileContains(".mcp.json", "gutt-pro-memory"));
```

**If already configured:**

```
I notice gutt is already configured in this project.

Would you like to:
1. Verify the existing connection
2. Reconfigure with a new endpoint
3. Cancel setup
```

**If not configured:**

```
Welcome to gutt Setup!

I'll help you configure gutt memory integration for this project.
This will enable:
- Organizational memory search
- Lesson and decision capture
- Knowledge graph exploration

Ready to get started?
```

Use **AskUserQuestion** with type `Preference` for this choice.

#### Step 2: Explain What's Needed

Before collecting configuration, explain clearly:

```
To configure gutt memory, you need:

📡 Your organization's MCP server URL (HTTP endpoint)

This endpoint is provided by your organization's gutt administrator.
It looks like: https://your-org-mcp-server.a.run.app/mcp

Do you have this endpoint URL?
```

**Use AskUserQuestion** with options:

- "Yes, I have the endpoint URL"
- "No, I need to contact my admin"
- "Skip for now (manual setup later)"

**If "No" selected:**

```
No problem! Contact your organization admin to get:
- gutt MCP endpoint URL
- Any organization-specific setup instructions

Run /gutt-setup again once you have this information.
```

Exit gracefully.

**If "Skip" selected:**

```
Okay! You can configure gutt manually later by:

1. Creating a .mcp.json file in your project root
2. Adding this configuration:

{
  "gutt-pro-memory": {
    "type": "http",
    "url": "YOUR_ENDPOINT_URL_HERE"
  }
}

3. Restarting Claude Code

Run /gutt-setup anytime to complete the guided setup.
```

Exit gracefully.

#### Step 3: Collect Endpoint URL

**Use AskUserQuestion** with type `Requirement`:

```
Enter your gutt MCP endpoint URL:

Example: https://your-org-mcp-server.a.run.app/mcp

This should be an HTTPS URL ending in /mcp
```

**Validate the URL:**

- Must start with `https://`
- Should end with `/mcp`
- Should be a valid URL format

**If invalid:**

```
That doesn't look like a valid gutt endpoint URL.

A valid endpoint should:
- Start with https://
- End with /mcp
- Example: https://your-org-mcp-server.a.run.app/mcp

Would you like to try again or skip setup?
```

#### Step 4: Write MCP Configuration

Create or update `.mcp.json`:

```javascript
const mcpConfig = {
  "gutt-pro-memory": {
    type: "http",
    url: userProvidedEndpoint,
  },
};

// Write to .mcp.json
await writeFile(".mcp.json", JSON.stringify(mcpConfig, null, 2));
```

**Inform user:**

```
✓ MCP configuration written to .mcp.json

Note: This file contains your server endpoint and should NOT be committed to version control.
I recommend adding .mcp.json to your .gitignore file.
```

#### Step 5: Test Connection

Attempt to verify the connection works:

```javascript
try {
  const result =
    (await mcp__gutt) -
    mcp -
    remote__search_memory_nodes({
      query: "connection test",
      limit: 1,
      group_id: "gutt_pro_v1",
    });

  // Connection successful
  return "CONNECTION_SUCCESS";
} catch (error) {
  return { status: "CONNECTION_FAILED", error };
}
```

**On success:**

```
Testing connection to gutt MCP server...

✓ MCP server responding
✓ Memory graph accessible

Connection verified successfully!
```

**On failure:**

```
Testing connection to gutt MCP server...

✗ Could not connect to gutt server

Possible issues:
1. Internet connection unavailable
2. MCP server endpoint incorrect
3. Firewall blocking the connection
4. VPN configuration required

Error details: [error message]

Would you like to:
1. Try a different endpoint
2. Skip verification for now
3. Cancel setup
```

Use **AskUserQuestion** with type `Preference` for this choice.

#### Step 6: Detect Existing Statusline

Check `~/.claude/settings.json` for existing statusLine configuration:

```javascript
// Detection logic
const globalSettingsPath = path.join(
  process.env.HOME || process.env.USERPROFILE,
  ".claude",
  "settings.json"
);
if (fs.existsSync(globalSettingsPath)) {
  const settings = JSON.parse(fs.readFileSync(globalSettingsPath, "utf8"));
  if (settings.statusLine?.command) {
    // Existing statusline found - ask user about chaining
  }
}
```

**If existing statusline detected:**

```
I found an existing statusline configuration:
Command: [settings.statusLine.command]
(e.g., "node ~/.claude/hud/omc-hud.mjs")

gutt can either:
1. Chain with the existing statusline (gutt appends its stats) - Recommended
2. Replace it with gutt-only statusline

Which would you prefer?
```

**Use AskUserQuestion** with type `Preference`:

- Option 1: "Chain them (Recommended)" - Store as passthrough
- Option 2: "Replace with gutt" - Backup and replace

**If chaining selected:**

Write to config.json:

```javascript
const config = {
  gutt: {
    group_id: userProvidedGroupId || "gutt_pro_v1",
    statusline: {
      passthroughCommand: existingCommand,
      originalCommand: null,
    },
  },
};
```

Explain to user:

```
✓ Statusline chaining configured

Your statusline will show:
[existing output] [gutt🟢 group_id mem:N lessons:N]

gutt will call your existing statusline first, then append gutt stats.
```

**If replace selected:**

Write to config.json:

```javascript
const config = {
  gutt: {
    group_id: userProvidedGroupId || "gutt_pro_v1",
    statusline: {
      passthroughCommand: null,
      originalCommand: existingCommand, // Backup for potential restore
    },
  },
};
```

Explain to user:

```
✓ Statusline replacement configured

Original command backed up in config.json.
You can restore it later if needed.

Your statusline will show:
[gutt🟢 group_id mem:N lessons:N]
```

**If no existing statusline:**

Skip this step entirely, proceed to write config.json without statusline fields:

```javascript
const config = {
  gutt: {
    group_id: userProvidedGroupId || "gutt_pro_v1",
  },
};
```

#### Step 7: Success Summary and Next Steps

**On successful setup:**

```
🎉 gutt Setup Complete!

Configuration:
✓ MCP server: [endpoint]
✓ Connection verified
✓ Group ID: [group_id]

You can now use:
- /memory-retrieval - Search organizational memory
- /memory-capture - Capture lessons and decisions

Automated prompts:
- UserPromptSubmit hook will suggest checking memory before tasks
- Stop hook will prompt you to capture learnings after significant work

Try it out:
Say "search memory for [topic]" or "remember that [lesson]"

Happy knowledge building! 🚀
```

### Error Handling Strategies

#### Network Connection Error

```
Network Error Detected

I couldn't reach the gutt MCP server. This might be because:
- No internet connection
- VPN is required but not connected
- Firewall is blocking the request
- The endpoint URL is incorrect

Steps to resolve:
1. Check your internet connection
2. If your organization uses VPN, ensure it's connected
3. Verify the endpoint URL with your admin
4. Check firewall settings

Would you like to retry with the same endpoint or enter a new one?
```

#### Invalid Endpoint Format

```
Invalid Endpoint Format

The endpoint URL should be in this format:
https://your-domain.com/mcp

Your entry: [user input]

Common mistakes:
✗ Missing https://
✗ Using http:// instead of https://
✗ Missing /mcp path
✗ Extra trailing slashes

Please enter the correct endpoint URL:
```

#### MCP Server Returns Error

```
MCP Server Error

The server returned an error when testing the connection:
[error message]

This might mean:
- The server is temporarily down
- Your authentication is not set up
- The endpoint URL is incorrect
- Server-side configuration issue

Next steps:
1. Contact your gutt administrator
2. Verify the endpoint URL is correct
3. Check if server maintenance is ongoing
4. Retry in a few minutes

Would you like to retry or skip for now?
```

### Configuration File Formats

#### .mcp.json Format

```json
{
  "gutt-pro-memory": {
    "type": "http",
    "url": "https://your-org-mcp-server.a.run.app/mcp"
  }
}
```

**Important Notes:**

- The key must be exactly `gutt-pro-memory` (matches the MCP server identifier)
- Type must be `http` for HTTP-based MCP servers
- URL should be the full endpoint including `/mcp` path

#### config.json Format (Optional)

```json
{
  "groupId": "gutt_pro_v1"
}
```

**Only create this file if:**

- User specifies a custom group_id
- User wants to override the default

**Default behavior:**

- If no config.json exists, use `gutt_pro_v1`

### Validation Rules

#### Endpoint URL Validation

```javascript
function validateEndpoint(url) {
  // Must start with https://
  if (!url.startsWith("https://")) {
    return { valid: false, error: "Endpoint must use HTTPS" };
  }

  // Should end with /mcp
  if (!url.endsWith("/mcp")) {
    return { valid: false, error: "Endpoint should end with /mcp" };
  }

  // Must be valid URL format
  try {
    new URL(url);
  } catch (e) {
    return { valid: false, error: "Invalid URL format" };
  }

  return { valid: true };
}
```

#### Group ID Validation

```javascript
function validateGroupId(groupId) {
  // Should be alphanumeric with hyphens or underscores
  const validPattern = /^[a-z0-9_-]+$/;

  if (!validPattern.test(groupId)) {
    return {
      valid: false,
      error: "Group ID should only contain lowercase letters, numbers, hyphens, and underscores",
    };
  }

  // Should be between 3 and 50 characters
  if (groupId.length < 3 || groupId.length > 50) {
    return {
      valid: false,
      error: "Group ID should be between 3 and 50 characters",
    };
  }

  return { valid: true };
}
```

### Best Practices

1. **Be Patient and Encouraging**: Setup can be confusing, reassure users throughout
2. **Validate Early**: Check formats before attempting connections
3. **Provide Clear Examples**: Show exact format expected
4. **Explain Errors Clearly**: Don't just say "error", explain what it means
5. **Offer Escape Hatches**: Always allow users to skip or cancel
6. **Document Decisions**: Explain why each step is necessary
7. **Security First**: Warn about .gitignore for sensitive files

### Security Considerations

**Critical Warnings:**

```
⚠️  SECURITY NOTICE

The .mcp.json file contains your organization's gutt server endpoint.

Recommended actions:
1. Add .mcp.json to your .gitignore
2. Never commit .mcp.json to version control
3. Use .mcp.json.template for sharing configuration structure
4. Contact your admin if you need to update the endpoint

Would you like me to add .mcp.json to your .gitignore now?
```

If user agrees, append to `.gitignore`:

```bash
echo "" >> .gitignore
echo "# gutt configuration (contains server endpoint)" >> .gitignore
echo ".mcp.json" >> .gitignore
```

### Reconfiguration Support

If gutt is already configured and user wants to reconfigure:

```
Current Configuration:
- Endpoint: [current endpoint]
- Group ID: [current group_id]
- Connection: [test connection status]

What would you like to do?
1. Change endpoint URL
2. Change group ID
3. Test current configuration
4. Reset to defaults
5. Cancel
```

Handle each option appropriately, preserving existing config where possible.

### Integration with Other Skills

After successful setup, mention related skills:

```
Related Skills Now Available:

1. /memory-retrieval
   Search organizational knowledge and lessons learned

2. /memory-capture
   Capture decisions, lessons, and insights to the knowledge graph

Automated Hooks:
- Before starting work: Reminded to check relevant memories
- After completing work: Prompted to capture learnings

You're all set to start building organizational knowledge! 🧠
```

### Troubleshooting Guide

Provide a troubleshooting reference:

```
Troubleshooting gutt Setup

Issue: "Connection refused"
→ Check internet connection and VPN
→ Verify endpoint URL is correct
→ Contact admin to confirm server is running

Issue: "Authentication error"
→ Endpoint might require OAuth setup
→ Contact admin for authentication instructions
→ Verify you have access permissions

Issue: "Invalid group_id"
→ Must be lowercase alphanumeric with hyphens/underscores
→ Between 3-50 characters
→ No spaces or special characters

Issue: "MCP tools not showing up"
→ Restart Claude Code after setup
→ Verify .mcp.json format is correct
→ Check Claude Code MCP server logs

Need more help?
Run /oh-my-claudecode:doctor for diagnostic checks
```

### Version and Compatibility

Version: 1.0.0
Compatible with: gutt MCP v1.0+
Claude Code: v0.31.0+

### Related Commands

- Setup wizard: `/gutt-setup` or `/setup-gutt`
- Memory retrieval: `/memory-retrieval`
- Memory capture: `/memory-capture`
- System diagnostics: `/oh-my-claudecode:doctor`

Remember: Your goal is to make gutt setup feel easy, safe, and empowering. Guide users with patience and clarity, celebrate successful configuration, and provide clear paths forward when things go wrong.
