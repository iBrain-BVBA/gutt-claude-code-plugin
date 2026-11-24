---
name: vault-list
description: "Lists the research vaults this gutt login can read and marks the ones it owns. If an expected vault is missing, it says why: for example, a team login can't read public vaults. Read-only. Use when someone says 'list vaults', 'which vaults are there', 'what vaults can I read', 'find a vault about'. Not for asking a vault a question (vault-ask) or for setting one up (vault-steer, vault-routines)."
argument-hint: "[part of a vault name]"
---

# Vault list

Shows the vaults the person can read now. `list_vaults` on the gutt server is the authority:
it lists exactly the vaults this login can read
(`../vault-curate/references/vault-access.md`).

## Hard rules

1. **Read-only.** Call only `list_vaults`, plus ToolSearch to find it. Never write to memory,
   a page or a file.
2. **Only what `list_vaults` returned.** Never add a vault from memory, a page or an earlier
   run.
3. **No guessing.** A failed `list_vaults` call is a failure (§Refusals in `vault-access.md`),
   not an empty list.

## Steps

1. **Find the server.** Follow `vault-access.md` §Finding the server for a reader.
2. **List.** `list_vaults(query=<the words given, or "">, limit=100)`. The query matches part
   of a vault's name. If 100 come back, page with `offset` until a page holds fewer than 100.
   Each vault has `name`, `group_id` and `owned`.

## Output

Vaults this login can read, sorted by name:

```
| Vault | Group | Yours |
| <name> | vault_<name> | yes / — |
```

Close with one line: `Ask one: /gutt-vaults:vault-ask <slug> "<question>"`, using a real slug
from the table (the name with underscores written as hyphens).

If the list is empty, or the person expected a vault that isn't in it, add: "Public vaults
are read from a personal gutt login. If you're signed in with a team login, you see only your
team's vaults: log in again with your personal account (in Claude Code: `/mcp` →
`gutt-mcp-remote` → re-authorise, and don't pick a team)."

## Example invocation

`/gutt-vaults:vault-list` or `/gutt-vaults:vault-list agents`
