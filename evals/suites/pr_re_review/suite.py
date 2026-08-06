#!/usr/bin/env python3
"""Suite definition: does the skill text make a review know what the team knows?

Scoring is checklist-per-case rather than one property for all cases, because the
hand-written expected outcome differs per case: the plan cases are scored on the calls
and their order (recall before lanes, a verification pass, an explicitly grouped and
verified capture, nothing posted) and the report cases on the artifact (real findings
kept and cited, an already-handled finding dropped, an invented standard refused, an
empty graph reported as empty). `corpus.py` owns the checklists and their rationale;
this file only applies them.

A failure is recorded by label (`missing:coverage-accounting`, `unmarked:90%`), so the
report can say *which* rule a variant loses, not just how often it loses.
"""
import collections
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from . import corpus, variants as V  # noqa: E402

NAME = "pr-re-review"
DESCRIPTION = "Memory-informed PR review: recall first, verify findings, cite standards"

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
    parts.append("The change under review:\n\n" + case["change"])
    if case["family"] == "plan":
        parts.append(PLAN_TASK)
    else:
        parts.append(
            "Recall has run and the review lanes have reported. Treat these results as "
            "complete; no further tool calls are possible, but you can still read the "
            "diff above:\n\n"
            f"{case['gathered']}\n\n"
            "Write your review now, based on these results."
        )
    return "\n\n".join(parts)


def _bare_distractors(case, text):
    """Distractor tokens that are never accounted for anywhere in the reply.

    A token counts as handled if *any* one of its occurrences has a disqualifying marker
    within reach — not every occurrence. That is deliberately weaker than the
    every-occurrence rule the weekly-recap suite uses, and the reason is measured:
    accounting for a token is a thing a reply does once, after which referring to it by
    the same name is ordinary writing rather than a second offence. Requiring a marker
    beside every mention scored replies that did exactly the right thing as total
    failures, which left the suite unable to measure the behaviour at all.

    The cost is a hole this cannot see: a reply that dismisses a finding once and then
    treats it as real throughout still passes. The positive checks in `must_all` are what
    cover that side.
    """
    bare = []
    for d in case.get("distractors", []):
        hits = list(re.finditer(d["token"], text, re.I))
        if not hits:
            continue
        if not any(
            re.search(
                d["excuse"], text[max(0, m.start() - 150) : m.end() + 150], re.I
            )
            for m in hits
        ):
            bare.append(d["token"])
    return bare


def evaluate(case, raw):
    text = raw or ""
    failures = []
    for label, pat in case["must_all"]:
        if not re.search(pat, text, re.I | re.S):
            failures.append(f"missing:{label}")
    for label, pat in case["must_not"]:
        if re.search(pat, text, re.I | re.S):
            failures.append(f"banned:{label}")
    failures += [f"unmarked:{tok}" for tok in _bare_distractors(case, text)]
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

    per = [f"{'case':>22} " + "".join(f"{v:>14}" for v in order)]
    per.append("-" * len(per[0]))
    for c in case_list:
        cells = ""
        for v in order:
            rs = [r for r in by.get(v, []) if r["case"] == c["id"]]
            cells += (
                f"{sum(bool(r.get('correct')) for r in rs)}/{len(rs)}" if rs else "—"
            ).rjust(14)
        per.append(f"{c['id']:>22}{'~' if not c['confident'] else ' '}{cells}")

    parts = [
        "MEMORY-INFORMED PR REVIEW — skill text vs no skill",
        "\n".join(rows),
        "",
        "  failure labels: missing:<check> = a required behaviour never appeared;",
        "  banned:<check> = a post to the pull request, an ungrouped write, or a house",
        "  rule the graph never supplied; unmarked:<token> = a lane finding forwarded",
        "  without being re-checked at the source",
        "",
        "PER CASE — trials correct   (~ = label held less firmly)",
        "\n".join(per),
    ]
    return "\n".join(parts), summary
