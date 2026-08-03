---
name: ticket-research
description: "Build the context brief a developer needs before starting a Jira ticket — what the ticket itself says, what organizational memory adds (the decisions, meetings, and people behind it), related past work, and what is still missing. Use before picking up a ticket whose background is thin, scattered, or assumes meetings the developer was not part of. Triggers on: ticket context, research this ticket, what's behind this ticket, why does this ticket exist, missing context, background for, prepare to implement, before I start on this ticket."
---

# Ticket Research

A ticket records what to do; the reasons — the decisions, the meeting where it
came up, who wanted it and why — usually live outside it. This skill assembles
both halves into one cited brief: what Jira says, what organizational memory
adds, and what remains genuinely unknown. The brief makes a ticket's context
reliable; it does not replace the developer's judgment — every claim carries
its source, and thin evidence is labeled thin rather than smoothed over.

Underneath, `memory-search` owns the search ladder and the relevance gate,
`graph-traversal` owns relationship walking when a summary names more than it
states, and `memory-capture` owns any durable write. Those ship with the
gutt-core plugin (this plugin depends on it); without them, follow the rules
below and note the gap in one line. Jira access comes from whatever Atlassian
tooling the session surfaces — an issue fetch, a JQL search, a comment tool.
Find them in your tool list; names and prefixes vary per install.

## Hard rules (non-negotiable — read first)

1. **Jira is read-only here — with one gated exception.** Never edit a ticket's
   fields, status, description, or acceptance criteria. The only write this
   skill may produce is **one comment**, drafted in your reply and posted only
   after the user approves the exact text in this session. A posted comment
   cannot be edited or deleted from here, so the approved draft is the text
   that has to be right — and it posts as markdown, not wiki markup.
2. **Everything cited.** Every brief item names its source: a ticket field, a
   comment (author, date), a memory node, fact, or episode (id, date), or a
   linked ticket key. A claim you cannot cite does not go in the brief.
3. **Evidence, not verdicts.** Report what was found and what it implies as a
   question, not a conclusion — "X was decided on <date> (id) — does it still
   hold here?" beats "do X". The developer keeps the judgment.
4. **Explicit `group_ids` on org reads when the brief may be shared.** Omitting
   `group_ids` silently includes the user's personal scope, and a brief that
   becomes a Jira comment must not leak private notes. Take the group name from
   results already in the session or ask; never guess one — a guessed group id
   is a fabricated identifier.
5. **Bare tool names.** Call memory and Jira tools by whatever names your tool
   list surfaces; the `mcp__…__` prefix varies per install. Probe with
   ToolSearch before concluding a tool is missing.
6. **No memory writes.** If research surfaces something durable — a gap
   pattern, a decision nobody recorded — hand it to `memory-capture` (its
   trust-tier gate applies). This skill only reads.

## When to use

Before starting work on a ticket whose background is unclear — or when someone
asks what a ticket is really about. Not for duplicate hunting
(`ticket-duplicates`), not for sizing (`ticket-estimate`), and not for org
questions with no ticket in play (`memory-search` directly).

## Step 1 — what Jira says

Fetch the ticket by key: summary, description, acceptance criteria, comments,
and links (issue links and remote links). Then extract what the rest of the
research runs on:

- the subject terms — feature, component, system names;
- the people — reporter, assignee, active commenters;
- the open questions — the "why" the ticket assumes, undefined terms, absent
  or untestable acceptance criteria.

No Jira tooling in the session → Degradation (pasted text works).

## Step 2 — what memory adds

Run `memory-search` rung 1 on the extracted terms — the subject, the "why"
phrasing ("decision about <subject>", "<subject> discussed"), and the people —
following its reformulation and stop rules. Deepen a hop via `graph-traversal`
only where a summary names a decision or discussion without stating it.

**Minimum recall outcome — owe this list before writing the brief**, with an
explicit "none found" per category rather than silence:

- decisions or agreements bearing on the ticket (id, date);
- discussions — meetings, episodes — where it came up (id, date);
- related past work and its outcome (id or key, date);
- what the ticket's area touches or depends on, and any incidents or
  regressions recorded against it (id, date) — the impact surface a developer
  otherwise rebuilds by hand;
- people connected to the area beyond those already on the ticket.

## Step 3 — related tickets

One or two JQL angles for context — linked issues' neighbors, recent tickets
in the same component, a summary-term search. This is context, not a duplicate
check: verdicts on duplication belong to `ticket-duplicates`.

## Step 4 — the brief

```markdown
# Context brief — <KEY>: <summary>

## What Jira says

<2–4 lines: the goal, current status, and whether acceptance criteria exist and are testable>

## What memory adds

<grouped under: Decisions & why · Discussions · Related work · Area history & impact · People>

- <finding> — <source, date>

## Related tickets

| Key | Relation | Why it matters |
| --- | -------- | -------------- |

## Gaps & open questions

- <what the ticket leaves unanswered — and who or where might answer it>

## Suggested next steps

- <smallest actions that close the gaps: read X, ask the named person, confirm Y>
```

Categories where nothing was found stay in the brief as "none found" — absence
is information, and it is what makes the brief trustworthy on the tickets
whose context really is complete.

## Offering the comment

After presenting the brief, offer to condense it into a Jira comment — the
"what memory adds" and "gaps" sections only; the ticket does not need itself
restated. Post per rule 1: exact approved text, once.

## Degradation

- **No Jira tools:** ask the user to paste the ticket text (and any comments
  that matter), run steps 2–4 on it, and mark Related tickets as skipped.
- **No memory tools:** probe with ToolSearch first; if truly absent, deliver
  the Jira-only half and say in one line that memory grounding was skipped.
- Either way: never stall, and name the degradation in the brief itself.

## References

- Search ladder, relevance gate, summary-first reads: `memory-search`
  (gutt-core) — its `references/tools.md` holds the per-tool contracts.
- Relationship walking and edge-currency checks: `graph-traversal`.
- Durable captures out of a research session: `memory-capture`.
- If an agent runs this as itself, `agent-memory-protocol` owns identity and
  registration; plain read-only research needs neither.
- Siblings: `ticket-duplicates` (duplicate verdicts), `ticket-estimate`
  (effort and risk grounding).
