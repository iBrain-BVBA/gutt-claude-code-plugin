#!/usr/bin/env python3
"""Suite definition: does the skill text produce a backlog cleanup that can be audited?

Scoring is checklist-per-case rather than one property for all cases, because the
hand-written expected outcome differs per case: the plan case is scored on the calls
(one JQL fetch, memory grounding with org scope, nothing mutated ungated) and the
proposal cases on the artifact (the seeded clusters found with their keys, stale
candidates justified from evidence rather than age, the denominator stated, the
degradation disclosures present). `corpus.py` owns the checklists and their rationale;
this file only applies them.

A failure is recorded by label (`missing:cluster-csv-pair`, `banned:claims-acted`), so
the report can say *which* seeded answer a variant loses, not just how often it loses —
the missing:cluster-* labels are the recall measurement on the seeded clusters.
"""
import collections
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from lib.scoring import bare_distractors  # noqa: E402

from . import corpus, variants as V  # noqa: E402

NAME = "backlog-dedupe"
DESCRIPTION = "Backlog dedupe: seeded clusters found, stale justified, nothing acted"

SYSTEM = (
    "You are Claude Code, Anthropic's official CLI, in an interactive session with "
    "organizational-memory tools connected."
)

PLAN_TASK = (
    "Tools cannot be executed in this run. Reply with the plan you would follow: each "
    "tool call with its concrete parameter values, in the order you would make them, "
    "and what you would do with the results."
)


def variants():
    return V.all_variants()


def cases():
    return corpus.build()


def build_prompt(variant_text, case):
    parts = [corpus.TODAY, case["surface"]]
    if variant_text:
        parts.append(
            "You have loaded the following skill for this task:\n\n" + variant_text
        )
    parts.append(f'The user asks: "{case["ask"]}"')
    if case["family"] == "plan":
        parts.append(PLAN_TASK)
    else:
        parts.append(
            "You have already gathered these tool results — treat them as complete; no "
            "further calls are possible in this run:\n\n"
            f"{case['gathered']}\n\n"
            "Write your reply to the user now, based on these results."
        )
    return "\n\n".join(parts)



def evaluate(case, raw):
    text = raw or ""
    failures = []
    for label, pat in case["must_all"]:
        if not re.search(pat, text, re.I | re.S):
            failures.append(f"missing:{label}")
    for label, pat in case["must_not"]:
        if re.search(pat, text, re.I | re.S):
            failures.append(f"banned:{label}")
    failures += [f"unmarked:{tok}" for tok in bare_distractors(case, text)]
    return {
        "correct": not failures,
        "failures": failures,
        "chars": len(text),
        "tail": text[-300:],
    }


def report(results, case_list, variant_map):
    order = list(variant_map)
    index = {c["id"]: c for c in case_list}
    by = collections.defaultdict(list)
    for r in results:
        by[r["variant"]].append(r)

    head = f"{'variant':12} {'chars':>6} {'all':>6} {'confident':>10} {'errors':>7}"
    rows = [head, "-" * len(head)]
    summary = {}
    for v in order:
        rs = by.get(v) or []
        if not rs:
            rows.append(f"{v:12} — no results")
            continue
        conf = [r for r in rs if index[r["case"]]["confident"]]
        acc = sum(bool(r.get("correct")) for r in rs) / len(rs)
        acc_c = sum(bool(r.get("correct")) for r in conf) / len(conf) if conf else 0
        errs = sum(1 for r in rs if r.get("error"))
        fails = collections.Counter(f for r in rs for f in r.get("failures") or [])
        summary[v] = {
            "acc": acc,
            "acc_confident": acc_c,
            "errors": errs,
            "n": len(rs),
            "failures": dict(fails),
            "variant_chars": len(variant_map[v]),
        }
        rows.append(
            f"{v:12} {len(variant_map[v]):>6} {acc:>5.0%} {acc_c:>10.0%} {errs:>7}"
        )
        for label, n in fails.most_common():
            rows.append(f"{'':12}   {label}: {n}/{len(rs)}")

    per = [f"{'case':>24} " + "".join(f"{v:>14}" for v in order)]
    per.append("-" * len(per[0]))
    for c in case_list:
        cells = ""
        for v in order:
            rs = [r for r in by.get(v, []) if r["case"] == c["id"]]
            cells += (
                f"{sum(bool(r.get('correct')) for r in rs)}/{len(rs)}" if rs else "—"
            ).rjust(14)
        per.append(f"{c['id']:>24}{'~' if not c['confident'] else ' '}{cells}")

    parts = [
        "BACKLOG DEDUPE — skill text vs no skill",
        "\n".join(rows),
        "",
        "  failure labels: missing:cluster-* = a seeded cluster not found (the recall",
        "  measurement); missing:<other> = a required behaviour never appeared;",
        "  banned:<check> = an acted-on or fabricated claim; unmarked:<token> = a",
        "  mutating call shown without its approval gate",
        "",
        "PER CASE — trials correct   (~ = label held less firmly)",
        "\n".join(per),
    ]
    return "\n".join(parts), summary
