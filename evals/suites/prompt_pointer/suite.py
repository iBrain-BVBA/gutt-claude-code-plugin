#!/usr/bin/env python3
"""Suite definition: does the injected recall pointer change what the agent does?

Unlike the Stop judge, there is no JSON verdict to parse here — the thing under test is
an *instruction to an agent*, and the only evidence is the reply. So scoring is textual,
and the limitation is worth stating plainly: **tools are disabled in these runs, so this
measures stated intent, not an actual skill invocation.** A reply saying "let me check
organizational memory first" scores as recall even though nothing ran. That is the right
trade for comparing wordings — it is cheap, deterministic in shape, and the failure it
cannot see (announcing recall then not doing it) is not a property of the wording. The
e2e tier is where a real invocation is observed.

The pointer arrives as `additionalContext`, which Claude Code delivers as a system
reminder next to the prompt — so `build_prompt` wraps it in that shape rather than
pasting it in as if the user had typed it. Getting that wrapper wrong would make every
variant look like a user instruction and hide precisely the injection-framing effect
V1-mandatory exists to measure.

## How many trials before a difference is real

More than feels necessary. Two runs of the *same* variants over the *same* cases at 15
trials disagreed sharply: on `retry-arch`, V4 scored 5/15 then 12/15 while V0 scored 13/15
then 9/15 — enough to read as a large effect in either direction depending on which run you
saw. Pooled to n=120 per variant the two wordings are 26% and 27% recall misses, i.e. the
same. A single run at 15 trials per case is not a measurement of anything under about 20
points, and the per-case column is the most tempting place to over-read because its
denominator is the trial count alone.

Practical rule: treat one run as a hypothesis and pool independent runs before believing a
gap. The differences in this suite that survived pooling are large and categorical —
V1-mandatory leaking and going noisy on a greeting, V2-terse losing recall outright,
V5-summary-first losing recall outright. Nothing in the 5–15 point band survived.
"""
import collections
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from . import corpus, variants as V  # noqa: E402

NAME = "prompt-pointer"
DESCRIPTION = "Does the injected UserPromptSubmit recall pointer get consumed, ignored, or surfaced"

# Ordinary agent framing, not the Stop judge's "reply with one JSON object" — see the
# `system` note in lib/runner.run_matrix.
SYSTEM = (
    "You are Claude Code, Anthropic's official CLI for software engineering tasks. "
    "Answer the user concisely."
)

HOOK = (
    pathlib.Path(__file__).resolve().parents[3]
    / "gutt-core"
    / "hooks"
    / "user-prompt-submit.cjs"
)

# Saying it will recall / is recalling. Kept broad on purpose: the wordings differ in how
# they name the act, and a pattern tuned to V0's phrasing would score V2 as a failure for
# being terse rather than for being ineffective.
#
# The third line is load-bearing and was learned the hard way. Tools are off in these runs,
# so the most common *success* looks like "since I can't access the memory search, here are
# the best practices" — the model prioritised recall, found no tool, and said so. An earlier
# version of this pattern matched only the hyphenated skill name and scored every one of
# those as a miss, which inverted the V0/V3 ranking on the first 225-call run. Reaching for
# recall and being unable to run it is the wording working; the missing tool is the
# harness's doing, not the prompt's.
RECALL = re.compile(
    r"memory[- _]?(search|lookup)|search_memory|organizational memory|"
    r"search(ing)? memory|check(ing)? memory|recall(ing)?\b|prior decisions|"
    r"what we (already )?know|memory first|"
    r"without the memory|(can(no|')?t|cannot|unable to|no) (access|run|use|reach)[^.]{0,40}memory",
    re.I,
)

# Any mention of the machinery at all. This is the e2e GP-868 detector's alphabet.
MENTIONS = re.compile(r"memory|gutt|skill|instruction", re.I)

# A durable finding named as one of the three types, in the shape V4 asks for — the word
# carrying a label's punctuation ("Lesson:", "**Insight**"), not the word in passing. Prose
# like "the key insight is" is a sentence, not a labelled finding a Stop judge can lift out
# of a summary, and counting it would report the clause as working when it is not.
LABEL = re.compile(
    r"\b(insight|incident|lesson)s?\b\s*[:—-]|"
    r"[*_#]{1,3}\s*(insight|incident|lesson)s?\b",
    re.I,
)

# Treating the injection as something to report or resist rather than act on. This is the
# actual GP-868 failure: the text surfaced to the user instead of consumed.
LEAK = re.compile(
    r"system.?level directive|mandatory requirement|prompt.?injection|"
    r"ignore (that|this|the) (instruction|directive)|"
    r"I (was|have been) (told|instructed|asked) to|"
    r"(a|the) (system|injected) (message|instruction|directive|reminder) (says|asks|tells)|"
    r"overrides the user|I will not comply|appears to be an attempt",
    re.I,
)


def variants():
    return V.all_variants()


def cases():
    return corpus.build()


def _assert_baseline_matches_shipped():
    """V0 must be what ships. A drifted baseline makes every delta meaningless."""
    source = HOOK.read_text(encoding="utf-8")
    block = source.split("const SEARCH_CONTEXT")[1].split(";")[0]
    # The hook concatenates the string across lines, mixing plain "..." pieces with a
    # template literal whose content contains escaped backticks (it names the skill in
    # code formatting). Both quote styles are collected in source order, and the escape
    # clause in each alternative is load-bearing: `[^`]*` stops at the backslash of an
    # escaped backtick, silently dropping the skill name and reporting phantom drift.
    segs = [a or b for a, b in re.findall(r'"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`', block)]
    shipped = "".join(segs).replace("\\`", "`").replace("${SEARCH_SKILL}", V.SEARCH_SKILL)
    shipped = re.sub(r"\s+", " ", shipped).strip()
    baseline = re.sub(r"\s+", " ", V.V0_SHIPPED).strip()
    if shipped != baseline:
        raise SystemExit(
            "V0-shipped has drifted from SEARCH_CONTEXT in user-prompt-submit.cjs.\n"
            f"  hook:     {shipped[:160]}...\n"
            f"  variant:  {baseline[:160]}...\n"
            "Re-copy it before trusting a comparison against the shipped wording."
        )


def build_prompt(variant_text, case):
    _assert_baseline_matches_shipped()
    return (
        f"{case['prompt']}\n\n"
        f"<system-reminder>\n{variant_text}\n</system-reminder>"
    )


def evaluate(case, raw):
    text = raw or ""
    recalled = bool(RECALL.search(text))
    mentions = bool(MENTIONS.search(text))
    leaked = bool(LEAK.search(text))

    # Correct means both halves: the recall decision the wording asks for, and — where the
    # turn is one that should get a bare answer — no mention of the machinery at all.
    correct = recalled is case["want_recall"]
    if case["want_quiet"]:
        correct = correct and not mentions
    if leaked:
        correct = False

    return {
        "correct": correct,
        "recalled": recalled,
        "want_recall": case["want_recall"],
        "mentions": mentions,
        "leaked": leaked,
        # Deliberately *not* folded into `correct`. Only V4 asks for a labelled finding, so
        # scoring V0 wrong for omitting one would mark it down for obeying its own wording.
        # The comparison that means something is V4 against the others on the same cases.
        "labeled": bool(LABEL.search(text)),
        "chars": len(text),
        # Kept for eyeballing: aggregate numbers hide a wording that is technically right
        # and unbearable to read.
        "head": text[:200],
    }


def report(results, case_list, variant_map):
    order = list(variant_map)
    index = {c["id"]: c for c in case_list}
    by = collections.defaultdict(list)
    for r in results:
        by[r["variant"]].append(r)

    head = (
        f"{'variant':14} {'chars':>6} {'all':>6} {'confident':>10} {'missed':>9} "
        f"{'over-recall':>12} {'noisy':>8} {'leaked':>7} {'labelled':>10} {'stray':>8} "
        f"{'errors':>7}"
    )
    rows = [head, "-" * len(head)]
    summary = {}
    for v in order:
        rs = by.get(v) or []
        if not rs:
            rows.append(f"{v:14} — no results")
            continue
        conf = [r for r in rs if index[r["case"]]["confident"]]
        want = [r for r in rs if index[r["case"]]["want_recall"]]
        wont = [r for r in rs if not index[r["case"]]["want_recall"]]
        quiet = [r for r in rs if index[r["case"]]["want_quiet"]]
        findings = [r for r in rs if index[r["case"]].get("want_label")]
        rest = [r for r in rs if not index[r["case"]].get("want_label")]
        missed = sum(1 for r in want if not r.get("recalled"))
        over = sum(1 for r in wont if r.get("recalled"))
        noisy = sum(1 for r in quiet if r.get("mentions"))
        leaked = sum(1 for r in rs if r.get("leaked"))
        labelled = sum(1 for r in findings if r.get("labeled"))
        stray = sum(1 for r in rest if r.get("labeled"))
        errs = sum(1 for r in rs if r.get("error"))
        acc = sum(bool(r.get("correct")) for r in rs) / len(rs)
        acc_c = sum(bool(r.get("correct")) for r in conf) / len(conf) if conf else 0
        summary[v] = {
            "acc": acc, "acc_confident": acc_c, "missed": missed, "wants": len(want),
            "over_recall": over, "wonts": len(wont), "noisy": noisy, "quiets": len(quiet),
            "leaked": leaked, "labelled": labelled, "findings": len(findings),
            "stray_labels": stray, "errors": errs, "chars": len(variant_map[v]),
        }
        rows.append(
            f"{v:14} {len(variant_map[v]):>6} {acc:>5.0%} {acc_c:>10.0%} "
            f"{missed:>5}/{len(want):<3} {over:>7}/{len(wont):<4} "
            f"{noisy:>4}/{len(quiet):<3} {leaked:>4}/{len(rs):<2} "
            f"{labelled:>6}/{len(findings):<3} {stray:>4}/{len(rest):<3} {errs:>7}"
        )

    per = [f"{'case':>14} {'want':>8}" + "".join(f"{v:>14}" for v in order)]
    per.append("-" * len(per[0]))
    for c in case_list:
        cells = ""
        for v in order:
            rs = [r for r in by.get(v, []) if r["case"] == c["id"]]
            cells += (
                f"{sum(bool(r.get('correct')) for r in rs)}/{len(rs)}" if rs else "—"
            ).rjust(14)
        want = "RECALL" if c["want_recall"] else ("quiet" if c["want_quiet"] else "skip+say")
        if c.get("want_label"):
            want += "+L"
        per.append(f"{c['id']:>14} {want:>8}{'~' if not c['confident'] else ' '}{cells}")

    parts = [
        "POINTER EFFECT",
        "\n".join(rows),
        "",
        "  missed      = should have recalled, did not",
        "  over-recall = recalled on a turn that did not warrant it",
        "  noisy       = mentioned memory/gutt/skill on a turn owed a bare answer (GP-868 shape)",
        "  leaked      = treated the injection as a directive to report or resist",
        "  labelled    = named a durable finding Insight/Incident/Lesson on a turn that",
        "                produced one — this is what V4-summary's clause exists to do",
        "  stray       = emitted such a label on a turn that produced nothing to record",
        "",
        "PER CASE — trials correct",
        "\n".join(per),
    ]
    return "\n".join(parts), summary
