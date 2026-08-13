---
name: backlog-dedupe
description: "Scan a JQL-scoped slice of a Jira backlog for tickets that are really the same work: duplicate and overlap clusters with cited evidence, consolidation proposals that map source tickets to one drafted item, and stale candidates each carrying its justification. Propose-only — every close, cancel, merge, or link waits for the user's per-action approval. Use when a backlog has grown noisy, before a planning pass, or when old tickets need recycling into something current. Triggers on: scan the backlog for duplicates, clean up the backlog, consolidate these tickets, overlapping work across the backlog, stale tickets, backlog hygiene, merge candidates, recycle old tickets, too many open tickets."
---

# Backlog Dedupe & Aggregation

Backlogs accumulate the same ask in different words: filed twice a year apart,
filed small three times instead of once as one piece of work, or left open long after a
decision quietly retired it. Every planning pass then pays for the noise. This
skill scans a bounded slice, clusters what is really one piece of work, proposes
what the clusters consolidate into, and lists what looks dead — every claim
carrying its evidence, every action waiting for the human. The agent proposes;
the human disposes.

Underneath, `memory-search` owns the search ladder and the relevance gate,
`graph-traversal` owns relationship walking, and `memory-capture` owns any
durable write; all three ship with the gutt-pro plugin (this plugin depends on
it) — without them, follow the rules below and note the gap in one line. Jira
access comes from whatever Atlassian tooling the session surfaces; find it in
your tool list — names and prefixes vary per install.

## Hard rules (non-negotiable — read first)

1. **Propose-only — nothing in Jira changes without per-action approval.** No
   close, cancel, merge, link, label, issue creation, or field edit lands unless the user
   approved that specific action, or an explicitly named batch of them, in this
   session. Approval is the gate, not an undo; silence is not approval. A batch
   counts as named only where the text the user reads before answering carries
   every key and what happens to each — a label standing for them is not that
   text. One ask decides one thing: nothing unrelated rides along in the same
   question, and housekeeping never shares a question with a Jira action. The
   one other permitted write is a comment, drafted and posted only after the
   user approves the exact text. Write markdown and set the tool's
   content-format parameter to markdown when it exposes one.
2. **Fetch the slice once, then work the copy.** Pull the slice into an
   enumerated working set — key, summary, status, age, last activity — in one
   pass, and cluster against that. Per-ticket live calls across a slice multiply
   cost and stall long before the slice ends; fetch an item's full detail only
   for the few whose verdict turns on it.
3. **Counts are recounted, never estimated — and "every" and "none" are
   counts.** Cluster sizes, stale totals, and any claim of how many tickets
   something covers are computed by enumerating the working set. A number that
   cannot be recounted from the set does not enter the output. A claim about all
   of something — every edit in a history, no real activity on a ticket — is the
   same claim wearing a different word: enumerate it, give the tally, and name
   the exceptions. "Twenty of twenty-two entries are sprint moves" is a finding;
   "every entry is a sprint move" is that finding with the exceptions dropped,
   and the exceptions are often where the real activity is.
4. **Every cluster carries its evidence; every stale candidate carries its
   justification.** A cluster names its ticket keys, the outcome they share (not
   the wording), and any memory record tying them together — each with id and
   date. A stale candidate states age, last activity, and what superseded it or
   decided against it. A bare list of old tickets is exactly the output this
   skill must never produce.
5. **Calibrate on a sample before scaling.** Before clustering the full slice,
   run the bar over a handful of items and report those verdicts first — at
   least one you read as clearly current and one as clearly stale or duplicated,
   each with the evidence that put it there. Where the user or the record can
   confirm them, that is the check; where neither can, the sample still puts the
   bar in front of the user early enough to be argued with. A bar that misreads
   the sample does not get scaled to the slice.
6. **Org scope is checked at the output, and engagements do not mix.** Pass
   explicit `group_ids` naming the org group on reads — take the name from
   session results or ask; never guess one — and treat scope as server-decided.
   Nothing from another client's engagement enters any query, cluster, or
   proposal — check per line, not per run. The run summary, once decisions are
   made, goes through `memory-capture`'s gate into the engagement's own group,
   chosen deliberately on the same never-guess terms and targeted by whatever
   means `memory-capture` says targets it.
7. **Bare tool names**, probed with ToolSearch before concluding one is missing;
   the `mcp__…__` prefix varies per install.
8. **Issue types, workflow transitions, and link names come from the
   organization, not from this skill.** Read what the project actually exposes
   before proposing against it: its issue types, the transitions its workflow
   defines, the link types the instance carries. A consolidation is proposed at
   whatever type that project uses for work of its size, and an action is named
   the way the workflow names it. Never hardcode one; where a proposal needs a
   shape the project does not have, say so rather than inventing it.

## When to use

A backlog segment that needs hygiene — noisy, old, or about to be planned over.
Not for deciding whether two specific tickets are the same thing
(`gutt-developer:ticket-duplicates`, a separate plugin this one does not depend
on — this skill clusters a slice and hands borderline pairs there; where it is
not installed, flag the pair as arguable rather than deciding it). Not for
ranking the slice (`backlog-prioritization`, this plugin — its overlap evidence
is this skill's output when both run), and not for drafting or reshaping
individual stories (`story-creation`, this plugin — an approved consolidation's
draft is refined there).

## Step 1 — the slice

A JQL-scoped set the user names or confirms — a project, a component, an age
window, a status set. Unbounded scans produce unarguable output; if the slice is
large, agree a bound and report it. Fetch once (rule 2) and enumerate the
working set: key, summary, status, age, last activity. State the count — it is
the denominator every later number rests on.

## Step 2 — what memory adds

Search by theme, not per ticket: the subjects the slice's summaries cluster
around. What moves verdicts: a decision that retired an idea (an open ticket for
it is stale, with the citation), work already done, prior consolidations of the
same area, and incident or rework history binding items together. Deepen a hop
with `graph-traversal` only where a summary names a decision or dependency
without stating it.

**Minimum outcome:** per cluster and per stale candidate, either a memory
citation or an explicit `similarity only` mark — wording-level evidence is real,
but the reader must see which kind they are getting.

## Step 3 — cluster and classify

Group items that seek the same outcome, not the same words. Every item in the
slice ends in exactly one bucket, and the buckets sum to the slice count
(rule 3):

- **Duplicate cluster** — the same outcome sought more than once; one survivor,
  or one new item covering them all, would replace the rest.
- **Overlap cluster** — parts of one piece of work filed separately;
  consolidation into a single item is the proposal.
- **Stale candidate** — aged, inactive, superseded or decided against, with
  rule 4's justification.
- **Keep** — pulls its own weight as filed.

A pair whose verdict stays genuinely arguable is flagged as arguable and handed
to the single-ticket check (When to use) rather than forced into a bucket.

## Step 4 — the proposal

```markdown
# Backlog dedupe — <slice JQL>, <count> tickets, <date>

## Calibration

<the known-answer sample and its verdicts — rule 5>

## Duplicate and overlap clusters

| #   | Tickets | Shared outcome | Evidence (source, date) or `similarity only` | Proposal |
| --- | ------- | -------------- | -------------------------------------------- | -------- |

## Consolidations

### <cluster #> → <proposed consolidation summary, at the project's own type>

- **Draft description:** <what the consolidated item is, built from the
  clustered tickets' own asks>
- **Source tickets:** <keys — what each contributes, what closing it loses>

## Stale candidates

| Ticket | Age / last activity | Why it looks dead — evidence, or `similarity only` | Proposal |
| ------ | ------------------- | -------------------------------------------------- | -------- |

## Untouched

<count kept as filed — the remainder that shows the scan covered the slice>

## What this rests on

- Slice and count: <JQL, N>
- What was searched: <the memory phrasings and Jira angles>
- What would change a verdict: <the open questions>
```

Every row of both tables fills its evidence cell — a source and a date, or the
literal `similarity only`. Prose that names no source is an unfilled cell: the
reader cannot tell a cited verdict from a plausible one.

Then the decisions, one at a time or as an explicitly named batch: for each
proposal the user approves — close, cancel, link as a duplicate in the
instance's own link type, create the consolidated item — apply exactly that
action, report the key and result, and stop at the first surprise. A
consolidated item is created on the same exact-content terms as any story, and
refined via `story-creation` when it needs more than the draft. Report failures item by item; a partial pass is the normal
failure, and the user needs to know where it stopped.

## Step 5 — the record

Once decisions are made, offer the run summary — slice, clusters found, actions
taken and declined — through `memory-capture`'s gate into the engagement's own
group (rule 6). The next scan of this backlog starts from what this one decided.

## Degradation

- **No Jira tools:** cluster a pasted export (a key-and-summary list is enough)
  on the same rules; say plainly that ages and activity could not be verified
  and nothing can be actioned from here.
- **No memory tools:** probe with ToolSearch first; if truly absent, cluster on
  wording and structure alone and mark every verdict `similarity only` — the
  decision, prior-work, and superseded-by evidence was skipped, which weakens
  stale candidates most.
- Never stall; the degradation statement sits at the top of the proposal,
  before the clusters it weakens — the reader must know what the verdicts are
  worth before reading them.

## References

- Search ladder and relevance gate: `memory-search` (gutt-pro); relationship
  walking: `graph-traversal`; durable captures and their gate: `memory-capture`;
  identity if an agent runs this: `agent-memory-protocol`.
- Reply shape — substance first, lists ranked and capped: `output-style`
  (gutt-pro).
- Siblings in this plugin: `backlog-prioritization` (consumes these clusters as
  ranking evidence), `story-creation` (refines a consolidation's draft).
- The same-or-different verdict on one pair of tickets belongs to
  `gutt-developer:ticket-duplicates`, in a separate plugin this one does not
  depend on.
