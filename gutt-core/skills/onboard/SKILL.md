---
name: onboard
description: "First-use onboarding for gutt memory integration. Verifies MCP connection, demonstrates memory search and capture, explains HUD and active hooks. Triggers on: onboard, getting started, first time, setup guide, how does this work."
---

# Onboard Skill

**Announce:** "Starting gutt memory onboarding..."

Walk the user through first-use setup and verification of the gutt memory integration.

## Flow

### Step 1: Detect MCP

Check if the gutt MCP server is configured in the project's settings.

```bash
# Check for gutt MCP configuration in settings
cat .claude/settings.json 2>/dev/null | grep -q "gutt"
```

- **If configured:** Announce "gutt MCP server found in settings." and proceed to Step 2.
- **If NOT configured:** Ask the user for their MCP server URL and guide them through setup:
  1. Ask: "What is your gutt MCP server URL? (e.g., https://your-instance.gutt.io/mcp)"
  2. Explain they can also run `/gutt-pro:setup` to configure it.
  3. Once URL is provided, help add it to `.claude/settings.json`.

### Step 2: Verify Connectivity

Run a test query to confirm the MCP connection is live:

```python
search_memory_nodes(query="test connectivity", max_nodes=1)
```

| Result                 | Action                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| Success (any response) | "MCP connection verified." Proceed to Step 3.                      |
| Not configured error   | "MCP server not configured. Run `/gutt-pro:setup` first." Stop.    |
| Unreachable / timeout  | "MCP server unreachable. Check your network and server URL." Stop. |
| Auth failure           | "Authentication failed. Check your API key or token." Stop.        |

### Step 3: First Search

Demonstrate memory retrieval by searching the knowledge graph:

```python
search_memory_nodes(query="recent decisions or lessons", max_nodes=5)
```

**Show results formatted as:**

```markdown
## Your Memory Graph

Found [N] entries:

| Entity | Type   | Summary         |
| ------ | ------ | --------------- |
| [name] | [type] | [brief summary] |
```

**Explain:** "The gutt memory graph stores organizational knowledge -- lessons learned, decisions made, patterns discovered, and relationships between them. Every search, capture, and agent delegation flows through this graph."

If no results are returned: "Your memory graph is empty -- that is expected for a new setup. It will grow as you work."

### Step 4: First Capture

Demonstrate memory capture by storing an onboarding record:

```python
add_memory(
  name="Onboarding: plugin activated",
  episode_body="gutt-pro onboarding completed for this project. Plugin active with memory integration.",
  source="text",
  source_description="onboard skill - first capture"
)
```

**Confirm:** "First memory captured. This entry marks the activation of the plugin for this project."

### Step 5: HUD Explainer

Offer the status bar HUD. It is off until the user asks for it — a plugin cannot
install a status line, so `/gutt-pro:statusline` is the only way it appears, and it
writes the user's own settings file only when they run it.

```
An optional HUD can show gutt's state in your status bar:

  [gutt 🟢 on <group>]                   configured, recall live
  [gutt ⚪ on !]                         no gutt MCP server — run /gutt-pro:setup
  [gutt 🟢 off]                          recall disabled — /gutt-pro:on restores it
  [gutt 🟢 zzz→14:30 <group>]            snoozed until then

Turn it on with /gutt-pro:statusline, off again with /gutt-pro:statusline off.
```

If they accept, tell them to run the command themselves rather than running it for
them — the point of the command is that installing it is their decision.

### Step 6: Active Hooks

List all hooks that are active and what they do:

```markdown
## Active Hooks

| Hook                 | Event                | What It Does                                           |
| -------------------- | -------------------- | ------------------------------------------------------ |
| session-start        | SessionStart         | Opens the session record and runs the state TTL sweep  |
| session-connectivity | SessionStart (async) | Probes MCP configuration for the HUD                   |
| session-end          | SessionEnd           | Finalizes the session record and clears session snooze |
| user-prompt-submit   | UserPromptSubmit     | Injects relevant memory context before each prompt     |
| post-memory-search   | PostToolUse (gutt)   | Records that memory was searched, for the recency gate |
| _(prompt hook)_      | Stop                 | Judges whether the turn is worth capturing to memory   |
```

The status bar HUD is not a hook and is not on by default — a plugin cannot install
one. Mention that `/gutt-pro:statusline` turns it on, and that it shows connection
state, whether recall is on, off or snoozed, and the group being written to.

### Step 7: Next Steps

```markdown
## Next Steps

You are ready to use gutt memory integration. Here is what to try:

1. **Search before tasks** -- Use `/gutt-pro:memory-search` or just start
   working; the hooks automatically search memory for relevant context.

2. **Capture corrections and decisions** -- Use `/gutt-pro:memory-capture`
   when you learn something worth remembering, or say "remember that..."
   naturally.

3. **Available agents** -- Your agent list shows what you can delegate to;
   which agents are there depends on which gutt plugins you installed.

4. **Skills** -- Run `/gutt-pro:skills-discovery` to analyze what additional
   skills could help your workflow.
```

## --check Mode

When invoked with `--check`, skip the tutorial and just verify:

1. **MCP connectivity** -- Run test query, report pass/fail.
2. **Hook registration** -- Confirm hooks.json is loadable and all hook scripts exist on disk.
3. **Statusline** -- Look in `~/.claude/settings.json`, the only place a status line
   can live. Report it as installed, someone else's, or absent. Absent is not a
   fault; it is the default until the user runs `/gutt-pro:statusline`.

Output a compact status table:

```markdown
## gutt Plugin Health Check

| Component         | Status                                     |
| ----------------- | ------------------------------------------ |
| MCP connectivity  | OK / FAIL: [reason]                        |
| Hook registration | OK ([N] hooks) / FAIL: [reason]            |
| Statusline        | installed / not installed / someone else's |
```
