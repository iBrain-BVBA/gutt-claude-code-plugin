#!/usr/bin/env python3
"""Check a candidate prompt against the guards in tests/hook-architecture.test.cjs.

A variant that scores well but violates a guard cannot ship, and every one of those
guards records a live failure — so ranking an unshippable candidate wastes the round.
This mirrors the assertions in Python so a candidate can be checked for nothing.

Deliberately a mirror, not a shared source: the .cjs guards are the contract, and if the
two drift the fix is to update this file. `python3 -m suites.stop_judge.shippable`
re-checks every variant.
"""
import re

GATED = ("Lesson", "Decision", "WorkingAgreement")


def check(prompt):
    """Return a list of guard violations; empty means shippable."""
    bad = []
    condition = prompt.split("\n\n")[0]
    if not condition.startswith("Nothing"):
        bad.append("condition must open 'Nothing' — the CLI maps satisfied to ok:true")
    if re.search(r"you are deciding|decide whether", condition, re.I):
        bad.append("condition reads as a task, not a proposition")
    if "stop_hook_active" not in prompt:
        bad.append("no termination condition (livelock)")
    if "$ARGUMENTS" not in prompt:
        bad.append("payload not interpolated — stop_hook_active cannot arrive")
    if not re.search(r"durable for the team|throwaway|scaffolding", prompt, re.I):
        bad.append("durability not required separately from type")
    if not re.search(r"omit `reason`|no other field", prompt, re.I):
        bad.append("does not tell the judge to drop `reason` on an allow")
    if not re.search(r"10 words", prompt):
        bad.append("no word cap on bullets")
    if not re.search(r"one bullet per subject|bullet per subject", prompt, re.I):
        bad.append("reason shape leaves bullet count to the judge")
    types = re.findall(r"^- (?:an?|the) \*\*([A-Za-z]+)\*\*", prompt, re.M)
    if sorted(set(types)) != ["Incident", "Insight"]:
        bad.append(f"fire-condition bullets are {sorted(set(types))}, want Incident+Insight")
    missing = [t for t in GATED if t not in prompt]
    if missing:
        bad.append(f"gated types not ruled out: {missing}")
    if not re.search(r"do not restate this response format|quotes the JSON gets echoed", prompt, re.I):
        bad.append("no anti-restatement clause — the verdict prints as the user's answer")
    if not re.search(r"format sample, not findings|never carry them", prompt, re.I):
        bad.append("example not marked as a sample — judge fires carrying its bullets")
    if not re.search(r"judge the finding|not what it \*?did\*?", prompt, re.I):
        bad.append("does not separate the finding from the activity")
    if re.search(r"routine edits|reading or searching code|answering a question", prompt, re.I):
        bad.append("lists an activity as a reason to stay quiet — discards real findings")
    if not re.search(r"not continuing it|capture nothing yourself|call no tool", prompt, re.I):
        bad.append("no role sentence — the judge joins the work instead of scoring it")
    if not re.search(r"opens with the line", prompt, re.I):
        bad.append("skill line only shown in the example, not asked for")
    # Not checked: that a fired verdict cannot become the user's answer. It is a real
    # defect (see FINDINGS.md and leak_probe.py) but no wording tested fixes it without
    # costing more elsewhere, so there is no assertion in the .cjs suite to mirror. This
    # file tracks the tests, not the wish list.
    if re.match(r"^-\s*(Insight|Incident):", prompt.strip().split("\n")[-1]):
        bad.append("ends on an example bullet — biases the judge toward firing")
    return bad


if __name__ == "__main__":
    import sys
    import pathlib

    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
    from suites.stop_judge import variants as V

    worst = 0
    for name, text in V.all_variants().items():
        bad = check(text)
        lines = len([l for l in text.split("\n") if l.strip()])
        flag = "SHIPPABLE" if not bad else f"{len(bad)} violation(s)"
        print(f"{name:12} {lines:>3}L {len(text):>5}c  {flag}")
        for b in bad:
            print(f"{'':18} - {b}")
        worst = max(worst, len(bad))
    sys.exit(0)
