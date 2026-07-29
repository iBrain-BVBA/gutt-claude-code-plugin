#!/usr/bin/env python3
"""Run a variant × case × trial matrix through `claude -p` and collect the replies.

Every job is isolated: a job that raises is recorded as an error and the matrix keeps
going, and results are flushed to disk as they arrive. An earlier version of this
harness let one scoring exception propagate out of the worker and lost ten minutes of
completed calls, which is the whole reason for both.
"""
import concurrent.futures as cf
import json
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
BLOCKED = (
    "monthly spend limit",
    "usage limit reached",
    "hit your usage limit",
    "Credit balance is too low",
    "rate limit",
    "overloaded",
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
    if len(out) < 400 and any(m.lower() in out.lower() for m in BLOCKED):
        return f"<blocked {out[:200]}>"
    return out


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
               model=FAST_MODEL, allow_tools=False, out_path=None):
    """Run every (variant, case, trial) and return the scored records."""
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
                      allow_tools=allow_tools, cwd=run_dir)
            rec["raw"] = raw[:3000]
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
                    json.dump(results, open(out_path, "w", encoding="utf-8"), indent=1)
            print("." if rec.get("correct") else ("!" if rec.get("error") else "X"),
                  end="", flush=True)
            if n % 70 == 0:
                print(f" {n}")
    print()
    if out_path:
        json.dump(results, open(out_path, "w", encoding="utf-8"), indent=1)
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
