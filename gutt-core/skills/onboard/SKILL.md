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
  2. Explain they can also run `/gutt-claude-code-plugin:setup` to configure it.
  3. Once URL is provided, help add it to `.claude/settings.json`.

### Step 2: Verify Connectivity

Run a test query to confirm the MCP connection is live:

```python
search_memory_nodes(query="test connectivity", max_nodes=1)
```

| Result                 | Action                                                                         |
| ---------------------- | ------------------------------------------------------------------------------ |
| Success (any response) | "MCP connection verified." Proceed to Step 3.                                  |
| Not configured error   | "MCP server not configured. Run `/gutt-claude-code-plugin:setup` first." Stop. |
| Unreachable / timeout  | "MCP server unreachable. Check your network and server URL." Stop.             |
| Auth failure           | "Authentication failed. Check your API key or token." Stop.                    |

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
  episode_body="gutt-claude-code-plugin onboarding completed for this project. Plugin active with memory integration.",
  source="text",
  source_description="onboard skill - first capture"
)
```

**Confirm:** "First memory captured. This entry marks the activation of the plugin for this project."

### Step 5: HUD Explainer

Explain the statusline that appears at the bottom of the terminal:

```
The HUD statusline shows live counters:

- memoryQueries: Number of memory searches performed this session
- lessonsCaptured: Number of lessons/decisions written to memory this session

These reset each session. You can manually reset them with:
  /gutt-claude-code-plugin:reset-counters
```

### Step 6: Active Hooks

List all hooks that are active and what they do:

```markdown
## Active Hooks

| Hook                    | Event                               | What It Does                                            |
| ----------------------- | ----------------------------------- | ------------------------------------------------------- |
| session-start           | SessionStart                        | Loads seed registry and primes memory cache on startup  |
| sessionstart-setup      | SessionStart                        | Validates MCP configuration and plugin state            |
| user-prompt-submit      | UserPromptSubmit                    | Injects relevant memory context before each prompt      |
| stop-lessons            | Stop                                | Captures lessons learned when a conversation ends       |
| post-tool-lint          | PostToolUse (Edit/Write)            | Runs lint checks after file edits                       |
| cowork-periodic-capture | PostToolUse (Edit/Write/Task/Agent) | Periodically captures progress to memory during work    |
| post-task-lessons       | PostToolUse (Task/Agent)            | Extracts lessons from completed agent tasks             |
| post-memory-ops         | PostToolUse (MCP memory tools)      | Tracks memory operation metrics for the HUD             |
| pre-task-memory         | PreToolUse (Task/Agent)             | Injects relevant memory context before agent delegation |
| subagent-start-memory   | SubagentStart                       | Injects organizational memory into subagent context     |
| subagent-plan-review    | SubagentStop                        | Reviews subagent output for lessons to capture          |
| statusline              | StatusLine                          | Renders the HUD with memory operation counters          |
```

### Step 7: Next Steps

```markdown
## Next Steps

You are ready to use gutt memory integration. Here is what to try:

1. **Search before tasks** -- Use `/memory-search` or just start working;
   the hooks automatically search memory for relevant context.

2. **Capture corrections and decisions** -- Use `/memory-capture` when you
   learn something worth remembering, or say "remember that..." naturally.

3. **Available agents** -- Check `agents/` for specialized agents like
   `plugin-dev`, `plugin-qa`, `hook-expert`, and more.

4. **Skills** -- Run `/skills-discovery` to analyze what additional skills
   could help your workflow.
```

## --check Mode

When invoked with `--check`, skip the tutorial and just verify:

1. **MCP connectivity** -- Run test query, report pass/fail.
2. **Hook registration** -- Confirm hooks.json is loadable and all hook scripts exist on disk.
3. **Seed registry** -- Check if seed registry cache exists at the expected state directory.
4. **Cache status** -- Report whether the memory cache is warm or cold.

Output a compact status table:

```markdown
## gutt Plugin Health Check

| Component         | Status                          |
| ----------------- | ------------------------------- |
| MCP connectivity  | OK / FAIL: [reason]             |
| Hook registration | OK ([N] hooks) / FAIL: [reason] |
| Seed registry     | OK / NOT FOUND                  |
| Memory cache      | WARM / COLD                     |
```
