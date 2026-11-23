---
name: vault-steer
description: 'Creates or changes a public research vault''s charter and steering: writes Charter episodes (scope, beats, source rules, review policy, role taxonomy) and Steering episodes from the owner''s instructions, and owns the format vault-commit uses for Console steering rows. Use when the owner says ''steer vault'', ''steer <slug>'', ''new vault charter'', ''add a beat'', ''drop <topic> from the vault'', ''never include <source>'', or ''/gutt-vaults:vault-steer <slug> "…"''. Always takes the vault''s slug; there is no default vault. Not for approving findings (Console + vault-commit), running research (vault-curate) or changing the vault''s numbers, such as the stage ceiling or row cap (the Console''s Settings tab).'
argument-hint: '<slug> "<instruction>" | <slug> --charter | <slug> --show'
metadata:
  memory-identity: vault-charter
---

# Vault steer

The owner's contract with the vault: what it covers, where it looks, how strict the reviewer
is. The charter is several episodes extended by dated steering, never one giant episode.

`gutt-pro:memory-capture` owns dedup discipline, `gutt-pro:agent-memory-protocol` owns
registration and `gutt-pro:conflict-adjudication` owns clash judgement; this skill adds the
charter format.

## Memory identity

This workflow writes as **`vault-charter`** in the vault's own group `vault_<slug>`, through the
group's write tool (found at run time by `../vault-curate/references/memory-tools.md`; never by
a name you expect), with `last_n_episodes=0`. Steering aimed at a single agent is tagged with
that agent instead. The name is short, with no `--<scope>` suffix, on purpose: the dedicated
vault group is the scope. Before the first registration in a group, run the first-registration
check described in `vault-curate`'s Memory identity section, then:

```
register_agent(name="vault-charter", group_id="vault_<slug>",
  description="Holds a public research vault's charter and the owner's steering.")
```

Recall runs in two passes, own scope (`agent_id="vault-charter"`) then group-wide without
`agent_id`; the group-wide pass is never skipped, since Steering from the Console can be tagged
with the agent it targets. On an unknown-agent error re-register once; then write nothing and
show the owner the episode text instead.

## Hard rules

0. **The slug is required.** No slug, an unknown one, or a vault file whose `group_id` isn't
   `vault_<slug>`: stop with the message in `../vault-curate/references/routines.md` (for
   `--charter` on a new vault, the slug names the file you'll create). Never pick a vault
   yourself.
1. **Interactive only, owner present.** Show every episode before writing and wait for a yes.
   (vault-commit uses only the template, for steering the owner already typed or accepted on
   the Console.)
2. **One instruction per Steering episode,** with `applies_to` and, when it replaces one,
   `supersedes`.
3. **Steering can't loosen the boundaries:** public sources only, the owner approves anything
   published, no writes outside the vault group, the reviewer stays read-only. Refuse and say
   why.
4. **Numbers aren't steering.** The stage ceiling, row cap, precedent and ladder thresholds
   and the other keys in `../vault-curate/references/vault-config.md` are changed on the
   Console's Settings tab, not in a charter or Steering episode. Point the owner there
   ("pin the reviewer at stage 1" is `ladder.ceiling` 1 in Settings). Charters state none of
   them.
5. **Charter is the owner's.** Never write a Charter episode from an agent's suggestion.
6. **Clash check before writing:** assemble the effective charter
   (`../vault-curate/references/charter-assembly.md`); if the new item contradicts a live one
   without superseding it, ask whether it supersedes; if unsure, run
   `gutt-pro:conflict-adjudication` and show the result.

## Workflow

- **`--show`**: assemble and print the effective charter with episode ids. No writes.
- **`--charter`** (new vault or rework): walk the owner through scope, beats, source rules,
  review policy and, for a vault that tracks roles, a role taxonomy, one at a time, drafting
  each episode from `references/charter-template.md`. For a new vault also create the vault
  file (`../vault-curate/references/routines.md` §The vault file) with only `slug`,
  `group_id` (`vault_<slug>`, hyphens as underscores) and `console_url` (null until the
  Console exists); the vault's name, owner, question and beats go to the Console's `meta/vault`
  once it exists (`../vault-curate/references/vault-config.md` §What the vault file keeps).
- **`"<instruction>"`**: classify `applies_to`, find the item it refines or supersedes, draft
  the Steering episode, show it, write on yes.

Before a new vault's first write, confirm the group exists in `list_writable_groups`.
A missing group needs a gutt admin; stop.

## Output contract

```
vault <slug> steer: wrote <n> episode(s): <names>
effective charter now: <one line per applies_to>
```

## Degradation

No write tool for the group, or two memory servers exposing it
(`../vault-curate/references/memory-tools.md`): print the episodes for the owner to keep, write
nothing.

## Grounding Protocol

The effective charter, plus the last 4 weeks of rejection-pattern Insights when the owner asks
what to change.

## Learning Protocol

Rejection patterns that read as standing instructions are proposed by vault-brief as Console
steering rows; they become steering only when the owner accepts them.

## Example invocation

`/gutt-vaults:vault-steer <slug> "drop vendor webinars as sources"`. Example:
`/gutt-vaults:vault-steer next-agent-to-hire "drop vendor webinars as sources"`.
