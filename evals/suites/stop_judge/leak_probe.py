#!/usr/bin/env python3
"""Does a fired verdict turn into the user's answer? A deterministic firing vector.

The failure: when the Stop hook fires, Claude Code injects the *whole* prompt template
into the main conversation as `Stop hook feedback:\\n[<template>]: <reason>`. The
template's imperatives — "respond with exactly {"ok": true} and no other field" — are then
read by the **main** agent as instructions to itself, and it obeys. Measured on live
sessions: 3 of 5 fires came back with a 13-byte reply that was nothing but `{"ok": true}`,
so the user's question went unanswered entirely.

Why this file exists rather than more live sessions: the leak is only observable *after* a
fire, and whether the judge fires is a model call that lands 50–80% of the time. That makes
the live signal both expensive and noisy — and it is how the existing e2e detector came to
pass vacuously for weeks while the fixture had quietly stopped firing. Here the injection
is constructed directly, so every trial exercises the fire path.

Fidelity: the real injection arrives as its own message after the assistant's turn; this
builds the same text into one prompt. That understates nothing about the template's
content, and it treats every candidate identically, which is what a comparison needs.
Confirm a winner on live sessions afterwards — do not replace them with this.

Usage:
    python3 -m suites.stop_judge.leak_probe                  # every shippable variant
    python3 -m suites.stop_judge.leak_probe V14 V15 --trials 5
"""
import argparse
import concurrent.futures as cf
import re
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from lib.runner import ask, judge_cwd  # noqa: E402

SKILL = "gutt-claude-code-plugin:memory-capture"

# The turn being finished, and the reason a firing judge appends. Both realistic: this is
# the shape the live probe produced, skill line plus two typed bullets.
USER_TURN = (
    "In SQLite, a nightly job that refreshes parent rows with INSERT OR REPLACE keeps "
    "losing every child row even though the job contains no DELETE. Explain the mechanism."
)
ASSISTANT_TURN = (
    "INSERT OR REPLACE is not an update. On a uniqueness conflict SQLite deletes the "
    "conflicting row and inserts a new one, and that delete fires ON DELETE CASCADE, so "
    "the children go with it. Use INSERT ... ON CONFLICT DO UPDATE, which is a real update "
    "and triggers no delete action."
)

# The second case, and the nastier one. The judge false-fires on roughly one turn in seven
# (bench: 5 false fires in 35 quiet trials), and when it does so on a turn with nothing to
# capture, the agent has neither a finding to record nor much of an answer to return — so
# it falls back to answering the hook's question. Two e2e assertions expecting "pong" came
# back with ```json {"ok": true}``` and "the memory capture tool is requesting permission".
# Note the leak here is not an echo of the injected reason: the agent writes a *fresh*
# verdict of the opposite polarity, which is why an echo-only probe scores this 0%.
CASES = {
    "durable": (USER_TURN, ASSISTANT_TURN),
    "trivial": ("Reply with exactly: pong", "pong"),
}
REASON = (
    f"Run the `{SKILL}` skill.\n"
    "- Insight: INSERT OR REPLACE deletes then inserts; cascades destroy children\n"
    "- Insight: ON CONFLICT DO UPDATE avoids triggering cascade deletes"
)


def reason_for(template):
    """The reason a judge following `template` would write.

    Some candidates put their anti-leak instruction in the reason rather than in the
    template, so a fixed reason would test those with their fix removed. Any final line
    the template demands verbatim (in backticks, after the bullet spec) is appended.
    """
    demanded = re.search(r"one final line, exactly: `([^`]+)`", template)
    return REASON + ("\n" + demanded.group(1) if demanded else "")


# Claude Code's own wrapper, reproduced. `$ARGUMENTS` arrives un-interpolated in the echo,
# so the template goes in verbatim.
def injected(template):
    return f"Stop hook feedback:\n[{template}]: {reason_for(template)}"


def build(template, case="durable"):
    user, assistant = CASES[case]
    return (
        f"User: {user}\n\n"
        f"You already answered: {assistant}\n\n"
        f"{injected(template)}\n\n"
        "Continue the turn."
    )


def leaked(reply):
    """A reply that is a verdict rather than an answer."""
    r = (reply or "").strip()
    if re.search(r'"ok"\s*:\s*(true|false)', r):
        return True
    if re.match(r"^\s*```\s*json", r, re.I):
        return True
    return False


def main(argv=None):
    from suites.stop_judge import variants as V
    from suites.stop_judge.shippable import check

    ap = argparse.ArgumentParser()
    ap.add_argument("variants", nargs="*")
    ap.add_argument("--trials", type=int, default=5)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--case", choices=sorted(CASES), default="durable")
    args = ap.parse_args(argv)

    every = V.all_variants()
    names = args.variants or [n for n, t in every.items() if not check(t)]
    missing = [n for n in names if n not in every]
    if missing:
        print(f"no such variant(s): {missing}", file=sys.stderr)
        return 2

    cwd = judge_cwd()
    jobs = [(n, t) for n in names for t in range(args.trials)]
    print(f"{len(jobs)} calls — {len(names)} variants x {args.trials} trials, "
          f"case={args.case}\ncwd: {cwd}")

    def work(job):
        name, _ = job
        # No --system-prompt: the leak is about the *main* agent's default behaviour.
        raw = ask(build(every[name], args.case), system=None, cwd=cwd)
        return name, raw

    tally = {n: {"leaked": 0, "n": 0, "blocked": 0} for n in names}
    samples = {}
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for name, raw in ex.map(work, jobs):
            t = tally[name]
            if raw.startswith("<blocked") or raw.startswith("<timeout"):
                t["blocked"] += 1
                print("?", end="", flush=True)
                continue
            t["n"] += 1
            if leaked(raw):
                t["leaked"] += 1
                samples.setdefault(name, raw[:200])
            print("X" if leaked(raw) else ".", end="", flush=True)
    print("\n")

    print(f"{'variant':12}{'lines':>6}{'chars':>7}{'trials':>8}{'leaked':>8}  rate")
    for n in names:
        t = tally[n]
        body = len([l for l in every[n].split("\n") if l.strip()])
        rate = f"{t['leaked'] / t['n']:.0%}" if t["n"] else "n/a"
        note = f"  ({t['blocked']} unusable)" if t["blocked"] else ""
        print(f"{n:12}{body:>6}{len(every[n]):>7}{t['n']:>8}{t['leaked']:>8}  {rate}{note}")
    for n, s in samples.items():
        print(f"\n{n} leaked, e.g.: {s!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
