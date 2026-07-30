#!/usr/bin/env python3
"""Turns to send the pointer alongside.

The shipped wording draws its own line: recall before substantive work, skip for "a
greeting, a self-contained factual question, or a purely mechanical edit", and on
anything larger never skip silently. These cases sit on both sides of that line and on
the awkward edges of it.

Three labels per case, because the pointer can fail in independent ways:

  want_recall   should the reply say it is recalling from memory first?
  want_quiet    must the reply not mention memory/gutt/skills *at all*?
  want_label    did this turn produce a durable finding, so V4's closing-summary clause
                has something to name? Defaults false — only two cases set it.

They are not opposites. A large task where the model decides not to recall should still
mention memory — the wording asks for one line saying why. A trivial task should be
answered with no mention of memory in it, and that is the live detector for the GP-868
failure mode: `tests/e2e/session-lifecycle.e2e.cjs` sends "Reply with exactly: pong" and
asserts the reply matches none of /memory|gutt|skill|instruction/. `pong` is carried here
under the same id so the eval and the e2e assertion cannot drift apart.

`confident` marks cases where the label is unarguable. The rest are judgement calls kept
in deliberately — a prompt whose history-bearing-ness is debatable is exactly where a
wording change shows up — and the report separates the two.

**Constraint on the recall-expected cases: they must be answerable from an empty working
directory with no tools.** Judge calls run from `lib/runner.judge_cwd()` with
`--allowedTools ""`, so a prompt naming a file the model cannot open ("add rate limiting
to the auth endpoint") draws "please provide more details about your project" — a reply
that neither recalls nor declines to. Every variant scored 0 on exactly that prompt in the
first run, which is the signature of a case measuring the harness rather than the wording:
a case no wording can pass is a constant. So the substantive turns are phrased as decisions
and questions, which a model engages with on its own. The turns that *should* stay quiet are
exempt — `mechanical` names a file on purpose, and "I need to see the file" is a correct
quiet answer.
"""


def build():
    cases = [
        # --- should recall: substantive work in a repo with history -------------------
        {
            "id": "ratelimit",
            "prompt": "Should we throttle the auth endpoint at the gateway or in the app?",
            "want_recall": True,
            "want_quiet": False,
            "confident": True,
        },
        {
            "id": "retry-arch",
            "prompt": "We keep getting duplicate webhook deliveries. How should we handle retries?",
            "want_recall": True,
            "want_quiet": False,
            "confident": True,
        },
        {
            "id": "why-postgres",
            "prompt": "Why did we end up on Postgres instead of DynamoDB for the events table?",
            "want_recall": True,
            "want_quiet": False,
            "confident": True,
        },
        # --- should stay quiet: the wording's own named exceptions --------------------
        {
            # Same fixture as the e2e GP-868 detector. Any mention of memory here is a leak.
            "id": "pong",
            "prompt": "Reply with exactly: pong",
            "want_recall": False,
            "want_quiet": True,
            "confident": True,
        },
        {
            "id": "greeting",
            "prompt": "hey, morning",
            "want_recall": False,
            "want_quiet": True,
            "confident": True,
        },
        {
            "id": "factual",
            "prompt": "In JavaScript, does Array.prototype.sort mutate the array?",
            "want_recall": False,
            "want_quiet": True,
            "confident": True,
        },
        {
            "id": "mechanical",
            "prompt": "Rename the variable `usr` to `user` in src/session.js.",
            "want_recall": False,
            "want_quiet": True,
            "confident": False,
        },
        # --- turns that genuinely produce a durable finding ---------------------------
        # V4-summary's clause is conditional: "state any durable finding … say nothing if
        # the turn produced none". Every other case here is a question, and a question
        # answered produces no finding — so silence is the clause behaving correctly, and a
        # suite made only of questions cannot tell that apart from the clause being inert.
        # These two carry a finished piece of work with a takeaway inside it. They are the
        # only cases where `want_label` is true, and the only ones that can falsify the
        # clause. Marked non-confident so they leave the headline recall figure alone.
        {
            "id": "flaky-writeup",
            "prompt": (
                "We burned two days on a flaky CI failure. The test seeded its RNG from the "
                "clock, so it only failed on runs starting near midnight UTC. Write that up "
                "for the team."
            ),
            "want_recall": True,
            "want_quiet": False,
            "want_label": True,
            "confident": False,
        },
        {
            "id": "deploy-postmortem",
            "prompt": (
                "Last night's deploy failed: the migration job started before the config map "
                "was mounted, so it read an empty database URL. We fixed it with an init "
                "container that waits for the mount. Give me the postmortem summary."
            ),
            "want_recall": True,
            "want_quiet": False,
            "want_label": True,
            "confident": False,
        },
        # --- edges -------------------------------------------------------------------
        {
            # The user has pre-empted recall. Skipping is right; doing it silently is not,
            # and overriding the user to recall anyway is worse.
            "id": "user-declines",
            "prompt": "Don't go looking anything up, just add the null check to parseConfig.",
            "want_recall": False,
            "want_quiet": False,
            "confident": False,
        },
        {
            # Small change, large blast radius: historical underneath. Phrased as a
            # judgement call rather than the original imperative ("Bump the MCP client
            # timeout from 30s to 120s"), which scored 0/25 across every variant — with no
            # repo to look at, the model correctly answered "I'm in an empty directory, tell
            # me which file". That measured the harness. Asking whether the change is safe
            # keeps the history-bearing quality and loses only the looks-mechanical framing,
            # which `mechanical` already covers from the other side.
            "id": "bump-timeout",
            "prompt": "Is raising our MCP client timeout from 30s to 120s going to bite us?",
            "want_recall": True,
            "want_quiet": False,
            "confident": False,
        },
    ]
    for case in cases:
        case.setdefault("want_label", False)
    return cases
