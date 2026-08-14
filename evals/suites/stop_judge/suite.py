#!/usr/bin/env python3
"""Suite definition: how a Stop-judge case is presented, and how a reply is scored."""
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from lib.runner import parse_verdict  # noqa: E402
from lib.scoring import accuracy_table, per_case_table, shape_table  # noqa: E402

from . import corpus, variants as V  # noqa: E402

NAME = "stop-judge"
DESCRIPTION = "Does the Stop prompt hook fire on durable findings and stay quiet otherwise"

GATED = re.compile(r"\b(Lesson|Decision|WorkingAgreement)\b")


def variants():
    return V.all_variants()


def cases():
    return corpus.build()


def build_prompt(variant_text, case):
    """What the model receives: the turn, then the prompt with $ARGUMENTS filled in.

    The real judge gets the turn as message history and Claude Code prepends its own
    'Based on the conversation transcript above'; the harness folds both into one user
    message. The gap is identical for every variant, so comparisons hold.
    """
    payload = json.dumps({
        "session_id": "eval-" + case["id"],
        "transcript_path": "/tmp/eval.jsonl",
        # A fixture, not anyone's real checkout. This string reaches the model inside
        # the payload being scored, so a real path here measures one machine's layout.
        "cwd": "/home/eval/gutt-claude-code-plugin",
        "hook_event_name": "Stop",
        "stop_hook_active": case["stop_hook_active"],
        "last_assistant_message": case["last_assistant_message"],
        "background_tasks": [],
        "session_crons": [],
    })
    body = variant_text.replace("$ARGUMENTS", payload)
    return ("Based on the conversation transcript above.\n\n"
            f"<conversation>\n{case['conversation']}\n</conversation>\n\n{body}")


def score_reason(reason):
    """Mechanical checks on a fired reason: is it the payload the prompt asked for?"""
    if isinstance(reason, list):  # some replies return the bullets as an array
        reason = "\n".join(f"- {x}" for x in reason)
    text = reason if isinstance(reason, str) else json.dumps(reason)
    bullets = re.findall(r"^\s*[-*]\s*(.+)$", text, re.M)
    typed = [b for b in bullets if re.match(r"\**(Insight|Incident)\**\s*:", b)]
    over = [
        len(re.sub(r"^\**(Insight|Incident)\**\s*:\s*", "", b).split())
        for b in typed
        if len(re.sub(r"^\**(Insight|Incident)\**\s*:\s*", "", b).split()) > 10
    ]
    return {
        "chars": len(text),
        "names_skill": "memory-capture" in text,
        "bullets": len(bullets),
        "all_typed": bool(bullets) and len(typed) == len(bullets),
        "over_10w": over,
        "gated_type": bool(GATED.search(text)),
        "json_echo": bool(re.search(r'"ok"|\{"|"reason"', text)),
    }


def evaluate(case, raw):
    verdict = parse_verdict(raw)
    got = verdict.get("ok") if isinstance(verdict, dict) else None
    rec = {
        "want_ok": case["want_ok"],
        "got_ok": got,
        "correct": got is case["want_ok"],
        "parsed": verdict is not None,
    }
    if got is False:
        rec["reason"] = (verdict or {}).get("reason", "")
        rec["shape"] = score_reason(rec["reason"])
    return rec


def report(results, case_list, variant_map):
    order = list(variant_map)
    acc, summary = accuracy_table(results, case_list, variant_map, order)
    parts = [
        "VERDICT ACCURACY", acc, "",
        "REASON SHAPE ON TURNS THAT SHOULD FIRE",
        shape_table(results, case_list, variant_map, order), "",
        "PER CASE — trials correct",
        per_case_table(results, case_list, variant_map, order),
    ]
    return "\n".join(parts), summary
