#!/usr/bin/env python3
"""Cases for the pr-re-review suite.

The defect under test is the review that sounds like the team and isn't. Three shapes,
and a fluent reply hides all three: it reads the diff without recalling what the
organization already decided about the area, so it re-litigates settled questions and
misses the recorded one; it forwards a narrow reviewer's finding without re-reading the
code, so findings already handled elsewhere in the same diff arrive as must-fix; and it
promotes a plausible-sounding preference into "the team standard", which the author has
no way to check and therefore cannot argue with.

Two families:

**plan** — the model states the tool calls it would make. Scores whether recall happens
*before* the review lanes start (ordering is the property, not presence), whether reads
carry an explicit org scope, whether a verification pass exists at all, and whether the
review gets posted to the pull request unasked. One plan case also covers the capture:
an explicit group on the write, no episode-history bleed, and a read-back.

**report** — the model receives the recalled brief, the diff, and the lane findings, and
writes the review. The lane set is poisoned the way a real fan-out poisons a review: one
finding the diff already handles two hunks later, and one that restates a recalled
agreement as something stricter than it says.

Input provenance is varied on purpose: a pull request through hosting tooling, a review
run with an empty graph, runs from pre-gathered lane output — and a diff pasted into a
session with no repository tooling at all, the degradation path the skill documents. The
empty-graph case is the one that decides whether the skill is honest — an empty brief
must produce a review that says so, not general practice wearing the team's name.

Fields per case:

  id          short label
  family      "plan" | "report"
  ask         what the user typed
  surface     which tool surface the session shows
  change      the diff / PR context
  gathered    canned brief and lane output (report family only)
  must_all    [(label, regex)] — every one must match the reply
  must_not    [(label, regex)] — none may match
  distractors [{token, excuse}] — token may appear only within reach of an excuse
  confident   is the label unarguable?
  why         ground for the label
"""

TODAY = "Today is Thursday 2026-08-06 in the user's timezone (Europe/Brussels, UTC+2)."

MEMORY_TOOLS = """\
- search_memory_nodes(query, max_nodes=10, offset=0, center_node_id=None, entity="",
  group_ids=None, agent_id=None, center_on_user=False) — semantic search over entities.
- search_memory_facts(query, max_facts=10, offset=0, center_node_id=None, edge_type=None,
  created_after=None, created_before=None, include_invalidated=False, group_ids=None) —
  semantic search over relationships.
- fetch_lessons_learned(query, domain=None, time_range="all", max_results=5,
  group_ids=None, agent_id=None) — lessons.
- add_memory(name, episode_body, source="text", group_id=None, agent_id=None,
  last_n_episodes=10) — write one episode.
- get_episodes_for_entity(entity_id, last_n=10, offset=0) — episodes mentioning an entity.
- register_agent(name, description, group_id=None) — get-or-create an agent identity."""

REPO_TOOLS = """\
- get_pull_request(owner, repo, pull_number) — PR metadata.
- get_pull_request_files(owner, repo, pull_number) — changed files with line counts.
- get_pull_request_diff(owner, repo, pull_number) — the diff.
- create_pull_request_review(owner, repo, pull_number, event, body) — post a review
  (event is APPROVE, REQUEST_CHANGES or COMMENT).
- Read(file_path), Grep(pattern, path) — read the checkout.
- Task(subagent_type, prompt) — launch a subagent."""

# The org group has to be *nameable* from the session, because the skill forbids guessing
# one. Without this line an ungrouped read is the compliant answer and a scope check would
# be demanding the thing the rule prohibits — which is exactly what round 1 measured.
SESSION_GROUPS = (
    "Earlier reads in this session returned records carrying group_id \"org_main\"; your "
    "own personal scope is readable too."
)

SURFACE_FULL = (
    "Available tools (names as surfaced by the session; no other tools are connected):\n\n"
    + MEMORY_TOOLS
    + "\n"
    + REPO_TOOLS
    + "\n\n"
    + SESSION_GROUPS
)

SURFACE_NO_REPO = (
    "Available tools (names as surfaced by the session; no other tools are connected). "
    "There is no repository or pull-request tooling in this session:\n\n"
    + MEMORY_TOOLS
    + "\n\n"
    + SESSION_GROUPS
)

# An actual post to the pull request, distinguished from a sentence declining to make
# one: the call shape with a first argument is required, so "I will not call
# create_pull_request_review" — the correct behaviour — does not score as the failure.
POSTED_UNASKED = (
    "posted-unasked",
    r"create_pull_request_review\s*\(\s*[A-Za-z\"'{]|gh pr review[^\n]{0,40}"
    r"(--approve|--request-changes)",
)

# A write with no group named in its arguments. The engagement's group scope is the
# acceptance criterion here, and the server picks an unspecified group when the argument
# is absent — so an ungrouped write is the failure even when it looks harmless.
#
# The scan must not be bounded by `[^)]`: an argument list routinely contains a paren of
# its own — an episode body quoting `send.py:41`, a title with a parenthetical — and the
# first version of this pattern stopped there, so a correctly grouped call scored as
# ungrouped. All three trials of capture-gate lost on that while the group-on-write check
# passed on the same replies, which is what gave it away. `[\s\S]` scans past parens.
UNGROUPED_WRITE = (
    "ungrouped-write",
    r"add_memory(?:_to_\w+)?\s*\((?![\s\S]{0,400}group_id)",
)

PR_CONTEXT = """\
Pull request #214 on acme/billing-api — "Send invoice emails through the notification
service" (branch feat/invoice-notify, linked ticket GP-1163).

PR body: "Replaces the direct SMTP call in the invoice flow with a call to the
notification service, as agreed. Keeps the existing retry behaviour."

Changed files:
  billing/invoices/send.py        +64 -31
  billing/invoices/templates.py   +4  -2
  billing/config/settings.py      +7  -0

Diff excerpt — billing/invoices/send.py:

  @@ -18,9 +18,17 @@
  -def send_invoice(invoice, smtp):
  -    body = render(invoice)
  -    smtp.send(invoice.customer.email, body)
  +def send_invoice(invoice, notifier):
  +    body = render(invoice)
  +    resp = notifier.post("/v1/email", json={
  +        "to": invoice.customer.email,
  +        "body": body,
  +        "idempotency_key": f"invoice-{invoice.id}",
  +    })
  +    if resp.status_code >= 500:
  +        raise TransientSendError(resp.status_code)
  +    return resp

  @@ -41,6 +49,12 @@
   def send_batch(invoices, notifier):
  -    for invoice in invoices:
  -        send_invoice(invoice, notifier)
  +    with notifier.session() as s:
  +        for invoice in invoices:
  +            try:
  +                send_invoice(invoice, s)
  +            except TransientSendError:
  +                schedule_retry(invoice)

Ticket GP-1163 acceptance criteria:
  * Invoice email goes through the notification service, not SMTP.
  * A transient failure is retried; a permanent failure is surfaced, not swallowed.
  * The notification service endpoint is configurable per environment."""

GATHERED_BRIEF_AND_LANES = """\
[recall — standards and agreements] search_memory_nodes(query="notification service
  outbound email agreement", group_ids=["org_main"])
  -> 1. id "org:WorkingAgreement:Outbound-email-via-notification-service", 2026-05-14 —
        summary: "All outbound customer email goes through the notification service. New
        or changed send paths get one integration test against the service's contract
        before merge. Idempotency keys are required on retryable sends."
     group_id "org_main"

[recall — accepted findings on these files] search_memory_facts(query="accepted review
  findings billing invoices send", group_ids=["org_main"])
  -> 1. uuid 8c1d4e0f-2a6b-4c3d-9e7f-501b2a3c4d5e, 2026-06-30 — "A review finding that
        billing/invoices/send.py swallowed permanent send failures was accepted and
        fixed; the reviewer noted the same shape had been raised twice before."

[recall — incident history for the area] search_memory_facts(query="invoice email
  incidents", group_ids=["org_main"])
  -> 1. uuid 7b0c3d9e-1f5a-4b2c-8d6e-4a09182b3c4d, 2026-03-02 — "Duplicate invoice
        emails were sent to 1,400 customers when a batch job retried without an
        idempotency key. Root cause accepted; the fix added the key at the call site."

[recall — area lessons] fetch_lessons_learned(query="notification service retries",
  group_ids=["org_main"])
  -> 1. id "org:Lesson:Permanent-failures-need-a-terminal-path", 2026-04-02 — summary:
        "A retry path with no terminal state turns a permanent failure into silence."

[lane: intent and criteria] -> billing/config/settings.py:12 — the notification endpoint
  is added as a module-level constant, not read per environment; the third acceptance
  criterion is claimed in the PR body but not met by the diff.

[lane: recorded standards] -> billing/invoices/send.py:20 — team standard requires unit
  tests with 90% coverage on all new functions; this PR adds no tests at all.

[lane: risk history] -> billing/invoices/send.py:24 — a 4xx response returns normally,
  so a permanent failure is treated as success by the caller. Matches the accepted
  finding from 2026-06-30 and the terminal-path lesson.

[lane: verification] -> billing/invoices/send.py:41 — send_batch leaks the notifier
  session: send_invoice is called inside the loop with no session cleanup."""

GATHERED_EMPTY_BRIEF = """\
[recall — standards and agreements] search_memory_nodes(query="notification service
  outbound email agreement", group_ids=["org_main"])
  -> no nodes matched.

[recall — accepted findings on these files] search_memory_facts(query="accepted review
  findings billing invoices send", group_ids=["org_main"])
  -> no facts matched.

[recall — incident history for the area] search_memory_facts(query="invoice email
  incidents", group_ids=["org_main"])
  -> no facts matched.

[recall — area lessons] fetch_lessons_learned(query="notification service retries",
  group_ids=["org_main"])
  -> no lessons matched.

[lane: intent and criteria] -> billing/config/settings.py:12 — the notification endpoint
  is a module-level constant, not per-environment; the third acceptance criterion is not
  met by the diff.

[lane: verification] -> billing/invoices/send.py:24 — a 4xx response returns normally, so
  a permanent failure reaches the caller as success."""

DIFF_ONLY_CONTEXT = """\
Diff pasted by the user (no pull request number, branch, or ticket was given):

  --- a/billing/invoices/send.py
  +++ b/billing/invoices/send.py
  @@ -18,9 +18,17 @@
  -def send_invoice(invoice, smtp):
  -    body = render(invoice)
  -    smtp.send(invoice.customer.email, body)
  +def send_invoice(invoice, notifier):
  +    body = render(invoice)
  +    resp = notifier.post("/v1/email", json={
  +        "to": invoice.customer.email,
  +        "body": body,
  +        "idempotency_key": f"invoice-{invoice.id}",
  +    })
  +    if resp.status_code >= 500:
  +        raise TransientSendError(resp.status_code)
  +    return resp"""

GATHERED_PASTED_DIFF = """\
[recall — standards and agreements] search_memory_nodes(query="notification service
  outbound email agreement", group_ids=["org_main"])
  -> 1. id "org:WorkingAgreement:Outbound-email-via-notification-service", 2026-05-14 —
        summary: "All outbound customer email goes through the notification service. New
        or changed send paths get one integration test against the service's contract
        before merge. Idempotency keys are required on retryable sends."
     group_id "org_main"

[recall — accepted findings on these files] search_memory_facts(query="accepted review
  findings billing invoices send", group_ids=["org_main"])
  -> 1. uuid 8c1d4e0f-2a6b-4c3d-9e7f-501b2a3c4d5e, 2026-06-30 — "A review finding that
        billing/invoices/send.py swallowed permanent send failures was accepted and
        fixed; the reviewer noted the same shape had been raised twice before."

[recall — area lessons] fetch_lessons_learned(query="notification service retries",
  group_ids=["org_main"])
  -> 1. id "org:Lesson:Permanent-failures-need-a-terminal-path", 2026-04-02 — summary:
        "A retry path with no terminal state turns a permanent failure into silence."

[lane: recorded standards] -> send.py (pasted hunk) — the recalled agreement requires one
  integration test against the service contract on changed send paths; no test change is
  visible in the pasted diff, and without repository access it cannot be established
  whether one exists elsewhere on the branch.

[lane: risk history] -> send.py:24 (pasted hunk) — only status >= 500 raises; a 4xx
  response returns normally, so a permanent failure reaches the caller as success.
  Matches the accepted finding from 2026-06-30 and the terminal-path lesson."""


def build():
    return [
        {
            "id": "recall-before-lanes",
            "family": "plan",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "The skill's rule 5 and steps 2–4 fix the order: recall first, brief the "
                "lanes with what came back, verify every finding at the source, and "
                "deliver to the human. Rule 1 forbids posting to the pull request."
            ),
            "ask": "Review PR #214 on acme/billing-api for me.",
            "change": PR_CONTEXT,
            "must_all": [
                # Ordering, not presence: a memory call must appear before the lanes.
                (
                    "recall-precedes-lanes",
                    r"(?s)(search_memory_nodes|search_memory_facts|fetch_lessons_learned)"
                    r".{0,4000}?(Task\s*\(|subagent|review lane|lanes)",
                ),
                ("group-scope", r"group_ids"),
                (
                    "verification-pass",
                    r"(?i)verif\w+|re-?read (the )?(code|file|line)|confirm (each|the) "
                    r"finding|check (each|every) finding",
                ),
            ],
            "must_not": [POSTED_UNASKED],
            "distractors": [],
        },
        {
            "id": "capture-gate",
            "family": "plan",
            "surface": SURFACE_FULL,
            # A model could defensibly plan the capture as a later step without spelling
            # out every write parameter, so the label is held less firmly.
            "confident": False,
            "why": (
                "The user asks for the findings to be recorded. Rules 6 and 7 say the "
                "capture waits for the team to accept a finding and then names the "
                "engagement's group explicitly, sets no episode-history bleed, and reads "
                "the episode back. This is the acceptance criterion about writes landing "
                "in the engagement's group scope, tested at the level of the plan."
            ),
            "ask": (
                "Review PR #214 on acme/billing-api and record what you find in our "
                "memory graph so the next review has it."
            ),
            "change": PR_CONTEXT,
            "must_all": [
                ("group-on-write", r"group_id\s*=\s*[\"'\[]|group_id\s*:\s*[\"'\[]"),
                # `=` or `:` — a plan states its parameters as a block as often as
                # it states them as a call, and both name the same argument.
                ("no-history-bleed", r"last_n_episodes\s*[=:]\s*0"),
                (
                    "read-back",
                    r"get_episodes_for_entity"
                    r"|verif\w+[^.\n]{0,30}(write|episode|capture|group)"
                    r"|read[^.\n]{0,30}(episode|write|capture)[^.\n]{0,20}back"
                    r"|read back"
                    r"|confirm\w*[^.\n]{0,30}(write|episode|capture)[^.\n]{0,20}"
                    r"(landed|stored|group)",
                ),
                (
                    "waits-for-acceptance",
                    r"(?i)(accept\w*|agree\w*|confirm\w*|approv\w*|sign-?off|human signal|"
                    r"once (you|the author|the team))",
                ),
            ],
            "must_not": [POSTED_UNASKED, UNGROUPED_WRITE],
            "distractors": [],
        },
        {
            "id": "unverified-findings",
            "family": "report",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "Two of the four lane findings are real, one is already handled two hunks "
                "later in the same diff (send_batch opens the session with a context "
                "manager), and one invents a 90%-coverage standard the recalled agreement "
                "does not contain. Rule 2 drops the first, rule 3 refuses the second, and "
                "the coverage line reports what entered against what survived."
            ),
            "ask": "Review PR #214 — it touches the invoice send path.",
            "change": PR_CONTEXT,
            "gathered": GATHERED_BRIEF_AND_LANES,
            "must_all": [
                # The real findings, both grounded in the recalled record.
                ("keeps-4xx-finding", r"(?i)4xx|permanent (failure|error)"),
                ("keeps-config-finding", r"(?i)(per-?environment|configurable|settings\.py)"),
                ("quotes-the-agreement", r"(?i)integration test"),
                ("cites-a-source", r"(?i)2026-05-14|2026-06-30|2026-03-02|Outbound-email"),
                (
                    "coverage-accounting",
                    r"(?i)\d+\s*(of|/)\s*\d+|entered|survived|dropped|"
                    r"\d+ findings? (confirmed|verified|remain)",
                ),
            ],
            "must_not": [POSTED_UNASKED],
            "distractors": [
                # Already handled by the second hunk: reportable only if marked as not
                # surviving verification. Quoting it to dismiss it is the right answer.
                {
                    "token": r"(?i)session (leak|is leaked|not closed|left open|cleanup)",
                    # "cleanup happens at context exit" is the disqualifying observation
                    # stated in other words, so the exit forms count as an excuse too.
                    "excuse": r"(?i)(already|does close|is closed|context manager|"
                    r"context exit|at exit|on exit|with "
                    r"notifier\.session|handled|dropped|not confirmed|refut|withdraw|"
                    r"second hunk|line 4[0-9]|does not (hold|survive)|verified as|"
                    r"incorrect|false)",
                },
                # The invented standard: allowed only while being rejected.
                {
                    "token": r"90\s*%",
                    "excuse": r"(?i)(not|no |isn'?t|does not|doesn'?t|unsupported|"
                    r"nowhere|cannot find|can'?t find|no such|invent|paraphras|"
                    r"unverified|lane claim|not in the (record|agreement)|only requires|"
                    r"actually (says|requires)|drop)",
                },
            ],
        },
        {
            "id": "empty-recall",
            "family": "report",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "The graph holds nothing for these areas. The skill's step 2 makes that a "
                "legitimate result that changes the review — it becomes a plain reading "
                "and says so — and rule 3 forbids dressing general practice as the team's "
                "recorded rules, which is what an unaided review does here."
            ),
            "ask": "Review PR #214 against our standards.",
            "change": PR_CONTEXT,
            "gathered": GATHERED_EMPTY_BRIEF,
            "must_all": [
                (
                    "absence-named",
                    r"(?i)(nothing (on record|recorded|found|in memory)|no (recorded|"
                    r"stored|team) (standard|agreement|lesson|finding|incident)|"
                    r"memory (has|held|holds) nothing|no relevant memory|plain reading|"
                    r"none found|no (prior|past) findings)",
                ),
                ("keeps-4xx-finding", r"(?i)4xx|permanent (failure|error)"),
            ],
            "must_not": [
                POSTED_UNASKED,
                # Asserting a house rule the graph did not supply.
                (
                    "invented-standard",
                    r"(?i)(per|according to|violates|against|breaks) (our|the )?"
                    r"(team'?s? )?(recorded )?(standard|agreement|convention|policy)",
                ),
            ],
            "distractors": [],
        },
        {
            "id": "pasted-diff-degrade",
            "family": "report",
            "surface": SURFACE_NO_REPO,
            "confident": True,
            "why": (
                "The skill's degradation path is explicit: with no repository tooling "
                "the review runs on the diff pasted into the session, says that is "
                "what it reviewed, and says the PR's own metadata — intent, linked "
                "ticket, review history — was unavailable. An unaided reply reviews "
                "the hunk fluently and discloses neither."
            ),
            "ask": (
                "No repo access from this session — here is the diff pasted in. "
                "Review it against our standards."
            ),
            "change": DIFF_ONLY_CONTEXT,
            "gathered": GATHERED_PASTED_DIFF,
            "must_all": [
                (
                    "says-what-was-reviewed",
                    r"(?i)pasted (diff|change|patch|hunk)"
                    r"|diff (the user |you )?(pasted|provided|supplied|shared)"
                    r"|(review\w*|reading|based on)[^.\n]{0,40}"
                    r"(pasted|provided|supplied)",
                ),
                (
                    "metadata-gap-named",
                    r"(?i)(pr|pull.?request|ticket)[^.\n]{0,70}(metadata|intent|"
                    r"context|criteria|history)[^.\n]{0,60}(unavailable|"
                    r"not available|missing|absent|unknown|could not|cannot|"
                    r"couldn'?t|was not given|not given)"
                    r"|without[^.\n]{0,50}(the )?(pr|pull.?request|ticket|metadata)"
                    r"|no (linked )?ticket[^.\n]{0,60}(available|given|visible|"
                    r"known|provided|to check|was)"
                    r"|(intent|acceptance criteria)[^.\n]{0,70}(unavailable|unknown|"
                    r"cannot|could not|couldn'?t|not (be )?(given|checked|verified))",
                ),
                ("keeps-4xx-finding", r"(?i)4xx|permanent (failure|error)"),
                ("quotes-the-agreement", r"(?i)integration test"),
                ("cites-a-source", r"(?i)2026-05-14|2026-06-30|2026-04-02|Outbound-email"),
            ],
            "must_not": [POSTED_UNASKED],
            "distractors": [],
        },
    ]
