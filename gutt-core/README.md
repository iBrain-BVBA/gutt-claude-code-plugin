# gutt-pro

The core gutt plugin: organizational memory for Claude Code. It connects Claude Code to your
gutt knowledge graph, points Claude at memory search when a session starts, offers to capture
what a turn learned when it ends, and gives you commands to turn it off, snooze it or change how
captures are confirmed. Every other gutt plugin depends on it. Its source lives in `gutt-core/`.

```
claude plugin marketplace add iBrain-BVBA/gutt-claude-code-plugin
claude plugin install gutt-pro@gutt-plugins
```

## Sign in

The plugin brings two MCP servers of its own:

- `gutt-closed-beta` — the gutt shared stage server (`https://mcp.stage.gutt.pro/mcp`), for
  closed-beta users.
- `gutt-enterprise` — your organization's gutt, set with the plugin option `mcp_url`. It has no
  default: until you set it, `/mcp` lists it as failed with "URL is unset or invalid", which
  closed-beta users can ignore.

After installing, open the connector list and click **Authorise** on `gutt-closed-beta` (or
`gutt-enterprise` once it points at your organization):

- In the terminal and the desktop app's Code tab: type `/mcp`, pick the server, choose
  Authenticate.
- In the Claude app (claude.ai, the desktop app's chat and Cowork): open **Customize** →
  **Plugins** → **Yours** → gutt-pro, go to its **Connectors** tab and add the server.
  Installing the plugin there doesn't add the connector by itself.

The first time, the gutt login page opens: click **Sign up** to create your personal login on
the stage server.

To use your organization's own gutt, run `/gutt-pro:setup` and give it your endpoint, or set
it at install time; `gutt-enterprise` then points there:

```
claude plugin install gutt-pro@gutt-plugins --config mcp_url=https://your-org.example/mcp
```

Your admin has the endpoint; [gutt.pro](https://gutt.pro) has the rest.

## Try it

- "What did we decide about authentication last quarter, and why?"
- "Before I start on the billing export, what do we already know about it?"
- "Remember that the staging database resets every Sunday night."

Or run `/gutt-pro:onboard` for a guided tour in a live session.

## Skills

| Skill                   | What it does                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `memory-search`         | Searches memory before a task: shallow first, summaries first, deeper only when the first pass is thin                   |
| `memory-capture`        | Writes one self-contained memory: Insight and Incident directly, Lesson, Decision and WorkingAgreement after you confirm |
| `graph-traversal`       | Follows relationships: how things connect, what blocks what, whether a fact still holds                                  |
| `conflict-adjudication` | Two memories disagree: weighs the evidence and recommends supersede, coexist or escalate (read-only)                     |
| `agent-memory-protocol` | Gives a named agent or skill workflow a stable memory identity, scoped recall and tagged writes                          |
| `component-creator`     | Designs and scaffolds plugin components, skills first, an agent only when one is really needed                           |
| `migrate-memory`        | Moves Claude Code's own per-project memory files into gutt, once, with your consent                                      |
| `onboard`               | First-use tour: checks the connection, shows search and capture, explains the hooks and status bar                       |
| `output-style`          | Reply conventions: the answer first, concrete, no preamble                                                               |
| `skills-discovery`      | Finds missing skills from repeated corrections and workflow gaps                                                         |
| `weekly-recap`          | A cited recap of a week for a person, project or team; writes nothing                                                    |
| `memory-retrieval`      | Old name for `memory-search`, kept so the old command still works                                                        |

Skills run when Claude judges them relevant, or by name: `/gutt-pro:memory-search "auth patterns"`.

## Agent

| Agent             | What it does                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `gutt-pro-memory` | Explores the graph across several hops in its own context and returns a short, cited answer |

## Commands

| Command                     | Effect                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/gutt-pro:setup`           | Point the plugin at a different gutt MCP endpoint                                                                                             |
| `/gutt-pro:start`           | Same as `/gutt-pro:setup`                                                                                                                     |
| `/gutt-pro:health`          | What registered, and whether memory is reachable                                                                                              |
| `/gutt-pro:config`          | Show the stored settings and the state they add up to                                                                                         |
| `/gutt-pro:off`             | Turn recall off for the rest of this session; `/gutt-pro:off 30` for 30 minutes (1–10080)                                                     |
| `/gutt-pro:disable`         | Turn recall off until `/gutt-pro:on`, across restarts                                                                                         |
| `/gutt-pro:on`              | Clear an off, a snooze and a disable                                                                                                          |
| `/gutt-pro:mode auto\|hitl` | `auto`: Insight and Incident written directly, the rest after you confirm; `hitl`: every capture the end-of-turn judge proposes waits for you |
| `/gutt-pro:statusline`      | Add the status bar to your `~/.claude/settings.json` (`off` removes it, `status` checks it)                                                   |
| `/gutt-pro:agent-scope`     | Bind the memory scope named workflows use in this directory                                                                                   |

The settings commands (`config`, `off`, `disable`, `on`, `mode`, `statusline`, `agent-scope`)
are applied by the prompt hook before Claude reads anything, and stored in the plugin's data
directory, except `statusline`, which writes your `~/.claude/settings.json`. A few things worth
knowing:

- **`off` is temporary, `disable` is durable.** Both silence recall and the end-of-turn capture
  judge. An out-of-range minute count changes nothing rather than being clamped.
- **Bare `/off`, `/on`, `/disable` and `/mode` also work**, and the reply says so. Bare
  `/config` does not: Claude Code's own `/config` takes it first.
- **In Cowork and cloud routines, settings last one session.** Runtime state there is discarded
  when the session ends.
- **Agent scope** decides whether named workflows share memory across checkouts. It becomes a
  suffix on every workflow identity registered here, so `pr-reviewer` becomes
  `pr-reviewer--<label>`. Directories bound to the same label share one pool of workflow memory;
  different labels stay apart. With nothing bound, a workflow derives a label from the git
  remote's `owner/repo`, or the folder name when there is no remote. The binding is keyed on the
  working directory and lives on this machine, so a second checkout or a moved directory needs
  binding again. `/gutt-pro:agent-scope show` reports what is bound here.

Upgrading from 2.x or 3.0? The command names changed; see
[docs/migration-3.0.md](../docs/migration-3.0.md).

## What runs on its own

Six hooks: see [docs/hooks.md](../docs/hooks.md). The status bar is opt-in: see
[docs/statusline.md](../docs/statusline.md).

## Cursor

`/gutt-pro:setup` registers the MCP server in `~/.cursor/mcp.json`, and the skills and the
`rules/gutt-memory.mdc` rule load in Cursor. The status bar and the `mcp_url` plugin option are
Claude Code only. See the main [README](../README.md#cursor).
