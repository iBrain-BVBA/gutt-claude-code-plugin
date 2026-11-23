# The gutt status bar

gutt's state, live in your Claude Code status bar. Opt in with one command:

```
/gutt-pro:statusline
```

That is the only way it appears. Claude Code accepts a status line only from your own
`~/.claude/settings.json`, and nothing in the plugin writes that file unless you ask.
`/gutt-pro:statusline off` removes it again; `/gutt-pro:statusline status` reports where things
stand. Your existing settings are backed up before either change, and a status line you wrote
yourself is never touched or overwritten.

The status bar is a Claude Code terminal feature. Cowork, cloud routines and Cursor do not show
it.

```
[gutt 🟢 on acme-eng] | [Opus 5] ctx 38%
```

| Segment             | Means                                                                |
| ------------------- | -------------------------------------------------------------------- |
| 🟢                  | a gutt call came back: the server is reachable and authenticated     |
| 🟡 `- auth needed!` | sign in again: the tools are gone, or a call came back unauthorised  |
| 🔴                  | a call reached the server and failed for some other reason           |
| ⚪                  | nothing observed yet                                                 |
| ⚠                   | the status bar itself broke; see `hook-errors.log` in the data dir   |
| `on`                | recall is live                                                       |
| `off`               | durably disabled; `/gutt-pro:on` brings it back                      |
| `zzz→14:30`         | snoozed until then; `zzz` alone means for the rest of this session   |
| `hitl`              | capture mode is human-in-the-loop (shown only when it is not `auto`) |
| `!`                 | no gutt MCP server is configured; run `/gutt-pro:setup`              |
| `acme-eng`          | the group this session writes to, when one is set locally            |
| `ctx 38%`           | how much of the context window is spent                              |

## What green means

Green is earned, not assumed. It means a real call to the server came back, so it reports
reachability and authentication together. Two signals feed it, and they cover each other's
blind spots: responses to gutt tool calls say whether the server is answering and whether it
accepted your credentials; the session transcript says whether its tools are still in the tool
list, which is the only way to notice a server nobody is calling. The tool list wins where they
disagree: once the tools have gone, it does not matter how recently a call last worked.

A quiet session stays green: an observation does not go stale just because you have not touched
memory for a while. The exception is a green that nothing corroborates. If the transcript cannot
be read at all, a success older than ten minutes lapses back to ⚪. Amber and red stay either
way, because a warning that expires takes with it the one instruction you could have acted on.

A configuration check at session start cannot do this: a hook cannot open a socket, so it can
only establish that a server is named in a settings file. That is reported separately, as `!`,
and only when the check positively found nothing configured. A check that could not tell says
nothing at all.

## Narrow terminals

The two informational segments, context usage and then the group, drop as the terminal
narrows, in that order. Everything else either reports a fault or names the fix, and none of it
drops, so `- auth needed!` survives on the narrowest bar.

## When it goes wrong

- **Upgrading from 2.x?** The old status bar stops working: it pointed into a 2.x path that no
  longer exists, and the plugin removes the dead entry for you. Run `/gutt-pro:statusline` once
  to get the new one, which survives future upgrades.
- **Disappeared on its own?** Claude Code sometimes drops `statusLine` while rewriting
  `settings.json` ([anthropics/claude-code#62486](https://github.com/anthropics/claude-code/issues/62486)).
  The next session restores it, or run `/gutt-pro:statusline` again.
- **Blank, or showing `⚠`?** Run `/gutt-pro:statusline status`. It follows both links behind the
  entry, the stable path in your `settings.json` and the renderer that path forwards to, and says
  which one broke, including a repair that failed earlier in the session. A `⚠` means the bar is
  running and something inside it threw; the reason is in `hook-errors.log` in the plugin's data
  directory.
