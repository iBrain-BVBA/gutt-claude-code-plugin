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


# The candidate wording for the scope-resolution sentence, carried as an arm rather than
# applied as an edit. Derived from the shipped body by one substitution, asserted to have
# applied, so the two arms cannot drift and the text that ships if this arm wins is
# byte-identical to the text this round measured. The shipped sentence runs the source
# order and the normalisation together, chained by "else"; the candidate restores the
# reference's own phrasing, which states that the first step yielding a value wins.
OLD_ORDER = """Resolve `<scope>` at runtime, where you run: the scope bound to this working
directory (the invoked `agent-memory-protocol` skill carries the file read), else
the git remote's `owner/repo`, else the working folder's name"""

NEW_ORDER = """Resolve `<scope>` at runtime, where you run. Take the first of these that yields a
value and stop there: the scope bound to this working directory (the invoked
`agent-memory-protocol` skill carries the file read); the git remote's `owner/repo`;
the working folder's name"""


def _candidate(body):
    assert body.count(OLD_ORDER) == 1, "shipped scope-resolution sentence not found"
    return body.replace(OLD_ORDER, NEW_ORDER)


def all_variants():
    return {
        "V0-shipped": _skill_body(),
        "V2-order": _candidate(_skill_body()),
        "V1-none": "",
    }
