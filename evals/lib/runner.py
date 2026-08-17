#!/usr/bin/env python3
"""Run a variant × case × trial matrix through `claude -p` and collect the replies.

Every job is isolated: a job that raises is recorded as an error and the matrix keeps
going, and results are flushed to disk as they arrive. An earlier version of this
harness let one scoring exception propagate out of the worker and lost ten minutes of
completed calls, which is the whole reason for both.
"""
import concurrent.futures as cf
import json
import os
import re
import subprocess
import tempfile
import threading

FAST_MODEL = "claude-haiku-4-5-20251001"
# A prompt hook is a single-turn JSON call, so the harness keeps the system prompt to
# that and nothing more. Note that --system-prompt replaces the default but does not
# suppress CLAUDE.md auto-discovery — which is what `judge_cwd` below is for.
JUDGE_SYS = "You evaluate a hook condition for Claude Code and reply with a single JSON object."


def judge_cwd():
    """A scratch directory outside the repo to run judge calls from.

    CLAUDE.md is discovered from the working directory upward, so a call made from the
    repo hands the judge this project's instructions on top of the prompt under test.
    Running from a temp directory sheds the project CLAUDE.md and the project
    `.claude/settings.json`; the user-level `~/.claude/CLAUDE.md` still loads and is the
    same for every variant.

    What this does *not* shed is the user-scope plugin registration in
    `~/.claude/plugins/known_marketplaces.json` — that is inherited whatever the cwd,
    measured. Hooks are off in these children anyway, so it does not affect the judge; it
    is the e2e tier that the registration breaks.

    Hooks are disabled by the inline `--settings` in `ask`, not from here. An earlier
    version wrote a `settings.json` into this directory, which did nothing twice over:
    nothing referenced the path, and a bare `./settings.json` is not a file Claude Code
    loads (project settings live at `.claude/settings.json`). The inline form does work —
    measured, `--settings '{"disableAllHooks": true}'` gives zero hook completions and
    zero prompt-hook dispatches where an unflagged run gives one of each.
    """
    return tempfile.mkdtemp(prefix="gutt-eval-")


# The CLI reports quota and availability problems on stdout with exit 0, so they arrive
# looking exactly like a model reply. Left undetected they score as wrong answers: one
# run lost two variants to "hit your org's monthly spend limit" and reported them as 5%
# and 2% accuracy on prompts that had measured 81% twenty minutes earlier. A run that
# hits one of these is void, not bad — so `ask` flags it and `run_matrix` stops.
# Matched as patterns, not bare substrings, and this matters more than it looks. The
# earlier list contained plain "rate limit" and "overloaded", which a *model reply* can
# legitimately contain — a prompt-pointer case asking about rate limiting drew the answer
# "so I can implement rate limiting appropriately", and the whole run was declared void.
# The failure inverts the one this guard exists for: a good run reported as no run.
# So each pattern now requires the wording an *error* uses, not the topic.
BLOCKED = (
    r"monthly spend limit",
    r"usage limit reached",
    r"hit your usage limit",
    r"credit balance is too low",
    r"rate[ _]limit(_error)?\b[^.]{0,40}\b(exceed|reach|hit|retry|429)",
    # Bare "429" is not enough — "return 429 with a Retry-After header" is ordinary advice
    # about rate limiting, and it tripped this guard in self-check. Error framing is required.
    r"error[^.]{0,20}\b429\b",
    r"(api|server|service)[^.]{0,20}overloaded|overloaded_error",
    r"quota (exceeded|exhausted)",
)


def ask(prompt, model=FAST_MODEL, system=JUDGE_SYS, allow_tools=False, timeout=180, cwd=None):
    """One `claude -p` call. Returns stdout, or a `<marker>` string on failure."""
    cmd = ["claude", "-p", "--model", model, "--strict-mcp-config",
           "--settings", '{"disableAllHooks": true}']
    if system:
        cmd += ["--system-prompt", system]
    if not allow_tools:
        cmd += ["--allowedTools", ""]
    try:
        r = subprocess.run(cmd, input=prompt, capture_output=True, text=True,
                           timeout=timeout, cwd=cwd)
    except subprocess.TimeoutExpired:
        return "<timeout>"
    out = r.stdout.strip()
    if not out:
        return f"<empty exit={r.returncode} {r.stderr.strip()[:200]}>"
    if is_blocked(out):
        return f"<blocked {out[:200]}>"
    return out


def is_blocked(out):
    """Does this stdout look like a quota/availability wall rather than a reply?

    Both conditions must hold. The length bound alone was the original guard and is kept
    as the second line of defence: a real wall message is short, an agent's answer that
    happens to quote a 429 is not. Unit-testable on purpose — `python3 -m evals.lib.runner`
    self-checks it, because a regression here is invisible until it voids a paid run.
    """
    return len(out) < 400 and any(re.search(p, out, re.I) for p in BLOCKED)


def parse_verdict(raw):
    """Pull the {"ok": …} object out of whatever the model wrapped it in."""
    m = re.search(r'\{[^{}]*"ok"\s*:\s*(true|false).*', raw or "", re.S)
    if not m:
        return None
    frag = m.group(0)
    for end in range(len(frag), 0, -1):
        try:
            obj = json.loads(frag[:end])
        except ValueError:
            continue
        return obj if isinstance(obj, dict) else None
    return None


def run_matrix(variants, cases, build_prompt, evaluate, trials=1, workers=8,
               model=FAST_MODEL, allow_tools=False, out_path=None, system=JUDGE_SYS,
               meta=None):
    """Run every (variant, case, trial) and return the scored records.

    `system` is a suite's choice, not a constant: JUDGE_SYS frames the model as a hook
    evaluator returning one JSON object, which is right for the Stop judge and wrong for
    any suite measuring what an *agent* does with injected context — there the framing
    would be the largest thing in the prompt and would decide the result.

    `meta`, when given, is embedded in the raw file ({"meta": …, "records": […]})
    so a round stays self-describing after the shell history is gone. Without it the
    file is a bare list, the shape every round written before meta existed has.
    """

    def dump(results):
        path = out_path
        if not path:
            return
        payload = {"meta": meta, "records": results} if meta else results
        # Written beside the target and moved into place. Opening the target with
        # "w" truncates the last good snapshot before the new JSON is complete, so
        # a run killed mid-dump left a file that no longer parsed — destroying the
        # very records the periodic flush exists to preserve, and taking the round's
        # metadata with them. os.replace is atomic within a filesystem.
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=1)
        os.replace(tmp, path)
    jobs = [(v, c, t) for v in variants for c in cases for t in range(trials)]
    print(f"{len(jobs)} calls — {len(variants)} variants x {len(cases)} cases x {trials} trials")
    results, lock = [], threading.Lock()
    halted = threading.Event()
    run_dir = judge_cwd()
    print(f"judge cwd: {run_dir}")

    def work(job):
        vname, case, trial = job
        rec = {"variant": vname, "case": case["id"], "trial": trial}
        if halted.is_set():
            rec.update({"error": "skipped — run halted", "skipped": True})
            return rec
        try:
            raw = ask(build_prompt(variants[vname], case), model=model,
                      system=system, allow_tools=allow_tools, cwd=run_dir)
            # Stored in full. Checker fixes are validated by re-scoring stored records
            # offline, so a record whose reply is cut short is permanently unverifiable
            # — scoring here always saw the full reply, only the record lied. A 6000-char
            # cap did exactly that to every long reply in every round it touched. Raws
            # are gitignored, so the cost is disk.
            rec["raw"] = raw
            if raw.startswith("<blocked"):
                halted.set()
                rec.update({"error": raw, "blocked": True})
                return rec
            rec.update(evaluate(case, raw))
        except Exception as exc:  # a bad reply must cost one cell, never the matrix
            rec.update({"error": f"{type(exc).__name__}: {exc}", "correct": False})
        return rec

    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for n, rec in enumerate(ex.map(work, jobs), 1):
            with lock:
                results.append(rec)
                if out_path and n % 20 == 0:
                    dump(results)
            print("." if rec.get("correct") else ("!" if rec.get("error") else "X"),
                  end="", flush=True)
            if n % 70 == 0:
                print(f" {n}")
    print()
    if out_path:
        dump(results)
        print(f"-> {out_path}")
    blocked = [r for r in results if r.get("blocked")]
    if blocked:
        skipped = sum(1 for r in results if r.get("skipped"))
        print(f"\n*** RUN VOID — quota or availability wall hit: {blocked[0]['error']}")
        print(f"*** {skipped} calls skipped. Do not read the tables below as a result.")
    errs = [r for r in results if r.get("error") and not r.get("skipped")]
    if errs:
        print(f"{len(errs)} job errors, e.g. {errs[0]['error'][:160]}")
    return results


if __name__ == "__main__":
    # Free self-check of the one heuristic here that costs money when it is wrong.
    WALLS = [
        "You've hit your org's monthly spend limit. Contact your admin.",
        "Usage limit reached. Your limit will reset at 3pm.",
        "Claude AI usage limit reached|1799884800",
        "Your credit balance is too low to access the Anthropic API.",
        "API Error: 429 rate_limit_error — please retry after 60s",
        "Rate limit exceeded. Try again later.",
        "API Error: Overloaded",
        "quota exceeded for this organization",
    ]
    # Replies a suite legitimately produces. Every one of these voided a run once, or would.
    REPLIES = [
        "Please provide more details about your project so I can implement rate limiting.",
        "Throttle at the gateway — it protects the app before a request costs you anything.",
        "Return 429 with a Retry-After header so clients back off instead of hammering you.",
        "Rate limiting belongs at the edge; the app should stay unaware of quota policy.",
        "The pool was overloaded because every worker opened its own connection.",
    ]
    bad = [w for w in WALLS if not is_blocked(w)]
    noise = [r for r in REPLIES if is_blocked(r)]
    for w in bad:
        print(f"MISSED WALL   {w}")
    for r in noise:
        print(f"FALSE POSITIVE {r}")
    print("BLOCKED patterns OK" if not bad and not noise else "BLOCKED patterns BROKEN")
    raise SystemExit(1 if bad or noise else 0)
