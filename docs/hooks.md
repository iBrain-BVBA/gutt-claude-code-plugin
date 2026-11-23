# gutt-pro hooks

Only `gutt-pro` ships hooks. The role plugins (`gutt-developer`, `gutt-product`, `gutt-mentor`)
ship skills and nothing that runs on its own. The hooks are registered in
`gutt-core/hooks/hooks.json` and run with Node.js from the plugin's own directory.

| Hook                       | Event            | What it does                                                                                                                                           |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session-start.cjs`        | SessionStart     | Opens the session record and sweeps expired state                                                                                                      |
| `session-connectivity.cjs` | SessionStart     | Runs in the background: checks the gutt MCP server is configured, for the status bar, and keeps the status bar's entry point current                   |
| `session-end.cjs`          | SessionEnd       | Closes the session record and clears a session-only off                                                                                                |
| `user-prompt-submit.cjs`   | UserPromptSubmit | Applies `/gutt-pro:` settings commands; on a new session or after a compaction, points Claude at `memory-search`; checks gutt's tools are still listed |
| `stop-capture.cjs`         | Stop             | Asks a separate `claude -p` call whether the turn produced something worth keeping, and if so points Claude at `memory-capture`                        |
| `post-memory-search.cjs`   | PostToolUse      | Runs after any gutt tool call: resets the recall counter after a search, and records what the call showed about the connection                         |

`statusline.cjs` is not a hook. Claude Code runs it as a status line, from your own settings;
see [statusline.md](statusline.md).

## What they do not do

- No hook searches memory or writes to it. The prompt hook adds a pointer; Claude decides
  whether to follow it. The Stop hook asks; the `memory-capture` skill writes.
- The pointer to `memory-search` is added on a new session and after a compaction, not before
  every prompt.
- No hook edits, formats or lints your project's files. The only user file a hook touches is
  `~/.claude/settings.json`, and only to keep the status bar you opted into
  ([statusline.md](statusline.md)).
- No hook connects to the gutt server. Whether it answers is learned from real gutt tool calls
  and from the tool list in the session transcript. The Stop hook's `claude -p` judge is the
  only model call a hook makes.

## The end-of-turn capture judge

`stop-capture.cjs` spawns `claude -p` with a short prompt and the turn's summary. When the
verdict is "worth keeping", the turn continues with a pointer to `memory-capture`, which
classifies the capture and applies its own rules: Insight and Incident are written directly,
Lesson, Decision and WorkingAgreement wait for your confirmation.

- `/gutt-pro:off` and `/gutt-pro:disable` stop the judge as well as recall; no subprocess is
  spawned while either is in force.
- `/gutt-pro:mode hitl` makes every capture the judge proposes wait for your confirmation,
  whatever its type. A capture you ask for yourself follows `memory-capture`'s own rules.
- The judge waits while background agents are still working. A turn that ends with subagents
  in flight is not finished, so the Stop that runs once the last agent is done judges the whole
  turn. Background shell commands and MCP monitors do not make it wait.
- The judge needs a `claude` login on the machine it runs on. In Cowork's local agent mode,
  someone who has only used the desktop app and never signed in to the CLI on that machine gets
  no verdict; the turn ends normally. The failure is logged as a `judge` line in
  `hook-errors.log`; run `claude` once in a terminal to sign in.

## Errors

Hooks never block a turn on their own failure. Most failures are logged to `hook-errors.log`
in the plugin's data directory (`${CLAUDE_PLUGIN_DATA}`), described in
[runtime-state-convention.md](runtime-state-convention.md). Two are not: an unreadable hook
payload in the session-start, session-end, connectivity and post-tool hooks, and anything at
all when `CLAUDE_PLUGIN_DATA` is unset. An empty log is not proof the hooks are healthy.

## Where the platform details live

[hook-platform-capabilities.md](hook-platform-capabilities.md) records which hook events accept
which outputs, measured on the CLI and on both Cowork surfaces.
