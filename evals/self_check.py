#!/usr/bin/env python3
"""Offline self-check for the whole bench — no model calls, no spend, about a second.

The bench has two halves that cost very differently. A round spends real money and
takes minutes; everything here is free and deterministic. That is why this half can
be gated at all while the other half cannot, and why the two were worth separating
rather than excluding together.

Six things, in this order:

1. this gate is still wired into both places that run it — the local aggregate and
   CI — since neither would report the other missing;
2. the self-checks the modules already carry, run the way each expects to be run,
   each required to say so rather than merely exit zero;
3. every registered suite still hands over its variants and its cases;
4. every pattern a case carries compiles, and compiles the same way on every
   interpreter;
5. every suite's `build_prompt()` and `evaluate()` run once per case, and the
   checker has to come back with a verdict;
6. the re-score path runs over a committed fixture round.

Steps 4 and 5 are why this file exists. A pattern is held as a plain string and is
not compiled until a checker searches with it, so a suite builds clean while
carrying a pattern no interpreter will accept. The failure then lands during
scoring, where the runner catches it per cell and records a wrong answer — so a
broken checker publishes as a skill that scored badly, which does more damage than
a crash would. Nobody mistakes a traceback for a measurement; a plausible wrong
number is what gets believed. Importing the modules sees none of this, and building
the cases sees none of it either. Only calling through does.

The same reasoning runs one step further in step 5: calling a checker is not the
same as checking it. A checker that comes back with the wrong shape raises nothing,
and every cell it scores reads as an honest zero, so the verdict is inspected rather
than discarded.

Step 4 promotes the misplaced-flag warning to an error deliberately. A regex whose
global flag sits mid-expression is accepted with a warning by older interpreters and
rejected outright by newer ones, so a check that merely compiled would pass on the
machine that happened to run it and fail in CI — or the reverse, which is worse,
because then the gate is the thing that looks broken. Making the warning fatal
gives one answer everywhere.

That promotion is installed once, for the whole process, ahead of the first bench
module — see `FLAG_WARNING` below. Doing it per call site does not work: `re`
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
import os
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
FLAG_TEXT = "Flags not at the start"      # literal, for `PYTHONWARNINGS`
FLAG_WARNING = "[Ff]lags not at the start"  # regex, for `filterwarnings`
warnings.filterwarnings("error", message=FLAG_WARNING)

# The same rule for the children, which a filter installed here cannot reach: a
# warning filter is per-process state and `subprocess` does not carry it across. Each
# child compiles patterns of its own, and on an interpreter that only warns it would
# exit zero having written the warning to stderr — so the defect passed locally and
# failed in CI, which is the split this whole file exists to close. `PYTHONWARNINGS`
# takes a literal message prefix rather than a regex, hence the two spellings above.
CHILD_ENV = {**os.environ, "PYTHONWARNINGS": f"error:{FLAG_TEXT}"}

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
# has genuinely broken, which happens to raise the same exception type. Imported
# rather than copied: a second copy could be improved on its own, and rewording
# the original would turn every missing corpus into a failure with nothing in the
# diff pointing at why.
from lib.transcripts import MISSING_CORPUS  # noqa: E402

# A hand-built round, committed so the re-score path can be exercised anywhere. It
# carries its own cases because the suite that reaches that path builds its real ones
# from recorded sessions, which exist on one machine. Deliberately not under
# `results/`: the round files there are git-ignored and the reports beside them are
# committed output, so a fixture the gate depends on would read as one more result
# rather than as an input.
FIXTURE = HERE / "fixtures" / "stop-judge-round.json"

# The manifest that decides whether this gate runs at all.
PACKAGE_JSON = HERE.parent / "package.json"

CI_WORKFLOW = HERE.parent / ".github" / "workflows" / "ci.yml"

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
# are not defects.
#
# This list is what gets checked, not merely what gets named. Calling the checker
# reaches a pattern the list does not, but only the ones the single `PROBE` reply
# drives it to compile — and a checker branches on what it is reading. A pattern
# behind a branch that reply does not take is compiled by nothing here: not by the
# harvest, which does not know the field, and not by the call, which does not reach
# it. The two mechanisms overlap; neither is a superset. `case_patterns` below says
# the same thing about distractor excuses, which is the instance of it that exists
# today. So a suite adding a pattern to a field no list names gets no warning, and
# the list is the thing to extend.
PATTERN_FIELDS = ("work", "bookkeeping")

# Suites whose cases legitimately carry no patterns of their own, because the suite
# keeps them as module-level `re.compile` constants instead. Those are covered — they
# compile at import, under the process-wide rule — but they are invisible to the
# harvest, so the suite reports zero. Named here so that every *other* zero can be
# treated as a corpus that has been emptied rather than one that was checked.
PATTERNLESS_SUITES = {"prompt-pointer"}

# What a full run reaches. Asserted rather than inferred from `SUITES`, because
# inferring it from the same dict that got shortened is not a check: trimming the
# registry to one entry leaves "every registered suite passed" true and the run green.
# A number here has to be edited deliberately when a suite is added or removed, which
# is the point — that edit is the moment somebody decides the change was intended.
EXPECTED_SUITES = 10


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

    # `BaseException`, not `Exception`, here and at every other call into a suite.
    # A drift guard in this bench raises `SystemExit`, which is a `BaseException` —
    # so `except Exception` lets it past every handler, out of `main()`, and the gate
    # answers a defect in a suite by dying, with the suites after it unrun and no
    # summary. `KeyboardInterrupt` is re-raised because that one really is a request
    # to stop rather than a suite reporting itself broken.
    try:
        variants = module.variants()
    except KeyboardInterrupt:
        raise
    except BaseException as exc:  # noqa: BLE001 — a suite's SystemExit is a suite defect
        return "BROKEN", [f"variants() raised {type(exc).__name__}: {exc}"], 0, 0
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
        # ones. Nothing is recompiled afterwards to check them, and nothing needs to
        # be: the rule is already in force when the checker compiles, so the first
        # compile is the one that raises and the `except` below is what catches it. A
        # pattern that failed to compile is never cached — only a successful compile
        # is — so a second pass would re-raise what was already reported here.
        #
        # Both entry points a case reaches, not just the checker. `build_prompt` runs
        # nowhere else until a round is already spending money, and some suites hang
        # their baseline-drift guard off it — the check that a hand-copied V0-shipped
        # still matches the text the hook ships. An assertion only a paid run reaches
        # is one nobody meets until the bill arrives.
        try:
            prompt = module.build_prompt(next(iter(variants.values())), case)
        except KeyboardInterrupt:
            raise
        except BaseException as exc:  # noqa: BLE001 — a suite's SystemExit is a suite defect
            notes.append(f"{case['id']}: build_prompt() raised {type(exc).__name__}: {exc}")
        else:
            # What it returned, not only that it returned. An empty prompt raises
            # nothing and reaches the model as nothing, so every trial in a paid round
            # scores a reply to no question — the same plausible-number failure as a
            # checker that cannot run, arriving one step earlier.
            if not isinstance(prompt, str) or not prompt.strip():
                notes.append(f"{case['id']}: build_prompt() returned {prompt!r}, "
                             "which is not a prompt")

        try:
            verdict = module.evaluate(case, PROBE)
        except KeyboardInterrupt:
            raise
        except BaseException as exc:  # noqa: BLE001 — a suite's SystemExit is a suite defect
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
        # The type, not only the key. Scoring counts a cell with `bool(r["correct"])`,
        # so a checker answering `"yes"` scores every trial it touches as correct and
        # the arm publishes at 100%. That is the worse half of this failure: a wrong
        # answer everywhere reads as a skill scoring badly and gets investigated, while
        # a right answer everywhere reads as a skill working and does not.
        elif not isinstance(verdict["correct"], bool):
            notes.append(f"{case['id']}: evaluate() returned `correct` as "
                         f"{verdict['correct']!r}, which scoring reads through bool() — "
                         "a non-bool here scores the cell without measuring it")

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
    from lib.scoring import _lines
    from suites.stop_judge import suite as stop_judge

    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    meta, cases, records = fixture["meta"], fixture["cases"], fixture["records"]
    notes = []

    # The fixture's numbers have to differ from today's, or the assertion further down
    # stops discriminating without saying so. That check reads the size off the table
    # and compares it with what the round recorded; if the two are equal, a report that
    # ignored the round and re-derived from today's text prints the same figure and
    # passes. Measured: the identical planted defect goes red on the fixture as
    # committed and green once its four numbers are refreshed to today's. The fixture
    # says it must stay that way, which is prose — this is the part that enforces it.
    live_arms = stop_judge.variants()
    for dimension, measure in (("variant_chars", len), ("variant_lines", _lines)):
        for arm, recorded in meta[dimension].items():
            if arm in live_arms and recorded == measure(str(live_arms[arm])):
                notes.append(
                    f"fixture {dimension}[{arm}] is {recorded}, which is what today's "
                    "text measures — a derived size is no longer distinguishable from "
                    "a recorded one, so the size assertion below tests nothing. Change "
                    "the fixture to a number today's text cannot produce."
                )

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


def _runs_check_evals(lines):
    """True when some workflow step runs `check:evals` and nothing gates it.

    Split out so the wiring check reads as one question. A step is the block from a
    `- ` opener to the next one at the same indent; a `run:` inside it counts only if
    neither it nor any line of that block is commented out or an `if:`.
    """
    for i, line in enumerate(lines):
        if line.lstrip().startswith("#"):
            continue
        if not re.match(r"\s*(-\s*)?run:\s*npm run check:evals\s*$", line):
            continue
        # Back up to the `- ` that opens this step, collecting what guards it.
        guarded = False
        for prev in reversed(lines[:i]):
            stripped = prev.strip()
            if stripped.startswith("#") or not stripped:
                continue
            if re.match(r"\s*if:\s", prev):
                guarded = True
            if stripped.startswith("- "):
                break
        if not guarded:
            return True
    return False


def check_wiring():
    """This gate has to stay reachable from both places that run it.

    They are not the same place and neither reports the other missing. `test:all` is
    the aggregate a developer runs by hand — nothing invokes it automatically, since
    the pre-commit hook runs only lint-staged and the symlink guard. CI never runs
    `test:all` either; it invokes `check:evals` as a step of its own. So dropping the
    step from `test:all` leaves every CI job green while removing the local run, and
    deleting the CI step leaves the gate off every pull request while `test:all` still
    passes. A gate that stops running is indistinguishable from one that keeps passing,
    so both legs are asserted here.
    """
    notes = []
    try:
        scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    except (OSError, ValueError, KeyError) as exc:
        return [f"cannot read scripts from {PACKAGE_JSON}: {type(exc).__name__}: {exc}"]
    if "check:evals" not in scripts:
        return ["package.json declares no `check:evals` script"]
    # The whole script, matched, not the filename found somewhere inside it. Asserting
    # only that the name appears lets the script be stubbed out during a Python-less CI
    # incident and never restored — and, worse, lets its exit code be discarded. A
    # trailing `|| true` keeps the filename, keeps this check green, and makes the gate
    # incapable of ever failing `test:all` or CI: the run still prints which suites are
    # broken, and still exits 0. Disabling a gate has to read differently from running
    # one, and only an anchored match tells them apart.
    if not re.fullmatch(r"python3? evals/self_check\.py", scripts["check:evals"].strip()):
        notes.append("`check:evals` no longer runs `evals/self_check.py` and nothing "
                     "else — a wrapper can discard its exit code, which leaves the gate "
                     f"reporting defects it can never fail on: {scripts['check:evals']!r}")
    if "check:evals" not in scripts.get("test:all", ""):
        notes.append("`test:all` no longer runs `check:evals` — the aggregate a "
                     "developer runs by hand no longer reaches this gate, and CI's "
                     "own step would not report that")
    try:
        workflow = CI_WORKFLOW.read_text(encoding="utf-8")
    except OSError as exc:
        notes.append(f"cannot read {CI_WORKFLOW}: {type(exc).__name__}: {exc}")
    else:
        # A step that runs, not the string anywhere in the file. Deleting a step is the
        # rare way one stops running; commenting it out, or hanging a condition on it,
        # is the common way — and both leave `check:evals` in the text for a substring
        # test to find. So: an uncommented `run:` line, in a step carrying no `if:`.
        # Walking back to the step's `- ` opener costs no YAML parser, which this
        # repository has no dependency for, and separates a step being present from it
        # executing. It reads only this file, whose shape is ours to keep.
        if not _runs_check_evals(workflow.splitlines()):
            notes.append("no CI job runs `check:evals` on an unconditional step — this "
                         "gate is off every pull request, and `test:all` passing "
                         "locally would not report it. A commented-out step, or one "
                         "guarded by `if:`, still carries the name and does not run.")
    return notes


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
        done = subprocess.run(argv, cwd=HERE, capture_output=True, text=True,
                              encoding="utf-8", env=CHILD_ENV)
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
            # A child that passed can still have said something. Warnings go to stderr,
            # which is where the misplaced-flag warning lands on the interpreters that
            # only warn — so discarding a passing child's stderr throws away the one
            # signal this gate is built around, on exactly the interpreter where it is
            # the only signal there is.
            for line in done.stderr.strip().splitlines()[-12:]:
                print(f"    {line}")
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
        except KeyboardInterrupt:
            raise
        except BaseException as exc:  # noqa: BLE001 — a suite's SystemExit is a suite defect
            status, notes, ncases, found = "BROKEN", [f"{type(exc).__name__}: {exc}"], 0, 0
        # A suite that hands over cases carrying no patterns at all has been emptied,
        # not checked — and the count reads the same as a suite that legitimately keeps
        # its patterns as module-level constants, so a zero is not visually suspicious.
        # Naming the one suite that is allowed to report zero is what makes the rest of
        # the zeros mean something.
        if status == "OK" and found == 0 and name not in PATTERNLESS_SUITES:
            status = "BROKEN"
            notes = [f"{ncases} cases carrying no patterns at all — either the corpus "
                     "was emptied, or this suite keeps its patterns somewhere the "
                     "harvest does not look and belongs in PATTERNLESS_SUITES"]
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
    except KeyboardInterrupt:
        raise
    except BaseException as exc:  # noqa: BLE001 — a suite's SystemExit is a suite defect
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
    # And a run that reached most of them has not established what it claims to. The
    # floor above only catches the registry being emptied; a registry shortened to one
    # entry passes it, having checked a tenth of the bench and said so in a summary line
    # nobody diffs. `SUITES` is a dict literal in `run.py` — the most likely thing in
    # that file for a merge to mangle.
    if len(SUITES) != EXPECTED_SUITES:
        print(f"the registry holds {len(SUITES)} suites, not the {EXPECTED_SUITES} this "
              "gate expects — if a suite was added or removed on purpose, update "
              "EXPECTED_SUITES in the same change")
        return 1
    if broken:
        print(f"broken: {', '.join(broken)}")
        return 1
    if skipped:
        print(f"skipped for a missing corpus: {', '.join(skipped)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
