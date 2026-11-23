# Assembling the effective charter

Shared by vault-curate, vault-review, vault-brief, vault-steer and vault-commit.

## Read

Group-wide in `vault_<slug>`, no `agent_id`:

1. `get_episodes(group_id="vault_<slug>", last_n=50)` and page while `has_more`, keeping
   episodes whose name starts `Charter:` or `Steering:`. (Search alone can miss old ones.)
2. For each, parse the header lines the templates in
   `../../vault-steer/references/charter-template.md` define: `applies_to`, `supersedes`,
   `date`, `target_agent` (steering aimed at one agent).

## Assemble

1. Group by `applies_to`: `scope`, `beat:<name>`, `sources`, `review`, `brief`,
   `roles` (role taxonomy), `agent:<name>`.
2. Order each group by date, oldest first. The Charter episodes are the base.
3. Apply each Steering item in order. An explicit `supersedes: <episode name>` removes that
   episode's instruction. Otherwise the newer item refines the older one; both stay.
4. Two items that genuinely clash (both can't be followed, no `supersedes`): run
   `gutt-pro:conflict-adjudication` on the pair; follow the older item until the owner
   decides, and raise the clash on the Console.

## Output

```
effective_charter:
  scope: <text>            # audience, in scope, out of scope
  beats: {<name>: {look_for, window_days, primary_source_types, max_items, freshness_days}}
  sources: {allow: [], deny: [], primary_means: <text>}
  review: {always_escalate: [], legacy_numbers: {}}   # numbers: vault-config.md
  brief: <text>
  roles: [<role names>]    # role taxonomy, for vaults that track roles
  agent_steering: {<agent>: [<text>]}
  episode_ids: [<every Charter/Steering episode used>]
  clashes: [<pair>]
```

Every run records `episode_ids` in its Run, so each finding traces to the charter that
produced it.

## Recent steering

List Steering newer than `review.recent_steering_days` (`vault-config.md`) separately: the
reviewer escalates any row touching one.

## Numbers in an older review charter

A review-policy charter written before Settings existed may state a stage ceiling, precedents
needed, an agreement threshold or an override window. Put them under `legacy_numbers` in the `review` section;
`vault-config.md` §Numbers still in an older review-policy charter says when they apply.
