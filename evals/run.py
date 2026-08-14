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

from lib.runner import FAST_MODEL, run_matrix  # noqa: E402

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

    out_dir = HERE / "results"
    out_dir.mkdir(exist_ok=True)
    # Key the raw file on the variant set as well as the trial count. Keyed on trials
    # alone, a second run at the same depth silently overwrote the first — which is how a
    # V0-vs-V13 comparison was lost to a later V13-vs-V14 run at 5 trials, leaving only
    # the printed table. Rounds are the unit of comparison here (see README), so losing
    # one is losing the ability to check a claim.
    tag = "-".join(sorted(variant_map)) if len(variant_map) <= 4 else f"{len(variant_map)}v"
    # A non-default model gets its own filenames for the same reason: a sonnet round and a
    # haiku round at the same depth and variant set are different measurements, and the one
    # written second would otherwise be the only one left.
    slug = "" if args.model == FAST_MODEL else f"-{args.model.replace('.', '')}"
    raw_path = out_dir / f"{args.suite}-{args.trials}t-{tag}{slug}.json"
    # Same config twice is two measurements, not one file: suffix instead of
    # overwriting, or the round written second is the only one left.
    n = 2
    while raw_path.exists():
        raw_path = out_dir / f"{args.suite}-{args.trials}t-{tag}{slug}-r{n}.json"
        n += 1

    # Identity travels with the round: what text was measured (variant hashes), on
    # which model, from which tree, and when. A number whose provenance lives only
    # in the shell history cannot support a comparison later.
    def _git(*a):
        try:
            return subprocess.run(["git", *a], cwd=HERE, capture_output=True,
                                  text=True, timeout=10).stdout.strip()
        except Exception:
            return ""

    meta = {
        "suite": args.suite,
        "model": args.model,
        "trials": args.trials,
        "date": datetime.datetime.now(datetime.timezone.utc)
                                  .isoformat(timespec="seconds"),
        "git_sha": _git("rev-parse", "--short", "HEAD") or "unknown",
        "git_dirty": bool(_git("status", "--porcelain")),
        "variant_sha256": {k: hashlib.sha256(str(v).encode("utf-8")).hexdigest()[:12]
                           for k, v in variant_map.items()},
    }

    # A suite may declare its own system prompt; the Stop judge's framing is wrong for
    # any suite measuring what an agent does with injected context.
    kwargs = {"system": suite.SYSTEM} if hasattr(suite, "SYSTEM") else {}
    results = run_matrix(variant_map, case_list, suite.build_prompt, suite.evaluate,
                         trials=args.trials, workers=args.workers, model=args.model,
                         out_path=str(raw_path), meta=meta, **kwargs)

    text, summary = suite.report(results, case_list, variant_map)
    print("\n" + text)
    report = out_dir / f"{args.suite}-report{slug}.md"
    report.write_text(
        f"# {args.suite} — {args.trials} trial(s) per case\n\n"
        f"Judge model: `{args.model}`.\n\n"
        f"{len(case_list)} cases, {len(variant_map)} variants, {len(results)} calls.\n\n"
        f"```\n{text}\n```\n",
        encoding="utf-8",
    )
    (out_dir / f"{args.suite}-summary{slug}.json").write_text(
        json.dumps({"meta": meta, **summary}, indent=1), encoding="utf-8")
    print(f"\n-> {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
