#!/usr/bin/env python3
"""Labelled turns from real sessions, for scoring Stop-judge prompts.

`want_ok` is the correct verdict under the policy every variant shares: fire only on a
durable Insight or Incident. The FIRE labels are not a reconstruction — each is a turn
whose finding was actually written to the graph or the memory directory at the time,
which is the strongest ground truth available here.

`confident` marks a label worth defending outright. Borderline cases stay in the corpus
— a prompt that has to be shielded from them is not ready — but are reported separately
so a variant is not marked down for a call the author is unsure of.
"""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from lib.transcripts import clip_end, clip_mid, extract_turns, find_session  # noqa: E402

# Claude Code names a project's transcript directory after its absolute path, with
# the separators replaced. Derive it from wherever this checkout actually is —
# hardcoding one machine's path sent every other machine looking in a directory that
# could not exist.
#
# This makes the lookup correct anywhere; it does not make the suite runnable
# anywhere. The sessions below are real recorded turns, which is the ground truth
# the docstring above leans on, and they exist only where they were recorded.
# Vendoring the extracted turns as literals would fix that and cost the provenance.
# That trade is unmade — see the FileNotFoundError message below.
PLUGIN_PROJECT = str(pathlib.Path(__file__).resolve().parents[3]).replace("/", "-")
HEAD, TAIL, LAST = 4000, 2500, 3000

# (session prefix, turn index, want_ok, confident, why)
CASES = [
    # ---- should fire -------------------------------------------------------
    ("b727e2aa", 6, False, True,
     "livelock confirmed live: 16 evaluations pre-fix, empty reply — Incident plus mechanism"),
    ("b727e2aa", 12, False, True,
     "enumerated the Stop payload; stop_hook_active reaches the judge through no other channel"),
    ("cda7e83e", 0, False, True,
     "Claude Code emits no debug-log line for PostToolUse — captured as an Insight at the time"),
    ("cda7e83e", 9, False, True,
     "directory-source marketplace runs the working tree — captured as an Insight at the time"),
    ("b727e2aa", 14, False, False,
     "borderline: the stray $ARGUMENTS literal came from the installed copy, not the tree"),
    ("6c7a2aef", 2, False, False,
     "borderline: /plugin update resolves the marketplace to the default branch, serving 2.7.0"),
    # Relabelled after the first run. This was marked quiet — 'analysis of a merged PR,
    # derivable from the diff' — and V6 fired on it three times out of three, naming the
    # UserPromptSubmit/R11 consequence. memory/r11-orphaned-by-thin-router-design.md
    # carries originSessionId 6c7a2aef, so the finding was in fact recorded from this
    # very turn: the variant was right and the label was wrong.
    ("6c7a2aef", 0, False, True,
     "dropping the UserPromptSubmit hook orphaned R11 — recorded from this turn"),
    # ---- should stay quiet -------------------------------------------------
    ("b727e2aa", 18, True, True, "routine: commit, push, update PR — all of it in the git log"),
    ("62709a2b", 0, True, True, "turn abandoned after one sentence — work in progress"),
    ("cda7e83e", 4, True, False,
     "borderline: routine commit and push, but the turn also disproved a reviewer's diagnosis"),
    ("cda7e83e", 12, True, True, "'just respond done' — trivial"),
    ("cda7e83e", 5, True, True, "this turn IS the capture — already recorded"),
    ("cda7e83e", 15, True, False, "borderline: answer read straight out of the public hooks docs"),
]

# Same turn as case 2, with the loop-breaker set: must stay quiet regardless of content.
TERMINATION = ("b727e2aa", 12, True, True, "stop_hook_active is true — already asked this turn")


def build():
    cached = {}

    def turn(prefix, idx):
        if prefix not in cached:
            cached[prefix] = {
                t["idx"]: t for t in extract_turns(find_session(PLUGIN_PROJECT, prefix))
            }
        return cached[prefix][idx]

    def case(prefix, idx, want, confident, why, active, cid):
        t = turn(prefix, idx)
        return {
            "id": cid,
            "src": f"{prefix}#{idx}",
            "want_ok": want,
            "confident": confident,
            "why": why,
            "stop_hook_active": active,
            "conversation": f"USER: {clip_end(t['prompt'], 1500)}\n"
                            f"{clip_mid(t['transcript'], HEAD, TAIL)}",
            "last_assistant_message": clip_end(t["last_assistant_message"], LAST),
        }

    out = [case(*c, False, f"c{n:02d}") for n, c in enumerate(CASES, 1)]
    out.append(case(*TERMINATION, True, f"c{len(CASES) + 1:02d}-active"))
    return out


if __name__ == "__main__":
    cases = build()
    fire = sum(1 for c in cases if not c["want_ok"])
    print(f"{len(cases)} cases — {fire} should fire, {len(cases) - fire} should stay quiet")
    for c in cases:
        flag = "FIRE " if not c["want_ok"] else "quiet"
        act = " [active]" if c["stop_hook_active"] else ""
        print(f"  {c['id']:>11} {flag}{act:9}{'' if c['confident'] else ' ~':3} "
              f"{len(c['conversation']):>6}b  {c['src']:<12} {c['why'][:62]}")
