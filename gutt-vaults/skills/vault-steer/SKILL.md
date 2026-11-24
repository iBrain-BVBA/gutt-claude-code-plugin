---
name: vault-steer
description: 'Creates or changes a public research vault''s charter and steering: writes Charter episodes (scope, beats, source rules, review policy, role taxonomy) and Steering episodes from the owner''s instructions, and owns the format vault-commit uses for Console steering rows. Use when the owner says ''steer vault'', ''steer {slug}'', ''new vault charter'', ''add a beat'', ''drop {topic} from the vault'', ''never include {source}'', or ''/gutt-vaults:vault-steer {slug} "…"''. Always takes the vault''s slug; there is no default vault. Not for approving findings (Console + vault-commit), running research (vault-curate) or changing the vault''s numbers, such as the stage ceiling or row cap (the Console''s Settings tab).'
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
a name you expect), with `last_n_episodes=0`. Every Charter and Steering episode is tagged
`vault-charter`, Steering aimed at a single agent included (its `target_agent` header line
names that agent): readers find the charter through this node
(`../vault-curate/references/charter-assembly.md` §Read). The name is short, with no `--<scope>` suffix, on purpose: the dedicated
vault group is the scope. Before the first registration in a group, run the first-registration
check described in `vault-curate`'s Memory identity section, then:

```
register_agent(name="vault-charter", group_id="vault_<slug>",
  description="Holds a public research vault's charter and the owner's steering.")
```

Recall runs in two passes, own scope (`agent_id="vault-charter"`) then group-wide without
`agent_id`; the group-wide pass is never skipped, since older Steering can be tagged with the
agent it targets. On an unknown-agent error re-register once; then write nothing and
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
  `group_id` (`vault_<slug>`, hyphens as underscores), `console_url` (null until the
  Console exists) and, when the owner keeps the vault on a server that starts a group on its
  first write (such as the shared gutt stage), `memory_connector` with that connector's name
  or names. Then **publish the vault's Console**: this is the step that creates it, and no
  other skill does. Follow `../vault-pages/SKILL.md` §Publish a page, page `console`,
  which writes the new URL into the vault file's `console_url` and seeds the Console's
  `meta/vault` with the vault's name, slug, group, owner, question and beats
  (`../vault-curate/references/vault-config.md` §What the vault file keeps). No Artifact tool
  here: leave `console_url` null and tell the owner to run
  `/gutt-vaults:vault-pages <slug> publish console` where they have one; vault-curate stops
  until the Console exists.
- **`"<instruction>"`**: classify `applies_to`, find the item it refines or supersedes, draft
  the Steering episode, show it, write on yes.

Before a vault's first write, find its server with
`../vault-curate/references/memory-tools.md` step 2. Every write waits for that.

- **`memory_connector` set:** the named connector is the server. For `--charter` on a new
  vault, no episode back is expected (a vault has none before its charter), and so is its id
  missing from `list_writable_groups` on a server that starts groups on the first write; the
  first write, through the generic `add_memory` with `group_id="vault_<slug>"`, starts the
  group. Check that write as step 6 says. Rejected, or acknowledged but never seen: stop, and
  tell the owner that `vault_<slug>` must be created on, or granted to them on, the server
  `memory_connector` names (a gutt admin does that where groups are provisioned). For any
  other mode, or an existing vault, no episode back means the connector doesn't hold the vault:
  stop as **None** below.
- **Not set:** the server is the one that lists `vault_<slug>` as writable. Not listed
  anywhere: the group needs a gutt admin to create it, unless the owner's server starts groups
  on the first write, in which case they set `memory_connector` to that connector's name.
- **None, or two:** write nothing and print the episodes (§Degradation). Say which case it is
  and the fix: with `memory_connector` unset, set it (or have the group created, above); with
  it set, name the connector that isn't connected, or the two prefixes found for it.

**Create the vault where the server has vaults.** If that server also exposes `create_vault`
(the shared gutt stage does), writes to `vault_<slug>` are refused until the vault exists and
this login owns it. Before the first write of `--charter`, check
`../vault-curate/references/vault-access.md`:

1. Check the name (the slug with hyphens as underscores) against §Names. If it breaks a rule,
   stop before any call, name the rule, and suggest a slug that keeps to it.
2. `list_vaults(query="<name>", limit=100)` and look for `vault_<slug>`:
   - **Listed, `owned: true`:** the vault exists and is this login's. Go on.
   - **Listed, `owned: false`:** someone else owns that name. Stop and ask for another slug.
     Never write to it.
   - **Not listed:** show the owner what `create_vault` does, then wait for a yes. It makes
     this login the vault's only writer. From a personal login, every personal login can read
     the vault. From a team login, only that team can read it. On a yes, call
     `create_vault(name="<name>")` and check that the returned `group_id` is `vault_<slug>`.
     A refusal is explained with §Refusals, and nothing is written.
3. A write still refused with `Only the owner can add to` means the vault belongs to another
   login. Stop and tell the owner that only the login that created the vault can write to it.

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
`/gutt-vaults:vault-steer example-vault "drop vendor webinars as sources"`.
