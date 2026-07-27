---
name: conflict-adjudication
description: "Work out what to do when two stored memories disagree. Given one specific pair, gather the evidence — who asserted each, what standing they hold, whether the two even apply to the same project — then recommend exactly one of supersede, coexist, or escalate, with the evidence cited. Reads only: it never rewrites or removes memory. Triggers on: these two memories disagree, which decision wins, conflicting decisions, contradicting lessons, is this decision still authoritative, supersede or keep both, who has authority here, resolve this conflict."
---

# Conflict Adjudication

Two memories say incompatible things. This skill decides what to recommend about
them: retire the older one, let both stand, or put it in front of a human.

It runs on **one pair you already hold** — typically because a capture path
searched before writing and turned up something that contradicts what was about
to be stored, or because a reader noticed two stored memories disagree.

The evidence is the organization itself: who asserted each memory, what role
they hold, who reports to whom, and whether the two apply to the same project.
That evidence comes out of meeting transcripts, so it is uneven — most of this
skill is about knowing when it is good enough to act on.

## Hard rules (non-negotiable — read first)

1. **A pair comes in — never go hunting for one.** Two specific memories, one
   recommendation. This skill does not sweep the graph looking for
   contradictions; "find all the conflicts" is a different job and not this one.
   With no pair in hand, ask which two memories are in question and stop.

2. **Recommend, never act.** Name what should happen and why — the caller
   decides and writes. Never call a delete tool, never write a correcting
   episode, and never describe a memory as "superseded" in the past tense. It
   isn't, until someone acts on the recommendation.

3. **Escalating is the honest default.** `supersede` and `coexist` have to be
   earned from evidence; `escalate` is where you land when they aren't. Most
   real pairs escalate, and that is a correct outcome, not a failure — a
   well-evidenced "a human should look at this, here's why" is the product.
   Never manufacture confidence the evidence doesn't support.

4. **Check both memories are real, current, and ours.** Before weighing
   anything, read both summaries and at least one source episode each. Discard
   the pair if either side is:
   - a **teaching example** — training, onboarding, workshop, or demo material
     often contains invented decisions with placeholder names, written in
     exactly the vocabulary of a real conflict ("superseded", "invalidated");
   - **another organization's** — a client's or a conference speaker's practice
     recounted in our transcripts is not our decision, even when a colleague is
     the one recounting it;
   - **aspirational** — "should be", "we're considering", "the plan is" records
     an intention, not a decision in force. Weigh follow-through over phrasing
     though: a proposal the team visibly acted on for months is a real position,
     whatever tense it happened to be recorded in.

   Judge by the primary source, not by every episode attached. A memory whose
   episodes mix a genuine transcript with demo or eval material that merely
   _re-cites_ it is still real — the re-citation is weak corroboration, not
   grounds to discard.

   Discarding is an exit, not a verdict. Report `no adjudication`, name which
   side failed and why, and cite the episode that shows it. Don't reach for
   `escalate` instead — there is nothing here for a human to decide.

5. **Never read a relationship's direction from `get_node_edges`.** It puts the
   node you asked about in the source slot every time, whichever way the
   relationship actually points, so every edge that truly points _inward_ comes
   back reversed. The tell: every result names your own query as the source.
   Confirm with `get_entity_edge` on the edge's UUID, or an uncentered
   `search_memory_facts`. Get this wrong and the org chart inverts — ask about a
   founder and you'll be told they report to the people who report to them.

6. **Weigh corroboration, not single edges.** A role or reporting line asserted
   in one episode is a passing mention; the same one across several episodes is
   evidence. Check each fact's `episodes` list and prefer the well-corroborated
   reading. This matters because role edges over-fire: a sentence that merely
   mentions a role — someone _seeking_ a CTO, _talking to_ a CTO, _discussing
   the importance of_ a CTO — can attach that role to the person. Corroboration
   is the most reliable signal available here; it outperforms dates, which are
   missing on roughly half of these relationships. It counts only _after_ rule
   4: a rehearsed demo retold across five sessions is five retellings of one
   pitch, not five confirmations of a decision.

## What to gather

Four things, for each side of the pair. Any of them may be missing — say so and
carry on; partial evidence is normal and is itself an input to the verdict.

| Evidence     | What you're after                              | How                                                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scope**    | Which project or domain each memory applies to | A scope relationship where one exists — but often none does; then triangulate from what the memory was produced by or attached to, and say which you relied on. If it points at a ticket or product, hop up to the project              |
| **Author**   | Who asserted it                                | No relationship reliably links a memory to its author — read the source episode and take the speaker. A person relationship on the memory is a bonus, not the norm                                                                      |
| **Standing** | Each author's role and reporting lines         | Their role and reporting relationships, direction confirmed per rule 5, corroboration counted per rule 6. Always filter by relationship type — an unfiltered pull on a senior person can blow the tool's output limit and fail outright |
| **Timing**   | When each became true                          | The validity date where present; otherwise creation time, which is when it was _recorded_, not when it became true — weaker, and say so                                                                                                 |

**Match on an edge's shape, not just its name.** The extractor may call a
relationship anything, but entity types are a fixed set — a reporting line is
person-to-person, a role is person-to-role. So search wider than the exact name,
then keep what has the right endpoints: an invented synonym still carries real
evidence, and an edge with the wrong endpoints isn't the relationship it claims
to be, whatever it's called.

**Before comparing two people, make sure each is _one_ person.** The same
colleague often exists as several nodes holding different facts, and senior
people — the ones most likely to be either side of a conflict — are worst
affected. A shared email settles it. With no email to compare, say the identity
is unresolved and treat that side's standing as thin rather than guessing.

Two lookups fail in confusing ways. Fetching a node by the raw UUID carried in a
fact can come back as an authorization error rather than the node — retry with
the readable id before concluding anything is missing or forbidden. And pulling
every episode for an entity can exceed the output limit on quite ordinary nodes;
reach episodes through the `episodes` list on a specific fact instead.

## Reaching a verdict

An order of consideration, not a formula — every rung needs judgment, and the
evidence differs every time.

1. **Scope first — do these even collide?** Different projects, or different
   altitude (a team-wide practice and one project's local variation), and there
   is no conflict to resolve: **coexist**. This is the cheapest question and the
   evidence behind it is the most reliable, so ask it first. Note that scope
   relationships point at several kinds of target — a project, a ticket, a
   product, a domain — so normalize before concluding two scopes differ.

2. **Then weigh standing and timing together.** Hold both: who had the standing
   to make this call, and which came later.
   - **Pointing the same way** — the later memory also carries at least equal
     standing: **supersede**. This is the clean case.
   - **Pointing opposite ways** — the later memory comes from someone with less
     standing than the earlier one: **escalate**. Do not let recency quietly
     override authority; a newer memory from a junior colleague is exactly the
     case a human should see. Say plainly in the recommendation which way each
     signal pointed.
   - **Equal standing on both sides** — the same person reversing themselves, or
     two peers — leaves timing to decide it alone: **supersede**, saying that
     standing was neutral rather than absent.
   - **One signal missing entirely, the other clear and well-corroborated** — it
     may carry the verdict alone. Say which one you leaned on and that the other
     was unavailable.

3. **Escalate on thin evidence, and name what was thin.** The distinction from
   the case above is whether the evidence is _absent_ or _unreliable_: absent
   evidence can be worked around, unreliable evidence can't. Escalate when a
   signal is present but untrustworthy — standing resting on a single
   uncorroborated mention, contradictory reporting lines, duplicate people you
   couldn't consolidate — or when too little is left to stand on: no recoverable
   author on either side, or both sides undated. Name the specific gap, so the
   human knows what to supply.

Retiring a memory never means deleting it. The older one stays in the graph,
marked as no longer current, so the record of what was decided and when survives.
Say that explicitly whenever you recommend `supersede`.

## What to hand back

One verdict, and the evidence behind it. The consumer renders this for a human,
so the evidence has to stand on its own:

- **verdict** — exactly one of `supersede`, `coexist`, `escalate`
- **pair** — both memories by id, with a one-line statement of what each claims
- **for supersede**: which one is superseded and which replaces it
- **reasoning** — which rung decided it, and which signals pointed where
- **evidence** — every fact leaned on, cited: nodes by readable id, edges and
  episodes by UUID, with dates on anything time-sensitive
- **gaps** — what was missing, unverifiable, or contradictory. Required on
  `escalate`, and worth stating on the others too

Never present a verdict without its evidence — an unsupported recommendation is
worse than an escalation.

## Degradation

Needs the memory read tools; the navigation ones are separately gated and may be
absent. Probe rather than assume.

Without navigation you keep search but lose reliable relationship walking: scope
and authorship usually survive, standing rarely does. Gather what you can, then
apply rule 3 as written and note that the org evidence was unavailable — never
downgrade to guessing at authority. Never stall.

## References

- Finding the entry memories: `memory-search`. Walking their relationships,
  including the stale-edge and hub-node hazards: `graph-traversal`.
- Writing a correction once a human has approved one: `memory-capture`.
- Tool parameters, return shapes, and gating — the memory tool reference in
  `memory-search` (`references/tools.md`). Single source; not restated here.
