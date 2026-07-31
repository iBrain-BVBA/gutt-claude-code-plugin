#!/usr/bin/env python3
"""Does the SessionStart migration offer reach the user, without hijacking the turn?

The offer is injected as `SessionStart` `additionalContext` and asks the agent for two
things at once: surface a one-line offer at the end of the reply, and do not let that
displace whatever the user actually asked for. Both halves are prose instructions to a
model, so neither is decidable by a unit test — `hook-architecture.test.cjs` can assert
the sentence is present, not that it works.

Why a probe rather than a `run.py` suite: `lib/runner.run_matrix` calls `ask()` without a
`system` argument, so every call inherits `JUDGE_SYS` ("reply with a single JSON object").
Under that system prompt the model emits a verdict and no offer could ever appear, so a
suite would measure nothing and report it as 0%. `leak_probe.py` hit the same wall and
solved it the same way: call `ask(system=None)` for the *main agent's* default behaviour.

Fidelity, stated because it bounds every number below:

- **Model.** Measured, and the reason this does not default to the bench's `FAST_MODEL`:
  the shipped text offers **24/24 on `claude-sonnet-5`** and **3/12 (25%) on
  `claude-haiku-4-5`**, with the user's question answered cleanly in every call on both.
  So the offer is largely a property of the session model, and on the fast model it is
  both unreliable and far from ceiling, which leaves no headroom to tell wordings apart.
  A first 1-trial pass read 0/5 on Haiku and looked like a hard floor; at 6 trials it is
  25%. That was small-sample noise, and it is the standing warning of this bench —
  re-run before believing a rate, and treat anything under ~10 points as unresolved.
- **Channel.** The real offer arrives as its own `SessionStart` context block before the
  first user prompt; this folds it into the prompt under the same label Claude Code uses.
  Understates nothing about the text and is identical for every variant.
- **cwd.** Calls run from `judge_cwd()`, outside the repo, so the project `CLAUDE.md` is
  not in context. `~/.claude/CLAUDE.md` still loads, equally for every variant.

Usage:
    python3 -m suites.migrate_offer.probe                      # every variant, 5 trials
    python3 -m suites.migrate_offer.probe V0-shipped --trials 8
    python3 -m suites.migrate_offer.probe --case displaced
    python3 -m suites.migrate_offer.probe --model claude-haiku-4-5-20251001   # ~25%, noisy
"""
import argparse
import concurrent.futures as cf
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from lib.runner import ask, judge_cwd  # noqa: E402

# Not `lib.runner.FAST_MODEL`. The offer is addressed to the session's main agent, and on
# the fast model it is ignored outright (0/5, measured — see the module docstring), so a
# comparison run there is uniformly 0% and settles nothing.
PROBE_MODEL = "claude-sonnet-5"

from . import variants as V  # noqa: E402

# ---------------------------------------------------------------------------
# Cases: the turn the offer has to share with the user's actual request
# ---------------------------------------------------------------------------

# `answered` is deliberately a keyword check on the substance of the reply, not a model
# judge: the question is only ever "did the offer crowd out the answer", and a regex that
# can be read off the page is worth more here than a second model call that cannot.
CASES = {
    # Baseline. Short, self-contained, cheap to answer — the offer has room.
    "simple": {
        "user": "In git, what does `git rev-list --count HEAD` print?",
        "answered": r"commit|count",
    },
    # A substantive request. Derailing costs the user something real, and the reply is
    # long enough that an offer can get lost in the middle rather than land at the end.
    "busy": {
        "user": (
            "Our CI job installs dependencies, runs unit tests, then builds a Docker "
            "image. It takes 14 minutes and most of that is dependency install. Give me "
            "three concrete ways to cut the time, with the tradeoff of each."
        ),
        "answered": r"cach|layer|lock|parallel|prune|image",
    },
    # The collision this probe exists for. Another instruction also wants the end of the
    # reply: a Stop-hook fire loads the capture skill, whose reporting rule ends the reply
    # with a TL;DR "placed last, after everything else". Both cannot be last.
    "displaced": {
        "user": "In git, what does `git rev-list --count HEAD` print?",
        "answered": r"commit|count",
        "injection": (
            "Stop hook feedback:\n"
            "[Nothing from this finished turn needs to be written to the team's long-term "
            "memory ... output one JSON verdict on the conversation above.]: "
            "Run the `gutt-pro:memory-capture` skill.\n"
            "- Insight: rev-list counts reachable commits, not repository size\n\n"
            "The memory-capture skill's reporting rule applies: say little about the "
            "capture itself, and when the capture interrupted work that was already "
            "finished, end the reply with a brief TL;DR of that work, placed last, after "
            "everything else."
        ),
        "prior_reply": (
            "`git rev-list --count HEAD` prints the number of commits reachable from "
            "HEAD, as a single integer."
        ),
    },
}

# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

SKILL = "migrate-memory"
# An offer line talks about migrating *and* names where it is migrating to. Requiring the
# second half keeps incidental uses of "migration" (a CI answer about migrating a base
# image, say) from scoring as offers.
MIGRATE = re.compile(r"migrat", re.I)
DESTINATION = re.compile(r"\bgutt\b|\bgraph\b|" + SKILL, re.I)
# Announcing the work rather than offering it. The scoping sentence in the shipped text
# exists to prevent exactly this, so it is the column that tests V2.
OVERREACH = re.compile(
    r"\b(i'?ll run|i will run|let me run|let's run|i'?m going to (run|migrate)|"
    r"running the|i'?ve (migrated|moved|backed up)|starting the migration|"
    r"i have migrated|now migrating)\b",
    re.I,
)


def offer_lines(reply):
    """Lines that read as an offer to migrate into gutt."""
    return [l for l in (reply or "").splitlines()
            if MIGRATE.search(l) and DESTINATION.search(l)]


def migration_lines(reply):
    """Lines that are talking about the migration at all.

    `OVERREACH` is matched only against these, never the whole reply. Scanning everything
    scored the `busy` case at 25% on a reply whose only match was "Package manager
    migration touches lockfile format" next to ordinary CI prose about running a build —
    a phrase from the *answer*, nothing to do with the offer. Overreach means announcing
    that the migration is being performed, so the sentence has to mention it.
    """
    return [l for l in (reply or "").splitlines()
            if MIGRATE.search(l) or SKILL in l.lower()]


def score(case, reply):
    """Deterministic scoring of one reply. No model judge."""
    text = reply or ""
    lines = [l for l in text.splitlines() if l.strip()]
    found = offer_lines(text)
    rec = {
        "offered": bool(found),
        "named_skill": SKILL in text,
        "answered": bool(re.search(CASES[case]["answered"], text, re.I)),
        "overreach": any(OVERREACH.search(l) for l in migration_lines(text)),
        "chars": len(text),
        "at_end": False,
        "offer_words": 0,
    }
    if found:
        last = found[-1]
        rec["offer_words"] = len(last.split())
        # At the end = within the final two non-empty lines, or starting beyond 70% of
        # the reply. Two lines of slack because a trailing sign-off is common and
        # harmless; the failure being measured is an offer buried mid-reply.
        try:
            pos = lines.index(last)
            rec["at_end"] = pos >= len(lines) - 2
        except ValueError:
            pass
        if not rec["at_end"]:
            rec["at_end"] = text.rindex(last) / max(len(text), 1) > 0.70
    return rec


def build(variant_text, case):
    """What the model receives. `variant_text == CONTROL` injects no offer at all."""
    c = CASES[case]
    parts = []
    if variant_text:
        parts.append(f"SessionStart hook additional context: {variant_text}")
    parts.append(f"User: {c['user']}")
    if "injection" in c:
        parts.append(f"You already answered: {c['prior_reply']}")
        parts.append(c["injection"])
        parts.append("Continue the turn.")
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("variants", nargs="*", help="variant labels (default: all)")
    ap.add_argument("--trials", type=int, default=5)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--model", default=PROBE_MODEL)
    ap.add_argument("--case", action="append", choices=sorted(CASES),
                    help="limit to this case (repeatable)")
    args = ap.parse_args(argv)

    every = V.all_variants()
    names = args.variants or list(every)
    missing = [n for n in names if n not in every]
    if missing:
        print(f"no such variant(s): {missing}", file=sys.stderr)
        return 2
    cases = args.case or sorted(CASES)

    cwd = judge_cwd()
    jobs = [(n, c, t) for n in names for c in cases for t in range(args.trials)]
    print(f"{len(jobs)} calls — {len(names)} variants x {len(cases)} cases x "
          f"{args.trials} trials\nmodel: {args.model}\ncwd: {cwd}")

    def work(job):
        name, case, _ = job
        # system=None on purpose: the offer is addressed to the main agent, so what is
        # being measured is the main agent's default behaviour, not a judge's.
        raw = ask(build(every[name], case), model=args.model, system=None, cwd=cwd)
        return name, case, raw

    tally = {(n, c): [] for n in names for c in cases}
    unusable = {(n, c): 0 for n in names for c in cases}
    samples = {}
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for name, case, raw in ex.map(work, jobs):
            if raw.startswith("<blocked") or raw.startswith("<timeout") or raw.startswith("<empty"):
                unusable[(name, case)] += 1
                print("?", end="", flush=True)
                continue
            rec = score(case, raw)
            tally[(name, case)].append(rec)
            samples.setdefault((name, case), raw[:400])
            print("." if rec["offered"] and rec["answered"] else "X", end="", flush=True)
    print("\n")

    def pct(rows, key):
        return f"{sum(bool(r[key]) for r in rows) / len(rows):.0%}" if rows else "n/a"

    head = (f"{'variant':20}{'case':>11}{'n':>4}{'offered':>9}{'at end':>8}"
            f"{'named':>7}{'answered':>10}{'overreach':>11}{'words':>7}")
    print(head)
    print("-" * len(head))
    for n in names:
        for c in cases:
            rows = tally[(n, c)]
            if not rows:
                bad = unusable[(n, c)]
                print(f"{n:20}{c:>11}{0:>4}   — no usable calls ({bad} unusable)")
                continue
            offers = [r for r in rows if r["offered"]]
            words = f"{sum(r['offer_words'] for r in offers) // len(offers)}" if offers else "—"
            note = f"  ({unusable[(n, c)]} unusable)" if unusable[(n, c)] else ""
            print(f"{n:20}{c:>11}{len(rows):>4}{pct(rows, 'offered'):>9}"
                  f"{pct(offers, 'at_end'):>8}{pct(rows, 'named_skill'):>7}"
                  f"{pct(rows, 'answered'):>10}{pct(rows, 'overreach'):>11}{words:>7}{note}")

    print("\n`at end` is a share of the calls that offered at all, not of all calls.")
    print("CONTROL-no-context must read 0% offered — any higher and the detector is "
          "matching\nsomething the injected context did not cause.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
