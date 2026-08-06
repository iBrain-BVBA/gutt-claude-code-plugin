#!/usr/bin/env python3
"""Variants: the shipped skill text against no skill at all.

V0 is read from the working tree at run time, not pasted here, so the suite always
measures the text that would ship — a copy would drift the first time the skill was
edited. The frontmatter is stripped because the loader keeps it; the model sees the body.

V1 is the control. An unaided model reviews a diff well; what it does not reliably do is
recall the team's record before reading, refuse to report a lane finding it has not
re-checked at the source, decline to promote a paraphrase into a house standard, or hold
a capture until someone has accepted the finding. The gap between the two is the skill's
measured value.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
SKILL_PATH = ROOT / "gutt-developer" / "skills" / "pr-re-review" / "SKILL.md"


def _skill_body():
    text = SKILL_PATH.read_text(encoding="utf-8")
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            return parts[2].strip()
    return text.strip()


def all_variants():
    return {
        "V0-shipped": _skill_body(),
        "V1-none": "",
    }
