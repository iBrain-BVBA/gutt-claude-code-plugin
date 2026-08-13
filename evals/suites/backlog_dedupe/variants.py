#!/usr/bin/env python3
"""Variants: the shipped skill text, the text before three edits, and no skill at all.

V0 is read from the working tree at run time, not pasted here, so the suite always
measures the text that would ship — a copy would drift the first time the skill was
edited. The frontmatter is stripped because the loader keeps it; the model sees the body.

V1 is the control. An unaided model groups similar tickets readily; what it does not
reliably do is keep the buckets summing to the slice, justify every stale candidate with
evidence rather than age alone, label wording-only verdicts as weaker than memory-backed
ones, or hold every close and merge behind per-action approval. The gap between the two
is the skill's measured value.

V2 is V0 with three later edits taken back out, so the pair can be scored in one run
rather than against a number from an earlier round. That matters here: this suite's own
control has not been shown stable between rounds, and a sibling suite watched its
zero-length arm move 13 points — wider than the gap most of these edits are trying to
buy. The three edits, all additions, were:

  - rule 3 extended to treat "every" and "none" as counts needing a tally;
  - rule 1 extended to define what makes a batch *named*, and to bar anything
    unrelated from sharing an approval question;
  - the evidence columns of both output tables renamed to carry the
    `similarity only` fallback, plus a line under the template making it a check.

V2 is derived by removing that text rather than pasted whole, so it cannot drift away
from V0 in the parts neither edit touched. Each removal raises if its anchor is gone —
a V2 that silently equalled V0 would read as evidence the edits change nothing.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
SKILL_PATH = ROOT / "gutt-product" / "skills" / "backlog-dedupe" / "SKILL.md"

# (added text, what stood there before). Whitespace is significant: these are matched
# against the skill body verbatim.
_EDITS = [
    (
        '3. **Counts are recounted, never estimated — and "every" and "none" are\n'
        "   counts.** Cluster sizes, stale totals, and any claim of how many tickets\n"
        "   something covers are computed by enumerating the working set. A number that\n"
        "   cannot be recounted from the set does not enter the output. A claim about all\n"
        "   of something — every edit in a history, no real activity on a ticket — is the\n"
        "   same claim wearing a different word: enumerate it, give the tally, and name\n"
        '   the exceptions. "Twenty of twenty-two entries are sprint moves" is a finding;\n'
        '   "every entry is a sprint move" is that finding with the exceptions dropped,\n'
        "   and the exceptions are often where the real activity is.",
        "3. **Counts are recounted, never estimated.** Cluster sizes, stale totals, and\n"
        "   any claim of how many tickets something covers are computed by enumerating\n"
        "   the working set. A number that cannot be recounted from the set does not\n"
        "   enter the output.",
    ),
    (
        "   session. Approval is the gate, not an undo; silence is not approval. A batch\n"
        "   counts as named only where the text the user reads before answering carries\n"
        "   every key and what happens to each — a label standing for them is not that\n"
        "   text. One ask decides one thing: nothing unrelated rides along in the same\n"
        "   question, and housekeeping never shares a question with a Jira action. The\n"
        "   one other permitted write is a comment, drafted and posted only after the\n"
        "   user approves the exact text. Write markdown and set the tool's\n"
        "   content-format parameter to markdown when it exposes one.",
        "   session. Approval is the gate, not an undo; silence is not approval. The one\n"
        "   other permitted write is a comment, drafted and posted only after the user\n"
        "   approves the exact text. Write markdown and set the tool's content-format\n"
        "   parameter to markdown when it exposes one.",
    ),
    (
        "| #   | Tickets | Shared outcome | Evidence (source, date) or `similarity only` | Proposal |\n"
        "| --- | ------- | -------------- | -------------------------------------------- | -------- |",
        "| #   | Tickets | Shared outcome | Evidence (source, date) | Proposal |\n"
        "| --- | ------- | -------------- | ----------------------- | -------- |",
    ),
    (
        "| Ticket | Age / last activity | Why it looks dead — evidence, or `similarity only` | Proposal |\n"
        "| ------ | ------------------- | -------------------------------------------------- | -------- |",
        "| Ticket | Age / last activity | Why it looks dead (evidence) | Proposal |\n"
        "| ------ | ------------------- | ---------------------------- | -------- |",
    ),
    (
        "Every row of both tables fills its evidence cell — a source and a date, or the\n"
        "literal `similarity only`. Prose that names no source is an unfilled cell: the\n"
        "reader cannot tell a cited verdict from a plausible one.\n\n",
        "",
    ),
]


def _skill_body():
    text = SKILL_PATH.read_text(encoding="utf-8")
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            return parts[2].strip()
    return text.strip()


def _prior_body():
    """The shipped body with the three later edits removed.

    Raises if any anchor has moved. Reverting an edit the skill no longer contains
    would leave V2 equal to V0 under a name that promises otherwise, which is worse
    than a failed run: the report would show two arms agreeing and read as a result.
    """
    body = _skill_body()
    for added, before in _EDITS:
        if added not in body:
            raise RuntimeError(
                "backlog-dedupe V2-prior is stale: cannot find the edited text\n"
                f"  {added.splitlines()[0][:70]!r}\n"
                "in the shipped skill. Re-derive the arm against the current wording, "
                "or drop it once the comparison it was built for has been made."
            )
        body = body.replace(added, before, 1)
    return body.strip()


def all_variants():
    return {
        "V0-shipped": _skill_body(),
        "V2-prior": _prior_body(),
        "V1-none": "",
    }
