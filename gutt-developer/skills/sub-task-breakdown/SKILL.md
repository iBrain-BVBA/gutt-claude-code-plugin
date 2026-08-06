---
name: sub-task-breakdown
description: "Break one story into the sub-tasks it actually decomposes into — each with a title, checkable acceptance criteria, a grounded effort range, and its dependencies — in Jira's own vocabulary and nobody else's. Produces a proposal to argue with, never sub-tasks written into Jira unless explicitly asked for. Use when a story is too big to start, or before refinement. Triggers on: break this down, split this story, sub-tasks for, decompose, too big to start, slice this, what are the pieces, sequence the work, task breakdown, how do we split this."
---

# Sub-task Breakdown

A story that is too big to start is usually not too big to describe — the pieces
are known, they were just never written down, and so nobody can begin, estimate,
or parallelize. This skill writes them down: a small set of sub-tasks, each with
acceptance criteria a reviewer could actually check, an effort range grounded in
comparable past work, and the dependencies that fix their order. The output is a
proposal. Which slices are right, and whether they get filed at all, stays with
the team.

Underneath, `memory-search` owns the search ladder and the relevance gate,
`graph-traversal` owns relationship walking when a summary names a thing
without stating it, and `memory-capture` owns any durable write; all three ship
with the gutt-pro plugin (this plugin depends on it) — without them, follow the
rules below and note the gap in one line. Jira access comes from whatever Atlassian tooling the session
surfaces; find it in your tool list — names and prefixes vary per install.

## Hard rules (non-negotiable — read first)

1. **Jira is read-only by default; filing is a gated exception.** Never touch
   the parent story — not its description, not its acceptance criteria, not its
   fields, not its status. Divergence from the parent goes in the proposal, and
   in a comment if the user approves one; the story's own text is the author's.
   Sub-tasks are **created only when the user asks for them in this session and
   approves the exact set** — titles, criteria, and links as they will be
   written. Creating issues is outward-facing and not undone by an apology:
   approval is the gate, and silence is not approval. The other permitted write
   is one comment, on the same exact-text terms.
2. **Jira's vocabulary only — no other tracker's mechanics in the output.** A
   dependency is a Jira issue link (`blocks` / `is blocked by`); a parent is
   the parent field of a sub-task issue type; acceptance criteria are text in
   the sub-task's own description. No `#123` references, no `Closes #…`
   trailers, no checklist-as-linking — whatever tracker the session exposes,
   this skill emits Jira. That includes foreign references quoted from the
   parent's own text, which is where they usually get in: **translate** each to
   the Jira key it means, or **name it as untranslatable** — "the parent cites
   `#412`, which does not resolve to a Jira issue; ask the author which ticket
   it means." Never pass one through unaccounted.

3. **Acceptance criteria are checkable or they are not criteria.** Each one
   states an observable outcome someone else could check without asking the
   author what was meant — checkable by a person, not necessarily by an
   automated test. "Refactor the handler" is a title, not a criterion;
   "the handler rejects a payload over 1 MB with a 413 and logs the size" is a
   criterion. A sub-task whose criteria you cannot make observable is a sign the
   slice is wrong — resize it rather than writing a vague criterion.
4. **Effort is a range with a basis, or it is labeled a guess.** Ground each
   sub-task the way `ticket-estimate` does: comparable past work with citations,
   in the unit the team actually uses — read the unit off the parent and its
   board; if it is not visible, ask, or default to a day-range and say so. No
   comparables for a slice means `low confidence` on that row, said out loud.
   And state the whole separately from the sum: integration, review, and
   handoffs are real and are not inside any one sub-task.
5. **Dependencies are real ordering constraints, not a preferred sequence.** A
   `depends_on` claims the earlier sub-task must land first for the later one to
   be doable — a shared interface, a migration, a decision. Taste, tidiness, and
   who happens to be free are not dependencies. Say which are hard and which are
   merely convenient, and keep the graph acyclic: a cycle means the slice
   boundary is in the wrong place.
6. **Design notes stay light and stay labeled.** Enough approach to make a slice
   startable and its effort defensible — the touch points, the obvious
   sequencing risk — and no further. Full implementation design (interfaces,
   data model, migration strategy) is the architect role's work, not this
   skill's; where a slice cannot be sized without it, say that instead of
   inventing it.
7. **Org scope is checked at the output, not the request.** Pass explicit
   `group_ids` naming the org group on reads — take the name from results
   already in the session or ask; never guess one. Treat scope as
   server-decided: before any comparable or citation enters a filed sub-task or
   an offered comment, confirm that item's own scope is the org group;
   personal-scope material stays in the in-session proposal, marked as personal.
   **Bare tool names**, probed with ToolSearch before concluding one is missing.
   **No memory writes** — a durable slicing lesson goes through `memory-capture`
   and its trust-tier gate.

## When to use

A story nobody can start, or refinement prep for one. Not for sizing a story
that needs no splitting (`ticket-estimate` on its own), not for the background
of a story whose purpose is unclear (`ticket-research` first — a breakdown of a
misunderstood story is worse than none), and not for designing the
implementation.

## Step 1 — the parent, and whether it can be sliced yet

Fetch the story: summary, description, acceptance criteria, components, existing
sub-tasks and links, and the unit its board estimates in. No Jira tooling → the
pasted-text path in Degradation.

Then decide, out loud, whether a breakdown is even the right output:

- **Criteria absent or untestable** → the slices would inherit the vagueness.
  Say so, propose the criteria the story needs, and hold the breakdown.
- **Sub-tasks already exist** → this is a revision, not a first cut. Read them,
  and mark every proposed slice as new, an overlap with an existing one, or a
  replacement for it.
- **The story is already one slice** → say that too. A breakdown that invents
  three sub-tasks for a one-day change is noise the board pays for.

## Step 2 — the seams

Cut where the work actually separates, and take the seam from the story's own
criteria wherever they carry one — a criterion that can be demonstrated on its
own is a slice. The seams that hold in practice: a vertical piece of behaviour
that can be verified end to end; a boundary another slice depends on
(interface, schema, contract) which therefore comes first; a mechanical sweep
that is large but uniform; the tests or migration for a piece that ships
separately from it.

Aim for three to seven sub-tasks. Fewer means the story was already a slice;
more usually means the seams are wrong — or that this is an epic wearing a
story's issue type, which is worth saying rather than working around.

## Step 3 — ground the effort and the risk

`memory-search` rung 1 per slice shape — comparable past work, and lessons about
this surface: what was underestimated, which dependency stalled, where the
incidents cluster. Every one of these reads carries the org group's `group_ids`
(rule 7); a read that omits it is scoped by the server, not by you. One search
pass usually serves several slices; do not re-run it per row. A `ticket-estimate`
or `ticket-research` output already in context is the grounding — extend it
rather than searching again. Deepen one hop via `graph-traversal` only where a
comparable's summary names a dependency, incident, or decision without stating
it.

**Minimum outcome:** every row carries either a cited comparable or an explicit
"no comparable found", which per rule 4 forces `low confidence` on that row.

## Step 4 — the proposal

```markdown
# Sub-task proposal — <KEY>: <summary>

## Shape

<one or two lines: how many slices, on what seam, and the whole-story effort
with the integration overhead named separately from the sum of the rows>

## Sub-tasks

### <n>. <title>

- **Acceptance criteria**
  - <observable outcome>
- **Effort:** <range in the team's unit> — <confidence> — <basis, cited>
- **Depends on:** <sub-task number, hard or convenient> | none
- **Design notes:** <the touch points and the sequencing risk, briefly> | none
- **Status against the parent:** new | overlaps <existing sub-task> | replaces
  <existing sub-task>

## Order

<the dependency order, hard constraints first, and what can run in parallel>

## What this leaves open

- <decisions the breakdown needed and did not have — including anything that
  belongs to implementation design rather than here>
```

## Filing them

Only on an explicit ask, and only after the user approves the exact set (rule 1).
When that happens:

- create each as a **sub-task issue type under the parent key** — never a
  sibling story, and never a second parent;
- put the acceptance criteria in the sub-task's own description, as text;
- write effort into whatever estimate field the team actually uses, and only if
  the user said to — a range does not fit a single-number field, so ask which
  end goes in rather than silently picking one;
- create dependencies as issue links of type `blocks` / `is blocked by`, after
  the sub-tasks exist, and report the links created;
- report what was created with keys, and what failed, item by item. A partial
  filing is the normal failure here and the user needs to know exactly where it
  stopped.

## Degradation

- **No Jira tools:** work from the story text pasted in, produce the same
  proposal, and say plainly that nothing can be filed and that existing
  sub-tasks could not be checked for overlap.
- **No memory tools:** probe with ToolSearch first; if truly absent, propose the
  slices with effort marked as ungrounded guesses per rule 4, and say in one
  line that comparables were unavailable.
- Never stall; name the degradation next to the rows it weakens.

## References

- Effort method, comparables, and risk grounding: `ticket-estimate` — this skill
  applies it per slice rather than restating it.
- Story background before slicing: `ticket-research`.
- Search ladder and relevance gate: `memory-search` (gutt-pro); relationship
  walking: `graph-traversal`; durable captures: `memory-capture`.
- If an agent runs this as itself, `agent-memory-protocol` owns identity and
  registration.
