#!/usr/bin/env python3
"""Entry point for the eval bench.

    python3 evals/run.py --list
    python3 evals/run.py stop-judge --trials 3
    python3 evals/run.py stop-judge --variants V0-shipped V6 V7

Writes raw records to evals/results/<suite>-<trials>t-<variants>.json (suffixed -rN
rather than overwriting an existing round) and a rendered table to
evals/results/<suite>-report.md.
"""
import argparse
import datetime
import hashlib
import importlib
import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from lib.runner import FAST_MODEL, failed, run_matrix  # noqa: E402
from lib.scoring import _lines  # noqa: E402

SUITES = {
    "stop-judge": "suites.stop_judge.suite",
    "prompt-pointer": "suites.prompt_pointer.suite",
    "capture-close": "suites.capture_close.suite",
    "weekly-recap": "suites.weekly_recap.suite",
    "bug-investigation": "suites.bug_investigation.suite",
    "sub-task-breakdown": "suites.sub_task_breakdown.suite",
    "pr-re-review": "suites.pr_re_review.suite",
    "story-creation": "suites.story_creation.suite",
    "backlog-dedupe": "suites.backlog_dedupe.suite",
    "backlog-prioritization": "suites.backlog_prioritization.suite",
}


def _code_dirty(status):
    """Does this `git status --porcelain` output show uncommitted *code*?

    Generated result artifacts do not make the tree dirty for this purpose. What the
    flag is asked to certify is whether the code — the skill text that produced the
    replies, or the checkers that scored them — is committed. Counting the report a
    re-score is about to write meant the first of four re-scores recorded a clean
    tree and the rest recorded a dirty one, purely because each had written the
    previous report.

    Splits on the status field rather than slicing fixed columns. The caller strips
    git's output, which removes the leading space of an unstaged first line only — so
    a column slice read that one path three characters in and never matched the
    exclusion, while every later line matched. One report modified therefore read as
    a dirty tree.

    Module-level so the self-check can exercise the shipped predicate. Restated
    inside the check instead, it pinned a copy: reverting this one to the column
    slice left every self-check green, which is the same fixture-tests-the-wrong-
    thing failure the column slice itself got through on.
    """
    return bool([
        ln for ln in status.splitlines() if ln.strip()
        and not ln.strip().split(maxsplit=1)[-1].strip('"')
        .startswith("evals/results/")
    ])


def git_state(prefix="git"):
    """`{"<prefix>_sha": …, "<prefix>_dirty": …}` for the tree this file lives in.

    Every field distinguishes "unknown" from a real value. Returning "" on failure
    and coercing it made the dirty flag report False — an assertion that the tree was
    clean — for a tree that was never inspected, while the SHA beside it honestly said
    "unknown". A non-zero exit is the common failure and raises nothing, so returncode
    has to be checked rather than left to the except.

    `prefix` exists because a re-scored table has two trees worth naming: the one whose
    skill text produced the replies, and the one whose checkers scored them. Those are
    the same tree only when a round is scored by the code that ran it.
    """
    def _git(*a):
        try:
            r = subprocess.run(["git", *a], cwd=HERE, capture_output=True,
                               text=True, timeout=10)
        except Exception:
            return None
        return r.stdout.strip() if r.returncode == 0 else None

    status = _git("status", "--porcelain")
    if status is None:
        dirty = "unknown"
    else:
        dirty = _code_dirty(status)
    return {
        f"{prefix}_sha": _git("rev-parse", "--short", "HEAD") or "unknown",
        f"{prefix}_dirty": dirty,
    }


def describe_tree(sha, dirty):
    """"`abc1234` (dirty tree)" — one phrase for a tree and its cleanliness."""
    return f"`{sha}`" + {False: "", True: " (dirty tree)",
                         "unknown": " (tree state unknown)"}[dirty]


def _claim_round(out_dir, stem):
    """Pick an unused raw-file name for this round; return it and its round tag.

    Same config twice is two measurements, not one file. The tag is carried to the
    summary, which holds the round's identity and so must not be destroyed by the
    next round at the same config. The committed report keeps its stable per-suite
    name — git history is its archive, which works only because the report header
    records which round produced it.

    The file is created here rather than merely tested for. Testing alone left a
    window: the raw file is not written until the first periodic flush, so two runs
    started minutes apart both selected the base name and the one finishing second
    silently won.
    """
    for n in range(1, 1000):
        tag = "" if n == 1 else f"-r{n}"
        path = out_dir / f"{stem}{tag}.json"
        try:
            path.touch(exist_ok=False)
        except FileExistsError:
            continue
        return path, tag
    raise SystemExit(f"1000 rounds already stored for {stem}; archive some.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("suite", nargs="?", help="suite id")
    ap.add_argument("--trials", type=int, default=1, help="runs per (variant, case)")
    ap.add_argument("--variants", nargs="*", help="limit to these variant labels")
    ap.add_argument("--cases", nargs="*", help="limit to these case ids")
    ap.add_argument("--workers", type=int, default=8)
    # The judge model is part of the result, not a detail of how it was produced: the
    # shipped Stop hook pins `model` in hooks.json, so a table measured on a different
    # model does not describe what ships. Default stays FAST_MODEL for continuity with
    # every round already in results/.
    ap.add_argument("--model", default=FAST_MODEL,
                    help=f"judge model (default {FAST_MODEL}); pass the full id, not an alias")
    ap.add_argument("--list", action="store_true", help="list suites and exit")
    args = ap.parse_args()

    if args.list or not args.suite:
        width = max(len(n) for n in SUITES)
        for name, mod in SUITES.items():
            print(f"{name:{width}} {importlib.import_module(mod).DESCRIPTION}")
        return 0
    if args.suite not in SUITES:
        print(f"unknown suite {args.suite!r}; try --list", file=sys.stderr)
        return 2

    suite = importlib.import_module(SUITES[args.suite])
    variant_map = suite.variants()
    case_list = suite.cases()
    if args.variants:
        variant_map = {k: v for k, v in variant_map.items() if k in args.variants}
        missing = set(args.variants) - set(variant_map)
        if missing:
            print(f"no such variant(s): {sorted(missing)}", file=sys.stderr)
            return 2
    if args.cases:
        case_list = [c for c in case_list if c["id"] in args.cases]
        # Validated like --variants above, and for the same reason. Filtering
        # silently meant one mistyped id selected nothing, and the empty round it
        # produced still overwrote the committed report with an empty table.
        unknown = set(args.cases) - {c["id"] for c in case_list}
        if unknown:
            print(f"no such case(s): {sorted(unknown)}", file=sys.stderr)
            return 2

    out_dir = HERE / "results"
    out_dir.mkdir(exist_ok=True)
    # Key the raw file on the variant set as well as the trial count. Keyed on trials
    # alone, a second run at the same depth silently overwrote the first — which is how a
    # V0-vs-V13 comparison was lost to a later V13-vs-V14 run at 5 trials, leaving only
    # the printed table. Rounds are the unit of comparison here (see README), so losing
    # one is losing the ability to check a claim.
    tag = "-".join(sorted(variant_map)) if len(variant_map) <= 4 else f"{len(variant_map)}v"
    # A non-default model gets its own filenames for a related but separate reason. The
    # round claim below keeps a sonnet round and a haiku round from overwriting each
    # other's raws whether or not the name distinguishes them; the slug is what keeps
    # their *reports* distinct, since those hold one stable name per suite and are not
    # round-claimed.
    slug = "" if args.model == FAST_MODEL else f"-{args.model.replace('.', '')}"
    raw_path, _ = _claim_round(out_dir, f"{args.suite}-{args.trials}t-{tag}{slug}")

    # Identity travels with the round: what text was measured (variant hashes), on
    # which model, from which tree, and when. A number whose provenance lives only
    # in the shell history cannot support a comparison later.
    meta = {
        "suite": args.suite,
        "model": args.model,
        "trials": args.trials,
        "cases": len(case_list),
        "jobs": len(variant_map) * len(case_list) * args.trials,
        "date": datetime.datetime.now(datetime.timezone.utc)
                                  .isoformat(timespec="seconds"),
        **git_state(),
        "variant_sha256": {k: hashlib.sha256(str(v).encode("utf-8")).hexdigest()[:12]
                           for k, v in variant_map.items()},
        # Lengths as well as hashes: a hash proves two rounds measured the same text
        # but cannot reconstruct the size a report quotes, so a re-score had no way to
        # state the measured length and fell back to whatever the skill file says now.
        "variant_chars": {k: len(str(v)) for k, v in variant_map.items()},
        # Lines as well, and counted by the same helper the table prints with, so a
        # re-score reports the shape the round measured rather than deriving one
        # number from the round and the other from whatever is on disk later.
        "variant_lines": {k: _lines(str(v)) for k, v in variant_map.items()},
    }

    # Fill the name claimed above so an aborted round is a readable file rather than
    # zero bytes that crash a re-score sweep. `meta["jobs"]` against the record count
    # is what tells a later reader the round was cut short: a killed run leaves a file
    # that parses, carries full provenance, and is silently missing its tail — and
    # because jobs run variant-major, the tail it loses is the last variant's hardest
    # cases, which flatters the control arm.
    raw_path.write_text(json.dumps({"meta": meta, "records": []}), encoding="utf-8")

    # A suite may declare its own system prompt; the Stop judge's framing is wrong for
    # any suite measuring what an agent does with injected context.
    kwargs = {"system": suite.SYSTEM} if hasattr(suite, "SYSTEM") else {}
    results = run_matrix(variant_map, case_list, suite.build_prompt, suite.evaluate,
                         trials=args.trials, workers=args.workers, model=args.model,
                         out_path=str(raw_path), meta=meta, **kwargs)

    text, summary = suite.report(results, case_list, variant_map)
    print("\n" + text)

    # A round whose calls never produced a reply is not a measurement. run_matrix
    # says so on the console, but the console scrolls and the committed report is
    # what survives — so a void round used to overwrite a real one with an all-zero
    # table and exit 0, which `run.py <suite> && git add results` treats as success.
    # The provenance block below would have made that table look better sourced than
    # the round it replaced.
    #
    # Keyed on every failure marker, not on the quota wall alone. A wall was the
    # failure this guard was written for, so an expired token or a timed-out call
    # walked straight past it: those cells scored as wrong answers, and the round
    # published a full table reading 0% with no errors reported.
    void = [r for r in results if failed(r.get("raw") or "")]
    if void:
        kinds = sorted({r["raw"].split()[0].rstrip(">") + ">" for r in void})
        print(f"*** report and summary NOT written — {len(void)} of {len(results)} "
              f"call(s) produced no reply: {', '.join(kinds)}")
        print(f"*** raw records kept at {raw_path} for diagnosis.")
        return 1

    # The report is the only artifact under version control, so the round identity
    # has to reach it. Without this the committed number named its judge model and
    # nothing else: not the tree it measured, not the skill text, not even the date.
    tree = describe_tree(meta["git_sha"], meta["git_dirty"])
    hashes = " ".join(f"{k}:{v}" for k, v in meta["variant_sha256"].items())
    report = out_dir / f"{args.suite}-report{slug}.md"
    report.write_text(
        f"# {args.suite} — {args.trials} trial(s) per case\n\n"
        f"Judge model: `{args.model}`.\n\n"
        f"{len(case_list)} cases, {len(variant_map)} variants, {len(results)} calls.\n\n"
        f"Round `{raw_path.stem}` — {meta['date']}, tree {tree}.\n"
        f"Variant text measured: {hashes}.\n\n"
        f"```\n{text}\n```\n",
        encoding="utf-8",
    )
    # Keyed off the raw file's stem, not rebuilt from the suite and round tag. The
    # summary is this round's aggregate and has to be as uniquely named as the round:
    # a name carrying only suite, model and round tag collapsed every configuration's
    # first run onto one file, so a 3-trial V0-V1 summary and a 5-trial V0-V2 summary
    # overwrote each other, and `-r2` collided across configurations too.
    (out_dir / f"{raw_path.stem}-summary.json").write_text(
        json.dumps({"meta": meta, **summary}, indent=1), encoding="utf-8")
    print(f"\n-> {report}")
    return 0


def _self_check():
    """Free check of the round-naming claim. Costs nothing and needs no API key.

    Round naming is the one part of this file whose failure is silent: an
    overwritten round leaves no error behind, just a missing measurement.
    """
    import tempfile

    wrong = []
    with tempfile.TemporaryDirectory() as td:
        d = pathlib.Path(td)
        got = [_claim_round(d, "suite-3t-V0-V1") for _ in range(3)]
        want = [("suite-3t-V0-V1.json", ""), ("suite-3t-V0-V1-r2.json", "-r2"),
                ("suite-3t-V0-V1-r3.json", "-r3")]
        for (path, tag), (wname, wtag) in zip(got, want):
            if (path.name, tag) != (wname, wtag):
                wrong.append(f"NAME  got {(path.name, tag)}, want {(wname, wtag)}")
        # Distinct files, each already on disk: claiming by creating is what closes
        # the window two runs started minutes apart used to share.
        if len({p for p, _ in got}) != 3:
            wrong.append("COLLISION  two rounds claimed the same path")
        if not all(p.exists() for p, _ in got):
            wrong.append("NOT CLAIMED  a returned path was never created")

    # The dirty filter, against real `git status --porcelain` output *as _git
    # returns it* — stripped. Feeding it hand-written lines with their leading
    # space intact is what let a column-slicing bug pass: the first line is the
    # only one that loses a character, so the fixture has to include one.
    # Calls the shipped `_code_dirty`, not a restatement of it — a fixture that
    # exercises its own copy of the logic passes whatever the shipped one does.
    _dirty = _code_dirty

    for label, raw, want in [
        ("only generated reports, first line stripped",
         " M evals/results/a-report.md\n M evals/results/b-report.md".strip(), False),
        ("a source file alongside them",
         " M evals/results/a-report.md\n M evals/run.py".strip(), True),
        ("clean tree", "", False),
        ("staged source", "M  evals/lib/scoring.py".strip(), True),
        ("untracked source", "?? evals/lib/new.py".strip(), True),
        ("renamed result file",
         "R  evals/results/a.md -> evals/results/b.md".strip(), False),
    ]:
        if _dirty(raw) != want:
            wrong.append(f"DIRTY FILTER  {label}: got {_dirty(raw)}, want {want}")
    for w in wrong:
        print(w)
    print("round naming OK" if not wrong else "round naming BROKEN")
    return 1 if wrong else 0


if __name__ == "__main__":
    sys.exit(_self_check() if "--self-check" in sys.argv else main())
