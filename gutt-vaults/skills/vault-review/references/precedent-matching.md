# Precedent matching

## Recall order

1. **Scoped** (`agent_id="vault-reviewer"`): your own Verdicts and every `Verdict: override …`.
   Overrides are your most valuable data: each one is a class where you were wrong.
2. **Group-wide**, no `agent_id`: the owner's Verdicts (tagged `vault-librarian`).
3. The effective charter and `Insight:` episodes with `insight_type: verdict_pattern`.

Use `search_memory_nodes(entity="Verdict", group_ids=["vault_<slug>"], query=<claim + beat>)`
for candidates, then `get_episodes_for_entity` on each to read the Verdict **episodes**.
History reads set `include_invalidated=true` on `search_memory_facts`.

## Recording a precedent

Record each precedent by its Verdict **episode uuid**. `search_memory_facts` returns the
Verdict's `DECIDES` fact with an `episodes` array of two uuids, the Finding's episode and the
Verdict's; keep the one whose `get_episode` name starts with `Verdict:`. Never record a node
id or a semantic id (`vault_<slug>:Verdict:Verdict-human:13`): similar names collide and
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

1. `search_memory_nodes(entity="Verdict", group_ids=["vault_<slug>"], query="<beat>
<claim_type> <role or subject>", max_nodes=20)`; page with `offset` while `has_more` and
   the results are still on topic.
2. For each candidate, `get_episodes_for_entity` and keep episodes whose name starts
   `Verdict:` and whose body says `Decided by: human` and the row's proposal type.
3. Read `Claim type`, `Source domain`, `Source class`, `Beat`, `Significance`, `Card
section` and the decision from the episode body; those lines are what the features above
   are matched on. An older Verdict may have no `Source class` line: take it from the
   Finding's source document node (`source_class` attribute), or infer it from the domain (a
   vendor's own site → vendor, a regulator or an official journal → primary, a university,
   arXiv or NBER → independent, a news site → press). An older card-diff Verdict may name the
   section only in its title (`RoleCard: <role> — <section> <date>`).
4. Record the episode's **uuid**, the 36-character `xxxxxxxx-xxxx-…` value. `get_episode` and
   `get_episodes_for_entity` return only a semantic `id` (`vault_<slug>:Episodic:Verdict-…`),
   which is not a uuid and must not be recorded. Get the uuid from
   `search_memory_facts(center_node_id=<Verdict node id>, include_invalidated=true)`: each
   fact's `episodes` array holds uuids; keep the one whose `get_episode` name starts
   `Verdict:`. Never record a node id or a semantic id.

Budget about 15 memory calls per batch: one search per distinct (beat, claim type) pair in the
batch, then reads for the top candidates.

## Agreement with time decay

Weight each precedent `w = 0.5 ^ (age_days / review.precedent_half_life_days)`. Steering
newer than a precedent that it contradicts sets that precedent's weight to 0. Agreement =
weighted share of the majority decision. Count N on unweighted precedents.

Auto-eligible when: N ≥ `review.precedents_min`, agreement ≥ `review.precedent_agreement`, and
no override in the class within `review.override_cooloff_days` (keys and defaults:
`../../vault-curate/references/vault-config.md`).

## Worked example

With the default settings (N 5, agreement 0.90, half-life 60 days). Row: beat `pricing`, claim_type `pricing`, source `intercom.com` (vendor), significance 2,
proposal_type `finding`. Precedents: 7 human Verdicts in that class, 6 rejected ("vendor
pricing page restating docs"), 1 approved 150 days ago. Weights: rejections ≈ 0.8 each, the
approval ≈ 0.18. Agreement ≈ 4.8 / 4.98 = 0.96 → eligible. Stage for the class is 1 →
`auto_reject`, confidence 0.96, precedents: the 6 rejection Verdict episode uuids.
