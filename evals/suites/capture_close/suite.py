#!/usr/bin/env python3
"""Suite definition: after a capture fires, does the reply end with the work?

The Stop judge's own accuracy is `stop-judge`'s question. This one starts where that one
stops: the verdict has fired, the capture has been written, and what is measured is the
reply the user is then left looking at. There is no JSON verdict here — the thing under test
is an instruction to an agent — so scoring is textual, and three properties of the setup are
worth stating before any number is read.

**The capture is presented as already done.** This is the load-bearing design choice and the
first version got it wrong. Tools are off in these runs (`--allowedTools ""`), so a prompt
that merely tells the model to run `memory-capture` produces a reply with no capture in it
at all — measured, 4 of 4 on the shipped wording. Nothing was then buried, because nothing
had happened, and every variant scored the same for the wrong reason: the suite was
measuring the harness. So each case now carries the capture's *result* alongside the fired
reason, exactly as the agent would be holding it at the moment it writes the reply. That is
where the defect lives — fresh, salient capture detail competing with the work for the last
paragraph — and it is reachable without a single tool call.

**The feedback channel is approximated.** The real hook returns `decision: "block"` with a
`reason`, which Claude Code delivers as a system message continuing the turn. Here it
arrives as a `<system-reminder>` after the assistant's own message. The wrapper matters for
the same reason it does in `prompt_pointer`: pasted in as if the user had typed it, every
variant would read as a user instruction and the framing effect would vanish.

**Position, not presence, is the measurement.** Every variant can produce a reply that
mentions the work somewhere. `evaluate` therefore scores the *tail* — the last part of the
reply, which is what the user is actually left with — and asks whether the work is there and
the bookkeeping is not. A reply that discusses the work at length and then closes on "the
episode is queued" is the exact defect, and a presence check would score it as a pass.

## Reading the numbers

`closed_on_work` is the column that matters; the rest diagnose *how* a variant failed.
Expect the noise floor documented in `evals/README.md` to apply here too — one run at a few
trials buys a direction, not a decimal, and `V1-none` versus `V0-shipped` is the only gap
this suite was built to resolve at small n, because it should be categorical.
"""
import collections
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from . import corpus, variants as V  # noqa: E402

NAME = "capture-close"
DESCRIPTION = "After a fired capture, does the reply close on the work or on the bookkeeping"

# Ordinary agent framing. The Stop judge's "reply with one JSON object" system prompt would
# be the largest thing in this prompt and would decide the result — see run_matrix's `system`.
SYSTEM = (
    "You are Claude Code, Anthropic's official CLI for software engineering tasks. "
    "You are continuing a turn you have already answered."
)

# How much of the reply counts as "the tail" — what the user is left looking at. A fraction
# rather than a line count, because replies here vary from a few lines to several
# paragraphs, and the bottom third of a long reply is the comparable thing to the bottom
# third of a short one. Floored so a terse reply still has a meaningful tail.
TAIL_FRACTION = 0.35
TAIL_FLOOR = 220

# Preamble the style forbids, anchored to the start. Matched on the first non-blank line
# only: "Let me know" further down is a closing pleasantry, scored separately, and matching
# it here would double-count one failure as two.
PREAMBLE = re.compile(
    r"^\s*(great|sure|certainly|absolutely|of course|good (question|catch))\b|"
    r"^\s*(let me|i'?ll|i will|i'?m going to|now (let me|i'?ll))\b|"
    r"^\s*(looking at|to answer|as requested|happy to)\b",
    re.I,
)

# Closing pleasantries, anchored to the end.
PLEASANTRY = re.compile(
    r"(let me know|hope (this|that) helps|happy to (clarify|help|assist)|"
    r"feel free to (ask|reach)|anything else|if you (have|need) any (other|further))"
    r"[^.!?]*[.!?]?\s*$",
    re.I,
)

# Framing the capture as a detour. This is the failure the "not an interruption" clause
# exists for, and it survives even in replies that otherwise close correctly.
APOLOGY = re.compile(
    r"returning to|back to (the|your) (work|question|task)|"
    r"(work|task) (this|that) interrupted|"
    r"(sorry|apolog\w+) for (the )?(detour|interruption|delay)|"
    r"(before|now that) (i|we) (was|were|had been) interrupted",
    re.I,
)

# A concrete next action. Not folded into `correct`: not every turn has one open, and a
# variant that manufactures one to satisfy the shape is worse than one that ends.
#
# Both the labelled form and the sentence form are matched. An earlier version required a
# line beginning "Next:" and scored 0 across every variant and case, including replies whose
# last sentence was "the next action is verifying the three other suites" — which is the
# thing being counted, written as prose. A diagnostic that never fires measures nothing.
NEXT_ACTION = re.compile(
    r"^\s*(next|next step|next action|to do next)\b\s*[:—-]|"
    r"\bnext (action|step)\b[^.]{0,40}\bis\b|"
    r"^\s*next[,:]? (run|open|check|try|start|re-?run)\b",
    re.I | re.M,
)


def variants():
    return V.all_variants()


def cases():
    return corpus.build()


def build_prompt(variant_text, case):
    """The turn at the moment the closing reply is written.

    Four parts, in the order the model would have met them: the user's request, its own
    finished answer, the hook's feedback carrying the variant, and the capture it has just
    completed. The last of those is what makes the measurement possible — see the module
    docstring — and it is deliberately verbose, because a one-line result is not a temptation.
    """
    reason = case["reason"] if not variant_text else f"{case['reason']}\n\n{variant_text}"
    return (
        f"The user asked:\n\n{case['prompt']}\n\n"
        f"You replied:\n\n{case['answer']}\n\n"
        f"<system-reminder>\nStop hook feedback: {reason}\n</system-reminder>\n\n"
        f"You then ran the capture. Its result:\n\n{case['capture_result']}\n\n"
        "Write the rest of your reply to the user."
    )


def _tail(text):
    cut = max(TAIL_FLOOR, int(len(text) * TAIL_FRACTION))
    return text[-cut:] if len(text) > cut else text


def _echoed(answer, reply):
    """Does the reply paste a long stretch of the original answer back down?

    Sentence-level rather than fuzzy: any sentence of 60+ characters reproduced verbatim
    from the answer is an echo. Short shared sentences are not evidence — the work has a
    vocabulary and the summary is supposed to use it — and 60 characters is comfortably
    above where two independent sentences about the same fact collide by chance.
    """
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", answer) if len(s.strip()) >= 60]
    return sum(1 for s in sentences if s in reply) >= 2


def evaluate(case, raw):
    text = raw or ""
    tail = _tail(text)
    work = re.compile(case["work"], re.I)
    book = re.compile(case["bookkeeping"], re.I)

    # The defect, precisely: the last thing the user reads is the bookkeeping rather than
    # the work. Presence of the work in the tail is necessary but not sufficient — a tail
    # that covers the fix and then signs off on "the episode is queued" is the failure, and
    # only the relative position distinguishes it from a summary that mentions the capture
    # in passing on its way to the work.
    closed_on_work = bool(work.search(tail)) and not _book_dominates(tail, work, book)

    # The capture must still be reported. Dropping it silently is a different failure from
    # burying the work, and a variant that scores well by never mentioning the capture has
    # not solved the problem — it has hidden the write from the user.
    reported = bool(book.search(text))

    preamble = bool(PREAMBLE.search(text.lstrip()))
    pleasantry = bool(PLEASANTRY.search(text))
    apology = bool(APOLOGY.search(text))
    echoed = _echoed(case["answer"], text)

    return {
        "correct": closed_on_work and reported and not (preamble or pleasantry or apology or echoed),
        "closed_on_work": closed_on_work,
        "reported": reported,
        "preamble": preamble,
        "pleasantry": pleasantry,
        "apology": apology,
        "echoed": echoed,
        "has_next": bool(NEXT_ACTION.search(text)),
        "chars": len(text),
        # For eyeballing. The tail is the disputed territory, so it is the useful excerpt —
        # a head excerpt would show every variant looking equally reasonable.
        "tail": tail[-300:],
    }


def _book_dominates(tail, work, book):
    """Is the bookkeeping the *last* thing in the tail, with the work above it?"""
    w = [m.start() for m in work.finditer(tail)]
    b = [m.start() for m in book.finditer(tail)]
    if not b:
        return False
    if not w:
        return True
    return max(b) > max(w)


def report(results, case_list, variant_map):
    order = list(variant_map)
    index = {c["id"]: c for c in case_list}
    by = collections.defaultdict(list)
    for r in results:
        by[r["variant"]].append(r)

    head = (
        f"{'variant':17} {'chars':>6} {'all':>6} {'confident':>10} {'closed':>9} "
        f"{'unreported':>11} {'echoed':>8} {'apology':>8} {'preamble':>9} "
        f"{'pleasantry':>11} {'next':>7} {'errors':>7}"
    )
    rows = [head, "-" * len(head)]
    summary = {}
    for v in order:
        rs = by.get(v) or []
        if not rs:
            rows.append(f"{v:17} — no results")
            continue
        conf = [r for r in rs if index[r["case"]]["confident"]]
        closed = sum(1 for r in rs if r.get("closed_on_work"))
        unreported = sum(1 for r in rs if not r.get("reported"))
        echoed = sum(1 for r in rs if r.get("echoed"))
        apology = sum(1 for r in rs if r.get("apology"))
        preamble = sum(1 for r in rs if r.get("preamble"))
        pleasantry = sum(1 for r in rs if r.get("pleasantry"))
        nxt = sum(1 for r in rs if r.get("has_next"))
        errs = sum(1 for r in rs if r.get("error"))
        acc = sum(bool(r.get("correct")) for r in rs) / len(rs)
        acc_c = sum(bool(r.get("correct")) for r in conf) / len(conf) if conf else 0
        mean_chars = round(sum(r.get("chars", 0) for r in rs) / len(rs))
        summary[v] = {
            "acc": acc, "acc_confident": acc_c, "closed_on_work": closed,
            "unreported": unreported, "echoed": echoed, "apology": apology,
            "preamble": preamble, "pleasantry": pleasantry, "has_next": nxt,
            "errors": errs, "n": len(rs), "mean_reply_chars": mean_chars,
            "variant_chars": len(variant_map[v]),
        }
        rows.append(
            f"{v:17} {len(variant_map[v]):>6} {acc:>5.0%} {acc_c:>10.0%} "
            f"{closed:>5}/{len(rs):<3} {unreported:>7}/{len(rs):<3} "
            f"{echoed:>4}/{len(rs):<3} {apology:>4}/{len(rs):<3} "
            f"{preamble:>5}/{len(rs):<3} {pleasantry:>7}/{len(rs):<3} "
            f"{nxt:>3}/{len(rs):<3} {errs:>7}"
        )

    per = [f"{'case':>18} " + "".join(f"{v:>18}" for v in order)]
    per.append("-" * len(per[0]))
    for c in case_list:
        cells = ""
        for v in order:
            rs = [r for r in by.get(v, []) if r["case"] == c["id"]]
            cells += (
                f"{sum(bool(r.get('correct')) for r in rs)}/{len(rs)}" if rs else "—"
            ).rjust(18)
        per.append(f"{c['id']:>18}{'~' if not c['confident'] else ' '}{cells}")

    parts = [
        "CLOSING THE TURN AFTER A FIRED CAPTURE",
        "\n".join(rows),
        "",
        "  closed     = the tail of the reply is the work, not the bookkeeping — the",
        "               measurement this suite exists for",
        "  unreported = never mentioned the capture at all; hiding the write is its own failure",
        "  echoed     = pasted two or more long sentences of the original answer back down",
        "  apology    = framed the capture as an interruption of the work",
        "  next       = offered one concrete next action (diagnostic, not scored)",
        "",
        "PER CASE — trials correct   (~ = label held less firmly)",
        "\n".join(per),
    ]
    return "\n".join(parts), summary
