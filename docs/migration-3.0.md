# Moving to gutt-pro 3.0

3.0 is a rebuild. One plugin became a suite of four, the core plugin was renamed from
`gutt-claude-code-plugin` to `gutt-pro`, and the memory machinery underneath was rewritten.

**Why it needs anything from you.** A plugin's name is its identity in Claude Code — it
namespaces every command and decides where the plugin's data lives. Renaming it therefore
creates what the platform sees as a different plugin. You are not offered an update, and
your settings do not follow you across. An ordinary version bump keeps your data; this is
not an ordinary version bump, and that is the whole reason there is work to do here.

**What you get for it.** Recall stops shouting on every prompt and is gated on whether you
have actually searched recently. Capture is judged by a model at the end of a turn instead
of a script guessing from tool names. Role plugins let you take only the parts you want.
And you can turn the whole thing off for a session without turning it off for good.

Whether you are coming from 2.x or installing for the first time, steps 1 and 4 are the
same. Everything between them is migration-only.

## What you need to do

1. Make sure you have the marketplace.
2. Note down any settings you want back.
3. Remove the old plugin.
4. Install the pieces you want.
5. Turn the status bar on — it no longer appears by itself.
6. Re-apply your settings.

Then read **Using gutt day to day**, because one command reversed meaning.

## Step 1 — Get the marketplace

**Most people need nothing here.** `gutt-plugins` is the same marketplace 2.x came from, so
if you installed the old plugin from it, it is still added.

```
/plugin marketplace list
```

**If `gutt-plugins` is listed, this step is done.** Installing with the full
`name@marketplace` spelling in step 4 refreshes that marketplace before it looks the plugin
up, so `gutt-pro` is found even though it is new to the catalogue. You do not have to add,
remove, or refresh anything by hand.

Two cases where that automatic refresh does not happen, both with the same fix:

- Claude Code older than 2.1.232, which did not refresh before the lookup.
- A marketplace supplied by managed settings or a seed directory, or a session with
  non-essential network traffic disabled.

If an install reports the plugin is not in the marketplace, refresh once and retry:

```
/plugin marketplace update gutt-plugins
```

Worth knowing regardless: third-party marketplaces like ours have background auto-update
**off** by default, so your cached copy of the catalogue can be weeks old. The refresh built
into a `name@marketplace` install is what normally covers that.

**If it is not listed**, add it:

```
/plugin marketplace add iBrain-BVBA/gutt-claude-code-plugin
```

That `owner/repo` shorthand is a GitHub repository, not a typo — **the repository kept its
old name even though the plugin was renamed**, so every marketplace link that worked before
still works.

### Only if yours points at a `marketplace.json` URL

Skip this unless `/plugin marketplace list` shows `gutt-plugins` sourced from a
`…/marketplace.json` URL rather than from a repository.

That form looks equivalent to the shorthand and is not: Claude Code downloads only the one
JSON file, while our catalogue points at each plugin by a path inside the repository — so
nothing those paths refer to ever arrives, and installs fail with `path not found`. Updating
will not fix it, because what is wrong is where the marketplace came from, not how fresh it
is. Re-add it from the repository instead:

```
/plugin marketplace remove gutt-plugins
/plugin marketplace add iBrain-BVBA/gutt-claude-code-plugin
```

Removing a marketplace uninstalls the plugins you installed from it, which on this path is
what you want anyway.

## Step 2 — Note down what you want back

**Skip to step 3 if you are on 2.7.1**, the last released 2.x. The settings below only
exist if you ran 3.0 from source.

Run `/gutt-claude-code-plugin:gutt config` and keep the output. If you have already
switched, nothing is lost — the first session after the rename reads the old directory and
tells you what did not carry over, naming the command that restores each one. It only reads;
it never moves or deletes.

**One thing to finish before you go further.** If you started `migrate-memory` and never
confirmed the notes reached gutt, finish that now. Once the local files are gone, the only
remaining copy is a backup inside the plugin's own data directory — and step 3 can delete it.

## Step 3 — Remove the old plugin

```
claude plugin uninstall gutt-claude-code-plugin@gutt-plugins --keep-data
```

**Use `--keep-data`.** Uninstalling from your last remaining scope otherwise deletes
`~/.claude/plugins/data/gutt-claude-code-plugin-gutt-plugins/` outright, and if you ever ran
`migrate-memory`, the backup in there is the only copy left of the notes it removed locally.
Keeping it costs nothing and is the difference between a recoverable mistake and a permanent
one.

The in-session `/plugin uninstall gutt-claude-code-plugin@gutt-plugins` works too, but it
opens the plugin panel to confirm — press **Esc** to close it afterwards. The shell form
above takes the flag and does not interrupt you.

⚠ **Never run both plugins at once.** If the old one is still installed when the new one
loads, both register their hooks, and the symptoms are duplicates rather than errors: two
recall injections per prompt, two capture judges spawning two model calls per turn, two
status bars. Uninstall before you install.

## Step 4 — Install the pieces you want

`gutt-pro` is the core and the only one you need. The other three are role plugins — take
the ones that match your work and ignore the rest.

```
# The core: memory search and capture, the status bar, the on/off and mode commands.
# Everyone starts here.
claude plugin install gutt-pro@gutt-plugins

# Jira tickets and pull requests: context research before you start, duplicate detection,
# effort estimates grounded in past work, bug triage, story breakdown, memory-informed review.
claude plugin install gutt-developer@gutt-plugins

# Backlogs: drafting stories from meetings and documents, finding duplicate and overlapping
# tickets across a slice, and ranking work with the evidence behind each position.
claude plugin install gutt-product@gutt-plugins

# People: onboarding someone onto a team or system, and growth programs tracked in your
# own private memory scope rather than the shared graph.
claude plugin install gutt-mentor@gutt-plugins
```

Two things worth knowing:

- **The role plugins depend on the core, and the platform handles that.** Installing any of
  them pulls in `gutt-pro` and enables it, so you cannot end up with a role plugin that has
  no memory underneath it. Installing the core alone is still the right first move.
- **A shell install does not affect the session you are in.** It loads next time you start
  Claude Code, or immediately if you run `/reload-plugins`. Installing from inside a session
  with `/plugin install <name>@gutt-plugins` tells you which of the two happened.

Then connect to your organization's memory endpoint:

```
/gutt-pro:setup
```

Restart, and authenticate through `/mcp` → `gutt-mcp-remote` → Authenticate. `/gutt-pro:health`
confirms the connection and lists what registered.

## Step 5 — Turn the status bar on

**This is the one thing you lose without being told.** In 2.x the plugin wrote the status
bar into your settings for you. 3.0 does not touch your settings unless you ask it to — so
you get no bar, and no message explaining the absence.

```
/gutt-pro:statusline
```

It installs once and survives later updates. It backs your settings file up first and
refuses outright if it finds a status bar it did not write, so it will not overwrite a
custom one.

The bar shows the connection, whether gutt is on or snoozed and until when, the capture mode
when it is not the default, the group you are writing to, context-window usage, and turns
since your last recall. Segments drop from the right as the terminal narrows.

## Step 6 — Re-apply your settings

Nothing carries across, because the data directory is named after the plugin and the plugin
was renamed. The old one is now orphaned at
`~/.claude/plugins/data/gutt-claude-code-plugin-gutt-plugins/`; the new one is
`gutt-pro-gutt-plugins`.

| What you had                          | Get it back with          |
| ------------------------------------- | ------------------------- |
| gutt switched off for good            | `/gutt-pro:disable`       |
| a capture mode other than the default | `/gutt-pro:mode hitl`     |
| an active snooze                      | `/gutt-pro:off [minutes]` |

Everything else regenerates or is simply gone: per-session state, the one-time 2.x cleanup
marker, and your per-project answers about migrating built-in memory — so a project where
you declined that offer may ask once more. Declining again is one click.

## Using gutt day to day

Five commands, and **one of them reversed meaning in 3.0** — worth thirty seconds even if
you skip everything else on this page.

| Command                     | What it does                                  |
| --------------------------- | --------------------------------------------- |
| `/gutt-pro:config`          | show what is on, and for how long             |
| `/gutt-pro:off`             | quiet for the rest of this session            |
| `/gutt-pro:off 30`          | quiet for 30 minutes (1–10080)                |
| `/gutt-pro:disable`         | off for good, surviving restarts, until `on`  |
| `/gutt-pro:on`              | back on, clearing both a snooze and a disable |
| `/gutt-pro:mode auto\|hitl` | capture automatically, or ask you first       |

### The row to read twice

**`off` is the temporary one now.** Earlier 3.0 builds had `/gutt off` survive a restart;
that behaviour moved to `disable`, and `off` became the session-length snooze. The reasoning
is that the cheap, reversible action should get the short word, and switching memory off
permanently should have to be typed on purpose.

If you are unsure which one is in force, `/gutt-pro:config` says so in words — "for this
session" against "until `/gutt-pro:on`".

### The old spellings do nothing

`/gutt …`, `/gutt:<sub>` and `/gutt-claude-code-plugin:gutt <sub>` are not aliases and not
deprecation warnings. They stop being commands: the text goes to Claude as an ordinary
prompt and no setting changes. That is deliberate. Because `off` reversed meaning in the
same release, an alias would have quietly done something other than what you meant — being
inert is the safer failure.

## Names that changed

Everything namespaced by the plugin moved with it. If any of these appear in a project's
`CLAUDE.md`, a permissions allowlist, or your own notes, update them:

| Was                                         | Now                          |
| ------------------------------------------- | ---------------------------- |
| `gutt-claude-code-plugin:memory-search`     | `gutt-pro:memory-search`     |
| `gutt-claude-code-plugin:memory-capture`    | `gutt-pro:memory-capture`    |
| `gutt-claude-code-plugin:migrate-memory`    | `gutt-pro:migrate-memory`    |
| `gutt-claude-code-plugin:output-style`      | `gutt-pro:output-style`      |
| `/gutt-claude-code-plugin:setup`            | `/gutt-pro:setup`            |
| `/gutt-claude-code-plugin:health`           | `/gutt-pro:health`           |
| `/gutt-claude-code-plugin:onboard`          | `/gutt-pro:onboard`          |
| `/gutt-claude-code-plugin:memory-retrieval` | `/gutt-pro:memory-retrieval` |

`memory-retrieval` was already a deprecated alias for `memory-search`. It still resolves,
but prefer `gutt-pro:memory-search`.

---

## Under the hood: what happened to each part

**You do not need this section to use 3.0.** It is here for two readers: anyone whose own
notes, scripts, or project files name a specific 2.x agent or setting, and anyone who wants
to know what the plugin stopped doing to their sessions.

### Commands

| 2.x               | 3.0                | Note                                                       |
| ----------------- | ------------------ | ---------------------------------------------------------- |
| `/setup`          | `/gutt-pro:setup`  |                                                            |
| `/start`          | `/gutt-pro:start`  |                                                            |
| `/health`         | `/gutt-pro:health` |                                                            |
| `/reset-counters` | **removed**        | the counters it reset no longer exist — see the status bar |

New: the five config verbs above, plus `/gutt-pro:agent-scope` and `/gutt-pro:statusline`.

### Skills

All four 2.x skills survive; the core has eleven now.

| 2.x                | 3.0                         | Note                              |
| ------------------ | --------------------------- | --------------------------------- |
| `memory-capture`   | `gutt-pro:memory-capture`   |                                   |
| `memory-retrieval` | `gutt-pro:memory-search`    | old id still resolves as an alias |
| `onboard`          | `gutt-pro:onboard`          |                                   |
| `skills-discovery` | `gutt-pro:skills-discovery` |                                   |

New in the core: `agent-memory-protocol`, `conflict-adjudication`, `graph-traversal`,
`migrate-memory`, `output-style`, `weekly-recap`. The role plugins add eleven more between
them — `/plugin` lists what your install actually has.

### Agents

This is where 3.0 cut deepest: fifteen agents became six across the suite. Most removals are
capability that became a skill, because a skill runs in your conversation with your context,
and a separate agent only earns its own window when the point is to keep work out of yours.

| 2.x agent                | 3.0                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gutt-pro-memory`        | `gutt-pro` — kept; multi-hop graph traversal is exactly the case for a separate window                                                                                                                    |
| `agent-creator`          | `gutt-pro` — kept                                                                                                                                                                                         |
| `onboarding-guide`       | `gutt-mentor`, beside a new `mentor` agent                                                                                                                                                                |
| `pr-reviewer`            | `gutt-developer`                                                                                                                                                                                          |
| `bug-investigator`       | `gutt-developer`                                                                                                                                                                                          |
| `memory-keeper`          | **Removed.** Automatic capture is the end-of-turn judge plus the `memory-capture` skill. The agent was a second, unguarded write path — it wrote directly, with no classification and no group targeting. |
| `code-simplifier`        | **Removed.** Claude Code's own `/simplify` covers it; the agent held nothing gutt-specific.                                                                                                               |
| `verify-tests`           | **Removed.** Running tests and reading coverage needs no agent.                                                                                                                                           |
| `doc-writer`             | **Removed.** Generic document generation, no memory behaviour of its own.                                                                                                                                 |
| `task-breakdown`         | **Removed.** The story-into-sub-tasks half is `gutt-developer:sub-task-breakdown`.                                                                                                                        |
| `ticket-validator`       | **Removed.** No equivalent today; definition-of-done gating is planned for a later role plugin.                                                                                                           |
| `incident-responder`     | **Removed** from the core. Planned for a DevOps role plugin, not yet shipped.                                                                                                                             |
| `retrospective-analyst`  | **Removed** from the core. Planned for a Delivery role plugin, not yet shipped.                                                                                                                           |
| `decision-auditor`       | **Removed.** A replacement core skill is planned; no equivalent today.                                                                                                                                    |
| `knowledge-gap-detector` | **Removed.** `gutt-pro:skills-discovery` covers the missing-skills half; the thin-graph half has no equivalent today.                                                                                     |

If you invoked any removed agent by name in your prompts or a project `CLAUDE.md`, that
reference now resolves to nothing.

### Hooks

You never call these — they are what the plugin does to your session, so a change here is a
change you feel. 2.x had seven hook scripts and 3.0 also has seven, but only `session-start`
and `user-prompt-submit` carry over still doing the job they did before.

| 2.x hook                  | What you experienced                                  | 3.0                                                                                                                           |
| ------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `session-start`           | session bootstrap                                     | kept; now also writes session state and sweeps expired files                                                                  |
| `user-prompt-submit`      | a `MANDATORY … you MUST` recall block on every prompt | kept, rewritten. States that memory is available and names the skill, gated on recall recency — so it stops repeating itself. |
| `post-memory-ops`         | tracked your memory tool calls                        | `post-memory-search`                                                                                                          |
| `stop-lessons`            | blocked the end of a turn to capture lessons          | `stop-capture`. A model judges whether the turn produced anything worth keeping.                                              |
| `sessionstart-setup`      | silently wrote the status bar into your settings      | **Removed.** Nothing writes your settings unless you ask; `/gutt-pro:statusline` is the only caller.                          |
| `cowork-periodic-capture` | periodic capture prompts in Cowork, idle in the CLI   | **Removed** with the agent it delegated to. Capture happens once at the end of a turn, on every platform.                     |
| `statusline`              | the status bar                                        | rebuilt, and opt-in — see step 5                                                                                              |

New: `session-end` closes the session record, and `session-connectivity` probes the memory
server in the background so the bar can tell the truth about the connection.

Subagent hooks are gone from 3.0 entirely. The separate subagent-hooks plugin in the 2.x
tree was never published and has no successor.

### Settings in `config.json`

| 2.x key                              | 3.0                                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `gutt.group_id`                      | unchanged                                                                                                                         |
| `gutt.statusline.passthroughCommand` | **Removed.** The bar no longer chains to a command of yours. Register that command directly in `~/.claude/settings.json` instead. |
| `gutt.statusline.multiLine`          | **Removed.** The bar is one line and drops segments as the terminal narrows.                                                      |
| `gutt.statusline.showTicker`         | **Removed** with the counters.                                                                                                    |

Of these, `passthroughCommand` is the only one whose removal costs you a working setup
rather than a preference: a custom status bar chained through the plugin stops appearing.

## If something is still wrong

- **No status bar** — it is opt-in; run `/gutt-pro:statusline`.
- **Install fails with `path not found`** — the marketplace was added by direct URL. Re-add
  it with the `owner/repo` form in step 1.
- **`Marketplace "gutt-plugins" not found`** — step 1.
- **Install says the plugin is not in the marketplace** — your cached catalogue predates
  `gutt-pro`. Run `/plugin marketplace update gutt-plugins` and retry.
- **Nothing is recalled or captured** — `/gutt-pro:config` reports the state and its scope;
  `/gutt-pro:on` clears both a snooze and a disable.
- **Two of everything** — the 2.x plugin is still installed. Uninstall it.
- **Commands missing right after installing** — run `/reload-plugins`, or restart.

`/gutt-pro:health` reports what registered and whether memory is reachable; `/plugin` shows
what is actually installed, which is the quickest way to tell a missing plugin from a
renamed command.
