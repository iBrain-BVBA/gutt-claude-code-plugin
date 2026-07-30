<p align="center">
  <img src="docs/banner.jpg" alt="gutt × Claude Code" width="600">
</p>

# gutt Plugin for Claude Code & Cursor

Persistent organizational memory for [Claude Code](https://claude.ai/claude-code) and [Cursor](https://cursor.com) via [gutt](https://gutt.pro).

## What is gutt?

[gutt](https://gutt.pro) is persistent organizational memory for AI agents.

- **Decisions** — Who decided what, when, and why
- **Lessons** — What worked, what didn't, don't repeat mistakes
- **Context** — Projects, people, relationships, history

This plugin connects Claude Code to your gutt memory, automatically:

- 📥 **Retrieves** relevant context before every task
- 📤 **Captures** lessons after every task
- 🔄 **Session-aware** — Memory context follows the session lifecycle

[**Sign up for gutt →**](https://gutt.pro)

---

## Overview

This plugin provides a memory backbone for Claude Code, enabling:

- **Automatic memory retrieval** before every task
- **Lesson capture prompts** after significant work
- **Auto-linting** after file edits
- **Multi-hop graph exploration** for deep organizational insights

## Quick Start

### Via Marketplace (Recommended)

1. **Install:** `claude plugin add gutt-claude-code-plugin@gutt-plugins`
2. **Setup:** Run `/gutt-claude-code-plugin:onboard`
3. **Done** — memory integration is active

### Manual Install (Developers)

1. **Clone:** `git clone https://github.com/iBrain-BVBA/gutt-claude-code-plugin ~/.claude-plugins/gutt-claude-code-plugin`
2. **Enable:** Add to `.claude/settings.json` under `"plugins"`
3. **Setup:** Run `/gutt-claude-code-plugin:onboard`

> **Shared hook libs:** Hook libraries have a single source in `shared/`; each plugin's `hooks/lib/*` symlinks into it. Running from a cloned repo resolves those symlinks in place. Note that `--plugin-dir` / local-path installs do **not** dereference cross-plugin symlinks — to test a real install, use the git marketplace source. Marketplace installs dereference them automatically into real files.

### Cursor

#### Installation

1. In Cursor, run `/add-plugin` and enter the repo URL: `https://github.com/iBrain-BVBA/gutt-claude-code-plugin`
2. Run the setup command to configure the MCP connection
3. Enter your organization's gutt MCP endpoint URL when prompted
4. Restart Cursor → **Settings → Tools & MCP Servers** → Connect `gutt-mcp-remote`
5. Complete OAuth login

Cursor doesn't support all Claude Code hooks. The portable ones are prompt submit and file edit lint. Missing automation is compensated by Cursor rules (`.mdc`) that guide memory-first workflows.

See [docs/team-onboarding.md](docs/team-onboarding.md) for detailed installation instructions for both IDEs.

## Features

### Statusline

Real-time gutt status in your Claude Code HUD:

![gutt statusline](docs/statusline-hud.png)

- **Connection status** — Green circle when connected, `!` when not configured
- **Group** — the organizational group the session is writing to

Configure the statusline in your own `~/.claude/settings.json` (the plugin no
longer edits that file for you — see
[docs/runtime-state-convention.md](docs/runtime-state-convention.md#retired-locations)):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<plugin-root>/hooks/statusline.cjs\""
  }
}
```

> A `statusLine` in your own settings takes precedence over the plugin's. If you
> upgraded from 2.x, the retired auto-setup may have left one there — run
> `/gutt-claude-code-plugin:health` to check.

### Hooks

> **Note:** Hooks can be registered in either `hooks/hooks.json` (plugin-level) or `.claude/settings.json` (project-level). The table below shows all available hooks.

| Hook                       | Event            | Purpose                                                                                                         |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `session-start.cjs`        | SessionStart     | Opens the session record, runs the state TTL sweep                                                              |
| `session-connectivity.cjs` | SessionStart     | Async MCP connectivity probe for the HUD                                                                        |
| `session-end.cjs`          | SessionEnd       | Finalizes the session record, clears session snooze                                                             |
| `user-prompt-submit.cjs`   | UserPromptSubmit | Applies `/gutt` config commands; points at `memory-search` on a new session or after a compaction               |
| `stop-capture.cjs`         | Stop             | Shells out to `claude -p` to judge the turn; honours `/gutt off` and `mode`, defers while background agents run |
| `post-tool-lint.cjs`       | PostToolUse      | Auto-lints files after Edit/Write                                                                               |

### Settings — the `/gutt` command

Type these at any time; the change is applied by the UserPromptSubmit hook before the
model reads anything, and written to `${CLAUDE_PLUGIN_DATA}/config.json`.

| Command                 | Effect                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `/gutt config`          | Show the stored settings and the state they add up to                                      |
| `/gutt off`             | Turn memory recall off until `/gutt on` — survives restarts                                |
| `/gutt off 30`          | Snooze recall for 30 minutes (1–10080), then it resumes on its own                         |
| `/gutt off session`     | Snooze recall for the rest of this session                                                 |
| `/gutt on`              | Clear any off or snooze                                                                    |
| `/gutt mode auto\|hitl` | Set the capture mode: `auto` writes a capture directly, `hitl` confirms each subject first |

`/gutt-claude-code-plugin:gutt <subcommand>` and `/gutt:<subcommand>` are accepted too.
The HUD shows ` off` or ` zzz` in the gutt segment while recall is suppressed, since a
durable off is otherwise invisible.

Two things worth knowing. An out-of-range minute count is **rejected, not clamped** —
`/gutt off 300000` changes nothing rather than silencing recall for seven months. And off
or snooze silences **both** halves: no recall pointer is injected, and the end-of-turn
capture judge is not run at all (no subprocess is spawned). Capture mode is the other
axis — it governs only how a capture is confirmed once the judge has fired.

The judge also **defers while background agents are still working**. A turn that ends with
subagents in flight is not finished, so judging it would score a partial summary; the Stop
that runs once the last agent drains judges the whole thing instead. Background shell
commands and MCP monitors do not defer it — they cannot add a finding, and some run for the
whole session.

### Skills

| Skill            | Command                                     | Purpose                                    |
| ---------------- | ------------------------------------------- | ------------------------------------------ |
| memory-search    | `/gutt-claude-code-plugin:memory-search`    | Shallow-first, summary-first memory search |
| memory-capture   | `/gutt-claude-code-plugin:memory-capture`   | Structured lesson capture with 4 patterns  |
| memory-retrieval | `/gutt-claude-code-plugin:memory-retrieval` | Deprecated alias → use memory-search       |

### Agents

| Agent              | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `gutt-pro-memory`  | Multi-hop graph exploration and search strategies |
| `memory-keeper`    | Autonomous lesson capture after significant work  |
| `config-discovery` | Scan repos for Claude Code config drift           |

### Mentoring (gutt-mentor plugin)

Individual development programs in the **personal** memory scope, shipped as a
separate plugin that depends on gutt-core: `individual-program-design` writes the
program (goals, milestones, check-in cadence) as one self-contained episode, and
`progress-tracking` reads it back, reports status from the record alone, and
chains the next check-in — so a fresh session picks up where the person stands
without re-explaining.

The `onboarding-guide` agent joins the two halves for a new joiner: it reads the
org graph for team, architecture, decisions, lessons and experts, then turns that
grounding into their own plan. **The plan goes to both scopes — personal, where it
is tracked, and (with their confirmation) org, where the next person joining that
role can learn from it. Their progress, blockers and open questions stay personal.**
Self-service: personal scope follows the authenticated login, so the joiner runs it
themselves. No hooks.

## Usage

### Memory Search

Search organizational memory before starting work:

```
/gutt-claude-code-plugin:memory-search "authentication patterns"
```

Returns:

- Related facts (relationships between entities)
- Relevant nodes (Lessons, Decisions, People, WorkItems)
- Domain-specific lessons

### Memory Capture

Capture learnings using one of 4 patterns:

```
/gutt-claude-code-plugin:memory-capture "We decided to use relative paths instead of env vars for cross-platform compatibility"
```

**Patterns:**

- **Negation**: "X does NOT work because Y"
- **Replacement**: "Instead of X, use Y"
- **Decision**: "We decided X because Y"
- **Lesson**: "Learned that X when Y"

## File Structure

```
gutt-plugins/                       # marketplace repo (name: gutt-plugins)
├── .claude-plugin/
│   └── marketplace.json           # lists gutt-core + auto-lint-plugin + gutt-mentor
├── shared/                         # single source for hook libs; plugins symlink these
├── gutt-core/                      # core plugin — name: gutt-claude-code-plugin, displayName: gutt-core
│   ├── .claude-plugin/plugin.json
│   ├── hooks/                      # Claude Code hooks (.cjs); hooks/lib/* symlink → shared/
│   ├── skills/                     # memory-search, memory-capture, onboard, skills-discovery
│   ├── agents/                     # gutt-pro-memory, memory-keeper, and other memory agents
│   ├── commands/                   # setup, start, health
│   ├── rules/gutt-memory.mdc       # Cursor rule for memory-first workflow
│   ├── mcp.json                    # MCP config template
│   └── config.json.example
├── auto-lint-plugin/               # standalone lint-on-edit plugin (no gutt dependency)
├── gutt-mentor/                    # mentor plugin — onboarding agent + personal-scope program design/tracking (no hooks)
│   ├── agents/                     # onboarding-guide
│   └── skills/                     # individual-program-design, progress-tracking
├── docs/                           # banner, HUD screenshot, team-onboarding guide
├── tests/
├── package.json
└── README.md
```

## Requirements

- Claude Code CLI ≥ 2.1.143 (multi-plugin marketplace with `displayName`) or Cursor 2.5+
- Node.js 18+
- gutt MCP server access (contact your organization admin)

## Cross-Platform Support

This plugin works on:

- macOS (ARM and Intel)
- Linux (Ubuntu, etc.)
- Windows (PowerShell, Git Bash)

**Note:** Hooks use relative paths for cross-platform compatibility.

**Windows contributors:** The shared hook libs use git symlinks. Enable them with `git config core.symlinks true` (or turn on Developer Mode) before cloning, or the links check out as plain text files. End users installing from the marketplace are unaffected — Claude Code copies real files into its cache.

## Troubleshooting

### Hook not firing

1. Verify plugin is installed: run `/plugins` to check gutt-claude-code-plugin is listed
2. Verify Node.js is in PATH
3. Restart Claude Code to reload hooks

### MCP connection failed

1. Verify OAuth completed: run `/mcp`, select `gutt-mcp-remote`, choose "Authenticate"
2. Check network connectivity to your organization's MCP endpoint
3. Contact your organization admin if authentication fails

### Memory search returns no results

1. Verify OAuth authentication completed successfully
2. Try broader search terms
3. Check if memory has been populated for your organization

## Contributing

1. Fork the repository
2. Create a feature branch
3. Follow conventional commits
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE)

## Links

- [gutt Website](https://gutt.pro)
- [Report Issues](https://github.com/iBrain-BVBA/gutt-claude-code-plugin/issues)
