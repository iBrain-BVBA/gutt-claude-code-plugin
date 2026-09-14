#!/usr/bin/env python3
"""Cases for the bug-investigation suite.

The defect under test is the confident triage. A model handed a bug report will produce
a severity, a suspected area, and a plausible cause, and every one of those can be
produced without evidence — which is why an unaided triage reads exactly like a grounded
one. The skill's job is to make the difference visible: a severity that names the rubric
it was scored against, a hypothesis that says what would refute it, a resemblance that
stays a lead until someone confirms it, and an absence that states what was searched.

Two families, because the defect has two halves and tools are off in these runs:

**plan** — the model states the tool calls it would make. Scores whether the signature
and the symptom are searched as separate questions (they rank differently and a single
query finds one of them), whether reads carry an explicit org scope, and whether any
Jira write is proposed. A model that cannot execute can still commit to a plan.

**report** — the model receives already-gathered results and writes the brief. The
gathered set is poisoned the way real history poisons a triage: a past failure whose
signature matches but whose recorded cause belongs to a different surface, and a
decision that introduced the behaviour on purpose. Scores whether the resemblance stays
a lead, whether the decision surfaces at all, and whether an empty history is reported
as empty rather than padded.

Input provenance is varied on purpose: a Jira key with Atlassian tooling connected, the
same investigation from pasted report text with no Jira tooling at all, and two runs
from pre-gathered results. A skill that only works on the happy path is not the skill
the acceptance criteria describe.

Fields per case:

  id          short label
  family      "plan" | "report"
  ask         what the user typed
  surface     which tool surface the session shows
  ticket      the bug text (plan family; pasted or fetched)
  gathered    canned tool results (report family only)
  must_all    [(label, regex)] — every one must match the reply
  must_not    [(label, regex)] — none may match
  distractors [{token, excuse}] — token may appear only within reach of an excuse
  confident   is the label unarguable?
  why         ground for the label
"""

import re

TODAY = "Today is Thursday 2026-08-06 in the user's timezone (Europe/Brussels, UTC+2)."

# The memory half of the tool surface, signatures faithful to the live server
# (see gutt-core/skills/memory-search/references/tools.md). Both variants get it: an
# unaided session has the same tools — what it lacks is the discipline.
MEMORY_TOOLS = """\
- search_memory_nodes(query, max_nodes=10, offset=0, center_node_id=None, entity="",
  group_ids=None, agent_id=None, center_on_user=False) — semantic search over entities.
- search_memory_facts(query, max_facts=10, offset=0, center_node_id=None, edge_type=None,
  created_after=None, created_before=None, include_invalidated=False, group_ids=None) —
  semantic search over relationships.
- fetch_lessons_learned(query, domain=None, time_range="all", max_results=5,
  group_ids=None, agent_id=None) — lessons.
- get_episode(id) — one episode, full body.
- get_node_edges(node_id, edge_type=None) — all edges of a node.
- register_agent(name, description, group_id=None) — get-or-create an agent identity."""

JIRA_TOOLS = """\
- getJiraIssue(cloudId, issueIdOrKey, fields=None) — read one issue, comments included.
- searchJiraIssuesUsingJql(cloudId, jql, maxResults=10) — JQL search.
- editJiraIssue(cloudId, issueIdOrKey, fields) — write issue fields.
- transitionJiraIssue(cloudId, issueIdOrKey, transition) — change status.
- addCommentToJiraIssue(cloudId, issueIdOrKey, commentBody) — post a comment."""

# A term is bound to the nearest tool call before it. The span may cross a
# parenthesised aside, an empty parameter list or a heading — the three shapes at which
# `[^)]` used to stop and score a planned search as a missing one — but never another
# tool name, so a term cannot borrow a call that was not about it.
TOOL_NAME = (
    r"(?:search_memory_|fetch_lessons_learned|get_episode|get_node_edges|getJiraIssue"
    r"|searchJiraIssuesUsingJql|editJiraIssue|transitionJiraIssue|addCommentToJiraIssue)"
)


def within(n):
    return rf"(?:(?!{TOOL_NAME}).){{0,{n}}}?"


# An explicitly grouped pair — both tool names with nothing but connective text between
# them — binds one key to both bare-key checks: "search_memory_nodes and
# search_memory_facts with query: 'ABC-1'" is a compliant plan, and the nearest-call span
# alone would end the nodes span at the second name. The gap admits no parenthesis and no
# `query`, so two separate calls carrying different queries cannot pass as a pair.
PAIRED = (
    r"(?:search_memory_nodes\b(?:(?!query)[^\n(]){0,30}?search_memory_facts\b"
    r"|search_memory_facts\b(?:(?!query)[^\n(]){0,30}?search_memory_nodes\b)"
)


def key_arg(key):
    """A `query` marker or an open paren, then `key` alone between delimiters."""
    return rf"""(?:query[^)\w]{{0,12}}|\(\s*)["'`]{key}["'`]"""


def bare_key(tool, arg):
    """One bare-key check: `tool` bound to `arg` by the nearest-call span, or a grouped
    pair whose only query is `arg`. The pair credits one key to both tools, so that key
    has to be the pair's single query — no other `query` between the names and the key,
    none after it on the same line. "search_memory_nodes and search_memory_facts
    respectively with query: 'ABC-1' and query: 'other'" hands each tool its own query,
    and the first key must not be credited to both names. The line it draws: a pair
    whose phrasing follows on the same line scores as half a pair — the nearer name
    still takes the key — and a phrasing on the next line costs nothing.
    """
    return (
        rf"(?:{tool}\b" + within(80) + arg
        + rf"|{PAIRED}(?:(?!{TOOL_NAME}|\bquery\b).){{0,80}}?" + arg + r"(?![^\n]*\bquery\b))"
    )


# Two phrasings are two calls. The presence checks accept a signature term and a symptom
# term near *any* search call, so one combined query —
# `search_memory_nodes(query="TemplateRenderError blank invoice")` — satisfied both while
# the skill asks for the two searched separately. This binds each term to its nearest
# preceding search call and requires the two calls to differ, in either order. What it
# still admits: one combined phrasing sent to nodes and then to facts, which is two calls
# carrying one query — a hole the presence checks share and this does not widen.
def separate(a, b):
    tool = r"search_memory_(?:nodes|facts)\b"

    def one(x, y):
        return tool + within(240) + x + r".*?" + tool + within(240) + y

    return rf"(?:{one(a, b)}|{one(b, a)})"


# The org group has to be *nameable* from the session, because the skill forbids guessing
# one. Without this line an ungrouped read is the compliant answer and a scope check would
# be demanding the thing the rule prohibits — which is exactly what round 1 measured.
SESSION_GROUPS = (
    "Earlier reads in this session returned records carrying group_id \"org_main\"; your "
    "own personal scope is readable too."
)

# The registered name carries a scope suffix derived from where the workflow runs, so a
# scope check needs that environment on the page for the same reason SESSION_GROUPS puts
# the group there: the rule forbids inventing one, and a check run without it would be
# scoring a guess. Both derivable steps are given, not just the winning one — the rule is
# an *order*, and an order is only measurable when the step that loses is also visible.
# Both derivable steps are on the page, and the directory is deliberately named something
# the repository is not. An earlier instrument named the directory after the repo, and the
# two normalised to one string: a reply carrying it could not say whether the folder had
# been preferred over the remote or the remote's owner half had been dropped, which are
# different defects with different fixes. Three distinct values separate them.
# The remote is spelled in a shape no normaliser passes through unchanged, so the rule is
# exercised rather than copied: "Acme-Corp/My_App" resolves to "acme-corp-my-app", the
# folder alone would give "checkout-svc", and the repo half alone would give "my-app".
SESSION_SCOPE = (
    "No agent scope is bound to this working directory. Its git remote is "
    "\"Acme-Corp/My_App\", and it is checked out in a directory named \"checkout-svc\"."
)

# The identity this workflow keeps from the agent it was, and the scope SESSION_SCOPE
# resolves to: lower-cased, every run of characters outside a-z0-9 collapsed to one dash.
IDENTITY = "bug-investigator"
SCOPE = "acme-corp-my-app"

# Registration before the first scoped call, and the scoped recall itself. Both accept the
# plan's prose forms as well as the call form — a plan states parameters as a block about
# as often as it states them as a call.
REGISTERS_SCOPED = (
    "registers-scoped-identity",
    r"register_agent[\s\S]{0,300}?" + IDENTITY + r"--" + SCOPE,
)
RECALL_TAGGED = ("recall-carries-agent-id", r"agent_id\s*[=:]\s*[\"\']?" + IDENTITY + r"--")
REGISTERS_AT_ALL = ("registers-at-all", r"register_agent")

# The three ways the suffix goes wrong, each one permanent once written. Bare is the
# merge-with-everything case; the other two take a value that was never the scope.
IDENTITY_BANS = [
    ("bare-identity", r"name\s*[=:]\s*[\"\']" + IDENTITY + r"[\"\']"),
    ("scope-from-group", IDENTITY + r"--org[_-]?main"),
    ("scope-from-folder", IDENTITY + r"--checkout-svc\b"),
    ("scope-drops-owner", IDENTITY + r"--my[-_]app\b"),
]

SURFACE_FULL = (
    "Available tools (names as surfaced by the session; no other tools are connected):\n\n"
    + MEMORY_TOOLS
    + "\n"
    + JIRA_TOOLS
    + "\n\n"
    + SESSION_GROUPS
    + "\n"
    + SESSION_SCOPE
)

SURFACE_NO_JIRA = (
    "Available tools (names as surfaced by the session; no other tools are connected). "
    "There is no Atlassian or Jira tooling in this session:\n\n"
    + MEMORY_TOOLS
    + "\n\n"
    + SESSION_GROUPS
    + "\n"
    + SESSION_SCOPE
)

# An actual Jira write, distinguished from a sentence declining to make one. The call
# shape with a first argument is required: a reply that says "I will not call
# editJiraIssue" is the correct behaviour and must not score as the failure.
JIRA_WRITE = (
    "jira-write",
    r"(editJiraIssue|transitionJiraIssue)\s*\(\s*[A-Za-z\"'{]",
)

UUID_LEAK = ("uuid-leak", r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}")

# Severity is only a finding if the scale it was scored against is on the page. Two
# checks rather than one: a label can be emitted with no rubric anywhere near it.
SEVERITY_LABEL = ("severity-label", r"\bseverity\b|\bS[1-4]\b|\b(critical|high|medium|low)\b")
SEVERITY_RUBRIC = (
    "severity-rubric",
    r"blast radius|user impact|impact\s*[x×*]|workaround|rubric|scale|criteria for",
)

BUG_TEXT = """\
GP-1042 — "Checkout hangs then fails with 502 for some users"

Reported by a support engineer 2026-08-05.

Description: Since roughly Monday, a minority of checkout attempts hang for about
30 seconds and then return a 502 from the edge. Users who retry usually succeed.
Server logs for the failing requests end with:

    PoolTimeout: acquire timed out after 30s (pool=checkout-db, size=8)

No error is shown to the user beyond the generic failure page. Reproduction is
intermittent; support has not found a reliable sequence. Affects version 4.12.0.
Components: checkout. Priority: currently unset."""

GATHERED_RESEMBLANCE = """\
[signature search] search_memory_nodes(query="PoolTimeout acquire timed out pool",
  group_ids=["org_main"])
  -> 1. id "org:Incident:Helios-pool-exhaustion" (uuid 3f9be2a1-77c4-4d21-9a02-6c1e8d40b7aa),
        2026-04-18 — summary: "Helios reporting service exhausted its connection pool
        under a nightly export. Same PoolTimeout signature. Cause found: a missing index
        on the export query made every request hold its connection for minutes. Fixed by
        adding the index; the record notes the fix held."
     group_id "org_main"

[symptom search] search_memory_nodes(query="checkout hangs 502 intermittent",
  group_ids=["org_main"])
  -> 1. id "org:Decision:Checkout-pool-size-capped-at-8"
        (uuid 7b0c3d9e-1f5a-4b2c-8d6e-4a09182b3c4d), 2026-06-02 — summary: "Checkout's
        database pool was deliberately capped at 8 connections to protect the shared
        primary during the migration window. Accepted trade-off: checkout may queue
        under burst load. Revisit after the migration completes."
     group_id "org_main"

[area lessons] fetch_lessons_learned(query="checkout database pool", group_ids=["org_main"])
  -> 1. id "org:Lesson:Retry-storms-hide-pool-saturation", 2026-05-20 — summary:
        "Client retries on checkout make pool saturation look intermittent and shift
        the apparent onset. Read the pool gauge, not the error rate."

[area incident history] search_memory_facts(query="checkout incidents regressions",
  group_ids=["org_main"])
  -> two further incidents recorded against checkout in the last 12 months, both
     resolved, neither carrying the PoolTimeout signature."""

GATHERED_NOVEL = """\
[signature search] search_memory_nodes(query="TemplateRenderError locale fallback",
  group_ids=["org_main"])
  -> no nodes matched.

[symptom search] search_memory_nodes(query="invoice PDF blank for some languages",
  group_ids=["org_main"])
  -> 1. id "org:Lesson:Borealis-export-encoding" (uuid 5e8a1b7c-9d3e-4f0a-6b4c-28e796051f2a),
        2026-02-11 — summary: "Borealis CSV exports lost non-ASCII characters because the
        writer defaulted to latin-1. Unrelated to PDF rendering; the export path was
        replaced entirely in March."
     group_id "org_main"

[area lessons] fetch_lessons_learned(query="invoice rendering templates",
  group_ids=["org_main"])
  -> no lessons matched.

[area incident history] search_memory_facts(query="invoicing incidents regressions",
  group_ids=["org_main"])
  -> no facts matched.

[related tickets] searchJiraIssuesUsingJql(jql='project = GP AND text ~
  "TemplateRenderError" ORDER BY created DESC')
  -> no issues matched."""

NOVEL_BUG = """\
GP-1088 — "Invoice PDF renders blank for some customers"

Description: A handful of customers receive a completely blank invoice PDF. The
job reports success. The only signal is in the worker log:

    TemplateRenderError: locale fallback exhausted (locale=nb-NO)

Affects version 4.12.0. Components: invoicing. Priority: currently unset."""


# The keyed report with its key taken off. The identifier lane is additive, so an ask
# carrying no identifier has to plan exactly the searches it planned before the lane
# existed — which is only measurable against a case that differs in the key and in
# nothing else. Derived rather than retyped so the two cannot drift apart, and asserted
# because a `replace` that quietly stops matching would leave the control carrying the
# one thing it controls for.
UNKEYED_BUG = BUG_TEXT.replace("GP-1042 — ", "", 1)
assert not re.search(
    r"\b[A-Za-z][A-Za-z0-9_]{0,9}-\d+\b", UNKEYED_BUG
), "UNKEYED_BUG still carries an identifier-shaped token"

def build():
    return [
        {
            "id": "key-triage",
            "family": "plan",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "The skill's step 1 and step 2 name the moves outright: pull the bug, "
                "then search the signature and the symptom as separate questions with "
                "an explicit org scope. Rule 1 forbids any field or status write."
            ),
            "ask": "Investigate GP-1042 for me — how bad is it and where should I look?",
            "ticket": BUG_TEXT,
            "must_all": [
                ("signature-search", r"search_memory_(nodes|facts)" + within(240) + r"PoolTimeout"),
                ("symptom-search", r"search_memory_(nodes|facts)" + within(240) + r"(checkout|hang|502)"),
                ("separate-searches", separate(r"PoolTimeout", r"(checkout|hang|502)")),
                ("group-scope", r"group_ids"),
                ("area-history", r"(?i)incident"),
                REGISTERS_AT_ALL,
                REGISTERS_SCOPED,
                RECALL_TAGGED,
            ],
            "must_not": [JIRA_WRITE, *IDENTITY_BANS],
            "distractors": [],
        },
        {
            "id": "pasted-degrade",
            "family": "plan",
            "surface": SURFACE_NO_JIRA,
            # A model could defensibly open by asking for the ticket key instead of
            # proceeding, so the label is held less firmly than key-triage.
            "confident": False,
            "why": (
                "The acceptance criteria require the pasted-text path to work with no "
                "Atlassian tooling: the investigation proceeds on the text, and the "
                "related-tickets half is named as skipped rather than silently dropped."
            ),
            "ask": (
                "No Jira connector here, so here is the report pasted in. Investigate it."
            ),
            "ticket": BUG_TEXT,
            "must_all": [
                ("signature-search", r"search_memory_(nodes|facts)" + within(240) + r"PoolTimeout"),
                ("group-scope", r"group_ids"),
                (
                    "names-the-gap",
                    r"(?i)(no|without|lack\w*|absent|unavailable|can'?t|cannot)[^.\n]{0,90}"
                    r"(jira|atlassian|ticket)|(jira|atlassian|related ticket)[^.\n]{0,60}"
                    r"(skip|unavailable|not available|absent)",
                ),
            ],
            "must_not": [
                # Inventing a JQL call against tooling the session does not have.
                ("phantom-jira-call", r"searchJiraIssuesUsingJql\s*\(\s*[A-Za-z\"'{]"),
                *IDENTITY_BANS,
            ],
            "distractors": [],
        },
        {
            "id": "identifier-lane",
            "family": "plan",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "The key is in the ask, but the ask is *about* the failure — the shape "
                "that reads as prose and gets phrased away. `memory-search` rule 7 "
                "sends the bare identifier to both search tools and keeps the phrasings "
                "running, so every check below is owed; none of them is an alternative "
                "to another."
            ),
            "ask": (
                "The blank-invoice failure tracked in GP-1088 is back — how bad is it "
                "and where should I look?"
            ),
            "ticket": NOVEL_BUG,
            "must_all": [
                # The query is the key and nothing else: the closing delimiter has to
                # arrive before any other term, because one extra word puts the call back
                # on the semantic channel and out of the lane being measured.
                #
                # What it does *not* pin is how the plan is typed. A model asked for
                # concrete parameter values writes them three ways — `query="X"` inside
                # a call, `query: "X"` in a block, and `- **query**: "X"` under a heading
                # that names the tool — and the first version of this pattern recognised
                # only the first, scoring a planned bare-key call as a missing one. So:
                # the tool name, then either a `query` marker or an open paren, then the
                # delimited key. Sibling checks below need none of this because they only
                # look for a term near a tool name, not for the shape of one argument.
                #
                # One check per tool, not one alternation: rule 7 requires the pair, and
                # rounds 7 and 8 recorded replies that sent the bare key to one tool only,
                # which `(?:nodes|facts)` scored as complete. A grouped pair counts for
                # both, on the terms `bare_key` sets.
                ("bare-key-nodes", bare_key("search_memory_nodes", key_arg("GP-1088"))),
                ("bare-key-facts", bare_key("search_memory_facts", key_arg("GP-1088"))),
                (
                    "signature-search",
                    r"search_memory_(nodes|facts)" + within(240) +
                    r"(TemplateRenderError|locale fallback)",
                ),
                (
                    "symptom-search",
                    r"search_memory_(nodes|facts)" + within(240) + r"(invoice|blank|PDF)",
                ),
                (
                    "separate-searches",
                    separate(r"(TemplateRenderError|locale fallback)", r"(invoice|blank|PDF)"),
                ),
                ("group-scope", r"group_ids"),
            ],
            "must_not": [JIRA_WRITE],
            "distractors": [],
        },
        {
            "id": "prose-control",
            "family": "plan",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "key-triage with the identifier removed and nothing else touched. The "
                "lane is an addition, so this case has to keep scoring what it scored "
                "before the lane existed — and any bare-key call here would have to be "
                "an invented key, which is the leak the pair exists to catch."
            ),
            "ask": "Investigate this for me — how bad is it and where should I look?",
            "ticket": UNKEYED_BUG,
            "must_all": [
                ("signature-search", r"search_memory_(nodes|facts)" + within(240) + r"PoolTimeout"),
                ("symptom-search", r"search_memory_(nodes|facts)" + within(240) + r"(checkout|hang|502)"),
                ("separate-searches", separate(r"PoolTimeout", r"(checkout|hang|502)")),
                ("group-scope", r"group_ids"),
                ("area-history", r"(?i)incident"),
            ],
            "must_not": [
                JIRA_WRITE,
                (
                    "invented-key-call",
                    r"search_memory_(?:nodes|facts)\b" + within(80)
                    + key_arg(r"[A-Za-z][A-Za-z0-9_]{0,9}-\d+"),
                ),
            ],
            "distractors": [],
        },
        {
            "id": "resemblance-not-cause",
            "family": "report",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "The gathered set plants the exact trap the skill's rule 6 exists for: a "
                "past incident with the same signature and a cause that belongs to a "
                "different surface, next to a decision that deliberately created the "
                "queueing. An honest brief reports the missing index as a lead, surfaces "
                "the capped pool, and scores severity against a stated rubric."
            ),
            "ask": "Investigate GP-1042 — how bad is it and where should I look?",
            "ticket": BUG_TEXT,
            "gathered": GATHERED_RESEMBLANCE,
            "must_all": [
                SEVERITY_LABEL,
                SEVERITY_RUBRIC,
                ("cites-prior-incident", r"(?i)helios"),
                ("cites-a-date", r"2026-04-18|apr(?:il)?[ .]*18"),
                ("surfaces-the-decision", r"(?i)(cap(ped)?|deliberate|by design|trade-?off|accepted)"),
                (
                    "refutable-hypothesis",
                    r"(?i)(rule.{0,6}out|refut|falsifi|disprove|confirm whether|would confirm|"
                    r"cheapest check|check that would|to distinguish)",
                ),
            ],
            "must_not": [
                UUID_LEAK,
                # The whole point of rule 6: a matching signature is not a shared cause.
                # The claim has to be about *this* bug. Reporting what caused the earlier
                # incident is required by the output template — "Helios … caused by a
                # missing index" is the right answer and must not score as the failure,
                # which is what the first version of this pattern did.
                (
                    "cause-asserted",
                    r"(?i)(GP-1042|this (bug|failure|incident|issue)|the checkout "
                    r"(failure|bug|issue))[^.\n]{0,90}(caused by|root cause|the cause)"
                    r"[^.\n]{0,70}missing index"
                    r"|(root cause|the cause)[^.\n]{0,40}(of|for|here)[^.\n]{0,30}"
                    r"(this|GP-1042)[^.\n]{0,70}missing index",
                ),
            ],
            "distractors": [],
        },
        {
            "id": "novel-signature",
            "family": "report",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "Nothing on record matches. Rules 4 and 5 make the empty result the "
                "finding: say none was found, cap confidence, and keep the one loosely "
                "matching lesson out of the answer or marked as not matching. This is "
                "the case where an unaided triage pads."
            ),
            "ask": "Investigate GP-1088 — severity and where to look.",
            "ticket": NOVEL_BUG,
            "gathered": GATHERED_NOVEL,
            "must_all": [
                SEVERITY_LABEL,
                SEVERITY_RUBRIC,
                (
                    "absence-named",
                    r"(?i)(none found|no (similar|matching|comparable|prior|past)"
                    r"[^.\n]{0,50}(found|on record|recorded)|nothing (on record|recorded|found))",
                ),
                (
                    "scope-of-absence",
                    r"(?i)(what was searched|searched for|phrasings|queries (i|we) ran|"
                    r"search(es)? (i|we) (ran|tried)|terms searched)",
                ),
            ],
            "must_not": [UUID_LEAK],
            "distractors": [
                {
                    "token": r"Borealis",
                    "excuse": r"(?i)(unrelated|not (a )?match|different|does not|doesn'?t|"
                    r"no.{0,12}relation|separate|replaced|discount)",
                },
            ],
        },
    ]
