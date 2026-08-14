#!/usr/bin/env python3
"""Slice Claude Code session transcripts into turns.

A turn is one real user prompt plus everything the assistant did before the next one,
rendered compactly: user text, assistant prose, and a line per tool call with a
truncated result. Prompt hooks can see all of that (verified by probe), so a case
built this way is close to what the judge really receives.

Session logs live in ~/.claude/projects/<slugified-cwd>/<session-id>.jsonl.
"""
import json
import pathlib
import re

PROJECTS = pathlib.Path.home() / ".claude" / "projects"

# Injected or replayed text that is not a person typing.
SKIP_MARKERS = (
    "<local-command-",
    "<command-name>",
    "Caveat: The messages below were generated",
    "This session is being continued from",
)


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(
        b["text"]
        for b in content or []
        if isinstance(b, dict) and b.get("type") == "text"
    )


def strip_reminders(s):
    return re.sub(r"<system-reminder>.*?</system-reminder>", "", s, flags=re.S).strip()


def clip(s, n):
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[:n] + " …"


def clip_end(s, n):
    """Trim to the last paragraph break that fits, so nothing ends mid-sentence.

    A cut that lands mid-sentence reads to a judge as work left unfinished — which
    prompts routinely treat as a reason to stay quiet — so careless clipping
    manufactures the verdict being measured.
    """
    if len(s) <= n:
        return s
    cut = s[:n]
    for sep in ("\n\n", "\n", ". "):
        if sep in cut:
            trimmed = cut.rsplit(sep, 1)[0].rstrip()
            return trimmed + ("." if sep == ". " else "")
    return cut


def clip_mid(s, head, tail):
    """Elide the middle of a long turn, cutting only at line boundaries."""
    if len(s) <= head + tail:
        return s
    a = s[:head].rsplit("\n", 1)[0]
    b = s[-tail:].split("\n", 1)[-1]
    return f"{a}\n… [middle of this turn elided by the eval harness] …\n{b}"


def _is_real_prompt(rec):
    if rec.get("type") != "user":
        return False
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in content
    ):
        return False
    body = strip_reminders(text_of(content))
    return len(body) >= 3 and not any(m in body for m in SKIP_MARKERS)


def extract_turns(path):
    """Return a list of turn dicts for one session log."""
    recs = []
    for line in open(path, encoding="utf-8"):
        try:
            recs.append(json.loads(line))
        except ValueError:
            pass  # partial trailing write, or a record shape we do not need

    starts = [i for i, r in enumerate(recs) if _is_real_prompt(r)]
    turns = []
    for n, start in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(recs)
        rendered, last_text, tools, pending = [], "", [], {}
        for rec in recs[start + 1 : end]:
            msg = rec.get("message") or {}
            if rec.get("type") == "assistant":
                for b in msg.get("content") or []:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text" and b.get("text", "").strip():
                        last_text = b["text"]
                        rendered.append("ASSISTANT: " + clip(b["text"], 1400))
                    elif b.get("type") == "tool_use":
                        arg = b.get("input") or {}
                        gist = next(
                            (
                                arg[k]
                                for k in ("command", "file_path", "pattern", "query", "prompt")
                                if arg.get(k)
                            ),
                            "",
                        )
                        pending[b.get("id")] = b.get("name")
                        tools.append(b.get("name"))
                        rendered.append(f"  [tool {b.get('name')}] {clip(str(gist), 220)}")
            elif rec.get("type") == "user":
                for b in msg.get("content") or []:
                    if not (isinstance(b, dict) and b.get("type") == "tool_result"):
                        continue
                    body = b.get("content")
                    if isinstance(body, list):
                        body = " ".join(
                            x.get("text", "") for x in body if isinstance(x, dict)
                        )
                    name = pending.get(b.get("tool_use_id"), "tool")
                    rendered.append(f"  [result {name}] {clip(str(body), 320)}")
        if not rendered:
            continue
        turns.append(
            {
                "idx": n,
                "prompt": strip_reminders(text_of(recs[start]["message"]["content"])),
                "transcript": "\n".join(rendered),
                "last_assistant_message": last_text,
                "tools": tools,
                "size": sum(len(x) for x in rendered),
            }
        )
    return turns


def find_session(project_slug, session_prefix):
    """Locate one session log by directory slug and session-id prefix."""
    hits = sorted((PROJECTS / project_slug).glob(f"{session_prefix}*.jsonl"))
    if not hits:
        raise FileNotFoundError(
            f"no session {session_prefix}* under {project_slug}.\n"
            "Cases built this way read session transcripts recorded on the machine that "
            "ran them, so a suite using them only builds where its sessions were "
            "recorded. This is a missing corpus, not a broken checkout."
        )
    return hits[0]


if __name__ == "__main__":
    import sys

    for t in extract_turns(sys.argv[1]):
        print(f"#{t['idx']:>3} {t['size']:>7}b {len(t['tools']):>3} tools  {clip(t['prompt'], 90)}")
