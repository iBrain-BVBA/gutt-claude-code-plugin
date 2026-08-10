---
name: bug-investigation
description: "Turn a bug into an investigation brief — how bad it is and why, which area it most likely lives in, and the similar failures the organization has already paid for, every claim cited. Produces a brief the developer acts on, never a severity, area, or status written into Jira. Use when a bug lands and nobody yet knows how bad it is or where to look. Triggers on: investigate this bug, triage this bug, how bad is this, what severity, where does this bug live, seen this before, similar failure, has this broken before, suspected area, root cause, why is this happening."
---

# Bug Investigation

A bug report says what broke. How much it costs, where it lives, and whether
this failure has happened before are all outside it — and the third is usually
the cheapest of the three to find, because someone has already paid for the
answer. This skill produces one cited brief: a severity with the reasoning that
produced it, a ranked suspected area with the evidence pointing there, and the
past failures that resemble this one together with what actually fixed them.
It is triage, not repair — the diagnosis and every line of the fix stay with
the developer.

Underneath, `memory-search` owns the search ladder and the relevance gate,
`graph-traversal` owns relationship walking when a summary names an incident
without stating it, and `memory-capture` owns any durable write; all three ship
with the gutt-pro plugin (this plugin depends on it) — without them, follow the
rules below and note the gap in one line. Jira access comes from whatever
Atlassian tooling the session surfaces; find it in your tool list — names and
prefixes vary per install.

## Hard rules (non-negotiable — read first)

1. **Jira is read-only here — never write a severity into it.** No priority or
   severity fields, no component or label edits, no status transitions, no
   assignment. The one permitted write is a comment the user explicitly asked
   for, posted only after they approve the exact text in this session. Treat it as final —
   approval is the gate, not an undo; a truly needed correction re-approves the
   text and targets the existing comment if the tool allows, rather than posting
   a second one. Write markdown and set the tool's content-format parameter to
   markdown when it exposes one.
2. **Severity carries the rubric it was scored against.** Read the scale the
   team actually uses off the ticket, its siblings, and anything memory records
   about severity conventions; if none is visible, ask, or state the default you
   applied — user impact × blast radius × whether a workaround exists — and say
   it is a default. Never emit a bare label: a severity without its rubric and
   its two or three deciding observations is an opinion wearing a badge.
3. **The suspected area is a ranked hypothesis, and it says what would refute
   it.** One to three candidates, most likely first, each with the evidence that
   points there and the single cheapest check that would rule it out. A
   hypothesis nothing could falsify is a guess — label it one.
4. **Every finding cited.** A past failure names its source: an incident,
   lesson, or episode (id, date), a ticket key with its resolution, or a
   comment with author and date. Uncitable material does not enter the brief.
   Absence is the exception by nature — it names what was looked for, not a
   source.
5. **"No similar failure found" carries its scope.** State the phrasings
   searched and the JQL angles tried, so absence is a checkable claim rather
   than a shrug. This matters most on the bugs that really are new: the brief
   has to be trustworthy when it says so.
6. **A resemblance is not a root cause.** A past failure that looks like this
   one is a lead with a citation, never the diagnosis. Report what the earlier
   fix was and what would confirm the same cause holds here; do not assert the
   cause, and never present a past fix as this bug's fix.
7. **Org scope is checked at the output, not the request.** Pass explicit
   `group_ids` naming the org group on reads — take the name from results
   already in the session or ask; never guess one, a guessed group id is a
   fabricated identifier. Treat scope as server-decided: before any finding
   enters the offered comment, confirm that item's own scope is the org group;
   personal-scope findings stay in the in-session brief, marked as personal.
   The same filter applies before any finding enters a comment the user asked
   to have posted.
   **Bare tool names**, probed with ToolSearch before concluding one is missing.
   **No memory writes** — a durable root-cause lesson goes through
   `memory-capture` and its trust-tier gate.

## When to use

A bug that needs sizing and a direction to look — freshly reported, or stalled
because nobody knows where it lives. Not for asking whether the bug is already
filed (`ticket-duplicates` owns duplicate verdicts), not for sizing the fix once
the area is known (`ticket-estimate`), and not for a production incident in
flight — an outage with a live blast radius is the operations role's work, and
this skill is the calmer, ticket-shaped version of the same motion.

## Step 1 — pin the failure down

Fetch the bug by key: summary, description, reproduction steps, priority and
severity fields as they currently stand, components, affects-version, comments,
and links. No Jira tooling in the session → Degradation; pasted text works and
is the supported path.

Then extract the four things the rest of the run searches on, and say which are
missing rather than filling them in:

- the **signature** — the error text, status code, stack frame, endpoint, or
  screen: the string a past occurrence would also carry;
- the **symptom in behaviour** — expected versus actual, stated without the
  reporter's diagnosis attached;
- the **surface** — component, service, or module named or implied;
- the **onset** — when it started, and what shipped near then if the ticket
  says.

A report with no signature and no reproduction is a triage input in its own
right: it caps severity confidence and it belongs in the brief's gaps.

## Step 2 — has this failed before

`memory-search` rung 1 on the signature and on the symptom phrasing, following
its reformulation loop and its stop-early conditions. Search the two
separately — a signature matches occurrences, a symptom matches write-ups, and
they rarely rank alike.

**Minimum recall outcome — owe this list before writing the brief**, with an
explicit "none found" per line rather than silence:

- past incidents or failures with the same signature or symptom (id, date), and
  what was found to cause them;
- what fixed them, and whether the record says the fix held;
- lessons recorded against this surface — including the ones about
  investigating it, not only about breaking it;
- decisions that constrain the area, or that introduced the behaviour on
  purpose: a bug report against a deliberate decision is a different
  conversation, and this is where it surfaces;
- incident history for the surface as a whole — an area that keeps breaking
  raises severity and narrows the hypothesis.

Deepen one hop via `graph-traversal` only where a summary names an incident,
cause, or decision without stating it.

## Step 3 — related tickets

Two or three JQL angles, resolved statuses included — a Done bug carries its
resolution, which is the most useful thing in the search: the signature's words,
the surface plus recent bugs, and the linked issues of the closest hits. This is
evidence for the brief, not a duplicate verdict; whether the ticket should be
closed as a duplicate belongs to `ticket-duplicates`.

## Step 4 — severity and hypothesis

Score severity per rule 2 and rank the area per rule 3. Both are built out of
step 1's observations and step 2's history — an area with repeat incidents and a
matching signature is a strong first candidate; a novel signature on a quiet
surface is a weak one, and the brief says so.

## Step 5 — the brief

```markdown
# Investigation brief — <KEY or "reported bug">: <summary>

## Severity

<label> — <rubric used, and whether it is the team's or the stated default> —
<the two or three observations that decided it> — <confidence: high/medium/low>

## Suspected area

| #   | Candidate | Evidence pointing here | Cheapest check that rules it out |
| --- | --------- | ---------------------- | -------------------------------- |

## Similar past failures

| Reference (id/key, date) | What happened | Cause found | What fixed it | Still holds? |
| ------------------------ | ------------- | ----------- | ------------- | ------------ |

## Area history

<incident and lesson density for this surface — or "none found">

## Gaps

- <what the report is missing, and what would close it: a repro, a log window, a
  named person>

## What was searched

<the memory phrasings and JQL angles, so the empty answers are checkable>

## Suggested next steps

- <the cheapest checks first, in the order that discriminates fastest>
```

Lines where nothing was found stay in the brief as "none found" — absence is
information, and it is what makes the brief trustworthy on a genuinely new bug.

## Degradation

- **No Jira tools:** ask for the bug text pasted in — description, reproduction
  steps, comments that matter — run steps 2, 4 and 5 on it, and mark Related
  tickets as skipped. This is the expected path in an unattended run, not a
  lesser one; the severity and hypothesis still stand on memory evidence.
- **No memory tools:** probe with ToolSearch first; if truly absent, deliver the
  ticket-only half, cap severity confidence at `medium`, and say in one line
  that history grounding was skipped — with no history, "never seen before" is
  not a finding you are entitled to.
- **Either way, the brief is built from the ticket and from memory — not from
  the code.** This skill does not read the repository, so "what shipped into
  this area recently" is not part of the evidence unless the ticket says. Say so
  when the suspected area rests on history alone; a reviewer who checks the
  recent changes may rank it differently, and should.
- Either way: never stall, and name the degradation next to the claim it
  weakens.

## References

- Search ladder, relevance gate, summary-first reads: `memory-search`
  (gutt-pro) — its `references/tools.md` holds the per-tool contracts.
- Relationship walking and edge-currency checks: `graph-traversal`.
- Durable captures out of an investigation: `memory-capture` and its tier gate.
- If an agent runs this as itself, `agent-memory-protocol` owns identity and
  registration; read-only triage needs neither.
- Siblings: `ticket-duplicates` (duplicate verdicts), `ticket-estimate` (sizing
  the fix), `ticket-research` (the full background brief when the bug turns out
  to be a design question).
