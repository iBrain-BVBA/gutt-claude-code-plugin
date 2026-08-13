---
name: story-creation
description: "Draft Jira-ready stories from source material — a meeting transcript, a wiki page, a freeform ask — and manage the ones already filed: structured updates, splits into sibling stories, links, and refreshes of stale text. Every draft cites its source and carries testable acceptance criteria; nothing is created or edited in Jira without approval of the exact content in the session, and without Jira tooling the output is ready-to-paste markdown. Use when discussion needs to become tickets, or a filed story no longer says what the team means. Triggers on: create stories from this transcript, draft tickets from this meeting, turn these notes into stories, write a story for, draft a Jira story, update this story, rework the description, split into separate stories, refresh this stale story."
---

# Story Creation & Management

The distance between "we agreed this in a meeting" and "a developer can start" is
a story someone still has to write. This skill writes it — from a transcript, a
page, or a sentence — and keeps it honest once filed: drafts that cite where each
claim came from, acceptance criteria a reviewer could check, dependencies named
in Jira's own vocabulary, and edits that change exactly what the user meant to
change. Everything is a proposal until the user approves it; Jira is written to
only then.

Underneath, `memory-search` owns the search ladder and the relevance gate,
`graph-traversal` owns relationship walking when a summary names a thing without
stating it, and `memory-capture` owns any durable write; all three ship with the
gutt-pro plugin (this plugin depends on it) — without them, follow the rules
below and note the gap in one line. Jira access comes from whatever Atlassian
tooling the session surfaces; find it in your tool list — names and prefixes
vary per install.

## Hard rules (non-negotiable — read first)

1. **Jira writes exist here, and every one is gated.** Stories are created, and
   fields edited, only when the user asks for that in this session and approves
   the exact content as it will be written — per story, or as an explicitly
   named batch. Creating and editing issues is outward-facing and not undone by
   an apology: approval is the gate, and silence is not approval. The same
   exact-text terms govern the one permitted comment. Write markdown and set the
   tool's content-format parameter to markdown when it exposes one.
2. **Every draft cites its source, and gaps stay visible.** Each draft names
   where it came from — the transcript passage, the page section, the user's
   ask. What the source does not say is not invented to round a story out: it
   goes under open questions, in the draft, where refinement can see it. A
   plausible detail with no source is the costliest failure here, because it
   reads exactly like the real thing.
3. **Editing is a diff against the fetched story, never a rewrite.** Read the
   story as it stands before proposing changes. The proposal shows each field —
   what it says now, what it would say, and why — and touches nothing the user
   did not ask about. A one-field change that arrives as a regenerated
   description resets wording the team already argued over.
4. **Acceptance criteria are checkable or the draft says why not.** Each
   criterion states an observable outcome someone other than the author could
   verify. Where the source does not support one, the draft carries the open
   question rather than a vague criterion dressed as a testable one.
5. **Work from a captured copy of the source.** Take the transcript or page once
   — pasted or fetched — and draft against that copy. Live re-reads per draft
   multiply cost and drift; fetch again only when the user says the source
   changed.
6. **Org scope is checked at the output.** Pass explicit `group_ids` naming the
   org group on reads — take the name from session results or ask; never guess
   one — and treat scope as server-decided. Nothing from another client's
   engagement enters a draft or a filed story; personal-scope material stays in
   the in-session proposal, marked as personal. **Bare tool names**, probed with
   ToolSearch before concluding one is missing; the `mcp__…__` prefix varies per
   install.
7. **Memory writes go through `memory-capture` — and accepted stories are worth
   one.** Once the user has approved and the stories are filed, offer to capture
   the outcome — what was asked, what was created, the keys — through
   `memory-capture`'s gate into the engagement's own group (explicit `group_id`,
   on rule 6's never-guess terms). Rejected drafts are not captured; they were
   proposals.

## When to use

Discussion that needs to become tickets — a meeting transcript, a wiki page, a
pasted thread, a sentence — or a filed story that needs reshaping: an update, a
split into sibling stories, links, a stale description brought back to true.
Not for breaking one story into its sub-tasks
(`gutt-developer:sub-task-breakdown` — its output is sub-task issues under an
unchanged parent, where a split here produces sibling stories); not for deciding
whether a draft duplicates an existing ticket
(`gutt-developer:ticket-duplicates` — this skill flags lookalikes and hands the
verdict there). Both live in a separate plugin this one does not depend on;
where one is not installed, say which part of the ask you are not covering
rather than attempting it. Not for sweeping a whole backlog slice for duplicate
clusters (`backlog-dedupe`, this plugin) or ranking one (`backlog-prioritization`,
this plugin). Decomposing an epic into its full child-story set is refinement
analysis this skill does not own — it drafts stories from the source material it
is given.

## Step 1 — the source and the target

Fix three things before drafting: the **source** (transcript, page, or ask —
captured once per rule 5), the **target** (project and issue type, read from the
user or the project's own conventions — never assumed), and the **mode**:
drafting new stories, or managing a named one. Managing starts by fetching the
story as it stands — summary, description, criteria, links, status — per rule 3.
Where the tracker is not reachable, the pasted-text path in Degradation.

## Step 2 — what memory adds

`memory-search` rung 1 on the subjects the source raises: decisions already made
about them, work already done or rejected, constraints a draft must respect.
This pass serves two ends: **grounding** — a draft that contradicts a recorded
decision must say so — and **duplicate smell** — a subject that already has a
ticket or a history gets flagged on the draft, with the same-or-different
verdict handed on per When to use. Deepen a hop with `graph-traversal` only
where a summary names a decision or dependency without stating it.

**Minimum outcome:** per draft, either grounding citations or an explicit
`no memory evidence` line. The second is a real result, not a failure.

## Step 3 — the drafts

From the captured source, extract every candidate story — deliberately more than
will survive; the user picks. One outcome per story: small and coherent beats
big and complete.

```markdown
# Story drafts — <source, dated>

### <n>. <proposed summary>

- **Description:** <what and why, in the team's own vocabulary>
- **Acceptance criteria**
  - <observable outcome>
- **Dependencies:** <draft n / existing KEY, as Jira issue links> | none
- **Source:** <the passage, section, or ask this came from>
- **Memory:** <citation with id and date> | no memory evidence
- **Open questions:** <what the source did not say> | none

## Not drafted

<what the source contained and this deliberately left out — already covered,
already decided against, too vague to carry criteria — so the user can overrule>

## What this rests on

<the source captured, what memory was searched, and what was not searched>
```

For management, the same frame carries rule 3's diff instead: per field,
`now → proposed — why`, plus one line naming the fields left untouched. A split
proposal names the sibling stories it would create — each in the draft form
above — and what remains in the original.

## Step 4 — approval and the write

Present the drafts; the user picks, per story or as an explicitly named batch,
and approves the exact content (rule 1). Only then:

- create each story with its approved summary, description, and criteria, and
  report the keys as they land;
- create dependency links (`blocks` / `is blocked by`) after the issues exist,
  and report the links created;
- for edits, write only the approved fields — nothing else;
- report failures item by item. A partial filing is the normal failure here, and
  the user needs to know exactly where it stopped.

Then rule 7's offer: the accepted outcome, through `memory-capture`, into the
engagement's group.

## Degradation

- **No Jira tools:** produce the same drafts as ready-to-paste markdown, and say
  plainly at the top that nothing was written to Jira and existing-ticket checks
  were skipped — a draft that looks filed but is not is worse than a labelled
  one.
- **No memory tools:** probe with ToolSearch first; if truly absent, draft from
  the source alone and mark every draft `no memory evidence` — the grounding and
  duplicate-smell half was skipped.
- Never stall; the degradation line sits at the top of the output it limits.

## References

- Search ladder and relevance gate: `memory-search` (gutt-pro); relationship
  walking: `graph-traversal`; durable captures and their gate: `memory-capture`;
  identity if an agent runs this: `agent-memory-protocol`.
- Reply shape — substance first, one next action last: `output-style` (gutt-pro).
- Siblings in this plugin: `backlog-dedupe` (slice-wide duplicate clusters —
  its approved consolidation drafts are refined here), `backlog-prioritization`
  (ranking a slice).
- Single-ticket work in the developer plugin, which is separate and may not be
  installed: `gutt-developer:ticket-duplicates` (same-or-different verdicts),
  `gutt-developer:sub-task-breakdown` (sub-tasks under one parent),
  `gutt-developer:ticket-research` (background), `gutt-developer:ticket-estimate`
  (effort).
