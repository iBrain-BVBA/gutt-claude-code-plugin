---
name: SKILL_NAME
description: "{{WHAT_THIS_SKILL_PRODUCES}} — {{THE_EVIDENCE_IT_RESTS_ON}}. {{WHAT_IT_NEVER_DOES}}. Use when {{THE_SITUATION}}. Triggers on: {{TRIGGER_PHRASE}}, {{TRIGGER_PHRASE_TWO}}, {{TRIGGER_PHRASE_THREE}}."
---

# {{SKILL_TITLE}}

{{ONE_PARAGRAPH_ON_WHAT_THIS_SKILL_DOES_AND_WHAT_IT_HANDS_BACK}}.

SCAFFOLD NOTE — delete this paragraph and every other one marked the same way; they are
addressed to you rather than to the agent that will read this skill, and the review step
fails while any remain. Rename this directory and the `name:` above together: a skill's
`name:` must equal its directory name, and nothing at runtime reports a mismatch.

Underneath, `memory-search` owns the search ladder and the relevance gate, `graph-traversal`
owns relationship walking, and `memory-capture` owns any durable write. This skill adds only
what is specific to {{THE_ROLE_ACTIVITY}} — the inputs to read, the order to read them in, and
the shape of the output. **Do not restate their rules here.** A second copy of the search
ladder is a copy that drifts, and the reader cannot tell which one is current.

## Hard rules (non-negotiable — read first)

1. **The ticket tracker and its wiki are the system of record.** Read the ticket and its
   linked pages before memory, and report against them. Never propose tracker mechanics this
   organization does not use — the label, template, and milestone conventions a public
   repository runs on do not transfer to closed delivery work.
2. **Produce input, never a committed number or a written field.**
   {{WHAT_THIS_SKILL_OUTPUTS}} is a proposal for the team to argue with. Write nothing into
   the tracker, and post no comment, without approval of the exact text in the session.
3. **Cite every claim that rests on a record.** A finding drawn from memory or from a page
   quotes and names its source. An uncited claim presented as the team's standard cannot be
   argued with by the person it is aimed at.
4. **Engagement scope on every write.** Pass the group explicitly. Client work does not cross
   tenants: nothing learned on one engagement is written into another's scope, and nothing
   client-identifying goes into a shared or personal scope.
5. **Say what was not found.** An empty recall is a result. Report it rather than filling the
   gap with a plausible-sounding inference.

## When to use

Use when {{THE_CONCRETE_SITUATION}}.

Not for {{THE_NEAR_MISS}} — that is `{{OTHER_SKILL}}`'s job.

## Step 1 — {{WHAT_THE_TRACKER_SAYS}}

{{WHICH_FIELDS_AND_LINKED_PAGES_TO_READ}}. Where the tracker is not reachable, work from what
the user pasted and say which half you are missing.

## Step 2 — {{WHAT_MEMORY_ADDS}}

One adaptive pass per `memory-search`, on the specifics Step 1 surfaced. Deepen only if the
first pass leaves the question open.

Look for: {{THE_KINDS_OF_RECORD_THAT_CHANGE_THE_ANSWER}}.

## Step 3 — {{THE_WORK}}

{{THE_ANALYSIS_OR_PRODUCTION_STEP}}, with each conclusion anchored to the record it came from.

## Step 4 — the output

```markdown
## {{OUTPUT_TITLE}}

### {{FIRST_SECTION}}

{{WHAT_GOES_HERE}} — each row carrying its evidence.

### Gaps and open questions

What was searched for and not found, and what a human needs to decide.

### What this rests on

The records actually read.
```

## Degradation

If the tracker tooling is absent, work from pasted text and name the gap in one line. If the
memory server is absent, say so in one line and deliver the tracker-only half. Never stall,
and never present a degraded pass as a complete one.

## References

- `memory-search` (gutt-pro) — the search ladder and the relevance gate.
- `memory-capture` (gutt-pro) — classification, dedup, and the write itself.
- `graph-traversal` (gutt-pro) — relationship walking, once a first pass has the entities.
- `output-style` (gutt-pro) — the shape of the reply that ends the turn.
