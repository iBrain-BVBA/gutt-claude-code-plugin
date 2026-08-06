#!/usr/bin/env python3
"""Variants: the shipped skill text against no skill at all.

V0 is read from the working tree at run time, not pasted here, so the suite always
measures the text that would ship — a copy would drift the first time the skill was
edited. The frontmatter is stripped because the loader keeps it; the model sees the body.

V1 is the control and the point of the suite: the workshop session had the same tools
and no skill, so V1 reproduces the incident conditions. The gap between the two is the
skill's measured value; V0 alone would only show that a model can follow instructions.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
SKILL_PATH = ROOT / "gutt-core" / "skills" / "weekly-recap" / "SKILL.md"


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
