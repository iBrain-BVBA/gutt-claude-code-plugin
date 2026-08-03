---
name: ticket-duplicates
description: "Check a Jira ticket — or a draft not yet filed — for duplicates and overlapping work before effort is spent twice: candidates from Jira search and from organizational memory, each resolved to a verdict with evidence and confidence. Use when a ticket smells familiar or before filing a new one. Triggers on: duplicate, already exists, didn't we already, has anyone worked on, similar ticket, overlaps with, filed twice, done before."
---

# Ticket Duplicates

Duplication hides in two places: another ticket (open or long resolved), and
history that never got a ticket — work already done, or an idea already
discussed and rejected. This skill searches both, then resolves every candidate
to an evidence-backed verdict. A resolved duplicate is a win twice over: the
work may already be done, and its history says what it cost.

Underneath, `memory-search` owns the search ladder and the relevance gate, and
`memory-capture` owns any durable write; both ship with the gutt-core plugin
(this plugin depends on it) — without them, follow the rules below and note
the gap in one line. Jira access comes from whatever Atlassian tooling the
session surfaces; find it in your tool list — names and prefixes vary per
install.

## Hard rules (non-negotiable — read first)

1. **Jira is read-only here — recommend, never act.** No linking, closing,
   labeling, or field edits; those are the human's calls. The only write this
   skill may produce is one comment, drafted and posted only after the user
   approves the exact text in this session (it posts as markdown and cannot be
   edited or deleted from here).
2. **Every candidate gets resolved.** Each surfaced candidate ends as a verdict
   or an explicit "not assessed (reason)" — never silently dropped. An
   unresolved candidate is exactly the false reassurance this skill exists to
   prevent.
3. **Fixed verdict vocabulary.** `duplicate` (same outcome sought), `overlaps`
   (shares part of the scope), `related` (useful context, different outcome),
   `distinct` — each with confidence `high`/`medium`/`low` and one line of
   evidence (a quote or fact, with key or id and date). No evidence means
   `related` at best.
4. **"Nothing found" carries its scope.** A clean result states what was
   searched — the JQL angles and the memory phrasings — so absence is a
   checkable claim, not a shrug.
5. **Explicit `group_ids` on org reads when the result may be shared.** Take
   the group name from results already in the session or ask; never guess one.
   Omitting `group_ids` silently includes personal scope.
6. **Bare tool names**, probed with ToolSearch before concluding one is
   missing; the `mcp__…__` prefix varies per install.
7. **No memory writes.** A duplication pattern worth keeping goes through
   `memory-capture` and its trust-tier gate.

## When to use

A ticket — or a not-yet-filed draft; pasted text is fine — that might repeat
something already filed, done, or rejected. Not for the full background brief
(`ticket-research`) and not for sizing (`ticket-estimate`).

## Step 1 — characterize the target

From the ticket or draft, fix what a true duplicate must match: the **outcome
sought** (not the wording), the component or system touched, and any concrete
signature (an error message, an endpoint, a screen). Wording differs between
authors; outcomes are what duplicate.

## Step 2 — candidates from Jira

Two or three JQL angles, resolved statuses included — a Done duplicate is
still a duplicate, and its resolution may already be the answer:

- summary and text terms plus their synonyms — search the outcome's words,
  then the system's words;
- recent tickets in the same component or under the same label;
- the linked issues of the closest hits.

## Step 3 — candidates from memory

`memory-search` rung 1 on the outcome phrasing and the signature: past
episodes of the same work, lessons from it, and — decisive when present — a
decision that already accepted or rejected the idea. "We chose not to" is as
strong a find as "already done".

## Step 4 — verdicts

Resolve every candidate (rule 2), order duplicates first, and report:

```markdown
# Duplicate check — <KEY or "draft">: <summary>

## Verdict

<one line: clear duplicate found / partial overlaps found / nothing found>

## Candidates

| Candidate | Verdict | Confidence | Evidence |
| --------- | ------- | ---------- | -------- |

## What was searched

<the JQL angles and memory phrasings used>

## Recommended action

<link / close as duplicate / split the overlap / proceed — the human acts>
```

**Stop rule:** at most three JQL angles plus `memory-search`'s own stop rule,
and one widening pass if every first-round candidate judges `distinct`. Beyond
that, report what was searched and stop — absence proven within a stated scope
beats an endless hunt.

## Degradation

- **No Jira tools:** memory-only check on pasted text; say the Jira half was
  skipped — the verdict cannot rule out an existing ticket.
- **No memory tools:** Jira-only check; say that history and rejected-idea
  coverage was skipped.
- Never stall; name the degradation next to the verdict it weakens.

## References

- Search ladder and relevance gate: `memory-search` (gutt-core); relationship
  walking when a candidate needs one more hop: `graph-traversal`.
- Durable captures: `memory-capture`. Identity if an agent runs this:
  `agent-memory-protocol`.
- Siblings: `ticket-research` (context brief), `ticket-estimate` (effort and
  risk grounding).
