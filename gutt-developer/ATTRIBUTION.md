# Attribution

Provenance and attribution for borrowed structure in this plugin's skills. Nothing
here is an instruction to an agent — the skill bodies are self-sufficient, and this
file exists so the borrowing is recorded and checkable.

## pr-re-review — the parallel-lane review structure

Adapted from the **pr-review-toolkit** plugin in
[`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official)
(`plugins/pr-review-toolkit`, principally `commands/review-pr.md` and the `agents/`
set), Apache License 2.0, © Anthropic.

Pinned at commit **`52e95f6756e577b6a788c941f994ca44de2cf2d6`** — the commit the
installed marketplace snapshot recorded, confirmed to resolve in that repository.
A later upstream revision may differ; re-read before claiming this skill tracks it.

This repository is MIT. This file makes no claim about what Apache-2.0 does or does
not require — that is not ours to assert — so the operating rule is the conservative
one: **if you copy substantial wording from the upstream plugin into this repo, carry
the Apache-2.0 licence and notice with it, and state that the file was changed.**
What was taken here is the structure rather than the wording, and the credit is given
regardless of whether anything obliged it.

### Adapted, not copied

**Taken:** the shape. A review is a fan-out of narrow single-question readers run in
parallel rather than one reader trying to hold everything at once; their findings are
aggregated into a severity-tiered summary; findings are anchored as `file:line`; the
review is worth running before the pull request is opened rather than after.

**Replaced, and this is the substance of the change.** Upstream selects its lanes by
file type — tests changed, so run the test analyzer; types added, so run the type
analyzer — and each lane's question is a static, diff-local property of the code.
Here the lanes are chosen by what the change touches, and every lane is briefed first
with what organizational memory holds about that area: the recorded agreements and
decisions, the findings this team has already accepted, the incident history of the
files. The lane questions follow from the brief rather than from the file extensions.
That inverts which half of the review is the expensive one: upstream's cost is
reading the diff carefully, this skill's is recalling correctly and then proving each
finding.

**Dropped:** the six named specialist agents (comment accuracy, test coverage, silent
failure, type design, general quality, simplification) and their separate agent files.
Those concerns are diff-local and already covered — the upstream toolkit installs
alongside this plugin and can be run directly, and code simplification is a built-in
capability of the CLI. Re-implementing them here would be a second, worse copy. The
lanes in `skills/pr-re-review/SKILL.md` are subagents spawned for one review, not
shipped agent definitions, for the same reason.

**Added, with no upstream counterpart:**

- **A mandatory verification pass.** Upstream aggregates lane findings into the
  report. A fan-out of confident narrow readers reliably produces findings that are
  true of the file but not of the change, or already handled elsewhere in the same
  diff, or duplicated across two lanes under different names — so here nothing is
  reported until it has been re-read at the source, and the entered-versus-survived
  counts are part of the output.
- **The citation rule.** A finding that rests on a house rule must quote and cite the
  record it came from. The failure this prevents is specific to a memory-informed
  review and does not arise upstream: a generalized preference presented as the team's
  standard is unfalsifiable by the author.
- **The capture offer.** Accepted findings can go back into memory as lessons, so the
  next review starts where this one ended. This is the half that makes the skill
  compound, and it is gated: an explicit human signal, and a verified group scope.
- **The delivery gate.** Upstream's command posts a review to the pull request as part
  of its workflow. Here the review is delivered to the human and nothing is posted,
  approved, or requested-changes without approval of the exact text in the session —
  posting notifies other people and is not retracted by an apology.
