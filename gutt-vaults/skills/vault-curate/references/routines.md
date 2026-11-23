# Routines: one set of four per vault

Every vault skill takes the vault's slug as its first argument and stops without it. There is
no default vault, even when the repo holds only one vault file. A routine's prompt therefore
names the vault on every line it runs.

| Routine                  | Default time (owner's zone) | Prompt line                                    |
| ------------------------ | --------------------------- | ---------------------------------------------- |
| `vault-<slug>-curate`    | Daily 02:40                 | `/gutt-vaults:vault-curate <slug>`             |
| `vault-<slug>-commit`    | 12:10 and 19:10             | `/gutt-vaults:vault-commit <slug>`             |
| `vault-<slug>-brief`     | Fri 13:20                   | `/gutt-vaults:vault-brief <slug>`              |
| `vault-<slug>-freshness` | Sun 03:10                   | `/gutt-vaults:vault-curate <slug> --freshness` |

Each routine runs against the owner's repo, which holds the vault file (below) and enables the
`gutt-pro` and `gutt-vaults` plugins in its `.claude/settings.json`, with the gutt memory
connector granted. Times are set on the routine, not on the Console: the Console's Settings tab
shows them read-only. An owner with several vaults staggers the curate routines about 20
minutes apart so runs don't overlap.

The same skills run in Claude Code in the terminal, the desktop app's Code tab and Cowork, for
an owner who wants to watch or steer a run.

## The vault file

One small JSON file per vault in the owner's repo, holding only `slug`, `group_id` and
`console_url` (`vault-config.md` §What the vault file keeps). Look for it in this order and use
the first one found:

1. `vaults/<slug>.json` (the layout of the `gutt-vault-starter` template repo);
2. `.claude/vaults/<slug>.json`.

If both exist and differ, stop: say which two files disagree and write nothing. A new vault's
file goes in `vaults/` unless the repo already keeps its vault files in `.claude/vaults/`.

## Missing or unknown slug

A skill started without a slug stops before any read and says:

```
<skill> needs the vault's slug: /gutt-vaults:<skill> <slug>. Vault files in this repo: <slugs from vaults/*.json and .claude/vaults/*.json, or none>.
```

A slug with no vault file stops the same way, naming the files it looked for. A vault file
whose `group_id` isn't `vault_<slug>` (hyphens as underscores) stops the run: the file and the
slug disagree about where the vault lives.

## Example

For a vault with slug `next-agent-to-hire` (example), the curate routine's prompt is
`/gutt-vaults:vault-curate next-agent-to-hire` and its group is `vault_next_agent_to_hire`.
