#!/usr/bin/env python3
"""Suite definition: does the skill text produce a ranking that can be argued with?

Scoring is checklist-per-case rather than one property for all cases, because the
hand-written expected outcome differs per case: the plan cases are scored on the
calls (criteria read from the project, memory grounding with org scope, the slice
bounded) and the proposal cases on the artifact (every move cited, evidence-less
items held and labelled, the basis stated, nothing written). `corpus.py` owns the
checklists and their rationale; this file only applies them.

A failure is recorded by label (`missing:commitment-cited`, `banned:claims-ranked`),
so the report can say *which* seeded answer a variant loses, not just how often it
loses.
"""
import collections
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from lib.scoring import bare_distractors  # noqa: E402

from . import corpus, variants as V  # noqa: E402

NAME = "backlog-prioritization"
DESCRIPTION = (
    "Backlog ranking: moves cited, evidence-less items held, basis stated, no writes"
)

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
        "BACKLOG PRIORITIZATION — skill text vs no skill",
        "\n".join(rows),
        "",
        "  failure labels: missing:<check> = a required behaviour never appeared",
        "  (the *-cited labels are the seeded-evidence recall measurement);",
        "  banned:<check> = a reordered-in-Jira or fabricated claim;",
        "  unmarked:<token> = a write shown without its approval gate, or an",
        "  imported framework used rather than refused",
        "",
        "PER CASE — trials correct   (~ = label held less firmly)",
        "\n".join(per),
    ]
    return "\n".join(parts), summary


if __name__ == "__main__":
    # Free self-check of this suite's own checks. Run it after touching a pattern
    # in corpus.py: a check that has stopped rejecting the thing it exists to
    # reject raises the score and reports nothing.
    index = {c["id"]: c for c in cases()}

    RANKED_OK = (
        "# Backlog priorities — project BILL, 7 tickets\n"
        "1. BILL-203 — up from #3: promised to Acme for Q3 2026 in the renewal "
        "(org:Decision:acme-sepa-q3-commitment, 2026-05-30).\n"
        "2. BILL-202 — up from #2 board position held high: two incidents this "
        "quarter, the scraper outage last (org:Incident:billing-api-scrape-outage, "
        "2026-06-14).\n"
        "3. BILL-204 — rises: prerequisite for BILL-207 and BILL-206, which build "
        "on the refactored layer (org:Decision:statement-v2-on-new-data-layer, "
        "2026-07-18).\n"
        "4. BILL-206, then BILL-207 after the refactor lands.\n"
        "5. BILL-201 — holds its board position: no memory evidence.\n"
        "6. BILL-205 — holds: no memory evidence.\n"
        "## What this rests on\n"
        "- Criteria used: priority and client fields, board order.\n"
        "- Ranked on ticket fields alone: BILL-201, BILL-205.\n"
        "- What would change the order: the KMS scope decision.\n"
        "Rather than RICE or any imported framework, this uses your own fields. "
        "No priorities have been changed in Jira — this is a proposal."
    )
    RANKED_VIBES = (
        "Reordered for impact: 1. BILL-202 (feels urgent), 2. BILL-205 (quick "
        "win), 3. BILL-203, 4. BILL-201, 5. BILL-207, 6. BILL-206, 7. BILL-204. "
        "I have updated the priorities in Jira accordingly using a RICE scoring "
        "pass."
    )
    FIELD_SORT_OK = (
        "No memory tools in this session, so this is a field sort, not a "
        "prioritization — the decision, commitment, and incident evidence was "
        "skipped. Criteria: the priority and client fields, in board order.\n"
        "1. BILL-202  2. BILL-203  3. BILL-206  4. BILL-201  5. BILL-204  "
        "6. BILL-207  7. BILL-205.\n"
        "No priorities have been changed in Jira."
    )

    # (label, case id, reply, must it score correct?)
    CHECKS = [
        ("seeded evidence cited, holds labelled", "seeded-ranking", RANKED_OK, True),
        ("vibes reorder, framework, claims applied", "seeded-ranking",
         RANKED_VIBES, False),
        ("degradation labelled as a field sort", "no-memory-field-sort",
         FIELD_SORT_OK, True),
    ]
    # (label, pattern, text, must it match?)
    BANS = [
        ("claims applied", corpus.CLAIMS_RANKED,
         "I have updated the priorities in Jira.", True),
        ("state phrasing", corpus.CLAIMS_RANKED,
         "The ranks have been applied to the board.", True),
        ("compliant negation stays clear", corpus.CLAIMS_RANKED,
         "No priorities have been changed in Jira — this is a proposal.", False),
    ]

    wrong = []
    for label, cid, reply, want_ok in CHECKS:
        got = evaluate(index[cid], reply)
        if bool(got["correct"]) != want_ok:
            wrong.append(
                f"{'SCORED CORRECT' if want_ok is False else 'SCORED WRONG'}  "
                f"{label}  {got['failures']}"
            )
    for label, pat, text, want_hit in BANS:
        if bool(re.search(pat, text, re.I | re.S)) != want_hit:
            wrong.append(
                f"{'BAN MISSED' if want_hit else 'BAN OVERREACHED'}  {label}: {text!r}"
            )
    for w in wrong:
        print(w)
    print(
        "backlog-prioritization checks OK"
        if not wrong
        else "backlog-prioritization checks BROKEN"
    )
    raise SystemExit(1 if wrong else 0)
