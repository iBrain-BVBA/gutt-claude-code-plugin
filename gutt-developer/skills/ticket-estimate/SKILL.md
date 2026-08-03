---
name: ticket-estimate
description: "Ground a Jira ticket's effort estimate and risk picture in comparable past work — what similar tickets actually involved, what bit the team before, which areas carry incident history. Produces input to the team's estimate, never a number written into Jira. Use when sizing a ticket, preparing refinement, or asking what could go wrong. Triggers on: estimate this ticket, how long will this take, effort for, sizing, story points for, what could go wrong, risk areas, refinement prep."
---

# Ticket Estimate

Estimates fail on the unknowns, and the unknowns are usually already in the
org's history: the last time this area was touched, what was underestimated,
which dependency stalled, where the incidents cluster. This skill grounds a
ticket's estimate in that history — comparables with citations, risks with
evidence, and an honest confidence label. The number stays advice: committing
to it is the team's act, not the skill's.

Underneath, `memory-search` owns the search ladder and the relevance gate,
`graph-traversal` owns relationship walking, and `memory-capture` owns any
durable write; they ship with the gutt-core plugin (this plugin depends on
it). Without them, follow the rules below and note the gap in one line. Jira
access comes from whatever Atlassian tooling the session surfaces; names and
prefixes vary per install.

## Hard rules (non-negotiable — read first)

1. **Never write an estimate into Jira.** No story-point fields, no estimate
   fields, no status changes — the output is advice in the reply. The one
   permitted write is a comment, drafted and posted only after the user
   approves the exact text in this session (markdown; it cannot be edited or
   deleted from here).
2. **Confidence is honest.** Thin comparables → say `low confidence` and why.
   An estimate with no comparables at all is a guess — label it a guess rather
   than dress it up as analysis. Fabricated confidence is the one failure mode
   this skill must never have.
3. **A range with a basis, in the team's unit.** Read the unit the team
   actually uses off the ticket and its board (points, days, t-shirt sizes);
   if it is not visible, ask, or default to a day-range and say so. Always a
   range plus the one-line basis — a bare number invites false precision.
4. **Calendar time is not effort.** A past ticket's created→resolved span
   includes waiting, handoffs, and life. Treat it as a weak upper signal only;
   prefer what the record says was actually involved — scope, rework,
   surprises.
5. **Every comparable and risk is real and cited** — a resolved ticket key
   with its resolution date, or a memory episode, lesson, or incident (id,
   date). No invented history, and no risk without its evidence.
6. **Explicit `group_ids` on org reads when the result may be shared** — take
   the group name from session results or ask; never guess one. **Bare tool
   names**, probed with ToolSearch. **No memory writes** — a durable sizing
   lesson goes through `memory-capture`'s gate.

## When to use

Sizing or refining a ticket, or asking what could go wrong with one. Not for
the background brief (`ticket-research` — though when one is already in
context, build on it instead of re-fetching), and not for duplicate hunting
(`ticket-duplicates`).

## Step 1 — what is actually being estimated

From the ticket (or a research brief already in context): the scope as stated,
and the scope that is missing — absent acceptance criteria, undefined terms,
unnamed dependencies. Every gap found here both widens the range and opens the
risk table.

## Step 2 — comparables

- **Jira:** resolved tickets in the same component or of the same shape (two
  JQL angles at most). Note their created→resolved spread per rule 4 — a
  signal, not a measurement.
- **Memory:** `memory-search` rung 1 on the subject and the work's shape —
  episodes of similar past work, and lessons about it: what was
  underestimated, what turned out bigger than filed, what went smoothly.

**Minimum outcome:** a comparables list, or an explicit "no comparable history
found" — which itself forces `low confidence` per rule 2.

## Step 3 — risks

`memory-search` for incidents, lessons, and decisions touching the components
and dependencies from step 1. An area with incident history, a dependency that
stalled before, a decision that constrains the approach — each lands in the
risk table with its citation. A `ticket-research` brief already in context
seeds this: its area-history findings are the risk table's first draft —
extend them rather than re-searching. And where the record shows the area has
little or no automated test coverage, say so explicitly: a change that cannot
be cheaply verified widens both the risk and the range.

## Step 4 — the output

```markdown
# Estimate grounding — <KEY>: <summary>

## Estimate

<range in the team's unit> — <confidence: high/medium/low> — <one-line basis>

## Comparables

| Reference | What it was | Signal for this ticket |
| --------- | ----------- | ---------------------- |

## Risk areas

| Area | Evidence (source, date) | What would reduce it |
| ---- | ----------------------- | -------------------- |

## What would tighten this

- <the open questions whose answers narrow the range>
```

## Degradation

- **No Jira tools:** estimate from pasted ticket text plus memory comparables;
  say the resolved-ticket half was skipped.
- **No memory tools:** Jira-only comparables; say incident and lesson
  grounding was skipped and cap confidence at `medium`.
- Never stall; the degradation line sits next to the confidence label it
  affects.

## References

- Search ladder and relevance gate: `memory-search` (gutt-core); deeper
  relationship checks: `graph-traversal`; durable captures: `memory-capture`;
  identity if an agent runs this: `agent-memory-protocol`.
- Siblings: `ticket-research` (context brief — reuse its output when fresh),
  `ticket-duplicates` (duplicate verdicts).
