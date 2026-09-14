"""Variants: the shipped skill text against no skill at all.

V0 is read from the working tree at run time, not pasted here, so the suite always
measures the text that would ship — a copy would drift the first time the skill was
edited. The frontmatter is stripped because the loader keeps it; the model sees the body.

V0 carries two bodies, bug-investigation's and memory-search's, because that is what a
session running bug-investigation has in front of it: the skill delegates its whole
search ladder to memory-search, and both shipped agents preload the pair. Rounds 1–8
loaded bug-investigation alone, so any check that turns on a memory-search rule — the
identifier pair is the first — was scoring a pointer to the rule, not the rule. Tables
from those rounds and from this instrument are different samples and are not compared
directly; FINDINGS marks the boundary.

V1 is the control and the point of the suite. A capable model handed a bug report and
memory tools will produce *something* triage-shaped without any skill; what it will not
reliably do is score severity against a named rubric, keep a resemblance from becoming a
root cause, or say out loud what it searched and failed to find. The gap between the two
is the skill's measured value; V0 alone would only show that a model can follow
instructions.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
SKILL_PATH = ROOT / "gutt-developer" / "skills" / "bug-investigation" / "SKILL.md"
CORE_PATH = ROOT / "gutt-core" / "skills" / "memory-search" / "SKILL.md"


def _skill_body(path):
    text = path.read_text(encoding="utf-8")
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            return parts[2].strip()
    return text.strip()


# The candidate wording for the scope-resolution sentence, as an arm rather than an edit.
# Derived from the shipped body by one substitution, asserted to have applied, so the two
# arms cannot drift and the text that ships after this round is byte-identical to the
# text the round measured.
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
        "V0-shipped": _skill_body(SKILL_PATH) + "\n\n---\n\n" + _skill_body(CORE_PATH),
        "V2-order": _candidate(_skill_body(SKILL_PATH)) + "\n\n---\n\n" + _skill_body(CORE_PATH),
        "V1-none": "",
    }
