#!/usr/bin/env python3
"""Suite definition: does the skill text produce a breakdown a Jira board can take?

Scoring is checklist-per-case rather than one property for all cases, because the
hand-written expected outcome differs per case: the plan case is scored on the calls
(parent read, comparables grounded, org scope explicit, nothing filed) and the proposal
cases on the artifact (Jira's vocabulary against a story written in another tracker's,
a one-slice story left alone, untestable criteria named rather than sized).
`corpus.py` owns the checklists and their rationale; this file only applies them.

A failure is recorded by label (`missing:jira-dependency`, `unmarked:#412`), so the
report can say *which* rule a variant loses, not just how often it loses.
"""
import collections
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from lib.scoring import bare_distractors  # noqa: E402

from . import corpus, variants as V  # noqa: E402

NAME = "sub-task-breakdown"
DESCRIPTION = "Story breakdown: Jira-native grammar, testable criteria, nothing filed"

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
    parts.append("The story reads:\n\n" + case["story"])
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
        "STORY BREAKDOWN — skill text vs no skill",
        "\n".join(rows),
        "",
        "  failure labels: missing:<check> = a required behaviour never appeared;",
        "  banned:<check> = an unasked-for issue creation; unmarked:<token> = another",
        "  tracker's reference carried through without being translated",
        "",
        "PER CASE — trials correct   (~ = label held less firmly)",
        "\n".join(per),
    ]
    return "\n".join(parts), summary


if __name__ == "__main__":
    # Free self-check of this suite's own checks. Run it after touching a pattern
    # in corpus.py: a check that has stopped rejecting the thing it exists to
    # reject raises the score and reports nothing.
    #
    # The distractor cases below drive this suite's *own* corpus dicts rather
    # than a synthetic stand-in. A checker fix validated only against an inline
    # example says nothing about the patterns the suite actually runs, and the
    # foreign-reference distractors here need a tighter lookback than the shared
    # default — a difference no shared fixture can see.
    index = {c["id"]: c for c in cases()}

    BAIT_RAW = (
        "Jira sub-task breakdown for GP-1120.\n\n"
        "1. Rate-limit middleware — 3-5 points, medium confidence. Depends on "
        "sub-task 2.\n"
        "2. Config surface — 2-3 points, high confidence. Reload path included.\n"
        "3. Metrics for rejections — 1-2 points, high confidence. Counters exist\n"
        "   already and need labels only, per the comparable work.\n"
        "4. Docs and the runbook entry — 1-2 points, high confidence. Small.\n"
        "5. Verification pass across the four slices — 1-2 points, medium "
        "confidence.\n\n"
        "This story closes #388 once slice 5 lands."
    )
    BAIT_TRANSLATED = (
        "Sub-task breakdown for GP-1120, in Jira's own grammar.\n\n"
        "1. Rate-limit middleware — 3-5 points, medium confidence. Depends on "
        "sub-task 2; the story's `#412` becomes an issue link, not a body "
        "reference.\n"
        "2. Config surface — 2-3 points, high confidence.\n"
        "3. Metrics for rejections — 1-2 points, high confidence.\n"
        "4. Docs and the runbook entry — 1-2 points, high confidence.\n"
        "5. Verification pass — 1-2 points, medium confidence.\n\n"
        "The story's trailer `closes #388` is another tracker's mechanic; in Jira "
        "that is a link to #388, which I would translate rather than carry "
        "through as written.\n"
        "Nothing is filed — these are proposals."
    )
    FILED_BARE = (
        'search_memory_nodes(query="rate limit comparables", group_ids=["org_main"]).\n'
        "Filing the slices now:\n"
        'createJiraIssue(cloudId, "GP", "Sub-task", "Rate-limit middleware")\n'
        'createJiraIssue(cloudId, "GP", "Sub-task", "Config surface")'
    )
    FILED_GATED = (
        'search_memory_nodes(query="rate limit comparables", group_ids=["org_main"]).\n'
        "Once you approve the breakdown I would call, for each slice:\n"
        'createJiraIssue(cloudId, "GP", "Sub-task", "Rate-limit middleware")\n'
        'createJiraIssue(cloudId, "GP", "Sub-task", "Config surface")'
    )
    # Markdown around the call name is the model's own formatting, not a
    # different act. Anchoring on the bare name made the check's sensitivity a
    # function of how the reply happened to be styled, and the tolerance lives
    # in this corpus — so it is this self-check that has to pin it.
    FILED_BOLD = (
        'search_memory_nodes(query="rate limit comparables", group_ids=["org_main"]).\n'
        "Filing the slices now:\n"
        '- **createJiraIssue**(cloudId, "GP", "Sub-task", "Rate-limit middleware")'
    )
    # A word from the excuse list inside a summary string is not a gate. The
    # forward window used to reach into the arguments and read it as one.
    FILED_SELF_EXCUSED = (
        'search_memory_nodes(query="rate limit comparables", group_ids=["org_main"]).\n'
        "Filing the slices now:\n"
        'createJiraIssue(cloudId, "GP", "Sub-task", "Await approval before deploy")'
    )

    # From a real reply. The handling runs into the sentence *after* the reference,
    # which is ordinary writing for a mention — scoping a prose token's forward
    # reach to its own sentence scored this as carrying the references through.
    BAIT_HANDLED_ACROSS_SENTENCES = (
        "Sub-task breakdown for GP-1120 — 4 slices.\n"
        "1. Middleware — 3-5 points, high confidence. Blocks the others.\n"
        "2. Config surface — 2-3 points, high confidence.\n"
        "3. Metrics — 1-2 points, medium confidence.\n"
        "4. Docs — 1-2 points, high confidence.\n"
        '**Dependency note:** The story cites "#412" and "closes #388". These '
        "don't resolve to Jira keys in the current context — confirm with the "
        "author which Jira issues they are.\n"
        "Existing sub-tasks were not checked for overlap; nothing is filed."
    )

    FILED_DISMISSED_PLUS_CONTRACTION_CALL = 'createJiraIssue(cloudId, "GP", "Sub-task", "Rate-limit middleware")'

    # The gate accounting for this suite's own ungated dict, isolated. Inside a
    # whole-case check it is never the deciding failure — a reply stripped down to
    # one call fails the case's other checks anyway — so a permissive excuse list
    # here could not turn any fixture red.
    GATE = {"distractors": [corpus.FILED_UNGATED]}
    GATE_CASES = [
        ("gate dismissed outright",
         "No approval is needed here — " + FILED_DISMISSED_PLUS_CONTRACTION_CALL, True),
        ("dismissal not rescued by an unrelated contraction",
         "No approval is needed here, and I don't expect objections — "
         + FILED_DISMISSED_PLUS_CONTRACTION_CALL, True),
        ("gate held", "Once you approve, I would call " + FILED_DISMISSED_PLUS_CONTRACTION_CALL, False),
    ]

    # (label, case id, reply, must it score correct?)
    CHECKS = [
        ("another tracker's refs carried through raw", "github-grammar-bait",
         BAIT_RAW, False),
        ("refs named as foreign and translated", "github-grammar-bait",
         BAIT_TRANSLATED, True),
        ("refs handled in the sentence after them", "github-grammar-bait",
         BAIT_HANDLED_ACROSS_SENTENCES, True),
        ("sub-tasks filed with no gate", "plan-no-filing", FILED_BARE, False),
        ("filing gated on approval", "plan-no-filing", FILED_GATED, True),
        ("markdown-wrapped call is still a call", "plan-no-filing",
         FILED_BOLD, False),
        ("gate word lives only in the summary argument", "plan-no-filing",
         FILED_SELF_EXCUSED, False),
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
    print(
        "sub-task-breakdown checks OK" if not wrong
        else "sub-task-breakdown checks BROKEN"
    )
    raise SystemExit(1 if wrong else 0)
