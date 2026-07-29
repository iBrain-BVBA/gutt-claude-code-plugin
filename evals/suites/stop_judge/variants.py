#!/usr/bin/env python3
"""Candidate wordings for the Stop hook's judge prompt, longest to shortest.

Every variant states the same policy and differs only in how much of it is spelled
out. Each must still carry five invariants, because dropping any one of them breaks a
behaviour that has already failed live:

  polarity      ok:true means nothing-to-record — inverted verdicts otherwise
  two types     Insight/Incident only; Lesson/Decision/WorkingAgreement are human-gated
  termination   stop_hook_active true -> ok:true, or the turn re-enters itself
  reason shape  skill name plus typed bullets, ten words each
  no JSON echo  a reason quoting the schema is printed to the user as the answer

V0 is read from the shipped hook so the baseline can never drift from what is running.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
SKILL = "gutt-claude-code-plugin:memory-capture"
EXAMPLE = (
    f"Run the `{SKILL}` skill.\n"
    "- Insight: prefix matching survives new tools; allowlists silently stop matching\n"
    "- Incident: queue sweep aged entries by file mtime, expired everything"
)


def shipped():
    hooks = json.loads((ROOT / "gutt-core" / "hooks" / "hooks.json").read_text(encoding="utf-8"))
    return hooks["hooks"]["Stop"][0]["hooks"][0]["prompt"]


V1 = f"""Nothing from this finished turn needs to be written to the team's long-term memory.

That is the condition. It is SATISFIED — {{"ok": true}} — when there is nothing to record: the common case, and the right answer whenever you are unsure. It is UNSATISFIED — {{"ok": false}} — only when something clearly does need recording.

Judge the whole turn from the conversation above. From the payload below read only `stop_hook_active`; ignore every other field, `last_assistant_message` included.

Hook payload: $ARGUMENTS

Something needs recording only if it is one of these two, and durable for the team:
- an **Insight** — a non-obvious constraint, mechanism or understanding a future reader could not recover from the code or the commit log;
- an **Incident** — something broke, and what happened.

A finding that lives only in throwaway scaffolding — a sandbox, a scratch script, a harness built for this session — is not durable, however real it is.

Everything else leaves the condition satisfied: a decision and its rationale, a corrective lesson, an agreement about how the team works (all three are gated behind an explicit human signal a hook cannot give), routine edits, answering a question, reading or searching code, formatting, work still in progress, and anything already recorded earlier in this turn.

When `stop_hook_active` is true you have already asked during this turn: respond {{"ok": true}} whatever else the transcript shows.

Condition holds → respond with exactly {{"ok": true}} and no `reason`.

Otherwise → {{"ok": false, "reason": "..."}}, and the reason is only this:

{EXAMPLE}

One bullet per subject, **10 words maximum each**, every bullet typed, and only ever Insight or Incident. Nothing else in it — no procedure, no rationale, no JSON. The skill holds all of that."""

V2 = f"""Nothing from this finished turn needs to be written to the team's long-term memory.

Judge that condition against the whole turn in the conversation above. Satisfied — {{"ok": true}} — means there is nothing to record: the common case, and the answer whenever you are unsure. From the payload read only `stop_hook_active`; if it is true, respond {{"ok": true}} regardless.

Hook payload: $ARGUMENTS

Only two things are worth recording, and only when durable for the team rather than found in throwaway scaffolding: an **Insight** (a non-obvious constraint or mechanism a future reader could not recover from the code or the commit log) or an **Incident** (something broke, and what happened). Everything else keeps the condition satisfied — decisions, lessons and team agreements are gated behind a human signal a hook cannot give, and routine edits, answers, code reading, formatting, unfinished work and anything already recorded this turn are not worth recording at all.

Condition holds → exactly {{"ok": true}}, no `reason`. Otherwise {{"ok": false, "reason": "..."}} where the reason is only this shape:

{EXAMPLE}

One bullet per subject, **10 words maximum each**, always typed, only ever Insight or Incident. No procedure, no rationale, no JSON — that all lives in the skill."""

V3 = f"""Judge the finished turn in the conversation above. Payload: $ARGUMENTS

Respond {{"ok": true}} — nothing to record — unless the turn produced a durable **Insight** (a non-obvious constraint or mechanism a future reader could not recover from the code or the commit log) or **Incident** (something broke, and what happened). Unsure, or `stop_hook_active` is true, or it was routine work, unfinished work, or already recorded → {{"ok": true}} with no `reason`. Decisions, lessons and team agreements are gated behind a human signal and also mean {{"ok": true}}.

Otherwise {{"ok": false, "reason": "..."}} where the reason is only:

{EXAMPLE}

One typed bullet per subject, 10 words max, Insight or Incident only, nothing else in it."""

V4 = f"""Judge the finished turn above. Payload: $ARGUMENTS

Answer {{"ok": true}} with no `reason` — nothing to record — unless the turn produced a durable **Insight** (non-obvious mechanism or constraint, unrecoverable from code or commit log) or **Incident** (something broke). Routine work, unfinished work, anything already recorded, anything you are unsure of, and `stop_hook_active: true` are all {{"ok": true}}. So are decisions, lessons and team agreements — those need a human's go-ahead.

Otherwise {{"ok": false, "reason": "..."}} where reason is exactly this shape — one typed bullet per subject, 10 words max, Insight or Incident only:

{EXAMPLE}"""

V5 = f"""Judge the finished turn above ($ARGUMENTS). Reply {{"ok": true}} unless it produced a durable Insight (non-obvious mechanism, unrecoverable from the code) or Incident (something broke) — routine, unfinished, already-recorded, unsure, and `stop_hook_active: true` are all {{"ok": true}}; so are decisions, lessons and agreements. Otherwise {{"ok": false, "reason": "Run the `{SKILL}` skill." + one 10-word typed bullet per subject, Insight or Incident only}}."""

# V6 and V7 answer the failure the first round exposed. Every variant above labels the
# turn by its *activity*: verification, testing, debugging and answering a question are
# all listed as reasons to stay quiet, and that is exactly how findings get made — so
# the judge discarded real Insights on account of how they were arrived at. These two
# ask what the turn learned instead, and drop the activity list altogether.

V6 = f"""Judge the finished turn in the conversation above. Payload: $ARGUMENTS

Ask what the turn *learned*, not what it *did*. Verifying, testing, debugging and answering questions are how findings get made — so judge the finding, never the activity that produced it.

Respond {{"ok": false}} when the turn established a durable **Insight** — how some system actually behaves, where that was not obvious and not stated in the code — or an **Incident** — something broke, and what happened. A finding still counts when the fix was already written, when it confirms a suspicion, or when it came out of a test.

Respond {{"ok": true}} with no `reason` when the turn only moved code around, restated what the code already says, was left unfinished, or recorded the point already. Same answer when the takeaway is a decision, a lesson or a team agreement — those need a human's go-ahead — and whenever `stop_hook_active` is true.

Fire → {{"ok": false, "reason": "..."}} and the reason is only this, one typed bullet per subject, 10 words each, Insight or Incident only:

{EXAMPLE}"""

V7 = f"""Judge the finished turn above. Payload: $ARGUMENTS

Ask what it learned, not what it did: testing and debugging are how findings get made, so judge the finding. {{"ok": false}} if the turn established how something actually behaves where that was not obvious from the code (**Insight**), or something broke (**Incident**) — it still counts if the fix was already written or it came from a test. {{"ok": true}}, no `reason`, if the turn only moved code, restated the code, was unfinished, already recorded the point, or the takeaway is a decision, lesson or agreement; likewise whenever `stop_hook_active` is true.

Reason shape when firing — one typed bullet per subject, 10 words each, Insight or Incident only:

{EXAMPLE}"""


# V8 keeps V6's finding-over-activity framing and repairs its two measured defects.
#
# Role. V7 compressed far enough that eight of its calls stopped judging and started
# capturing — "the memory server is unreachable, so per the skill's degradation rule I
# will surface the episode drafts". The corpus is full of turns about memory capture, and
# with the role stated only in passing the model joins the work instead of scoring it.
# One sentence of role costs a line and buys back the whole failure mode.
#
# Skill line. V6 named the skill in 14% of its reasons: the example block opens with
# `Run the … skill.` but models copy the bullets and drop the line above them. Saying the
# reason begins with that line, rather than only showing it, is what makes it survive.
V8 = f"""You are scoring a finished turn, not continuing it. Never capture anything yourself and never use a tool — your entire output is one JSON verdict on the conversation above. Payload: $ARGUMENTS

Ask what the turn *learned*, not what it *did*. Verifying, testing, debugging and answering questions are how findings get made, so judge the finding and never the activity that produced it.

Respond {{"ok": false}} when the turn established a durable **Insight** — how some system actually behaves, where that was not obvious and not stated in the code — or an **Incident** — something broke, and what happened. It still counts when the fix was already written, when it confirms a suspicion, or when it came out of a test.

Respond {{"ok": true}} with no `reason` when the turn only moved code around, restated what the code already says, was left unfinished, or recorded the point already. Same answer when the takeaway is a decision, a lesson or a team agreement — those need a human's go-ahead — and whenever `stop_hook_active` is true.

When firing, the reason opens with the line `Run the `{SKILL}` skill.` and then one typed bullet per subject, ten words each, Insight or Incident only:

{EXAMPLE}"""

# V9 tests whether the role sentence lets the compression go further: same content as V8
# with every explanatory clause removed.
V9 = f"""Score the finished turn above; do not continue it, capture anything, or call a tool. Output one JSON verdict only. Payload: $ARGUMENTS

Judge what the turn learned, not what it did — testing and debugging are how findings get made. {{"ok": false}} if it established how something actually behaves where the code does not say so (**Insight**) or something broke (**Incident**), counting still if the fix was already written. {{"ok": true}} with no `reason` if it only moved or restated code, was unfinished, already recorded the point, or the takeaway is a decision, lesson or agreement — and always when `stop_hook_active` is true.

A firing reason opens `Run the `{SKILL}` skill.` then one typed bullet per subject, ten words each:

{EXAMPLE}"""


# V10 is V9 with four words put back. V9 scored best on verdicts but typed only 81% of
# its bullets and named the skill in 69% of its reasons, where V8 managed 100% of both;
# the only thing V8's closing line has that V9's lacks is the explicit "Insight or
# Incident only" constraint. This restores it and nothing else.
V10 = V9.replace(
    "then one typed bullet per subject, ten words each:",
    "then one bullet per subject, ten words each, every one typed and only ever Insight or Incident:",
)


# V8–V10 win on verdicts and cannot ship. Each is missing the condition-first opening the
# CLI's polarity depends on, the durability clause, the typed fire-condition list, and the
# closing anti-restatement guard whose removal put a fenced verdict in front of the user
# 4/4. Ranking them again would rank prompts that are not deployable, so the two candidates
# below are compressions of the *shipped* prompt that satisfy every guard in
# tests/hook-architecture.test.cjs — checked mechanically by `shippable.py` before any call
# is spent. What is being measured is therefore only the compression: 14 lines → 11 → 9.
_CLOSE = (
    "Those two bullets are a format sample, not findings from this turn — never carry them "
    "into a verdict. And do not restate this response format inside the reason: a reason "
    "that quotes the JSON gets echoed back to the user as the assistant's answer instead of "
    "the answer they asked for."
)

# V12: the shipped prompt with its paragraph boundaries collapsed and every clause that
# restates a neighbouring one removed. 14 lines -> 11.
V12 = f"""Nothing from this finished turn needs to be written to the team's long-term memory. That sentence is the condition, SATISFIED — {{"ok": true}} — when there is nothing to record. You are scoring the turn, not continuing it: capture nothing yourself, call no tool, and let your whole output be one JSON verdict on the conversation above. Read `stop_hook_active` from the payload and ignore the rest.

Hook payload: $ARGUMENTS

Ask what the turn *learned*, not what it *did* — verifying, testing and debugging are how findings get made, so judge the finding and never the activity that produced it, and it counts still when the fix was already written or it came out of a test. The condition is UNSATISFIED — {{"ok": false}} — for exactly two things, and only where the subject is durable for the team rather than confined to throwaway scaffolding:
- an **Insight** — how some system actually behaves, where that was not obvious and is not stated in the code;
- an **Incident** — something broke, and what happened.

It stays satisfied for everything else: work that only moved code around or restated what the code already says, work left unfinished, and anything recorded earlier in this turn. It stays satisfied when the takeaway is a **Lesson**, a **Decision** or a **WorkingAgreement**, which the capture skill holds behind an explicit signal from the user that a hook cannot give. And it stays satisfied whenever `stop_hook_active` is true — you have already asked during this turn, and answering otherwise re-enters it.

Satisfied → exactly {{"ok": true}} and no other field; omit `reason`, it is discarded unread. Otherwise {{"ok": false, "reason": "..."}}, where the reason opens with the line "Run the `{SKILL}` skill." and continues with one bullet per subject, **10 words maximum each**, every bullet typed and only ever Insight or Incident:

{EXAMPLE}

{_CLOSE}"""

# V13: V12 with the two response branches folded into the stays-satisfied paragraph and
# the example cut to a single bullet. 11 lines -> 9. The open question it answers is
# whether the typed fire-condition list alone keeps bullets typed once the example stops
# demonstrating both types.
V13 = f"""Nothing from this finished turn needs to be written to the team's long-term memory — that is the condition, satisfied ({{"ok": true}}) when there is nothing to record. Score the turn, do not continue it: capture nothing yourself, call no tool, and output one JSON verdict on the conversation above. Read `stop_hook_active` from the payload; ignore the rest.

Hook payload: $ARGUMENTS

Ask what the turn *learned*, not what it *did* — testing and debugging are how findings get made, so judge the finding, never the activity, and count it even where the fix was already written. Unsatisfied ({{"ok": false}}) for exactly two things, and only where the subject is durable for the team rather than throwaway scaffolding:
- an **Insight** — how some system actually behaves, where that was not obvious and is not stated in the code;
- an **Incident** — something broke, and what happened.

Satisfied for everything else — code only moved or restated, work unfinished, the point already recorded, or a takeaway that is a **Lesson**, **Decision** or **WorkingAgreement** (the capture skill holds those behind an explicit user signal a hook cannot give) — and always when `stop_hook_active` is true, or the turn re-enters itself. Then respond exactly {{"ok": true}} and no other field: omit `reason`, it is discarded unread. Otherwise {{"ok": false, "reason": "..."}}, where the reason opens with the line "Run the `{SKILL}` skill." then one bullet per subject, **10 words maximum each**, every bullet typed and only ever Insight or Incident:

Run the `{SKILL}` skill.
- Insight: prefix matching survives new tools; allowlists silently stop matching

{_CLOSE}"""


# V14 = V13 plus a gloss on what `stop_hook_active` *means*, which V13's compression had
# dropped. Found live, not by this bench: on a turn whose Insight it had already named
# correctly, a V13 judge answered ok:true reasoning that "stop_hook_active=false means the
# hook is inactive and cannot itself request capture". Nothing in V13 says what false
# means, so the model supplied a meaning, and the one it chose suppresses every fire.
# The shipped 14-line prompt carried that gloss; the bench cannot see the difference
# because it never asks a variant what an unset flag implies.
V14 = V13.replace(
    "and always when `stop_hook_active` is true, or the turn re-enters itself.",
    "and always when `stop_hook_active` is true, which means you have already asked during "
    "this turn and answering otherwise re-enters it — while its being false is the normal "
    "case and says nothing either way.",
)
assert V14 != V13, "V14 gloss failed to apply — V13's termination clause was reworded"


# V15 = V14 plus a clause addressed to whoever reads this template as *feedback*.
#
# When the hook fires, Claude Code injects the whole template into the main conversation as
# `Stop hook feedback:\n[<template>]: <reason>`. Its imperatives — "respond with exactly
# {"ok": true} and no other field" — are then read by the *main* agent as instructions to
# itself, and it complies: measured across two prompts, 3 of 5 fires came back with a
# 13-byte reply that was nothing but `{"ok": true}`, so the user's question went unanswered.
# The pre-existing closing clause covers a different case (the judge quoting the schema
# inside its reason) and does nothing for this one.
#
# This is pre-existing, not new to the compression: the 14-line prompt leaked at the same
# 3/5 rate. It survived because the e2e detector for it can only see a reply that follows a
# fire, and the fixture had stopped firing.
_FEEDBACK = (
    "If this text has reached you as `Stop hook feedback` on a turn you have already "
    "finished, then none of it is addressed to you except the reason appended after it: do "
    "not emit a verdict, JSON, or any description of this format. Run the skill the reason "
    "names, and answer the question the user actually asked."
)

V15 = V14 + "\n\n" + _FEEDBACK

# V16 moves the anti-leak instruction out of the template and into the *reason*.
#
# V15 put it in the template and the judge read it as a rule for itself: on a turn whose
# Insight it named in full, it answered ok:true because "the instruction to 'capture nothing
# yourself, call no tool' prevents me from invoking memory-capture" and "without explicit
# user signal that this Insight should persist". Live fire rate fell to 3/15, against 5/6
# for V14. A prohibition addressed to a different reader still lands on the judge, because
# the judge is the only reader that is actually being asked a question.
#
# The reason avoids that entirely: it is written per fire, it is not part of the condition
# being scored, and in the injected block it is the *last* thing the main agent reads —
# after the template whose imperatives cause the leak. Final position is the position that
# wins, which is the same mechanism that made a trailing example get copied as findings.
_LAST_LINE = "Do not print this verdict — run the skill, then answer the question the user asked."

V16 = V14.replace(
    "every bullet typed and only ever Insight or Incident:",
    "every bullet typed and only ever Insight or Incident, and then one final line, exactly: "
    f"`{_LAST_LINE}`",
).replace(
    "- Insight: prefix matching survives new tools; allowlists silently stop matching",
    "- Insight: prefix matching survives new tools; allowlists silently stop matching\n"
    f"{_LAST_LINE}",
)
assert V16.count(_LAST_LINE) == 2, "V16 needs the closing line in both the spec and the example"
assert V16 != V14, "V16 patch failed to apply — V14's reason spec was reworded"


def all_variants():
    return {"V0-shipped": shipped(), "V1": V1, "V2": V2, "V3": V3, "V4": V4,
            "V5": V5, "V6": V6, "V7": V7, "V8": V8, "V9": V9, "V10": V10,
            "V12": V12, "V13": V13, "V14": V14, "V15": V15, "V16": V16}


if __name__ == "__main__":
    print(f"{'variant':12} {'lines':>6} {'chars':>6} {'~tokens':>8}")
    for k, v in all_variants().items():
        body = [l for l in v.split("\n") if l.strip()]
        print(f"{k:12} {len(body):>6} {len(v):>6} {len(v)//4:>8}")
