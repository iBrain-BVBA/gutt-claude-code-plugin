# gutt-pro — Team Onboarding Guide

Two steps, always in this order: **add the marketplace once**, then **install the plugins you
want**. Adding a marketplace installs nothing by itself, which is the step people skip.

Already on 2.x? Read [`migration-3.0.md`](./migration-3.0.md) instead — the plugin was
renamed, so you have work to do that a fresh install does not.

## Step 1 — Add the marketplace

```
/plugin marketplace list                                    # already there? skip ahead
/plugin marketplace add iBrain-BVBA/gutt-claude-code-plugin
```

That `owner/repo` shorthand is the GitHub repository. It keeps its original name even though
the plugin is now `gutt-pro`, so the shorthand looks mismatched and is correct.

If it is already listed you need nothing further — installing with the full
`name@marketplace` spelling in step 2 refreshes the catalogue before looking the plugin
up. Ours is a third-party marketplace, so background auto-update is off by default; if an
install reports the plugin is missing, run `/plugin marketplace update gutt-plugins` once
and retry.

⚠ **Do not add it by linking straight to `marketplace.json`.** A
`https://raw.githubusercontent.com/.../marketplace.json` URL looks equivalent and is not:
Claude Code downloads only that one file, while our catalogue points at each plugin by a path
inside the repository — so installs fail with `path not found`. If you already added the URL
form, run `/plugin marketplace remove gutt-plugins` and add it again as above.

## Step 2 — Install what fits your work

`gutt-pro` is the core and the only one you need. The rest are role plugins — take the ones
that match your job.

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

# People: onboarding someone onto a team or system, and growth programs tracked in your own
# private memory scope rather than the shared graph.
claude plugin install gutt-mentor@gutt-plugins
```

Installing a role plugin pulls in `gutt-pro` and enables it automatically — you cannot end up
with a role plugin that has no memory underneath it. A shell install loads on your next start,
or immediately after `/reload-plugins`.

## Step 3 — Connect to memory

```
/gutt-pro:setup
```

Then restart and authenticate: `/mcp` → `gutt-mcp-remote` → Authenticate.

## Step 4 — Turn the status bar on

```
/gutt-pro:statusline
```

**It is opt-in.** Nothing writes your settings unless you ask, so there is no bar until you
run this. It shows the connection, whether gutt is on or snoozed, the group you write to,
context usage, and turns since your last recall.

## Step 5 — Learn the four commands that matter

`/gutt-pro:onboard` walks through search and capture in a live session. Beyond that:
`/gutt-pro:config` shows what is on and for how long, `/gutt-pro:off` goes quiet for this
session, `/gutt-pro:disable` goes quiet for good, and `/gutt-pro:on` undoes either.
`/gutt-pro:health` tells you what registered and whether memory is reachable.

## Admin-managed rollout

For team-wide deployment, pre-configure through managed settings instead of asking each
person to run the steps above:

- `extraKnownMarketplaces` — register the gutt marketplace as a `github` source entry, so
  relative plugin paths resolve the same way the `owner/repo` form makes them resolve
- `enabledPlugins` — auto-install `gutt-pro`, plus whichever role plugins that team needs
- the memory endpoint can be pre-set in organization settings

The status bar cannot be pre-configured this way: it writes to each person's own settings, so
each person runs `/gutt-pro:statusline` themselves.

## Cursor

1. Run `/add-plugin` and enter `https://github.com/iBrain-BVBA/gutt-claude-code-plugin`
2. Run `/gutt-pro:setup` and give it your memory endpoint URL
3. Restart → Settings → Tools & MCP Servers → connect `gutt-mcp-remote`
4. Complete the OAuth login

Cursor has no `claude mcp add` CLI; the setup wizard registers the server by writing
`~/.cursor/mcp.json` directly.

## Troubleshooting

- **Install fails with `path not found`** — the marketplace was added by direct URL. Re-add it
  with the `owner/repo` form in step 1.
- **`Marketplace "gutt-plugins" not found`** — step 1 was skipped.
- **Install says the plugin is not in the marketplace** — stale catalogue. Run
  `/plugin marketplace update gutt-plugins` and retry.
- **Commands missing right after installing** — run `/reload-plugins`, or restart.
- **"MCP server not found"** — restart the IDE after installing.
- **Authentication fails** — the endpoint URL must start with `https://` and end with `/mcp`.
- **Memory tools not showing** — check the server is connected: `/mcp` in Claude Code,
  Settings → Tools & MCP Servers in Cursor.
- **No status bar** — it is opt-in; run `/gutt-pro:statusline`.
- **Nothing is recalled or captured** — `/gutt-pro:config` reports the state and its scope;
  `/gutt-pro:on` clears both a snooze and a durable off.
- **Two of everything** — two recall injections, two status bars: the 2.x plugin is still
  installed alongside 3.0. Uninstall `gutt-claude-code-plugin`.
- **Hook errors** — see `${CLAUDE_PLUGIN_DATA}/hook-errors.log`, per
  [`runtime-state-convention.md`](./runtime-state-convention.md).
