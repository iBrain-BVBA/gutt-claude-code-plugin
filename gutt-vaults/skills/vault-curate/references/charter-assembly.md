# Assembling the effective charter

Shared by vault-curate, vault-review, vault-brief, vault-steer and vault-commit.

## Read

Never list the whole group: `get_episodes` on `vault_<slug>` returns every Finding, Verdict and
Run as well (80k to 500k characters), its offset is ignored, and a reader without a shell
can't slice it. Read the charter through what points at it instead. Every read passes
`vault_<slug>`, never another group; a search with no `group_ids` searches your personal scope.

1. **The charter's own episodes.** Charter and Steering are written as `vault-charter`, so
   they hang off that agent's node. Call
   `get_episodes_for_entity(entity_id="vault_<slug>:Agent:vault-charter", last_n=20)` and page
   with `offset` (+20) while `has_more` is set (this tool's offset works, unlike
   `get_episodes`'s). Keep the episodes whose name starts `Charter:` or `Steering:`; skip
   `Config:` and anything else. The id doesn't resolve: find the node with
   `search_memory_nodes(query="vault-charter", entity="Agent", group_ids=["vault_<slug>"])`,
   taking the node named exactly `vault-charter`; none → step 1 contributes nothing.
2. **The Console's index.** Steering written before every Charter and Steering episode was
   tagged `vault-charter` may hang off the agent it targets instead, so step 1 can't see it.
   Add every id in the Console's `meta/charter.episode_ids` (the last assembly) and the
   `committed_episode` of every `steering` row with `status: committed`. Read each id step 1
   didn't return with `get_episode` (it takes a uuid or a semantic id).
3. **Ids that don't resolve.**
   - A committed `steering` row's episode: the owner's instruction can't be read. Stop the run
     before any research or write, with "charter incomplete: steering row <id> → <episode id>
     not found".
   - An id only `meta/charter.episode_ids` holds: the index recorded something that isn't in
     the vault. Leave it out, put "charter index id <id> not found" in the Run's `errors[]`,
     and the next `meta/charter` write drops it.
4. **Every Charter section is there.** `scope`, `sources`, `review` and one `beat:<name>` for
   each beat in `meta/vault.beats` need a Charter episode, and so does `roles` when the last
   assembly had one (a `roles` section in `meta/charter.sections`). One missing: stop before
   any research or write, with "charter incomplete: no <applies_to> Charter".
5. For each episode, parse the header lines the templates in
   `../../vault-steer/references/charter-template.md` define: `applies_to`, `supersedes`,
   `date`, `target_agent` (steering aimed at one agent).

No Console (vault-steer `--charter` on a new vault): there is no charter to read yet. Any other
run that can't read `meta/charter` or `steering` stops with "charter incomplete: Console
unreadable", since step 1 alone can miss older Steering.

The budget: one page per 20 charter episodes, plus one `get_episode` per indexed id step 1
didn't return. Both grow with the charter, never with the vault.

vault-reviewer doesn't run these steps: vault-curate sends it the ids on a `charter:` line and
it reads each with `get_episode` (`../../vault-review/SKILL.md` Step 1.2), then applies
§Assemble below.

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
  episode_ids: [<every Charter/Steering episode used, as get_episode returned its id>]
  clashes: [<pair>]
```

Every run records `episode_ids` in its Run, so each finding traces to the charter that
produced it. Record each id as `get_episode` or `get_episodes_for_entity` returned it, never
one built from an episode's name: a hand-built id that resolves to nothing poisons the index
for the next run (step 3).

## Recent steering

List Steering newer than `review.recent_steering_days` (`vault-config.md`) separately: the
reviewer escalates any row touching one.

## Numbers in an older review charter

A review-policy charter written before Settings existed may state a stage ceiling, precedents
needed, an agreement threshold or an override window. Put them under `legacy_numbers` in the `review` section;
`vault-config.md` §Numbers still in an older review-policy charter says when they apply.
