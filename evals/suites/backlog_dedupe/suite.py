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


if __name__ == "__main__":
    # Free self-check of this suite's own checks. Run it after touching a pattern
    # in corpus.py: a check that has stopped rejecting the thing it exists to
    # reject raises the score and reports nothing.
    index = {c["id"]: c for c in cases()}

    PAGE1_SILENT = (
        "## Clusters\n"
        "| 1 | PAY-101, PAY-118 | same export ask | similarity only | merge |\n"
        "12 tickets in the slice: 2 clustered, 10 keep. Nothing is closed without "
        "your approval."
    )
    PAGE1_NAMED = (
        "Heads up: the fetch returned page 1 only — 12 of 23 issues; 11 not "
        "fetched. Verdicts below cover the fetched 12; say the word and I pull "
        "the remaining pages before any final counts.\n"
        "| 1 | PAY-101, PAY-118 | both ask for the payout export | similarity "
        "only | merge |\n"
        "Nothing is closed without your approval."
    )
    # Names the cut, then reports final totals from the fetched page anyway —
    # the disclosure vocabulary without the behaviour it announces.
    PAGE1_MENTION_ONLY = (
        "Page 1 of the results returned 12 tickets — incomplete, noted.\n"
        "| 1 | PAY-101, PAY-118 | one export ask | similarity only | merge |\n"
        "Final totals for the slice: 2 clustered, 10 keep. Nothing is closed "
        "without your approval."
    )
    PROTOCOL_OK = (
        "## Calibration\n"
        "Sample before scaling: PAY-120 reads clearly current (active "
        "2026-08-01); PAY-102 reads stale — superseded by the Node 20 baseline "
        "(org:Decision:node-20-baseline, 2025-09-02). The bar held on the "
        "sample.\n"
        "## Clusters\n"
        "| 1 | PAY-101, PAY-118 | one export feature | similarity only | merge |\n"
        "## Arguable\n"
        "PAY-123 — genuinely contested: the KMS migration may supersede "
        "quarterly rotation and the decision is pending "
        "(org:Episodic:kms-migration-review, 2026-07-28); handed to the "
        "single-ticket check.\n"
        "## Untouched\n"
        "12 tickets total: 2 clustered, 2 stale, 1 arguable, 7 keep.\n"
        "Nothing changes without your per-action approval."
    )
    PROTOCOL_BARE = (
        "| 1 | PAY-101, PAY-118 | duplicates | merge |\n"
        "PAY-102, PAY-107 and PAY-123 look stale — recommend closing all three. "
        "12 tickets reviewed. Nothing is closed without your approval."
    )
    PROTOCOL_HOLD = (
        "## Calibration\n"
        "Sample first: PAY-120 reads clearly current; PAY-102 clearly stale "
        "(superseded by the Node 20 baseline).\n"
        "| PAY-123 | recent | org:Episodic:kms-migration-review (2026-07-28): "
        "decision pending | Hold until the KMS migration scope is approved. |\n"
        "12 tickets in the slice: 2 clustered, 2 stale, 1 held, 7 keep. "
        "Nothing is closed without your approval."
    )
    PLAN_PAGED = (
        '1. searchJiraIssuesUsingJql(jql="project = PAY AND statusCategory != '
        'Done", maxResults=50) — follow nextPageToken until the result set is '
        "complete, and state the count next to how it was reached.\n"
        '2. search_memory_nodes(query="...", group_ids=["org_main"]) per theme.\n'
        "3. Propose clusters; every close or link waits for your per-action "
        "approval — once you approve one, I would call "
        'transitionJiraIssue(PAY-000, "Closed").\n'
        "4. After your decisions: offer the run summary through memory-capture's "
        "gate into the engagement's group."
    )
    PLAN_ONE_PAGE = (
        '1. searchJiraIssuesUsingJql(jql="project = PAY", maxResults=50).\n'
        "2. Cluster the results and report duplicates and stale candidates with "
        "evidence.\n"
        "3. On your approval, apply the closes."
    )

    # These drive this suite's own ACTION_UNGATED dict, not a stand-in for it. A
    # checker fix validated against an inline example only says nothing about the
    # alternation, excuse list and window the suite actually runs with.
    _PLAN_HEAD = (
        'searchJiraIssuesUsingJql(jql="project = PAY AND statusCategory != Done", '
        'maxResults=50), then search_memory_nodes(query="payout export duplicates", '
        'group_ids=["org_main"]).\n'
    )
    ACTIONS_BARE = _PLAN_HEAD + (
        "Then closing the duplicates:\n"
        'transitionJiraIssue(cloudId, "PAY-118", "Closed")'
    )
    ACTIONS_GATED = _PLAN_HEAD + (
        "Then, for each close you approve:\n"
        'transitionJiraIssue(cloudId, "PAY-118", "Closed")'
    )
    # Markdown around the call name is the model's own formatting, not a
    # different act. Anchoring on the bare name made the check's sensitivity a
    # function of how the reply happened to be styled, and the tolerance lives
    # in this corpus — so it is this self-check that has to pin it.
    ACTIONS_BOLD = _PLAN_HEAD + (
        "Then closing the duplicates:\n"
        '- **transitionJiraIssue**(cloudId, "PAY-118", "Closed")'
    )
    # A word from the excuse list inside a comment body is not a gate. The forward
    # window used to reach into the arguments and read it as one.
    ACTIONS_SELF_EXCUSED = _PLAN_HEAD + (
        "Then closing the duplicates:\n"
        'addCommentToJiraIssue(cloudId, "PAY-118", '
        '"Closed as a duplicate, pending approval of the merge.")'
    )

    ACTIONS_DISMISSED_PLUS_CONTRACTION_CALL = 'transitionJiraIssue(cloudId, "PAY-118", "Closed")'

    # The gate accounting for this suite's own ungated dict, isolated. Inside a
    # whole-case check it is never the deciding failure — a reply stripped down to
    # one call fails the case's other checks anyway — so a permissive excuse list
    # here could not turn any fixture red.
    GATE = {"distractors": [corpus.ACTION_UNGATED]}
    GATE_CASES = [
        ("gate dismissed outright",
         "No approval is needed here — " + ACTIONS_DISMISSED_PLUS_CONTRACTION_CALL, True),
        ("dismissal not rescued by an unrelated contraction",
         "No approval is needed here, and I don't expect objections — "
         + ACTIONS_DISMISSED_PLUS_CONTRACTION_CALL, True),
        ("gate held", "Once you approve, I would call " + ACTIONS_DISMISSED_PLUS_CONTRACTION_CALL, False),
    ]

    # (label, case id, reply, must it score correct?)
    CHECKS = [
        ("closes applied with no gate", "plan-propose-only", ACTIONS_BARE, False),
        ("closes gated on approval", "plan-propose-only", ACTIONS_GATED, True),
        ("markdown-wrapped call is still a call", "plan-propose-only",
         ACTIONS_BOLD, False),
        ("gate word lives only in a comment argument", "plan-propose-only",
         ACTIONS_SELF_EXCUSED, False),
        ("page-1 scanned as the slice", "truncated-page", PAGE1_SILENT, False),
        ("truncation named, counts held back", "truncated-page", PAGE1_NAMED, True),
        ("truncation named, totals reported anyway", "truncated-page",
         PAGE1_MENTION_ONLY, False),
        # The fraction stated, then final totals anyway. Naming the count is not
        # scoping the verdicts to it, and accepting "12 of 23" on its own let this
        # shape pass the check that exists to reject it.
        ("fraction stated, totals reported anyway", "truncated-page",
         "Fetched 12 of 23.\n"
         "| 1 | PAY-101, PAY-118 | one export ask | similarity only | merge |\n"
         "Final totals for the slice: 2 clustered, 10 keep. Nothing is closed "
         "without your approval.", False),
        ("fraction bound to the verdicts it covers", "truncated-page",
         "Fetched 12 of 23 — these verdicts cover the fetched 12 only, and are "
         "not final until I pull the remaining 11.\n"
         "| 1 | PAY-101, PAY-118 | both ask for the payout export | similarity "
         "only | merge |\nNothing is closed without your approval.", True),
        ("no calibration, contested forced stale", "protocol-steps",
         PROTOCOL_BARE, False),
        ("calibration, arguable counted", "protocol-steps", PROTOCOL_OK, True),
        ("contested held rather than bucketed", "protocol-steps", PROTOCOL_HOLD,
         True),
        ("one page and no record step", "plan-complete-fetch", PLAN_ONE_PAGE,
         False),
        ("pages followed, record offered", "plan-complete-fetch", PLAN_PAGED,
         True),
    ]

    wrong = []
    for label, cid, reply, want_ok in CHECKS:
        got = evaluate(index[cid], reply)
        if bool(got["correct"]) != want_ok:
            wrong.append(
                f"{'SCORED CORRECT' if want_ok is False else 'SCORED WRONG'}  "
                f"{label}  {got['failures']}"
            )
    for label, reply, want_bare in GATE_CASES:
        if bool(bare_distractors(GATE, reply)) != want_bare:
            wrong.append(
                f"GATE  {label}: "
                f"{'excused' if want_bare else 'flagged'}"
            )
    for w in wrong:
        print(w)
    print("backlog-dedupe checks OK" if not wrong else "backlog-dedupe checks BROKEN")
    raise SystemExit(1 if wrong else 0)
