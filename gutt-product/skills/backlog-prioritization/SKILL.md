---
name: backlog-prioritization
description: "Rank a slice of the Jira backlog on the organization's own criteria, with each item's position justified by cited evidence — what was decided, what was promised to a client, which areas keep breaking — and close with a one-page summary for leadership. Produces a proposal to argue with, never a rank written into Jira. Use when deciding what to work on next, preparing a planning or roadmap conversation, or reporting backlog state upward. Triggers on: prioritize, what should we work on next, rank the backlog, top priorities, roadmap order, planning session prep, executive summary, backlog review, what matters most, sequence this work."
---

# Backlog Prioritization

A backlog ordered on ticket fields alone re-decides things the organization has
already decided. The evidence that changes the order is usually not in the
tickets: a commitment made to a client, a decision that makes one item a
prerequisite for three others, an area that has produced two incidents this
quarter, a cluster of requests that are really one feature. This skill puts that
evidence next to each item and reports the order it implies — plus a summary
short enough to open a leadership conversation rather than postpone it.

The order is a proposal. Ranking is an act of authority that stays with the
people accountable for the outcome; this skill's job is to make their decision
better informed, and to be explicit about where its own evidence runs thin.

Underneath, `memory-search` owns the search ladder and the relevance gate,
`graph-traversal` owns relationship walking, and `memory-capture` owns any
durable write; they ship with the gutt-pro plugin (this plugin depends on it).
Without them, follow the rules below and note the gap in one line. Jira access
comes from whatever Atlassian tooling the session surfaces; names and prefixes
vary per install.

## Hard rules (non-negotiable — read first)

1. **Jira is read-only here — never write an order into it.** No rank field, no
   priority field, no sprint or fix-version assignment, no status changes, no
   edits to any other field. The output is a proposal in the reply. The one
   permitted write is a comment, drafted and posted only after the user approves
   the exact text in this session. Treat it as final — approval is the gate, not
   an undo; a truly needed correction re-approves the text and targets the
   existing comment if the tool allows, rather than posting a second one. Write
   markdown and set the tool's content-format parameter to markdown when it
   exposes one.
2. **Every item's position carries its reason, and thin evidence says so.**
   Each ranked item gets the evidence that placed it there. An item whose only
   input is its own ticket fields is labelled `no memory evidence` and stays
   where the board already had it — moving an item on no evidence is the one
   failure mode this skill must never have. Never let a confident tone stand in
   for a citation.
3. **The criteria come from the organization, not from this skill.** Read what
   the project actually ranks on before ranking anything: the issue type's own
   field schema, and the values present on the slice. Where custom fields carry
   value, effort, risk, client, or commitment data, rank on those and name them
   in the output. Never import an outside scoring framework, never invent
   weights the organization has not agreed, and never hardcode a field name —
   discover them per project, and where nothing rankable is exposed, say so and
   fall back to the visible order plus rule 4's evidence.
4. **Evidence is the differentiator, and it is specific.** Four kinds move an
   item: a decision or commitment that binds it, a dependency that makes it
   block or wait on other items, history in the area it touches (incidents,
   repeated rework), and overlap with other items in the slice. Where a
   `backlog-dedupe` run's clusters are in the session, they are the overlap
   evidence, cited as such; otherwise step 3's own search covers it. Each one
   enters the output with its source and date, or it does not enter.
5. **Every claim is real and cited** — a Jira key, or a memory episode, lesson,
   decision, or incident with its id and date. No invented history, no
   commitment attributed to a client that no record shows, no dependency the
   graph does not carry.
6. **Org scope is checked at the output** — pass explicit `group_ids` naming the
   org group on reads (take the name from session results or ask; never guess
   one), treat scope as server-decided, and before any item of evidence enters
   the summary or an offered comment, confirm that item's own scope is the org
   group. Personal-scope material stays in the in-session output. A summary
   written for a client audience carries nothing from another client's
   engagement — check this per line, not per run. **Bare tool names**, probed
   with ToolSearch. **No memory writes** — a durable prioritization rationale
   goes through `memory-capture`'s gate.

## When to use

Deciding what to work on next, preparing a planning or roadmap conversation, or
reporting backlog state upward. Not for sizing a single ticket
(`gutt-developer:ticket-estimate`), not for the background on one ticket
(`gutt-developer:ticket-research`), and not for resolving whether two tickets
are the same thing (`gutt-developer:ticket-duplicates` — this skill notes
overlap as a ranking signal and hands the verdict there). Those three live in a
separate plugin this one does not depend on; where it is not installed, say
which part of the question you are not the right skill for rather than
attempting it. Clustering the whole slice first is `backlog-dedupe` (this
plugin) — run it before a prioritization whose slice smells of duplicates, and
rank the consolidations rather than their fragments.

## Step 1 — the slice and the criteria

Establish both before ranking anything:

- **The slice.** A JQL-scoped set the user names or confirms — a project,
  component, epic, sprint candidate pool, or an age window. Unbounded backlogs
  produce unusable output; if the slice is large, agree a bound and report it.
- **The criteria.** The issue type's field schema for that project, plus which
  of those fields the slice actually populates. A field that exists but is empty
  across the slice is not a criterion. Report the criteria you found before the
  ranking, so the user can correct them rather than discover them implied by
  an order they disagree with.

**Minimum outcome:** a bounded slice, and a named list of what it ranks on.

## Step 2 — what the tickets say

For the slice: the populated ranking fields from step 1, plus age and last
activity, and current status. Per rule 3 this is the starting order, not the
finished one.

Ask for named fields, never for everything. Link and comment collections carry
the full nested body of every related item, so requesting them across a whole
slice returns orders of magnitude more than the ranking needs and can exceed
what one response can hold. Fetch those per item, once ranking has narrowed the
set to the few whose dependencies actually decide their position.

## Step 3 — what memory adds

`memory-search` rung 1 per rule 4's four kinds — decisions and commitments
touching the slice's subjects, dependencies, area history, and overlap between
items. Deepen a hop with `graph-traversal` only where a summary names a
decision, dependency, or incident without stating it, or where an item's
position turns on whether a fact still holds.

Where the slice is large, search by subject cluster rather than per ticket — the
evidence that moves items is usually about an area or a commitment, not about
one key. A `backlog-dedupe` output already in the session is the overlap
evidence — cite its clusters rather than re-searching them.

**Minimum outcome:** per item, either evidence with citations or an explicit
`no memory evidence` mark. The second is a real result, not a failure.

## Step 4 — the ranked proposal

Order the slice on step 1's criteria as modified by step 3's evidence. State
each move rather than only the result: an item that rose or fell against its
board position says why, in one line, with the citation. Items with no memory
evidence hold their board position per rule 2.

## Step 5 — the summary for leadership

One page, written to be read by someone who will not open the backlog. It
answers three questions: what to do next, what the biggest available
simplification is, and what is most likely to go wrong. Where the session can
publish a page rather than print one, offer that — a one-pager for a meeting is
easier to read as a page than as terminal output — but the markdown below stays
the canonical form.

```markdown
# Backlog priorities — <slice>

## Ranked

| #   | Item | Why here | Evidence (source, date) |
| --- | ---- | -------- | ----------------------- |

## Consolidation opportunities

- <items that look like one piece of work, and what that would collapse —
  backlog-dedupe's clusters when it ran, step 3's evidence otherwise>

## Risk flags

| Area | What could go wrong | Evidence (source, date) |
| ---- | ------------------- | ----------------------- |

## What this rests on

- Criteria used: <the fields from step 1>
- Items ranked on ticket fields alone: <count, and which>
- What would change the order: <the open questions>
```

The last section is not optional. A ranking whose basis is invisible cannot be
argued with, and an unarguable ranking is the one that gets ignored.

## Degradation

- **No Jira tools:** rank a pasted list of items using memory evidence only;
  say the field-criteria half was skipped, which makes rule 3's criteria the
  user's to supply.
- **No memory tools:** report the board's own order with the criteria named, and
  say plainly that the decision, commitment, dependency, and incident evidence
  was skipped — without it this is a field sort, not a prioritization, and it
  should be labelled that way rather than presented as one.
- Never stall; the degradation line sits next to the ranking it limits.

## References

- Search ladder and relevance gate: `memory-search` (gutt-pro); deeper
  relationship and validity checks: `graph-traversal`; durable captures:
  `memory-capture`; identity if an agent runs this: `agent-memory-protocol`.
- Reply shape for the summary — substance first, lists ranked and capped, one
  next action last: `output-style` (gutt-pro).
- Siblings in this plugin: `backlog-dedupe` owns slice-wide duplicate clusters
  and consolidation proposals; `story-creation` drafts and reshapes the stories
  themselves.
- Single-ticket work belongs to the developer plugin, which is separate from
  this one and may not be installed: `gutt-developer:ticket-duplicates` owns the
  same-or-different verdict this skill only flags,
  `gutt-developer:ticket-estimate` owns effort and risk for one item, and
  `gutt-developer:ticket-research` owns one ticket's background.
