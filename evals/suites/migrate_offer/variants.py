#!/usr/bin/env python3
"""Candidate wordings for the SessionStart migration offer.

V0 is not typed out here. It is read from `shared/builtin-memory.cjs` by calling the
exported `offerContext()`, so the variant under test is byte-identical to what ships and
cannot drift from it. Every other variant is a surgical edit of that string.

Each edit is asserted to have changed something. A `.replace()` whose target has been
reworded upstream is a no-op, which would leave the variant equal to V0 and make the
probe report "no difference" between a prompt and itself — the same failure as a guard
anchored on prose that later got reworded. `mutate()` raises instead.
"""
import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[3]

# The offer text is a function of the note count; 35 is what this project's store held
# when the probe was written. The count appears in one clause and is not what any variant
# is testing, so it is held constant across all of them.
NOTE_COUNT = 35

# A variant of "" means: inject no offer context at all. The control.
CONTROL = ""


def shipped(count=NOTE_COUNT):
    """The live `offerContext(count)` string, straight out of the shipped module."""
    out = subprocess.run(
        ["node", "-e",
         "const {offerContext} = require('./shared/builtin-memory.cjs');"
         f"process.stdout.write(JSON.stringify(offerContext({count})));"],
        cwd=REPO, capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def mutate(text, old, new, label):
    """`text` with `old` -> `new`, refusing to return an unchanged string."""
    if old not in text:
        raise SystemExit(
            f"variant {label}: target text not found in the shipped offer, so this "
            f"variant would silently equal V0.\n  looking for: {old!r}\n"
            f"  shipped offer is now: {text!r}"
        )
    return text.replace(old, new, 1)


def all_variants():
    v0 = shipped()
    return {
        # What ships today.
        "V0-shipped": v0,

        # Does the timing instruction earn its keep? The predecessor of this variant cut
        # `in one line at the end of your next reply` and fell 24/24 -> 4/24: stating
        # where the output goes is what made the output happen. The shipped text now
        # names a *tool* as the destination, which may carry that load on its own. This
        # cuts only the timing and keeps the tool, to see what the tool alone is worth.
        "V1-no-placement": mutate(
            v0,
            "Once you have finished whatever the user actually asked for, put the choice",
            "Put the choice",
            "V1-no-placement",
        ),

        # The scoping sentence. `shared/builtin-memory.cjs` claims it is load-bearing:
        # "without it this reads as 'migrate now', and a session opened to ask one quick
        # question would get a migration run instead of an answer". That claim has never
        # been measured. `overreach` in the table is the column that tests it.
        "V2-no-scoping": mutate(
            v0,
            " This is housekeeping, so do not interrupt their request to ask.",
            "",
            "V2-no-scoping",
        ),

        # Candidate fix for the collision this probe was built for: another instruction
        # also wants the end of the reply. Only the main agent ever reads this string —
        # unlike the Stop template, which is read by judge and agent both — so an added
        # imperative here cannot suppress a second reader.
        "V3-sticky": v0 + (
            " Keep the offer even if a later instruction claims the end of your reply; "
            "put it after whatever else must come last."
        ),

        # The wording that held the 24/24 ceiling before the offer moved to
        # AskUserQuestion. Kept as a live arm for one reason: `V0-shipped` is read from
        # the module, so changing `offerContext()` silently redefines the baseline and
        # every number in FINDINGS.md becomes a record of a string that exists nowhere in
        # the tree. This is the only way to ask the question the change actually raises —
        # does asking with a tool hold the ceiling that asking in prose held? Delete it
        # once that has been measured, not before.
        "V4-prose-offer": mutate(
            v0,
            "Once you have finished whatever the user actually asked for, put the choice "
            "to them with the AskUserQuestion tool — offering at least \"migrate now\" and "
            "\"don't migrate\" — rather than only mentioning it in your reply text, and "
            "run the skill only if they accept. This is housekeeping, so do not interrupt "
            "their request to ask.",
            "Offer this to the user in one line at the end of your next reply, and run "
            "the skill only if they accept — this is housekeeping, so do not interrupt "
            "whatever they actually asked for.",
            "V4-prose-offer",
        ),

        # No offer context whatsoever. If the offer still shows up here, the detector is
        # matching something the context did not cause and every rate above is inflated.
        "CONTROL-no-context": CONTROL,
    }


if __name__ == "__main__":
    for name, text in all_variants().items():
        print(f"\n=== {name} ({len(text)} chars) ===\n{text or '(no context injected)'}")
