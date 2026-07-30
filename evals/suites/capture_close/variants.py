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
  V4-terse         the closing rule with the style list dropped. Separates "tell it where
                   the summary goes" from "tell it how to write".
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


# The rule GP-927 replaced, quoted from the `memory-capture` section it was removed from
# (commit history has the original). Reproduced as prose the agent receives, not as a
# citation, because that is how it reached the model when it shipped.
V2_TEXT = (
    "Close the reply with a short summary of that work, placed last, after everything "
    "else. Keep it to what the user needs to carry forward: what was delivered, anything "
    "that did not survive verification, and what is still open. It comes last because the "
    "capture is a footnote to the turn and the work is its subject."
)


def all_variants():
    block = shipped()
    return {
        "V0-shipped": block,
        "V1-none": "",
        "V2-summary-only": V2_TEXT,
        "V3-no-negatives": _drop_paragraph(block, "verbatim echo"),
        "V4-terse": _drop_paragraph(block, "no preamble"),
    }
