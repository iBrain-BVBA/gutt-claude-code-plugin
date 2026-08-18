#!/usr/bin/env python3
"""Offline self-check for the whole bench — no model calls, no spend, about a second.

The bench has two halves that cost very differently. A round spends real money and
takes minutes; everything here is free and deterministic. That is why this half can
be gated on every commit while the other half cannot, and why the two were worth
separating rather than excluding together.

Five things, in this order:

1. the self-checks the modules already carry, run the way each expects to be run,
   each required to say so rather than merely exit zero;
2. every registered suite still hands over its variants and its cases;
3. every pattern a case carries compiles, and compiles the same way on every
   interpreter;
4. every suite's `evaluate()` runs once per case, and has to come back with a
   verdict;
5. the re-score path runs over a committed fixture round.

Steps 3 and 4 are why this file exists. A pattern is held as a plain string and is
not compiled until a checker searches with it, so a suite builds clean while
carrying a pattern no interpreter will accept. The failure then lands during
scoring, where the runner catches it per cell and records a wrong answer — so a
broken checker publishes as a skill that scored badly, which does more damage than
a crash would. Nobody mistakes a traceback for a measurement; a plausible wrong
number is what gets believed. Importing the modules sees none of this, and building
the cases sees none of it either. Only calling through does.

The same reasoning runs one step further in step 4: calling a checker is not the
same as checking it. A checker that comes back with the wrong shape raises nothing,
and every cell it scores reads as an honest zero, so the verdict is inspected rather
than discarded.

Step 3 promotes the misplaced-flag warning to an error deliberately. A regex whose
global flag sits mid-expression is accepted with a warning by older interpreters and
rejected outright by newer ones, so a check that merely compiled would pass on the
machine that happened to run it and fail in CI — or the reverse, which is worse,
because then the gate is the thing that looks broken. Making the warning fatal
gives one answer everywhere.

That promotion is installed once, for the whole process, before anything else is
imported — see `FLAG_WARNING` below. Doing it per call site does not work: `re`
caches compiled patterns, and a cache hit returns before the parser that emits the
warning ever runs, so whichever call compiles a pattern first silences every check
that would compile it again. Installing the rule ahead of every import and every
call means the first compile is the one that raises, wherever it happens.

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

# The warning older interpreters give for a global flag placed mid-expression, which
# newer ones refuse outright. Matched by message rather than by category: turning
# every DeprecationWarning into an error would break the gate on an unrelated
# deprecation from a dependency or the standard library, which is a gate failing for
# a reason that is not the code's fault.
#
# Installed here, ahead of the first import, because a later filter cannot reach what
# it needs to. Suites and libs keep some of their patterns as module-level
# `re.compile` constants, which run once when the module is first imported — and
# `import_module` hands back a cached module without re-executing it, so a filter
# installed after that first import never sees those compiles and never will.
# `lib.runner` and `lib.scoring` arrive through `run` on the line below, ahead of
# every suite that shares them, and `lib.scoring` holds the distractor patterns most
# suites score through.
FLAG_WARNING = "[Ff]lags not at the start"
warnings.filterwarnings("error", message=FLAG_WARNING)

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Reported rather than allowed to escape. The rule installed above turns a misplaced
# flag in any shared lib into an exception raised right here, before `main()` exists —
# and a gate that answers a defect in the code with its own traceback is the reading
# this file is meant to prevent, where the gate is what looks broken.
try:
    from run import SUITES  # noqa: E402
except Exception as _exc:  # noqa: BLE001 — anything here is a broken bench, not a bug
    print("bench libraries BROKEN")
    print(f"    {type(_exc).__name__}: {_exc}")
    sys.exit(1)

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

# The manifest that decides whether this gate runs at all.
PACKAGE_JSON = HERE.parent / "package.json"

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


# Case fields that hold a bare pattern rather than a labelled pair. Named rather
# than inferred: a case also holds prose — an ask, a pasted diff — and some of that
# prose is not valid regex, so compiling every string field reports failures that
# are not defects. A field missing from this list is not left uncovered: whatever
# `evaluate()` searches with is compiled inside the call, under the process-wide
# rule above, so the list decides what gets named in a failure rather than what
# gets checked.
PATTERN_FIELDS = ("work", "bookkeeping")


def case_patterns(case):
    """Every regex a case carries, labelled well enough to name in a failure.

    Compiled directly rather than left to `evaluate()` to reach: a checker searches
    a distractor's excuse only once its token has matched, so a probe reply that
    mentions no distractor leaves those patterns untouched.
    """
    for key in ("must_all", "must_not"):
        for label, pattern in case.get(key, []):
            yield f"{key} {label}", pattern
    for distractor in case.get("distractors", []):
        token = distractor.get("token", "?")
        for field in ("token", "excuse"):
            if field in distractor:
                yield f"distractor {token} {field}", distractor[field]
    for field in PATTERN_FIELDS:
        if isinstance(case.get(field), str):
            yield field, case[field]


def compile_failures_for(pairs):
    """Compile labelled patterns, naming the ones that will not.

    A misplaced global flag raises here rather than warning, on every interpreter,
    because of the process-wide rule installed at the top of this file — not because
    of anything done locally. One mechanism covers this, the checker calls, and the
    imports, which is the only arrangement `re`'s pattern cache does not defeat.
    """
    failures = []
    for label, pattern in pairs:
        try:
            re.compile(pattern)
        except Exception as exc:
            failures.append(f"{label} — {type(exc).__name__}: {exc}")
    return failures


def compile_failures(case):
    """Compile every pattern the case itself carries."""
    return compile_failures_for(case_patterns(case))


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
        harvested = dict((pat, label) for label, pat in case_patterns(case))
        patterns += len(harvested)
        notes += [f"{case['id']}: {f}" for f in compile_failures(case)]

        # Running the checker is what reaches a pattern the harvest above cannot
        # name — one kept in an unlisted field, or written inline in the checker
        # itself. Those compile inside this call, where the process-wide rule makes
        # a misplaced flag raise on every interpreter rather than only on the strict
        # ones. Nothing is recompiled afterwards to check them: a second compile of
        # the same pattern is served from `re`'s cache without being parsed, so it
        # would report clean however broken the pattern is.
        try:
            verdict = module.evaluate(case, PROBE)
        except Exception as exc:
            notes.append(f"{case['id']}: evaluate() raised {type(exc).__name__}: {exc}")
            continue

        # A checker that answers in the wrong shape raises nothing, and every cell it
        # scores then reads as a plain zero rather than as a fault — the failure this
        # file exists to prevent, arriving through the checker instead of through a
        # pattern. The verdict's contents are not this gate's business; that it is a
        # verdict at all is.
        if not isinstance(verdict, dict) or "correct" not in verdict:
            notes.append(f"{case['id']}: evaluate() returned {verdict!r}, "
                         "which carries no `correct` verdict")

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

    Three things are asserted, because three defects hid here. A round that recorded
    only some of the dimensions has to report its size as not measured, rather than
    pair a number it has with one derived from today's text. The measured size has to
    reach the table, which is what the stand-in exists for. And a cell whose checker
    raised has to read differently from a cell whose reply was wrong, since scoring
    them alike is what let a broken checker publish as a poor result.

    Each of the three is asserted on a value, never on a call having failed to raise.
    Two of these defects raise nothing at all.
    """
    from lib import rescore as _rescore
    from lib.rescore import _MeasuredText
    from suites.stop_judge import suite as stop_judge

    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    meta, cases, records = fixture["meta"], fixture["cases"], fixture["records"]
    notes = []

    # Both shapes of round, because the interesting one is the round that recorded
    # only some of what a report wants. Rounds exist that carry `variant_chars` and
    # not `variant_lines`, and a re-score that took the measured number it had and
    # derived the one it lacked would hand the table a stand-in that answers for its
    # length and not its shape — which is the original defect, narrowed to the rounds
    # nobody thought to try. Driving the fixture with the field removed is what makes
    # that reachable here rather than the first time someone re-scores such a round.
    for label, dropped, measured in (("both dimensions", None, True),
                                     ("chars only", "variant_lines", False)):
        trimmed = {k: v for k, v in meta.items() if k != dropped}
        try:
            variants = {v: _rescore.measured_for(trimmed, stop_judge.variants(), v)
                        for v in meta["variant_chars"]}
            stop_judge.report(records, cases, variants)
        except Exception as exc:
            notes.append(f"re-score with {label} raised {type(exc).__name__}: {exc}")
            continue
        # Not raising is the weaker half. The rule is both numbers or neither, and
        # the way it breaks quietly is a round keeping the measured figure it has
        # while deriving the one it lacks — which raises nothing and prints a row
        # describing two different texts. `known` is what separates the two, so it
        # is what gets asserted.
        off = [v for v, t in variants.items() if t.known is not measured]
        if off:
            said = "measured" if measured else "not measured"
            notes.append(f"re-score with {label}: {', '.join(sorted(off))} "
                         f"should have reported its size as {said}")

    variants = {v: _MeasuredText(meta["variant_chars"][v], meta["variant_lines"][v])
                for v in meta["variant_chars"]}
    text, _ = stop_judge.report(records, cases, variants)

    # Compared column by column rather than by searching the row for the number.
    # The row also carries percentages and per-case counts, so a containment test
    # passes on a coincidence — "9" is inside "19", and a single digit is inside
    # almost anything.
    row = next((l for l in text.split("\n") if l.startswith("V0-shipped")), "")
    columns = row.split()
    for label, column, value in (("lines", 1, meta["variant_lines"]["V0-shipped"]),
                                 ("chars", 2, meta["variant_chars"]["V0-shipped"])):
        got = columns[column] if len(columns) > column else ""
        if got != str(value):
            notes.append(f"accuracy row reports {label} as {got!r}, "
                         f"not the measured {value}: {row!r}")

    ids = {c["id"] for c in cases}
    per_case = {}
    for line in text.split("\n"):
        head = line.strip().split(" ")[0] if line.strip() else ""
        if head in ids:
            per_case.setdefault(head, line)
    # Both halves are required to exist, not merely used if present. Guarding each
    # assertion on whether the fixture happened to yield a case turns a fixture edit
    # into a silent loss of the check — the same "inspected nothing, reported a pass"
    # this file refuses one level up, arriving through the data instead of the code.
    # `wrong` has to be a genuinely incorrect answer that nothing raised on; any
    # other case would satisfy the marking test without testing the distinction.
    errored = next((c["id"] for c in cases
                    if any(r.get("error") for r in records if r["case"] == c["id"])), None)
    wrong = next((c["id"] for c in cases
                  if c["id"] != errored
                  and any(not r.get("error") and not r.get("correct")
                          for r in records if r["case"] == c["id"])), None)
    if errored is None or wrong is None:
        notes.append("the fixture no longer carries both a cell whose checker raised "
                     "and a cell that was merely wrong, so nothing here tests that "
                     "the two are told apart")
        return notes
    if "!" not in per_case.get(errored, ""):
        notes.append(f"errored cell for {errored} is not marked: {per_case.get(errored)!r}")
    if "!" in per_case.get(wrong, ""):
        notes.append(f"cell for {wrong} is marked errored but nothing raised there")
    return notes


def check_wiring():
    """This gate has to stay in the chain that runs before a commit.

    Nothing else would report it missing. CI invokes the script by its own name, so
    taking the step out of `test:all` leaves every CI job green while removing the
    only place a developer meets the bench before pushing — a gate that stops running
    is indistinguishable from one that keeps passing.
    """
    try:
        scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    except (OSError, ValueError, KeyError) as exc:
        return [f"cannot read scripts from {PACKAGE_JSON}: {type(exc).__name__}: {exc}"]
    if "check:evals" not in scripts:
        return ["package.json declares no `check:evals` script"]
    if "check:evals" not in scripts.get("test:all", ""):
        return ["`test:all` no longer runs `check:evals` — this gate is off the chain "
                "that runs before a commit, and CI would not report it"]
    return []


def main():
    broken = []

    wiring_notes = check_wiring()
    if wiring_notes:
        broken.append("gate wiring")
        print("gate wiring BROKEN")
        for note in wiring_notes:
            print(f"    {note}")
    else:
        print("gate wiring OK")

    for label, argv in SELF_CHECKS:
        done = subprocess.run(argv, cwd=HERE, capture_output=True, text=True)
        # Exit zero is not proof a child checked anything, so the child has to say it
        # passed rather than merely decline to fail. That catches one that exits zero
        # without reaching its own report — an early return, or an exception on a path
        # that swallows it.
        #
        # It does not reach one step further in: each child decides its verdict from a
        # list of counterexamples, and a list emptied by a bad merge still prints OK
        # having compared nothing. Closing that means each child reporting how many
        # comparisons it made, which is a change in every one of them rather than here.
        said_ok = f"{label} OK".lower() in done.stdout.lower()
        if done.returncode == 0 and said_ok:
            print(f"{label} OK")
            continue
        broken.append(label)
        print(f"{label} BROKEN")
        if done.returncode == 0 and not said_ok:
            print(f"    exited 0 without reporting {label!r} passed — "
                  "it may have checked nothing")
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
            print(f"{name} OK — {ncases} cases, {found} case patterns")

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
          f"{patterns} case patterns compiled")

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
