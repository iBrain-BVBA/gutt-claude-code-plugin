---
name: pr-re-review
description: "Review a pull request against what the organization already knows — its recorded standards and agreements, the findings this team has accepted before, and the incident history of the files being touched — with each finding verified at the source before it is reported, and accepted findings offered up as lessons afterwards. Produces a review for a human to act on, never a verdict pushed to the pull request unasked. Use on a PR whose risk is in the history rather than in the diff. Triggers on: review this PR, re-review, review my changes, does this follow our standards, code review, what did we say about this, have we been bitten here, review before merge, second pass on this PR."
---

# PR Re-review

Static checks and a careful reader already cover what is visible in a diff. What
neither covers is what this organization has learned: the agreement that says how
this kind of change is made here, the finding raised on the last three pull
requests in this file, the incident whose cause is one line above the change. A
review that does not know those things re-litigates settled questions and misses
the one that matters. This skill recalls them first, briefs the review with them,
verifies every finding against the actual code before reporting it, and then
offers the findings the team accepts back to memory so the next review starts
where this one ended.

It is a second pass, and it says so in its name: it complements
correctness-focused review and the project's own automated gates rather than
replacing either. The merge decision is the human's.

Underneath, `memory-search` owns the search ladder and the relevance gate,
`graph-traversal` owns relationship walking, and `memory-capture` owns the
capture at the end — including its trust-tier gate, which is the reason this
skill cannot store a lesson on its own say-so. All three ship with the gutt-pro
plugin (this plugin depends on it); without them, follow the rules below and note
the gap in one line. Repository and pull-request access comes from whatever
tooling the session surfaces — a hosting-platform integration, or the local
checkout and its CLI. Find it in your tool list; names and prefixes vary per
install.

## Hard rules (non-negotiable — read first)

1. **The review is delivered to the human, not to the pull request.** No
   approving, no requesting changes, no merging, no pushing, no branch or label
   edits, and no inline comments posted as a side effect of reviewing. Posting
   any of it is a separate act, done only when the user asks in this session and
   approves the exact text: it is outward-facing, other people are notified, and
   an apology does not retract it. Silence is not approval. The same terms cover
   a Jira comment; a ticket's own fields and criteria are never edited.
2. **Every reported finding is verified at the source, and the verification is
   what makes it reportable.** Before a finding reaches the output, open the file
   at the line and confirm the claim holds in the code as it now stands —
   including the rest of the diff, which routinely already handles what a lane
   flagged. A finding that survives is `confirmed`; one that cannot be checked is
   `unverified` and says why; one that does not survive is dropped, not softened.
   Findings from parallel lanes are the raw material for this step and are never
   the output of the skill.
3. **A recalled standard is quoted and cited, or it is not a standard.** An
   agreement, decision, or lesson used to justify a finding carries its source
   (id, date) and the words it actually says. Never generalize a remembered
   preference into a team rule, and never attribute a finding to memory that
   memory did not supply — an invented house rule is the one failure that
   discredits the whole review, because the author has no way to check it.
4. **Severity is impact, not confidence, and the two are reported separately.**
   `must-fix` means merging it causes harm — data loss, a security hole, a broken
   contract, a violated recorded agreement. `should-fix` means real cost, later.
   `consider` is taste, and taste is capped: say so and keep it short. Pre-
   existing conditions the PR merely touches are labeled pre-existing and never
   counted against it.
5. **The lanes get the brief; the brief is not optional.** Recall runs before any
   lane starts, and every lane prompt carries the recalled material verbatim
   along with the diff scope. A lane that has to guess the team's standards
   invents them, which rule 3 then has to catch one finding at a time.
6. **Nothing is captured to memory without an explicit human signal.** The
   capture at the end is an offer. A finding the user accepts may be proposed as
   a Lesson; `memory-capture` owns the classification and its tier gate, and a
   Lesson needs that human signal regardless of how obviously true the finding
   looks. Never capture a finding the author disputed, and never capture during
   the review — only after the outcome is known.
7. **A capture lands in the engagement's group scope, explicitly and verifiably.**
   Pass `group_id` naming that org group on the write, taken from a read that
   returned it — never guessed, never inferred from a write tool's name suffix,
   never left to the server to choose. Set `last_n_episodes=0`. Then read the
   episode back and confirm the group on the stored record is the one intended;
   report the group in the reply. Org writes cannot be undone from a normal
   session, which is why the check happens after the write rather than instead of
   it.
8. **Org scope on reads, bare tool names, and no invented ids.** Pass explicit
   `group_ids` naming the org group on reads — from session results or by asking.
   Call memory, repository, and issue tools by whatever names the tool list
   surfaces; probe with ToolSearch before concluding one is missing. Cite nodes
   by the readable ids a read returned; never hand-build one.

## When to use

A pull request where the risk lives in history rather than in the diff — a
sensitive area, a repeat pattern, a team with recorded agreements worth holding
the change to. Also for a self-review before opening one. Not for the diff-local
sweep a project's own gates and a plain reading already do, not for hunting
duplicate tickets (`ticket-duplicates`), and not for triaging a failure that has
already shipped (`bug-investigation`).

## Step 1 — scope the change

Establish, from whatever tooling is available: the changed files with their line
ranges, the diff itself, the PR's stated intent, and the ticket it claims to
satisfy. Read the ticket's acceptance criteria if there is one — "does this do
what it said" is the first question and it is answered from the criteria, not
from the diff's self-description.

Note what the change does **not** touch as well: a behaviour change with no test
change, or a schema change with no migration, is a finding in its own right and
it is visible only from the file list.

Then extract what recall runs on: the paths and modules, the subsystem names, the
kind of change (interface, data, dependency, configuration, sweep), and the
author — because "what has this team already told this author" is a real and
frequently repeated finding.

## Step 2 — recall the brief

`memory-search` rung 1, following its reformulation loop and stop-early
conditions. Four questions, and the answers together are the brief:

| What to recall                                                                     | Why it changes the review                                                                                             |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Recorded standards, working agreements, and decisions covering this kind of change | These are the house rules the review is entitled to hold the change to — and the settled questions it must not reopen |
| Findings this team has accepted before, on these files or this pattern             | A repeat finding is stronger than a fresh one, and citing the earlier acceptance ends the argument                    |
| Incident and regression history for the touched areas                              | Where this code has hurt before is where to read hardest                                                              |
| Lessons about the subsystem, including how to change it safely                     | Often the only place a non-obvious constraint is written down                                                         |

Deepen one hop via `graph-traversal` only where a summary names an agreement,
incident, or accepted finding without stating it.

**Minimum recall outcome — owe this before any lane starts**, with an explicit
"none found" per line rather than silence. An empty brief is a legitimate result
and it changes the review: with nothing recalled, the review is a plain reading
and says so, rather than dressing general practice up as the team's rules.

## Step 3 — choose the lanes

Lanes are narrow readers run in parallel, each with one question, the brief, and
the diff scope. Default set, and it is deliberately small — a lane with nothing
to do returns noise:

- **Intent and criteria** — does the change do what the PR and the ticket say,
  and is anything claimed but absent?
- **Recorded standards** — where does the change diverge from the agreements,
  decisions, and lessons in the brief? Quote them.
- **Risk history** — for the areas with incident or regression history, what
  would go wrong the same way again?
- **Verification** — do the tests, or their absence, actually demonstrate the
  behaviour the change claims? What silently swallows a failure?

Add a lane only where the diff earns it — a new public interface, a dependency
change, a data migration, a permissions boundary — and say which lanes you ran
and which you skipped. On a small diff, run fewer lanes rather than the same
lanes shallower.

**Mechanics.** These are general-purpose subagent lanes launched from this skill,
not named agents: they exist for the length of the review. Each prompt carries
the brief verbatim, the file list with line ranges, one question, and the
instruction to return findings as `file:line`, claim, and evidence — with an
explicit "nothing found" rather than filler. A lane that cannot read the code
returns that, and it is recorded as a gap rather than as a clean pass. If
subagents are unavailable, run the lanes in sequence in this session; the passes
are what matter, the parallelism is only speed.

## Step 4 — verify

Every finding from every lane goes through rule 2 before it exists. Verification
is a read of the code at the named line, in the state the PR leaves it, and it
resolves the failure modes a fan-out reliably produces: the finding already
handled elsewhere in the same diff, the finding that is true of the file but not
of the change, the standard that was paraphrased into something stricter than
what memory holds, and the finding that duplicates another lane's under a
different name — merge those into one and keep the better evidence.

Report the count that entered verification and the count that survived. A pass
where nothing survived is a real and reportable outcome.

## Step 5 — the review

```markdown
# Review — <PR title or branch>

## Verdict

<one line: what stands in the way of merging, or that nothing does — the merge
decision itself stays with the human>

## What memory brought

- <agreement / decision / lesson / accepted finding> (id, date) — <how it
  applied here, or "checked, no divergence found">

<or: "nothing on record for these areas" — and the review is a plain reading>

## Must-fix

- `file:line` — <the finding> — <evidence> — <cited standard, if it rests on
  one> — <verified | unverified: why>

## Should-fix

- `file:line` — …

## Consider

- <capped and short>

## Pre-existing, not this PR

- `file:line` — <so it is not counted against the change>

## Coverage

<lanes run and skipped; findings entered versus survived verification; anything
that could not be read>
```

Lead with the verdict, and let a clean review be short. A review that pads
`consider` to look thorough costs the author's attention and teaches them to skim
the next one.

## Step 6 — offer the capture

After the author or reviewer has settled which findings they accept — not
before — offer to record what is durable. Hand it to `memory-capture`: it
classifies, dedupes against what is already stored, and applies its tier gate.
Rules 6 and 7 govern; in practice:

- Offer only findings the team **accepted**, and only the ones that generalize
  past this PR. A one-off typo is not a lesson.
- A repeat finding that memory already holds needs no second episode — say it was
  already recorded and cite it.
- Write with the engagement's `group_id`, verify the stored group, and report it.
- A disputed finding is not captured. If the dispute itself was informative, that
  is a conversation for the team, not a write.

## Degradation

- **No repository or pull-request tooling:** review a diff pasted into the
  session, or the local working tree if that is what the user means. Say which,
  and say that the PR's own metadata — intent, linked ticket, review history —
  was unavailable if it was.
- **No memory tools:** probe with ToolSearch first; if truly absent, deliver a
  plain reading and say in one line that the standards, accepted-finding, and
  incident layers were skipped. Do not substitute general best practice for the
  team's recorded rules — rule 3 holds hardest exactly here.
- **No subagents:** run the lanes sequentially (Step 3).
- **Write tools hidden or denied at capture time:** report the findings worth
  recording in the reply so nothing is lost, and say the capture did not happen.
- Never stall; name the degradation next to the section it weakens.

## References

- Search ladder, relevance gate, summary-first reads: `memory-search` (gutt-pro).
- Relationship walking and edge-currency checks: `graph-traversal`.
- Classification, dedup, and the trust-tier gate for the capture: `memory-capture`.
- If an agent runs this as itself — and one does, since a capture is a write —
  `agent-memory-protocol` owns registration and the `agent_id` tag.
- Siblings: `bug-investigation` (a failure that already shipped),
  `ticket-research` (why the change exists at all).
