# Precedent matching

## Recall order

1. **Scoped** (`agent_id="vault-reviewer"`): your own Verdicts and every `Verdict: override …`.
   Overrides are your most valuable data: each one is a class where you were wrong.
2. **Group-wide**, no `agent_id`: the owner's Verdicts (tagged `vault-librarian`).
3. The effective charter and `Insight:` episodes with `insight_type: verdict_pattern`.

Find candidates with `search_memory_nodes(entity="Verdict", group_ids=["vault_<slug>"], …)`,
then read each one's own Verdict episode through its `DECIDES` edge (§Finding the Verdict
episodes). History reads set `include_invalidated=true` on `search_memory_facts`.

## Recording a precedent

Record each precedent by its Verdict **episode uuid**: one of the uuids in the `episodes`
array of the Verdict node's own `DECIDES` fact, the one whose `get_episode` name starts with
`Verdict:`. Never record a node id or a semantic id (`vault_<slug>:Verdict:Verdict-human:13`): similar names collide and
renumber, so the precedent stops resolving and the Console row has to be re-keyed by hand.

## What counts

- `decided_by: human` only. Your own past auto decisions are not precedents, except as the
  "call an override reversed".
- Same `proposal_type` as the row. A re-check verdict is never a precedent for admitting a
  new Finding.
- An Override counts as the human decision for that row, and supersedes the Verdict it
  reverses.

## Similarity

A precedent is **similar** when all of these match: `beat`, `claim_type`, `source_class`,
significance band; and the claim is semantically close (same kind of assertion about the same
kind of subject). For `card_update` rows, match the card `section` instead of `beat`.

`source_domain` is not required to match: requiring it left most rows short of the
precedents they need, since the vault rarely sees one domain twice in the same beat. A same-domain
precedent counts double toward the weighted agreement (not toward N). A domain never seen in
any Verdict still escalates under hard rule 2.

Steering zeroes the weight of a precedent it contradicts; it also zeroes precedents on topics
it now blocks (for example, rows a Steering item no longer lets the librarian propose), since
no future row can resemble them.

## Finding the Verdict episodes

Two exact reads per candidate, both by id. Each returns one small result, so nothing needs
slicing.

1. `search_memory_nodes(entity="Verdict", group_ids=["vault_<slug>"], query="<beat>
<claim_type> <role or subject>", max_nodes=20)`; page with `offset` while `has_more` and
   the results are still on topic. Each node carries `attributes` with `decision`,
   `decided_by` and `proposal_type`: drop a candidate whose `decided_by` isn't `human` or
   whose `proposal_type` differs from the row's before reading anything more. A node without
   those attributes stays a candidate; its episode settles it.
2. For each candidate, `get_node_edges(node_id=<Verdict node id>, edge_type="DECIDES")`. This
   returns only that Verdict's own `DECIDES` facts; each fact's `episodes` array holds the
   uuids (36-character `xxxxxxxx-xxxx-…`) of the episodes that wrote it.
3. `get_episode(<uuid>)` on each uuid until one's name starts `Verdict:`. Its body says
   `Decided by: human` and the proposal type, and carries `Claim type`, `Source domain`,
   `Source class`, `Beat`, `Significance`, `Card section` and the decision: the features
   above are matched on those lines. Record **that uuid** (the argument you passed, not the
   semantic `id` the episode comes back with). A Verdict node none of whose `DECIDES` episodes
   is a `Verdict:` episode (only an Insight mentions it) is not a precedent.
4. An older Verdict may have no `Source class` line: take it from the Finding's source
   document node (`source_class` attribute), or infer it from the domain (a vendor's own site
   → vendor, a regulator or an official journal → primary, a university, arXiv or NBER →
   independent, a news site → press). An older card-diff Verdict may name the section only in
   its title (`RoleCard: <role> — <section> <date>`).

Never look a Verdict's uuid up with `search_memory_facts(center_node_id=<Verdict node id>)`:
the centre only biases a search ranked by the query over the whole group, so it returns other
Verdicts' facts and often not the centre's own (on 24 Nov 2026 a search centred on one Verdict
returned five other Verdicts' `DECIDES` facts and none of its own, and the run's precedents all
came back empty). `get_episodes_for_entity` isn't a substitute either: it lists every episode
that mentions the Verdict, Insights included, without uuids.

Budget: one search per distinct (beat, claim type) pair in the batch, then two reads per
candidate (step 2 and step 3). Read a pair's candidates in the search's order and stop once
you hold `review.precedents_min` similar human precedents that all agree, or after 10
candidates.

## Agreement with time decay

Weight each precedent `w = 0.5 ^ (age_days / review.precedent_half_life_days)`. Steering
newer than a precedent that it contradicts sets that precedent's weight to 0. Agreement =
weighted share of the majority decision. Count N on unweighted precedents, leaving out every
precedent whose weight is 0: a precedent Steering has invalidated says nothing about this row,
so invalidated precedents never make up the minimum count for one usable verdict. All
precedents at weight 0 means none is usable: escalate with "no similar precedent" (SKILL.md
Step 3).

Auto-eligible when: N ≥ `review.precedents_min`, agreement ≥ `review.precedent_agreement`, and
no override in the class within `review.override_cooloff_days` (keys and defaults:
`../../vault-curate/references/vault-config.md`).

## Worked example

With the default settings (N 5, agreement 0.90, half-life 60 days). Row: beat `pricing`, claim_type `pricing`, source `intercom.com` (vendor), significance 2,
proposal_type `finding`. Precedents: 7 human Verdicts in that class, 6 rejected ("vendor
pricing page restating docs"), 1 approved 150 days ago. Weights: rejections ≈ 0.8 each, the
approval ≈ 0.18. Agreement ≈ 4.8 / 4.98 = 0.96 → eligible. Stage for the class is 1 →
`auto_reject`, confidence 0.96, precedents: the 6 rejection Verdict episode uuids.
