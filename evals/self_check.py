#!/usr/bin/env python3
"""Offline self-check for the whole bench — no model calls, no spend, about a second.

The bench has two halves that cost very differently. A round spends real money and
takes minutes; everything here is free and deterministic. That is why this half can
be gated on every commit while the other half cannot, and why the two were worth
separating rather than excluding together.

Four things, in this order:

1. the self-checks the modules already carry, run the way each expects to be run;
2. every registered suite still hands over its variants and its cases;
3. every pattern a case carries compiles, and compiles the same way on every
   interpreter;
4. every suite's `evaluate()` runs, once per case.

Steps 3 and 4 are why this file exists. A pattern is held as a plain string and is
not compiled until a checker searches with it, so a suite builds clean while
carrying a pattern no interpreter will accept. The failure then lands during
scoring, where the runner catches it per cell and records a wrong answer — so a
broken checker publishes as a skill that scored badly, which does more damage than
a crash would. Nobody mistakes a traceback for a measurement; a plausible wrong
number is what gets believed. Importing the modules sees none of this, and building
the cases sees none of it either. Only calling through does.

Step 3 promotes `DeprecationWarning` to an error deliberately. A regex whose global
flag sits mid-expression is accepted with a warning by older interpreters and
rejected outright by newer ones, so a check that merely compiled would pass on the
machine that happened to run it and fail in CI — or the reverse, which is worse,
because then the gate is the thing that looks broken. Making the warning fatal
gives one answer everywhere.

A suite whose corpus is not on this machine is skipped by name and counted. Cases
built from recorded session transcripts only build where those sessions were
recorded, which is a real and expected state — but it is never silent, and a run
that exercised no suite at all exits non-zero rather than reporting it found
nothing wrong. "Inspected nothing" and "found nothing wrong" must not share an
exit code.
"""
import importlib
import json
import pathlib
import re
import subprocess
import sys
import warnings

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from run import SUITES  # noqa: E402

# The sentence `find_session` puts in its own error. Keying on it separates a
# corpus that was never recorded here — expected, and a skip — from a suite that
# has genuinely broken, which happens to raise the same exception type.
MISSING_CORPUS = "This is a missing corpus, not a broken checkout."

# A hand-built round, committed so the re-score path can be exercised anywhere. It
# carries its own cases because the suite that reaches that path builds its real ones
# from recorded sessions, which exist on one machine. Deliberately not under
# `results/`: everything there is generated and git-ignored, and a committed file in
# among it reads as output rather than as a fixture the gate depends on.
FIXTURE = HERE / "fixtures" / "stop-judge-round.json"

# One short reply, handed to every checker. It is not meant to score well; it is
# meant to make the checker run. What it must not do is decide the result, which
# is why nothing here asserts on the verdict that comes back.
PROBE = "Checked the sources and reported the finding, with nothing written back."

# The self-checks already living inside the bench's modules. Each is a real entry
# point rather than a function this file could import, so each runs as its own
# process: that is how a person runs them, and it keeps a module that calls
# `sys.exit` from taking this script down with it. The four suite checks import
# their package relatively and so need `-m` rather than a bare path.
SELF_CHECKS = [
    ("round naming", [sys.executable, "run.py", "--self-check"]),
    ("blocked patterns", [sys.executable, "lib/runner.py"]),
    ("rescore reader", [sys.executable, "lib/rescore.py", "--self-check"]),
    ("gate accounting", [sys.executable, "lib/scoring.py"]),
    ("backlog-dedupe checks", [sys.executable, "-m", "suites.backlog_dedupe.suite"]),
    ("sub-task-breakdown checks", [sys.executable, "-m", "suites.sub_task_breakdown.suite"]),
    ("story-creation checks", [sys.executable, "-m", "suites.story_creation.suite"]),
    ("backlog-prioritization checks",
     [sys.executable, "-m", "suites.backlog_prioritization.suite"]),
]


def case_patterns(case):
    """Every regex a case carries, labelled well enough to name in a failure.

    Compiling these directly rather than relying on `evaluate()` to reach them:
    a checker only searches a distractor's excuse once its token has matched, so
    a probe reply that mentions no distractor leaves those patterns untouched.
    """
    for key in ("must_all", "must_not"):
        for label, pattern in case.get(key, []):
            yield f"{key} {label}", pattern
    for distractor in case.get("distractors", []):
        token = distractor.get("token", "?")
        for field in ("token", "excuse"):
            if field in distractor:
                yield f"distractor {token} {field}", distractor[field]


def compile_failures(case):
    """Compile every pattern in a case, with the flag warning made fatal."""
    failures = []
    for label, pattern in case_patterns(case):
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            try:
                re.compile(pattern)
            except Exception as exc:
                failures.append(f"{label} — {type(exc).__name__}: {exc}")
    return failures


def check_suite(module_path):
    """Drive one suite far enough to use what it builds.

    Returns `(status, notes, case_count, pattern_count)`; status is OK, SKIP or
    BROKEN.
    """
    module = importlib.import_module(module_path)
    notes = []

    variants = module.variants()
    if not variants:
        return "BROKEN", ["variants() returned nothing"], 0, 0

    try:
        cases = module.cases()
    except FileNotFoundError as exc:
        if MISSING_CORPUS in str(exc):
            return "SKIP", [str(exc).splitlines()[0]], 0, 0
        raise
    if not cases:
        return "BROKEN", ["cases() returned nothing"], 0, 0

    patterns = 0
    for case in cases:
        patterns += sum(1 for _ in case_patterns(case))
        notes += [f"{case['id']}: {f}" for f in compile_failures(case)]
        try:
            module.evaluate(case, PROBE)
        except Exception as exc:
            notes.append(f"{case['id']}: evaluate() raised {type(exc).__name__}: {exc}")

    return ("BROKEN" if notes else "OK"), notes, len(cases), patterns


def check_rescore():
    """Drive the re-score path over the committed fixture round.

    The stand-in a re-score hands the tables in place of variant text is built only
    by a re-score, and only one suite's report reaches the table that reads it — so
    this path runs in no other check, and for a long time ran nowhere at all. No
    stored round carried the lengths the stand-in is built from, and the one suite
    that would exercise it cannot build its cases away from the machine that
    recorded their sessions. A defect there is invisible until someone re-scores a
    round that does not exist. Hence a fixture rather than a stored round.

    Two things are asserted, because two defects hid here. The measured size has to
    reach the table, which is what the stand-in exists for. And a cell whose checker
    raised has to read differently from a cell whose reply was wrong, since scoring
    them alike is what let a broken checker publish as a poor result.
    """
    from lib.rescore import _MeasuredText
    from suites.stop_judge import suite as stop_judge

    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    meta, cases, records = fixture["meta"], fixture["cases"], fixture["records"]
    variants = {v: _MeasuredText(meta["variant_chars"][v], meta["variant_lines"][v])
                for v in meta["variant_chars"]}

    text, _ = stop_judge.report(records, cases, variants)
    notes = []

    row = next((l for l in text.split("\n") if l.startswith("V0-shipped")), "")
    for label, value in (("lines", meta["variant_lines"]["V0-shipped"]),
                         ("chars", meta["variant_chars"]["V0-shipped"])):
        if str(value) not in row:
            notes.append(f"accuracy row is missing the measured {label} ({value}): {row!r}")

    ids = {c["id"] for c in cases}
    per_case = {}
    for line in text.split("\n"):
        head = line.strip().split(" ")[0] if line.strip() else ""
        if head in ids:
            per_case.setdefault(head, line)
    errored = next((c["id"] for c in cases
                    if any(r.get("error") for r in records if r["case"] == c["id"])), None)
    wrong = next((c["id"] for c in cases if c["id"] != errored), None)
    if errored and "!" not in per_case.get(errored, ""):
        notes.append(f"errored cell for {errored} is not marked: {per_case.get(errored)!r}")
    if wrong and "!" in per_case.get(wrong, ""):
        notes.append(f"cell for {wrong} is marked errored but nothing raised there")
    return notes


def main():
    broken = []

    for label, argv in SELF_CHECKS:
        done = subprocess.run(argv, cwd=HERE, capture_output=True, text=True)
        if done.returncode == 0:
            print(f"{label} OK")
            continue
        broken.append(label)
        print(f"{label} BROKEN")
        for line in (done.stdout + done.stderr).strip().splitlines()[-12:]:
            print(f"    {line}")

    exercised, skipped, patterns = [], [], 0
    for name, module_path in SUITES.items():
        try:
            status, notes, ncases, found = check_suite(module_path)
        except Exception as exc:
            status, notes, ncases, found = "BROKEN", [f"{type(exc).__name__}: {exc}"], 0, 0
        patterns += found
        if status == "SKIP":
            skipped.append(name)
            print(f"{name} SKIPPED — {notes[0]}")
        elif status == "BROKEN":
            broken.append(name)
            print(f"{name} BROKEN")
            for note in notes:
                print(f"    {note}")
        else:
            exercised.append(name)
            print(f"{name} OK — {ncases} cases, {found} patterns")

    try:
        rescore_notes = check_rescore()
    except Exception as exc:
        rescore_notes = [f"{type(exc).__name__}: {exc}"]
    if rescore_notes:
        broken.append("rescore round")
        print("rescore round BROKEN")
        for note in rescore_notes:
            print(f"    {note}")
    else:
        print("rescore round OK")

    print()
    print(f"suites: {len(exercised)} exercised, {len(skipped)} skipped, "
          f"{len(SUITES) - len(exercised) - len(skipped)} broken; "
          f"{patterns} patterns compiled")

    # A run that exercised nothing has not established anything. Reporting a pass
    # on it is the failure mode this whole file exists to prevent, one level up.
    if not exercised:
        print("no suite was exercised — refusing to report a pass on nothing")
        return 1
    if broken:
        print(f"broken: {', '.join(broken)}")
        return 1
    if skipped:
        print(f"skipped for a missing corpus: {', '.join(skipped)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
