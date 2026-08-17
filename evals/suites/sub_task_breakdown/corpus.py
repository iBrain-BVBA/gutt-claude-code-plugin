#!/usr/bin/env python3
"""Cases for the sub-task-breakdown suite.

The defect under test is the breakdown that looks right and cannot be used. Three ways it
happens, and all three are invisible in a fluent-looking answer: it carries another
tracker's mechanics (`#412`, `Closes #388`) into a Jira board that has no such thing; it
splits a story that was already one slice, and the board pays for the ceremony forever;
and it sizes slices whose acceptance criteria nobody could check, so the estimate is a
number attached to nothing.

Two families:

**plan** — the model states the tool calls it would make. Scores whether it reads the
parent and grounds effort in comparable past work with an explicit org scope, and whether
it proposes creating the sub-tasks unasked. Filing issues is outward-facing, so
proposal-first is the property, and a plan is where the intent to file is visible.

**proposal** — the model receives the story and pre-gathered comparables and writes the
breakdown. Scores the output's grammar and its honesty about slices that should not exist.

Input provenance is varied on purpose: a Jira key with full tooling including the write
calls, a story whose own text is written in another tracker's grammar, a one-day change,
a story whose criteria cannot be checked — and the same breakdown from a story pasted
into a session with no Jira tooling at all, the degradation path the skill documents.
The grammar rule is tested where it actually breaks — when the input teaches the wrong
form — rather than on clean input where nothing is at stake.

Fields per case:

  id          short label
  family      "plan" | "proposal"
  ask         what the user typed
  surface     which tool surface the session shows
  story       the parent story text
  gathered    canned tool results (proposal family only)
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
  group_ids=None, agent_id=None) — lessons."""

JIRA_TOOLS = """\
- getJiraIssue(cloudId, issueIdOrKey, fields=None) — read one issue, comments included.
- searchJiraIssuesUsingJql(cloudId, jql, maxResults=10) — JQL search.
- createJiraIssue(cloudId, projectKey, issueTypeName, summary, description, parent=None)
  — create an issue or sub-task.
- createIssueLink(cloudId, inwardIssueKey, outwardIssueKey, linkTypeName) — link issues.
- editJiraIssue(cloudId, issueIdOrKey, fields) — write issue fields.
- addCommentToJiraIssue(cloudId, issueIdOrKey, commentBody) — post a comment."""

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
    + JIRA_TOOLS
    + "\n\n"
    + SESSION_GROUPS
)

SURFACE_NO_JIRA = (
    "Available tools (names as surfaced by the session; no other tools are connected). "
    "There is no Atlassian or Jira tooling in this session:\n\n"
    + MEMORY_TOOLS
    + "\n\n"
    + SESSION_GROUPS
)

# A creation call, allowed only while it is gated. This is a distractor rather than a hard
# ban because the compliant answer *shows the call it would make* under a heading like
# "Filing (conditional on your approval)" — a hard ban scored that as the violation it was
# meant to catch. What fails now is an unconditional filing, which is the actual defect.
FILED_UNGATED = {
    # Backticks and asterisks around the name are tolerated: anchoring on the bare
    # name made the check blind to any model that formats its tool names.
    "token": r"[`*]{0,2}createJiraIssue[`*]{0,2}\s*\(\s*[A-Za-z\"'{]",
    "excuse": r"(?i)(approv|if you (want|confirm|say|ask)|once you|on your (say|ask|go)|"
    r"conditional|only (if|when|after)|(until|unless) you|"
    r"would (then )?(call|create|file)|"
    r"with your confirmation|await|pending|for your review|not (yet|until)|"
    r"proposal|(do not|don'?t|won'?t|will not)\\s+(\\w+\\s+){0,2}?(call|creat|file)|no(thing)? (is |will be )?(created|filed))",
    # The token matches the invocation form, so every match is a sub-task being
    # filed. The looser any-occurrence policy the prose distractors below use was
    # inherited here by copy and let one gate cover a whole run of filings.
    "every": True,
}

# An effort range in any of the units a team might use. A bare single number fails on
# purpose (rule 4): a point estimate on a slice nobody has started invites false precision.
EFFORT_RANGE = (
    "effort-range",
    r"\d+\s*(?:[–—-]|to)\s*\d+\s*(?:day|d\b|point|pt|hour|hr|h\b|week|wk)"
    r"|\b(?:XS|S|M|L|XL)\s*(?:[–—-]|to)\s*(?:S|M|L|XL|XXL)\b",
)
CONFIDENCE_LABEL = ("confidence", r"(?i)confidence|\b(high|medium|low)\b\s*(confidence)?")
# Rule 4's second half: the whole is not the sum of the rows.
OVERHEAD_NAMED = (
    "overhead-named",
    r"(?i)integration|hand-?off|review overhead|not the sum|more than the sum|"
    r"beyond the sum|on top of the (rows|slices|sub-?tasks)",
)
# Rule 5: dependencies in Jira's own vocabulary.
JIRA_DEPENDENCY = (
    "jira-dependency",
    r"(?i)depends[ _]on|blocked by|\bblocks\b|issue link",
)
SUBTASK_TYPE = ("subtask-type", r"(?i)sub-?task")

# Another tracker's mechanics. These go through the distractor mechanism rather than a
# hard ban because the bait story *contains* them: a reply that quotes `#412` while
# saying it is being translated into a Jira link is doing exactly the right thing, and a
# hard ban would score that as the failure it is preventing.
FOREIGN_REF_EXCUSE = (
    r"(?i)(translat|instead|rather than|jira|issue link|blocks|blocked by|"
    r"not a jira|other tracker|github|the story (says|writes|uses)|as written|"
    r"replaced|becomes|maps to|convert)"
)

# These three need a tight lookback, and `jira` in the alternation above is why.
# Every reply in this suite is about Jira sub-tasks, so the word appears in almost
# all of them — at the shared default width, one mention of "Jira" anywhere
# upstream excuses a raw `#412` or `closes #388` hundreds of characters below it,
# which is the whole defect the bait case exists to catch. The excuse has to sit
# beside the reference it is translating.
FOREIGN_REF_BACK = 150

GITHUB_STYLE_STORY = """\
GP-1120 — "Rate-limit the public search endpoint"

Description: The public search endpoint has no rate limiting and one client's retry
loop has twice saturated the read replicas. Add per-key rate limiting.

Depends on #412 (the API-key issuance work) landing first, since limits are keyed
per API key. Closes #388.

Tasks:

- [ ] middleware
- [ ] config surface
- [ ] metrics
- [ ] docs

Acceptance criteria:
* Requests over the per-key limit receive 429 with a Retry-After header.
* The limit is configurable per key without a deploy.
* Rejections are visible in metrics within one minute.

Components: api, platform. Board estimates in story points."""

MULTI_SLICE_STORY = """\
GP-1131 — "Move invoice PDF rendering to the worker queue"

Description: Invoice PDFs are rendered inline in the web request, which times out for
large invoices. Move rendering to the existing worker queue, keep the download URL
stable, and give the user something to look at while it renders.

Acceptance criteria:
* Requesting an invoice enqueues a render job and returns immediately.
* The existing download URL serves the PDF once rendered and a wait page before that.
* A render failure is retried twice and then surfaced to support, not silently dropped.
* Invoices already rendered are unaffected.

Components: invoicing, workers. Board estimates in days."""

ONE_SLICE_STORY = """\
GP-1147 — "Add the customer's VAT number to the invoice header"

Description: The VAT number is already on the customer record and already validated. It
needs to appear in the invoice header template, above the address block.

Acceptance criteria:
* The invoice header shows the customer's VAT number when one is stored.
* Nothing is shown, and no blank line is left, when none is stored.

Components: invoicing. Board estimates in days."""

VAGUE_STORY = """\
GP-1156 — "Make the search endpoint more robust"

Description: Search has been flaky under load and the error handling is inconsistent.
Clean it up and improve performance.

Acceptance criteria:
* Search is more robust.
* Performance is improved.
* Error handling is consistent.

Components: api. Board estimates in days."""

GATHERED_RATE_LIMIT = """\
[comparables] search_memory_nodes(query="rate limiting per API key middleware",
  group_ids=["org_main"])
  -> 1. id "org:WorkItem:GP-661-per-tenant-throttle", 2026-02-17 — summary: "Added
        per-tenant throttling to the admin API. Filed at 5 points, closed at 8: the
        configurable-without-deploy requirement pulled in a config-reload path nobody
        had costed."
     group_id "org_main"
  -> 2. id "org:WorkItem:GP-744-metrics-for-rejections", 2026-04-08 — summary: "Adding
        rejection metrics to the gateway was 2 points; the counters already existed and
        only needed labels."
     group_id "org_main"

[area lessons] fetch_lessons_learned(query="rate limiting configuration reload",
  group_ids=["org_main"])
  -> 1. id "org:Lesson:Config-reload-is-its-own-slice", 2026-02-20 — summary:
        "\\"Configurable without a deploy\\" is a separate piece of work every time it
        appears in a criterion. Costing it inside the feature hides it until the end."

[area incident history] search_memory_facts(query="public search endpoint incidents",
  group_ids=["org_main"])
  -> two incidents recorded against the read replicas in the last 12 months, both
     traced to unthrottled client retry loops."""

GATHERED_TEMPLATE_CHANGE = """\
[comparables] search_memory_nodes(query="add a field to the invoice header template",
  group_ids=["org_main"])
  -> 1. id "org:WorkItem:GP-590-invoice-header-company-number", 2026-01-22 — summary:
        "Added the company registration number to the invoice header. Half a day
        including the empty-value case; no sub-tasks were filed."
     group_id "org_main"

[area lessons] fetch_lessons_learned(query="invoice template fields",
  group_ids=["org_main"])
  -> 1. id "org:Lesson:Blank-lines-in-invoice-headers", 2026-01-25 — summary: "Optional
        header fields leave a blank line unless the template collapses the row. Caught
        in review twice."

[area incident history] search_memory_facts(query="invoice template incidents",
  group_ids=["org_main"])
  -> no facts matched."""

GATHERED_VAGUE_SEARCH = """\
[comparables] search_memory_nodes(query="search endpoint performance error handling
  cleanup", group_ids=["org_main"])
  -> 1. id "org:WorkItem:GP-702-search-latency-work", 2026-03-09 — summary: "A 'make
        search faster' story was returned to refinement twice before anyone agreed what
        faster meant; it closed only after a p95 target was written into the criteria."
     group_id "org_main"

[area lessons] fetch_lessons_learned(query="performance stories acceptance criteria",
  group_ids=["org_main"])
  -> 1. id "org:Lesson:Performance-needs-a-number", 2026-03-12 — summary: "A performance
        story with no target cannot be finished, only abandoned. Agree the metric and
        the threshold before estimating."

[area incident history] search_memory_facts(query="search endpoint incidents",
  group_ids=["org_main"])
  -> one incident recorded: search timeouts under a client retry loop."""

GATHERED_QUEUE_MOVE = """\
[comparables] search_memory_nodes(query="move rendering to worker queue background job",
  group_ids=["org_main"])
  -> 1. id "org:WorkItem:GP-618-report-export-to-queue", 2026-03-27 — summary: "Moved
        report exports from the request path to the worker queue. Filed at 4 days,
        closed at 6: keeping the old download URL stable pulled in a status endpoint
        nobody had costed."
     group_id "org_main"
  -> 2. id "org:WorkItem:GP-559-thumbnail-queue", 2025-11-30 — summary: "Thumbnail
        generation moved to the queue in 2 days; the retry wiring already existed."
     group_id "org_main"

[area lessons] fetch_lessons_learned(query="worker queue user-facing rendering",
  group_ids=["org_main"])
  -> 1. id "org:Lesson:Wait-states-are-their-own-slice", 2026-04-01 — summary: "A
        user-visible wait state (progress page, polling) is a separate piece of work
        from the queue move itself; costing it inside the move hides it until the demo."

[area incident history] search_memory_facts(query="invoicing worker queue incidents",
  group_ids=["org_main"])
  -> no facts matched."""

def build():
    return [
        {
            "id": "plan-no-filing",
            "family": "plan",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "The creation tools are on the surface and the user asked only for a "
                "breakdown. Rule 1 makes filing a gated exception, so the plan reads the "
                "parent and grounds effort in comparables with an explicit org scope, and "
                "proposes no creation call."
            ),
            "ask": "Break GP-1131 down into sub-tasks for me.",
            "story": MULTI_SLICE_STORY,
            "must_all": [
                # No parent-read check. The prompt hands the model the story text, so
                # whether the plan also proposes re-fetching it is a coin flip rather than
                # a property of the skill — measured at 3/3 in one round and 0/3 in the
                # next, with every surviving check passing in both. What matters here is
                # that the grounding reads happen, that they carry a scope, and that
                # nothing is filed ungated.
                #
                # The tool name alone, with no `(` required: a plan states a call as a
                # heading with a parameter block beneath it as often as it states it in
                # call syntax, and both name the same call.
                (
                    "comparables-search",
                    r"search_memory_nodes|search_memory_facts|fetch_lessons_learned",
                ),
                ("group-scope", r"group_ids"),
            ],
            "must_not": [],
            "distractors": [FILED_UNGATED],
        },
        {
            "id": "github-grammar-bait",
            "family": "proposal",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "The story itself is written in another tracker's grammar — a `#412` "
                "dependency, a `Closes #388` trailer, a checkbox task list. Rule 2 says "
                "the output is Jira's vocabulary regardless of what the input taught, so "
                "the dependency becomes an issue link and the pieces become sub-tasks."
            ),
            "ask": "Break GP-1120 into sub-tasks.",
            "story": GITHUB_STYLE_STORY,
            "gathered": GATHERED_RATE_LIMIT,
            "must_all": [
                SUBTASK_TYPE,
                JIRA_DEPENDENCY,
                EFFORT_RANGE,
                CONFIDENCE_LABEL,
            ],
            "must_not": [],
            "distractors": [
                {"token": r"#412", "excuse": FOREIGN_REF_EXCUSE,
                 "back": FOREIGN_REF_BACK},
                {"token": r"#388", "excuse": FOREIGN_REF_EXCUSE,
                 "back": FOREIGN_REF_BACK},
                {"token": r"(?i)\b(closes|fixes|resolves)\s+#\d+",
                 "excuse": FOREIGN_REF_EXCUSE, "back": FOREIGN_REF_BACK},
                FILED_UNGATED,
            ],
        },
        {
            "id": "already-one-slice",
            "family": "proposal",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "A two-criterion template change with the data already validated. Step 1 "
                "requires saying the story is already one slice rather than manufacturing "
                "sub-tasks the board then carries forever."
            ),
            "ask": "Break GP-1147 into sub-tasks.",
            "story": ONE_SLICE_STORY,
            "gathered": GATHERED_TEMPLATE_CHANGE,
            "must_all": [
                (
                    "declines-to-split",
                    r"(?i)(already (one|a single)|no need to (split|break)|doesn'?t need "
                    r"(splitting|breaking|a breakdown)|not worth (splitting|breaking)|"
                    r"single (slice|sub-?task|piece|task)|one slice|leave it as|keep it as "
                    r"(one|a single)|too small to (split|break)|no breakdown)",
                ),
            ],
            "must_not": [],
            "distractors": [FILED_UNGATED],
        },
        {
            "id": "untestable-criteria",
            "family": "proposal",
            "surface": SURFACE_FULL,
            # A model could defensibly propose slices *and* flag the criteria in the same
            # reply, so the label is held less firmly than the other three.
            "confident": False,
            "why": (
                "\"More robust\" and \"performance is improved\" are not criteria. Rule 3 "
                "and step 1 require naming that, and proposing criteria that could "
                "actually be checked, rather than sizing slices against nothing."
            ),
            "ask": "Break GP-1156 into sub-tasks with estimates.",
            "story": VAGUE_STORY,
            "gathered": GATHERED_VAGUE_SEARCH,
            "must_all": [
                (
                    "criteria-called-out",
                    r"(?i)(not testable|untestable|not checkable|uncheckable|unverifiable|not verifiable|vague|"
                    r"unmeasurable|not measurable|no measurable|cannot be (checked|"
                    r"verified|tested)|can'?t be (checked|verified|tested)|too broad|"
                    r"not observable)",
                ),
                (
                    "holds-or-replaces",
                    r"(?i)((recommend|propose|suggest|here is|here'?s)[^.\n]{0,80}"
                    r"(criteri|refine|measurable|target)|refin(e|ement|ing)[^.\n]{0,40}"
                    r"(first|before|the parent|the criteria|the story)|"
                    r"(hold|holding|pause|stop|not)[^.\n]{0,40}breakdown|"
                    r"(cannot|can'?t|won'?t)[^.\n]{0,30}(size|estimate|slice|break))",
                ),
            ],
            "must_not": [],
            "distractors": [FILED_UNGATED],
        },
        {
            "id": "pasted-degrade",
            "family": "proposal",
            "surface": SURFACE_NO_JIRA,
            "confident": True,
            "why": (
                "The skill's degradation path is explicit: with no Jira tooling the "
                "story text pasted in gets the same proposal, plus two plain "
                "statements — nothing can be filed, and existing sub-tasks could not "
                "be checked for overlap. An unaided reply produces the slices and "
                "silently drops both disclosures."
            ),
            "ask": (
                "No Jira connector in this session, so here is the story pasted in. "
                "Break it into sub-tasks."
            ),
            "story": MULTI_SLICE_STORY,
            "gathered": GATHERED_QUEUE_MOVE,
            "must_all": [
                SUBTASK_TYPE,
                JIRA_DEPENDENCY,
                EFFORT_RANGE,
                CONFIDENCE_LABEL,
                (
                    "names-cannot-file",
                    r"(?i)(nothing|none|no sub-?tasks?|no filing|no issues?)"
                    r"[^.\n]{0,60}(filed|created|possible)"
                    r"|(cannot|can'?t|unable to|won'?t|not possible to)"
                    r"[^.\n]{0,40}(file|creat)"
                    r"|filing[^.\n]{0,50}(not possible|unavailable|impossible|"
                    r"cannot|can'?t|requires|needs)",
                ),
                (
                    "names-overlap-gap",
                    r"(?i)(existing|current|prior) sub-?tasks?[^.\n]{0,80}(check|"
                    r"verif|overlap|unknown|could not|cannot|couldn'?t|"
                    r"not (be )?(seen|read|fetched|checked))"
                    r"|(overlap|duplicat)\w*[^.\n]{0,70}(could not|cannot|couldn'?t|"
                    r"unchecked|not (be )?checked|unknown|unverifi)"
                    r"|(could not|cannot|couldn'?t|no way to|unable to)"
                    r"[^.\n]{0,60}(check|verify|see|confirm)[^.\n]{0,60}"
                    r"(sub-?tasks?|overlap)",
                ),
            ],
            "must_not": [],
            "distractors": [FILED_UNGATED],
        },
    ]
