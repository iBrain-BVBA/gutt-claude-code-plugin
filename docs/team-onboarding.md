# GUTT Plugin — Team Onboarding Guide

## Claude Code — Individual Install

Steps:

1. Add the marketplace: `claude plugin marketplace add https://raw.githubusercontent.com/iBrain-BVBA/gutt-claude-code-plugin/main/.claude-plugin/marketplace.json`
2. Install the plugin: `claude plugin install gutt-pro --marketplace gutt-plugins`
3. Run `/gutt-pro:setup` or `/gutt-pro:start` in a Claude Code session to connect to your organization's gutt MCP endpoint
4. Restart Claude Code and authenticate via `/mcp` → `gutt-mcp-remote` → Authenticate

## Claude Code — Admin Managed

For team-wide deployment, admins can pre-configure via managed settings:

- `extraKnownMarketplaces` — add the gutt marketplace URL
- `enabledPlugins` — auto-install the plugin for all users
- MCP endpoint can be pre-configured in organization settings

## Cursor — Individual Install

Steps:

1. In Cursor, run `/add-plugin` and enter: `https://github.com/iBrain-BVBA/gutt-claude-code-plugin`
2. Run the setup command to configure the MCP connection
3. Enter your organization's gutt MCP endpoint URL when prompted
4. Restart Cursor → Settings → Tools & MCP Servers → Connect `gutt-mcp-remote`
5. Complete OAuth login

Note: Cursor doesn't have a `claude mcp add` CLI. The setup wizard handles MCP registration by writing to `~/.cursor/mcp.json` directly.

## Troubleshooting

Common issues:

- **"MCP server not found"**: Restart the IDE after installing the plugin
- **Authentication fails**: Check that your endpoint URL starts with `https://` and ends with `/mcp`
- **Memory tools not showing**: Ensure the MCP server is connected (green status). In Claude Code: `/mcp`. In Cursor: Settings → Tools & MCP Servers
- **Hook errors**: Check logs at `${CLAUDE_PLUGIN_DATA}/hook-errors.log` (the per-plugin data dir; see docs/runtime-state-convention.md)
- **Plugin not detected**: Make sure the plugin is installed and enabled. In Claude Code: `claude plugin list`. In Cursor: check Extensions panel
