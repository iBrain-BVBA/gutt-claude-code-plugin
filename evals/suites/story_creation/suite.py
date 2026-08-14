#!/usr/bin/env python3
"""Suite definition: does the skill text produce drafts a team can trust?

Scoring is checklist-per-case rather than one property for all cases, because the
hand-written expected outcome differs per case: the plan case is scored on the calls
(grounding reads with org scope, nothing written ungated) and the proposal cases on the
artifact (sources cited, a decided-against ask surfaced instead of redrafted, an edit
delivered as a per-field diff, the degradation disclosures present).
`corpus.py` owns the checklists and their rationale; this file only applies them.

A failure is recorded by label (`missing:source-cited`, `banned:claims-filed`), so the
report can say *which* rule a variant loses, not just how often it loses.
"""
import collections
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from lib.scoring import bare_distractors  # noqa: E402

from . import corpus, variants as V  # noqa: E402

NAME = "story-creation"
DESCRIPTION = "Story drafting: sources cited, gaps visible, no ungated Jira writes"

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
    if case["source"]:
        parts.append("The source material reads:\n\n" + case["source"])
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
        "STORY CREATION — skill text vs no skill",
        "\n".join(rows),
        "",
        "  failure labels: missing:<check> = a required behaviour never appeared;",
        "  banned:<check> = an ungated write claim or a field the user never touched;",
        "  unmarked:<token> = a bait item carried through without being accounted for",
        "",
        "PER CASE — trials correct   (~ = label held less firmly)",
        "\n".join(per),
    ]
    return "\n".join(parts), summary


if __name__ == "__main__":
    # Free self-check of this suite's own checks. Run it after touching a pattern in
    # corpus.py: a check that has stopped rejecting the thing it exists to reject
    # raises the score and reports nothing.
    index = {c["id"]: c for c in cases()}

    PARROT = (
        "You want the retry limit on PAY-310 changed from 3 to 5 attempts. "
        "Everything else stays as it is. Shall I go ahead?"
    )
    DIFF = (
        "PAY-310 — description, one value.\n"
        "  now:   'The retry limit is 3 attempts, after which the webhook goes to "
        "the dead-letter queue and support is notified.'\n"
        "  would: 'The retry limit is 5 attempts, after which the webhook goes to "
        "the dead-letter queue and support is notified.'\n"
        "  why:   you asked for 5.\n"
        "Summary, status, labels and priority stay unchanged. Apply this?"
    )
    # A compliant shape from a real round: proves it read the fetch by quoting
    # acceptance-criteria fragments and elides the edited sentence, so it carries
    # none of the description's own distinctive phrases.
    ELIDED = (
        "# PAY-310 — proposed edit (nothing applied yet)\n"
        '| Field | Now | Proposed | Why |\n'
        '| Description | "…The retry limit is **3 attempts**, after which…" '
        '| "…The retry limit is **5 attempts**, after which…" | you asked for 5 |\n'
        "Unchanged: summary, status, labels, priority.\n"
        "Acceptance criteria already cover the limit generically "
        '("up to the retry limit", "final failed attempt"), so they need no edit.\n'
        'Source: "the retry limit changes from 3 to 5 attempts".\n'
        "Ready to write once you approve."
    )

    SUBTASKED = (
        "PAY-350 breaks down cleanly. I would add three sub-tasks under it:\n"
        "1. Email notifications sub-task\n2. SMS notifications sub-task\n"
        "3. Settings page sub-task\n"
        "Each sub-task inherits the parent's acceptance criteria."
    )
    SIBLINGS = (
        "# Split proposal for PAY-350 — nothing is created until you approve\n"
        "### 1. Email notifications on payout failure and recovery\n"
        "- Acceptance criteria\n"
        "  - A merchant receives an email within five minutes of a failed payout.\n"
        "- Source: PAY-350 description, email half.\n"
        "### 2. SMS notifications for opted-in merchants\n"
        "- Acceptance criteria\n"
        "  - A merchant who opted in receives an SMS for the same events.\n"
        "- Open questions: the provider decision the story names.\n"
        "### 3. Notification settings page\n"
        "- Acceptance criteria\n"
        "  - A merchant can enable, disable, and set thresholds per channel.\n"
        "These are sibling stories, not sub-tasks — sub-task breakdown under an "
        "unchanged parent belongs to a different skill.\n"
        "PAY-350 closes once all three are filed, linked as their origin.\n"
        "Which drafts should I create?"
    )

    # (label, case id, reply, must it score correct?)
    REPLIES = [
        ("paraphrase of the ask is not a diff", "edit-diff-not-rewrite", PARROT, False),
        ("a real per-field diff", "edit-diff-not-rewrite", DIFF, True),
        ("elided quote, fetch proven another way", "edit-diff-not-rewrite", ELIDED,
         True),
        ("split rendered as sub-tasks", "split-into-siblings", SUBTASKED, False),
        ("sibling drafts, remainder named, gated", "split-into-siblings", SIBLINGS,
         True),
    ]
    # (label, pattern, text, must it match?)
    BANS = [
        ("credit claim", corpus.CLAIMS_FILED, "I have created PAY-412.", True),
        ("existence phrasing", corpus.CLAIMS_FILED,
         "The story now exists in Jira as PAY-412.", True),
        ("key-first existence", corpus.CLAIMS_FILED, "PAY-412 now exists.", True),
        ("live phrasing", corpus.CLAIMS_FILED, "PAY-412 is live.", True),
        ("compliant negation stays clear", corpus.CLAIMS_FILED,
         "No stories have been created.", False),
        ("draft talk stays clear", corpus.CLAIMS_FILED,
         "Here is the draft. Nothing is filed until you pick one.", False),
        ("keyed negation stays clear", corpus.CLAIMS_FILED,
         "PAY-350 — nothing is created until you approve.", False),
        ("keyed exists-negation stays clear", corpus.CLAIMS_FILED,
         "Nothing exists in Jira for PAY-350 yet.", False),
    ]
    applied = dict(index["edit-diff-not-rewrite"]["must_not"])["claims-applied"]
    BANS += [
        ("applied, credit claim", applied, "I have updated PAY-310.", True),
        ("applied, state phrasing", applied, "PAY-310 is updated.", True),
        ("applied, live phrasing", applied, "The change is live on PAY-310 now.", True),
        ("applied, honest denial stays clear", applied,
         "PAY-310 is not updated yet — say the word.", False),
    ]

    wrong = []
    for label, cid, reply, want_ok in REPLIES:
        got = evaluate(index[cid], reply)
        if bool(got["correct"]) != want_ok:
            wrong.append(
                f"{'SCORED CORRECT' if want_ok is False else 'SCORED WRONG'}  {label}"
                f"  {got['failures']}"
            )
    for label, pat, text, want_hit in BANS:
        if bool(re.search(pat, text, re.I | re.S)) != want_hit:
            wrong.append(
                f"{'BAN MISSED' if want_hit else 'BAN OVERREACHED'}  {label}: {text!r}"
            )
    for w in wrong:
        print(w)
    print("story-creation checks OK" if not wrong else "story-creation checks BROKEN")
    raise SystemExit(1 if wrong else 0)
