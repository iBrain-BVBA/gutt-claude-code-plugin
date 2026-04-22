# gutt-agent-intelligence-plugin

Agents that learn from their own experience. This plugin binds captured lessons to agent identities so future sessions and subagents can automatically retrieve the wisdom they accumulated.

## What it does

Every Claude Code session operating in a project gets a stable, project-scoped agent identity (`gutt-agent-<owner>-<repo>` when a git remote is available, with graceful fallbacks). Lessons captured during that session bind to the project's identity. When the project is opened again — by anyone, on any machine — the lessons surface automatically at session start.

Spawned subagents are handled too. Memory operations are role-aware:

| Subagent                    | Binding                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `memory-keeper`             | Captures under the parent session's agent identity (it is a proxy, not a learner).                             |
| `gutt-pro-memory`           | Can scope searches to the parent's subgraph, but the filter is optional.                                       |
| Every other worker subagent | Captures under its own subagent name, building a role-specific wisdom subgraph that compounds across projects. |

## Four hooks

1. **`SessionStart`** — resolves the project agent identity and persists it to `agent-identity.json`. That's it; no MCP traffic.
2. **`UserPromptSubmit`** — on the first prompt of each session, injects an `additionalContext` block naming the agent identity, listing mandatory `agent_id` usage on memory tools, and surfacing the on-disk lesson cache. When gutt MCP is configured, the block also contains `ACTION REQUIRED` directives instructing Claude to call `<prefix>register_agent` (once per machine) and `<prefix>fetch_lessons_learned` (once per session). The tool prefix is auto-discovered from the user's settings — whatever key names the gutt server in `.mcp.json` / `settings.json` becomes `mcp__<key>__` — so installs using `gutt-pro-memory-local`, `claude_ai_gutt-pro-memory`, etc. receive correctly-named directives. Later prompts in the same session are silent.
3. **`SubagentStart`** — dispatches a role-aware binding instruction (see table above) so spawned subagents use the right `agent_id`. Worker subagents receive their own `register_agent` `ACTION REQUIRED` directive on first use.
4. **`PostToolUse`** (matcher `mcp__.*gutt.*__.*`) — observes the tool responses of the MCP calls Claude makes in response to the directives above, and persists `lessons-<agent_id>.json` + `.registered-<name>.marker` for the next session.

### Why the LLM has to make the MCP call

The gutt MCP server uses OAuth for end-user authentication, and Claude Code's OAuth session token is only reachable by Claude Code's own MCP client — not by hook subprocesses. So the plugin cannot fetch lessons directly from a hook. Instead it nudges Claude (which already has the OAuth-authenticated MCP client) to make the call, and scrapes the result via `PostToolUse`.

This is a best-effort mechanism. LLM compliance with `ACTION REQUIRED` directives is high but not guaranteed. When Claude skips the call, the session proceeds with whatever lessons were cached by the previous session, or with none if this is the first session. No error path breaks the session.

### Hook dependency

`SessionStart` writes `agent-identity.json`. The other three hooks read that file and silently no-op if it is missing. If `SessionStart` fails to resolve an agent identity (see [Failure semantics](#failure-semantics) below), no grounding is emitted for the rest of the session.

### Refresh policy

The lesson cache refreshes whenever Claude actually makes a `fetch_lessons_learned` call. The grounding block nudges that call on the first prompt of every session, so in practice the cache is one session behind the live graph:

- Session N captures a lesson via `memory-keeper`.
- Session N+1's first prompt includes the `ACTION REQUIRED` directive.
- Claude calls `fetch_lessons_learned`; `post-lesson-scrape` writes the cache.
- Session N+1's later prompts already have the grounding from that call (the cache write races the prompt response, but the grounding is emitted from the PREVIOUS cache). The new lesson surfaces in session N+2's grounding.

If Claude skips the directive — observed in some sessions — the cache stays at its prior value. A transient gutt MCP outage has the same effect. No forced retries; no clobbering of warm cache with `[]`.

### Scoping model

Scoping is **client-side by contract**: the plugin injects an `additionalContext` block at `UserPromptSubmit` and `SubagentStart` that instructs the session to pass `agent_id` on `add_memory` and `fetch_lessons_learned` calls. The MCP server hard-filters on `agent_id` at query time, but there is **no `PreToolUse` validator** and **no write-path enforcement** — if the model omits `agent_id`, memory captures and fetches silently revert to un-scoped (pre-plugin) behavior.

This is deliberate: client-side scoping keeps the plugin self-contained and the MCP server unchanged. Adding a write-path validator is explicitly **out of scope for this plugin** and would be a separate ticket.

Practical consequence for debugging: when lessons appear cross-project or a project sees unrelated lessons, the first check is whether the injected `agent_id` instruction survived to the tool call — not whether the scraper fired.

### Failure semantics

All four hooks are best-effort and exit 0 regardless of internal failures; diagnostics land in `<PROJECT_STATE_DIR>/hooks/.state/hook-errors.log`. Distinguishing cases:

- **No gutt MCP configured / non-git cwd / malformed payload** → silent degradation. Session runs with just the agent-identity banner; no `ACTION REQUIRED`, no cache updates, just like vanilla Claude Code.
- **Identity resolution fully fails** (override, git remote, git root, and cwd basename all produce empty slugs) → `SessionStart` writes a one-line warning to stderr and skips all identity-dependent work. Set `CLAUDE_PLUGIN_OPTION_AGENT_ID` to recover.
- **Claude skips the `ACTION REQUIRED` directive** → the cache is untouched; the next session shows the same lessons as this one.
- **Malformed MCP `tool_response`** → the scraper logs and returns without writing; the prior cache is preserved. An `[]` response from the server is a legitimate signal and DOES overwrite the cache (to intentionally empty).

## Requirements

- A gutt MCP server — discovered via a settings-file entry (`~/.claude/settings.json`, `.mcp.json`, `~/.cursor/mcp.json`), or an installed gutt plugin's `.mcp.json`. Claude Code's OAuth client is responsible for authentication; this plugin does not speak to the server directly.
- Claude Code (these hook events are Claude Code-specific).

## Standalone

This plugin ships its own `.mcp.json`. It runs cleanly with or without the main `gutt-claude-code-plugin` installed. When both are installed, Claude Code deduplicates MCP servers by endpoint — no duplicate connection, no drift.

## Configuration

`userConfig` keys in `.claude-plugin/plugin.json`:

| Key                  | Default           | Purpose                                                                                                                                                                                             |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_id`           | _(auto-resolved)_ | Override the auto-resolved project agent identity. Useful for monorepos where the git remote alone is ambiguous.                                                                                    |
| `lesson_max_results` | `10`              | Cap on the number of lessons surfaced at session start. Forwarded to the `ACTION REQUIRED: fetch_lessons_learned` directive as `max_results`. Values `≤ 0` or non-numeric fall back to the default. |
| `lesson_time_range`  | `"30d"`           | Recency filter forwarded **verbatim** to the `ACTION REQUIRED: fetch_lessons_learned` directive as `time_range`. Accepts values like `7d`, `30d`, `all`. Validation is delegated to the MCP server. |

## Identity resolution fallback chain

1. `userConfig.agent_id` if set (prefixed + sanitized)
2. `git remote get-url origin` → `gutt-agent-<owner>-<repo>` (stable across clones, worktrees, and dir renames)
3. `git rev-parse --show-toplevel` basename → `gutt-agent-<repo-root>`
4. `path.basename(cwd)` → `gutt-agent-<folder>`

All outputs are sanitized via `/[^a-zA-Z0-9_-]/g → _` and never contain colons or slashes.

## State and cache locations

Under `$CLAUDE_PLUGIN_DATA/agent-intelligence/` when available (persistent across plugin updates), falling back to `<project>/.claude/hooks/.state/agent-intelligence/`:

- `agent-identity.json` — resolved project agent_id for this session
- `lessons-<agent_id>.json` — lesson cache (written by `post-lesson-scrape`)
- `.registered-<name>.marker` — one marker per `register_agent` call ever made from this machine, keyed by the `name` passed to the tool. Both the session agent and each worker subagent get their own marker.
- `.injected-<session_id>.marker` — per-session guard flag for UserPromptSubmit

## Testing

```sh
node --test plugins/gutt-agent-intelligence-plugin/tests/*.test.cjs
```

Tests do not require a live MCP server. The `ACTION REQUIRED` gating is verified by pinning `HOME` and `CLAUDE_PROJECT_DIR` to tmpdirs and toggling a fixture `.mcp.json`. The scraper is tested by feeding synthetic `tool_response` payloads and asserting cache + marker state.
