---
name: conflict-adjudication
description: "Work out what to do when two stored memories disagree. Given one specific pair, gather the evidence — who asserted each, what standing that carries, whether the two even apply to the same thing — then recommend exactly one of supersede, coexist, or escalate, with the evidence cited. Reads only: it never rewrites or removes memory. Triggers on: these two memories disagree, which decision wins, conflicting decisions, contradicting lessons, is this decision still authoritative, supersede or keep both, who has authority here, resolve this conflict."
---

# Conflict Adjudication

Two memories say incompatible things. This skill decides what to recommend about
them: retire the older one, let both stand, or put it in front of a human.

It runs on **one pair you already hold** — typically because a capture path
searched before writing and turned up something that contradicts what was about
to be stored, or because a reader noticed two stored memories disagree.

The evidence is the organization itself: who or what asserted each memory, what
standing that carries, and whether the two apply to the same thing. It is
extracted from whatever happened to be ingested, so it is uneven — most of this
skill is about knowing when it is good enough to act on.

## Hard rules (non-negotiable — read first)

1. **A pair comes in — never go hunting for one.** Two specific memories, one
   recommendation. This skill does not sweep the graph looking for
   contradictions; "find all the conflicts" is a different job and not this one.
   With no pair in hand, ask which two memories are in question and stop.

2. **Recommend, never act.** Name what should happen and why — the caller
   decides and writes. Never call a delete tool, never write a correcting
   memory, and never describe a memory as "superseded" in the past tense. It
   isn't, until someone acts on the recommendation.

3. **Escalating is the honest default.** `supersede` and `coexist` have to be
   earned from evidence; `escalate` is where you land when they aren't. (A pair
   that fails rule 4 exits before any of this applies.) Plenty of real pairs
   escalate, and that is a correct outcome, not a failure — a well-evidenced "a
   human should look at this, here's why" is the product. Never manufacture
   confidence the evidence doesn't support.

4. **Check both memories are real, settled, and ours.** Before weighing
   anything, read both summaries and trace each back to its source. The question
   is whether the memory records something this organization actually decided.
   Discard the pair if either side fails that:
   - **not real** — illustrative, rehearsed, or test material records an
     invented decision, and it tends to arrive in the exact vocabulary of a
     genuine conflict, so surface wording won't tell you. The source will;
   - **not ours** — someone else's practice recounted in our records stays
     theirs, however it reached us and whoever repeated it;
   - **not settled** — an intention, an option, or a proposal is not a position
     in force. Weigh follow-through over phrasing though: something the team
     visibly acted on is a real position whatever tense it was recorded in.
     Judge by the traces it left, not by how long it lasted.

   Judge by the primary source, not by everything attached. A memory whose
   sources include material that merely _re-cites_ it is still real — the
   re-citation is weak corroboration, not grounds to discard.

   Discarding is an exit, not a verdict. Report `no adjudication`, name which
   side failed and why, and cite the source that shows it. Don't reach for
   `escalate` instead — there is nothing here for a human to decide.

5. **Never read a relationship's direction from `get_node_edges`.** It puts the
   node you asked about in the source slot every time, whichever way the
   relationship actually points, so anything pointing inward comes back
   reversed — and the tell is that every result names your own query as the
   source. Confirm with `get_entity_edge` on the edge's id, or an uncentered
   `search_memory_facts`. Direction is the entire content of a reporting line;
   reversed, it inverts the hierarchy you are about to reason from.

6. **Weigh corroboration, not single mentions.** An attribute asserted in one
   source is a passing mention; the same one across several is evidence. Check
   how many sources back each fact and prefer the well-corroborated reading.
   Extraction attaches attributes from mere mention — being described as
   seeking, discussing, or dealing with something can attach it as though held —
   so a lone assertion often reflects the sentence it came from rather than a
   fact about the person. Corroboration is the most reliable signal available
   here, ahead of dates, which are frequently absent. It counts only _after_
   rule 4: repeated retellings of one rehearsed source are a single assertion,
   not several.

## What to gather

Four things, for each side of the pair. Any of them may be missing — say so and
carry on; partial evidence is normal and is itself an input to the verdict.

| Evidence     | What you're after                 | How                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Scope**    | What each memory applies to       | A scope relationship where one exists — often none does; then triangulate from what the memory was produced by or attached to, and say which route you relied on                                                                                                                                                                                                                                 |
| **Author**   | Who or what asserted it           | Trace the memory to its source. That may be a person speaking, a person writing directly, a record imported from another system, or an automated pass with nobody behind it. Where the source names no one, attribute it to whoever owned the session or record and say the attribution is circumstantial                                                                                        |
| **Standing** | What authority the author carries | Where the author is a person: their role and reporting lines, direction per rule 5, corroboration per rule 6. Filter by relationship type — an unfiltered pull on a well-connected person can exceed the tool's output limit and fail. Where no person is behind it, standing belongs to whoever stands behind the source record; if that can't be traced, standing is **unavailable, not zero** |
| **Timing**   | When each became true             | The validity date where present; otherwise creation time, which is when it was _recorded_, not when it became true — weaker, and say so                                                                                                                                                                                                                                                          |

**A memory can hold more than one story.** A long-lived one accumulates strands
— a proposal that was rejected, a practice that took hold later, an unrelated
aside. Rule 4 removes the strands that aren't ours; it doesn't choose among the
ones that are. Take the memory's current summary as what it now claims, since
that is what a reader is shown, then say which other strands you found and why
they don't change the call. A scope fanning out across many unrelated targets is
the signature to watch for.

**Match on a relationship's shape, not just its name.** The extractor may name a
relationship anything, but entity types are a fixed set — so search wider than
the exact name, then keep what has the right kind of thing at each end. An
invented synonym still carries real evidence; a relationship whose endpoints are
the wrong shape isn't the one it claims to be, whatever it's called.

**Before comparing two people, make sure each is _one_ person.** The same
colleague often exists as several nodes holding different facts, and the
well-connected people most likely to be either side of a conflict are worst
affected. A shared email settles it. With no email to compare, say the identity
is unresolved rather than guessing.

Two failures mislead: a lookup by raw id can report as forbidden when the record
is fine — retry with the readable id before concluding anything — and bulk
fetches of a memory's sources can exceed output limits, so reach them through a
specific fact instead.

## Reaching a verdict

An order of consideration, not a formula — every rung needs judgment, and the
evidence differs every time.

1. **Scope first — do these even collide?** Different subjects, or different
   altitude (a general practice and one local variation of it), and there is
   nothing to resolve: **coexist**. This is the cheapest question and its
   evidence is the most reliable, so ask it first. Scope targets vary in kind
   and in granularity, so normalize before concluding two differ.

   Two checks keep this honest. Ask _why_ there is no collision: a conflict that
   never existed and one already settled elsewhere both end in `coexist`, but
   the human reading it needs to know which. And when the narrower memory looks
   like a local variation, ask whether it reads as a **deliberate exception** or
   as someone **correcting a general misunderstanding** — the first genuinely
   coexists, the second is a supersede wearing a narrow scope.

2. **Then weigh standing and timing together.** Hold both: who had the standing
   to make this call, and which came later.
   - **Pointing the same way** — the later memory also carries at least equal
     standing: **supersede**. This is the clean case.
   - **Pointing opposite ways** — the later memory comes from someone with less
     standing than the earlier one: **escalate**. Do not let recency quietly
     override authority; a newer memory from a more junior source is exactly the
     case a human should see. Say plainly which way each signal pointed.
   - **Equal standing on both sides** — the same author reversing themselves, or
     two peers — leaves timing to decide it alone: **supersede**, saying that
     standing was neutral rather than absent.
   - **One signal missing entirely, the other clear and well-corroborated** — it
     may carry the verdict alone. Say which one you leaned on, and that the
     other was unavailable rather than weighed.

3. **Escalate on unreliable evidence — not merely thin evidence.** Absent
   evidence can be worked around, as rung 2's last case shows; evidence that is
   present but untrustworthy can't. Escalate when a signal misleads: standing
   resting on a single uncorroborated mention, contradictory reporting lines, or
   an author you can name but can't pin to one identity — that last is neither
   absent nor false but unattributable, and counts as unreliable. Escalate too
   when too little remains to stand on: no recoverable author on either side, or
   both sides undated. Name the specific gap, so the human knows what to supply.

Retiring a memory never means deleting it. The older one stays in the graph,
marked as no longer current, so the record of what was decided and when
survives. Say that explicitly whenever you recommend `supersede`.

## What to hand back

One verdict, and the evidence behind it. The consumer renders this for a human,
so the evidence has to stand on its own:

- **verdict** — exactly one of `supersede`, `coexist`, `escalate`. A pair that
  fails the reality gate never reaches the rubric: report `no adjudication`
  instead, keeping every other field below, and say which side failed — or
  both, when they fail together off shared sources
- **pair** — both memories by id, with a one-line statement of what each claims
- **for supersede**: which one is superseded and which replaces it
- **reasoning** — which rung decided it, and which signals pointed where
- **evidence** — every fact leaned on, cited: nodes by readable id, edges and
  sources by their own ids, with dates on anything time-sensitive
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
