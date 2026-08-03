#!/usr/bin/env python3
"""Candidate closing instructions appended to a fired Stop reason.

V0 is not written here. It is read out of the shipped skill between its injection markers,
because a baseline copied by hand drifts and every delta measured against a drifted
baseline is meaningless — the same reason `prompt_pointer.suite` re-derives its V0 from the
hook source. Here the read is trivial rather than a string-literal reconstruction: the
skill file *is* the deployed artifact.

Since the pointer change, what `shipped()` returns is one line naming this skill rather than a
copy of its rules, so V0 and the prose it replaced are now two different arms:

  V0-shipped       the live injected region — the pointer. Read from the file, so it tracks
                   whatever ships.
  V6-prose-block   the 804-character prose block V0 used to be, frozen as a literal below.
                   This is the arm the pointer has to beat, and freezing it is the point: it
                   is the first control in this suite's history that cannot re-baseline.

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

    The end marker is searched for *after* the begin marker, matching `readStyleBlock` in
    `gutt-core/hooks/lib/stop-judge.cjs`. Unanchored, an `INJECTED:END` appearing earlier in the file —
    quoted in commentary, or in an example of the markers themselves — would slice a region
    the hook never reads, and the baseline every variant is scored against would silently
    stop being the shipped text.
    """
    text = SKILL.read_text(encoding="utf-8")
    start = text.find(BEGIN)
    end = text.find(END, start + len(BEGIN)) if start != -1 else -1
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


# The prose block that shipped from GP-927 until the pointer replaced it, at the 804-character
# length it reached after the duplicated capture-account clause came out.
#
# Frozen as a literal, deliberately, and this is the one arm in the file that must not be
# derived. `shipped()` reads the live injected region, which is now one line naming this skill,
# so the prose is no longer reachable from the file at all — and a variant set that can only
# measure the pointer cannot answer the question the pointer raises. Nine rounds of derived-V0
# also taught the narrower lesson: a live-derived arm is a *baseline*, not a *control*. It
# silently re-baselines whenever anyone edits the skill, which is exactly how round 4's
# 878-character V0 and round 5's 804-character V0 came to be reported under one name and one
# label as though they were the same measurement. A control has to be bytes.
#
# Reproduced verbatim, unwrapped, as it sat between the markers — the newlines and the em
# dashes are part of what was scored.
PROSE_BLOCK = """The reply ends in two parts, in this order. Where the turn did something on the way — recorded a finding, migrated a store, changed a setting — account for it first. Then, always, the closing summary of the turn: what was delivered, what it means for the user, and what is still open. Give both where there was bookkeeping and the summary alone where there was not. Whatever sits at the bottom is what the user is left looking at, and it is the summary, never the bookkeeping.

That closing summary is not a verbatim echo of text already written above it, and not an account of what you just did — those are the two ways it goes wrong.

Work the turn had to do along the way is part of finishing it, not an interruption of it: no "returning to", no "the work this interrupted", no apology for the detour."""

# The length is asserted rather than commented because every table in FINDINGS.md is keyed on
# it, and a stray reflow here would renumber the history without failing anything.
if len(PROSE_BLOCK) != 804:
    raise SystemExit(
        f"PROSE_BLOCK is {len(PROSE_BLOCK)} chars, not the 804 that FINDINGS.md's tables are "
        "keyed on — it has been reflowed or edited, and the frozen arm is no longer frozen."
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


def _reanchor(block):
    """The shipped block, re-anchored on the skill invocation that sits above it.

    A different question from W1-W3. Those asked whether a better wording exists at or below
    the shipped length. This asks whether the block should name the skill invocation above it
    as a precondition instead of opening on a capture in the past tense.

    The review that raised it read "recorded a finding" as presupposing a write that has not
    happened yet, and read the block's deliberate recency position as demoting the skill line
    to the slot the same argument calls lossy. The counter-argument, which looks the stronger
    of the two: the block governs the *reply*, and the reply is composed after the skill has
    run, so the tense is correct at the point the instruction applies -- and the skill name
    holds first position, which is not a weak one either.

    Unresolved in both directions by this corpus, which hands the model a completed capture
    and therefore cannot see whether one ran at all (see FINDINGS.md, "What this does not
    establish"). Kept here so the question is settled by measurement when a corpus that can
    reach it exists, rather than by whichever reading sounds better.

    Exempt from the W length gate on purpose: length is not the variable, and a prefix can
    only make the candidate longer than the block it modifies.
    """
    opener = "The reply ends in two parts"
    if not block.startswith(opener):
        raise SystemExit(f"{SKILL}: the block no longer opens with the sentence R1 re-anchors")
    return f"After running the skill named above, t{block[1:]}"


def all_variants():
    pointer = shipped()
    # The prose-derived arms are built from `PROSE_BLOCK`, not from `pointer`. Each of the three
    # asks a question *about the prose* — drop one of its paragraphs, add the style list back,
    # re-anchor its opening sentence — and none of them is answerable against a one-line pointer.
    # Left deriving from `shipped()` they did not degrade, they raised: `_drop_paragraph` found no
    # paragraph to remove and `_reanchor` found no opening sentence to rewrite, both by design.
    variants = {
        "V0-shipped": pointer,
        "V1-none": "",
        "V2-summary-only": V2_TEXT,
        "V3-no-negatives": _drop_paragraph(PROSE_BLOCK, "verbatim echo"),
        "V5-plus-style": f"{PROSE_BLOCK}\n\n{style_paragraph()}",
        "V6-prose-block": PROSE_BLOCK,
        "W1-numbered": W1_NUMBERED,
        "W2-omission": W2_OMISSION,
        "W3-presend": W3_PRESEND,
        "R1-reanchor": _reanchor(PROSE_BLOCK),
    }
    # V0 is the live region, so a round would silently score the prose twice under two names if
    # someone put it back between the markers. That is a real edit someone might make to revert
    # this change, and it would make V0 and V6 an accidental duplicate pair rather than the
    # comparison the round exists for.
    if pointer == PROSE_BLOCK:
        raise SystemExit(
            "the injected region is the prose block again, so V0-shipped and V6-prose-block are "
            "the same arm — drop V6 if the revert is intended, rather than scoring it twice."
        )
    # The tuning round's own premise is "at or below the length of the block being tuned". That
    # block is the prose one — W1-W3 were built against it — so the gate stays keyed to it and
    # not to whatever is currently shipped. Keyed to `pointer` it would now reject all three.
    over = {
        k: len(v) for k, v in variants.items() if k.startswith("W") and len(v) > len(PROSE_BLOCK)
    }
    if over:
        raise SystemExit(
            f"tuning candidates must not exceed the prose block's {len(PROSE_BLOCK)} chars: {over}"
        )
    return variants
