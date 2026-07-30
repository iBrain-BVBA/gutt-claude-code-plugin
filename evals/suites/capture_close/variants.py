#!/usr/bin/env python3
"""Candidate closing instructions appended to a fired Stop reason.

V0 is not written here. It is read out of the shipped skill between its injection markers,
because a baseline copied by hand drifts and every delta measured against a drifted
baseline is meaningless — the same reason `prompt_pointer.suite` re-derives its V0 from the
hook source. Here the read is trivial rather than a string-literal reconstruction: the
skill file *is* the deployed artifact.

The ablations exist to answer specific questions rather than to fill a table:

  V1-none          what the capture path did before GP-927: the reason alone. This is the
                   defect baseline, and any variant that does not beat it is not worth its
                   chars.
  V2-summary-only  the rule this replaced, which lived in `memory-capture/SKILL.md` and
                   asked for "a short summary of that work, placed last". It was already in
                   context on the capture path, so if it scored the same, GP-927 bought
                   nothing and the story's premise is wrong.
  V3-no-negatives  V0 minus the sentence excluding a verbatim echo and a recap. The story
                   argues that "re-emit the answer" read literally produces exactly those
                   two, so this measures whether saying so is load-bearing or ornamental.
  V5-plus-style    V0 *plus* the whole-reply style list. Round 1 shipped that list inside the
                   markers and measured it at 335 characters for no detectable gain, so it
                   was moved out and the shipped block is now the shorter form. This variant
                   is the inversion that keeps the question open: it re-adds the list, so a
                   later pooled round can still find out whether it earns its place. Dropping
                   the comparison instead would have made the decision permanent by
                   forgetting it was made. Round 4 answered it: 67% against 96%, so the list
                   inside the markers is not free.
  W1/W2/W3         the round-4 tuning candidates, kept as documented negatives. See the block
                   above their text for what each one was trying to fix and FINDINGS.md for
                   what happened. None of them beat V0; W1 lost to saying nothing at all.
"""
import pathlib
import re

SKILL = (
    pathlib.Path(__file__).resolve().parents[3]
    / "gutt-core"
    / "skills"
    / "output-style"
    / "SKILL.md"
)
BEGIN = "<!-- INJECTED:BEGIN -->"
END = "<!-- INJECTED:END -->"


def shipped():
    """The injected region of the shipped skill, or a hard failure naming the reason.

    A silent fallback here would report the ablations against an empty baseline and look
    like a result, so this raises instead.
    """
    text = SKILL.read_text(encoding="utf-8")
    start, end = text.find(BEGIN), text.find(END)
    if start == -1 or end == -1:
        raise SystemExit(
            f"{SKILL} has no {BEGIN}/{END} pair — the shipped block cannot be read, so "
            "nothing measured against it would mean anything."
        )
    block = text[start + len(BEGIN) : end].strip()
    if not block:
        raise SystemExit(f"{SKILL}: the injected region is empty")
    return block


def _drop_paragraph(text, needle):
    """Remove the paragraph containing `needle`, failing loudly if it has moved."""
    paras = re.split(r"\n\s*\n", text)
    kept = [p for p in paras if needle not in p]
    if len(kept) == len(paras):
        raise SystemExit(
            f"no paragraph in the shipped block contains {needle!r} — an ablation that "
            "removes nothing is not an ablation"
        )
    return "\n\n".join(kept)


def style_paragraph():
    """The whole-reply style list, read from the section it was moved to.

    Pulled out of `SKILL.md` rather than pasted here for the same reason `shipped()` is: it
    is a live rule that someone will reword, and a copy would drift into measuring a wording
    that no longer exists anywhere. Raises rather than falling back, because a `V5` that
    silently equals `V0` would look like evidence that the style list changes nothing.
    """
    text = SKILL.read_text(encoding="utf-8")
    marker = "## Style for the whole reply"
    if marker not in text:
        raise SystemExit(
            f"{SKILL} has no {marker!r} section — the style list has moved or gone, and "
            "V5-plus-style cannot be built from it."
        )
    body = text.split(marker, 1)[1]
    # First paragraph of that section is the rules; the paragraphs after it explain why they
    # sit outside the markers, which is commentary and must not be measured as an instruction.
    for para in re.split(r"\n\s*\n", body):
        para = " ".join(para.split())
        if para.startswith("Substance first"):
            return para
    raise SystemExit(f"{SKILL}: the style section no longer opens with the rules paragraph")


# The rule GP-927 replaced, quoted from the `memory-capture` section it was removed from
# (commit history has the original). Reproduced as prose the agent receives, not as a
# citation, because that is how it reached the model when it shipped.
V2_TEXT = (
    "Close the reply with a short summary of that work, placed last, after everything "
    "else. Keep it to what the user needs to carry forward: what was delivered, anything "
    "that did not survive verification, and what is still open. It comes last because the "
    "capture is a footnote to the turn and the work is its subject."
)


# The tuning round (W1–W3). Target: match V5-plus-style's quality at or below the shipped
# block's 878 characters.
#
# Designed from the failure data, not from taste. Across rounds 2 and 3 every single failure
# of either candidate block was `reported` — the reply writes a perfectly good work summary
# and never mentions the capture at all — plus one `closed_on_work`. `preamble`,
# `pleasantry`, `apology` and `echoed` were 0 across all 120 calls. So V5's extra 335
# characters of style list cannot be what earns its score; nothing in that list mentions
# reporting a capture. The lever is the first half of the two-part demand.
#
# Reading the dropped replies makes the mechanism concrete: they continue the technical
# discussion as though the capture result had not been handed to them. The shipped block's
# opener is conditional — "Where the turn did something on the way" — which gives the model
# an out it takes, and the three examples after it are abstract enough not to catch.
#
# Each candidate attacks that differently, so a win is attributable:
#
#   W1-numbered    structural. The two parts become a numbered list with an explicit
#                  skip condition, rather than prose the model can read past.
#   W2-omission    names the measured failure outright: saying it happened is not optional.
#   W3-presend     a pre-send check instead of another declarative rule — the baseline
#                  skill's own mechanism, which we dropped. Different lever from W1/W2.
#
# Outcome, round 4 at n=24 (FINDINGS.md has the tables): none of the three beat V0's 96%.
# W3 88%, W2 83%, W1 62%. They are kept because each result is worth more than the candidate
# was. W1 is the sharpest: its one distinguishing sentence is permission to omit, and it
# omitted more often (8/24) than the variant with no instruction at all (7/24) — so the
# structural rewrite is not what cost it. W2 and W3 both fixed the axis they aimed at and
# lost the other one, which says the two halves of the demand trade against each other on
# this corpus and V0 is the wording that holds both. Do not re-derive these from scratch;
# a fourth attempt on the presence axis should expect to pay on `closed`.
#
# All three keep the "not an interruption" clause. Dropping it would buy ~160 characters and
# the corpus shows 0 apologies in 120 calls — but FINDINGS.md records that this bench cannot
# *reach* that failure, so cutting the clause on those grounds is the exact error the file
# warns about. It also has a guard in tests/hook-architecture.test.cjs.

W1_NUMBERED = """The reply ends in two parts, in this order.

1. What the turn did on the way — recorded a finding, migrated a store, changed a setting. A few lines: what happened, and anything the user still has to decide. Omit this part only if the turn did none of it.
2. The closing summary of the turn: what was delivered, what it means for the user, and what is still open.

Whatever sits at the bottom is what the user is left looking at, and it is part 2, never part 1.

Part 2 is not a verbatim echo of text already written above it, and not an account of what you just did — those are the two ways it goes wrong. Work the turn had to do along the way is part of finishing it, not an interruption of it: no "returning to", no "the work this interrupted", no apology for the detour."""

W2_OMISSION = """The reply ends in two parts, in this order. Where the turn did something on the way — recorded a finding, migrated a store, changed a setting — account for it first, in a few lines: what happened, and anything the user still has to decide. Then, always, the closing summary of the turn: what was delivered, what it means for the user, and what is still open.

Saying the first part happened is not optional: a reply that omits it leaves the user believing nothing was written. Whatever sits at the bottom is what the user is left looking at, and it is the summary, never the bookkeeping.

The summary is not a verbatim echo of text above it, and not an account of what you just did. Work the turn had to do is part of finishing it, not an interruption: no "returning to", no apology for the detour."""

W3_PRESEND = """The reply ends in two parts, in this order. Where the turn did something on the way — recorded a finding, migrated a store, changed a setting — account for it first, in a few lines: what happened, and anything the user still has to decide. Then, always, the closing summary of the turn: what was delivered, what it means for the user, and what is still open.

Work the turn had to do along the way is part of finishing it, not an interruption of it: no "returning to", no apology for the detour.

Before sending, check three things. Both parts are there. The summary is last. Its first line is substance rather than an announcement of what you are about to say, and its last line is not a pleasantry."""


def all_variants():
    block = shipped()
    variants = {
        "V0-shipped": block,
        "V1-none": "",
        "V2-summary-only": V2_TEXT,
        "V3-no-negatives": _drop_paragraph(block, "verbatim echo"),
        "V5-plus-style": f"{block}\n\n{style_paragraph()}",
        "W1-numbered": W1_NUMBERED,
        "W2-omission": W2_OMISSION,
        "W3-presend": W3_PRESEND,
    }
    # The round's own premise is "at or below the shipped length". A candidate that quietly
    # grew past it would still be scored and might well win on the extra words, which is not
    # the question being asked.
    over = {k: len(v) for k, v in variants.items() if k.startswith("W") and len(v) > len(block)}
    if over:
        raise SystemExit(
            f"tuning candidates must not exceed the shipped block's {len(block)} chars: {over}"
        )
    return variants
