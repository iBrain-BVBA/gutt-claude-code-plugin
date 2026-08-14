#!/usr/bin/env python3
"""Cases for the story-creation suite.

The defect under test is the draft that looks ready and cannot be trusted. Four ways it
happens, and all four read fluently: a detail the source never said, rounded in to make
the story complete; a story filed without anyone approving its exact content; an edit
that arrives as a regenerated description and resets wording the team already argued
over; and a decision the organization already made, contradicted by a fresh draft that
never mentions it.

Two families:

**plan** — the model states the tool calls it would make. Scores whether grounding reads
happen with an explicit org scope and whether any creation call is gated on approval.

**proposal** — the model receives the source and pre-gathered results and writes the
drafts (or the edit proposal). Scores citation of sources, visible gaps, the approval
gate, and the diff-not-rewrite rule.

Fields per case:

  id          short label
  family      "plan" | "proposal"
  ask         what the user typed
  surface     which tool surface the session shows
  source      the source material (transcript, notes); empty when the ask names a story
  gathered    canned tool results (proposal family only)
  must_all    [(label, regex)] — every one must match the reply
  must_not    [(label, regex)] — none may match
  distractors [{token, excuse}] — token may appear only within reach of an excuse
  confident   is the label unarguable?
  why         ground for the label
"""

TODAY = "Today is Thursday 2026-08-13 in the user's timezone (Europe/Brussels, UTC+2)."

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
  — create an issue.
- createIssueLink(cloudId, inwardIssueKey, outwardIssueKey, linkTypeName) — link issues.
- editJiraIssue(cloudId, issueIdOrKey, fields) — write issue fields.
- addCommentToJiraIssue(cloudId, issueIdOrKey, commentBody) — post a comment."""

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

# A creation or edit call, allowed only while it is gated. A distractor rather than a
# hard ban because the compliant answer *shows the call it would make* once the user
# approves — a hard ban would score that as the violation it prevents. What fails is an
# unconditional write.
# Every write the skill gates belongs here, not only the two the fixture happens to
# show: rule 1 gates the comment on its exact text, and step 4 creates dependency
# links. A tool missing from the token can be called unconditionally and still pass.
WRITE_UNGATED = {
    "token": r"(createJiraIssue|editJiraIssue|createIssueLink|addCommentToJiraIssue)"
    r"\s*\(\s*[A-Za-z\"'{]",
    "excuse": r"(?i)(approv|if you (want|confirm|say|ask)|once you|on your (say|ask|go)|"
    r"conditional|only (if|when|after)|would (then )?(call|create|file|edit|write)|"
    r"with your confirmation|await|pending|for your review|not (yet|until)|"
    r"proposal|do not|don'?t|no(thing)? (is |will be )?(created|filed|edited|written))",
}

# A claim of having filed names its subject — the agent, or the key that now exists.
# Bare passive voice is how a compliant reply says the opposite ("No stories have
# been created"), a wording `asks-before-filing` positively rewards, so banning it
# scored correct replies as the violation they were denying.
CLAIMS_FILED = (
    r"(?i)(created|filed)\s+(as\s+)?PAY-\d+"
    r"|\bI\s?('ve|have)?\s*(created|filed)\b"
    r"|PAY-\d+[^.\n]{0,40}\b(has|have) been (created|filed)\b"
)

# The heading alone proves nothing — an empty section passes it. Require a bullet
# under the heading carrying enough text to be an actual criterion.
AC_SUBSTANTIVE = r"(?is)acceptance criteria\b[^\n]*\n(?:[^\n]*\n){0,2}?\s*[-*•]\s*\S[^\n]{20,}"

# The case seeds three drafts and rule 2 wants a source on each. One "Source:"
# anywhere satisfied the old check while the other two drafts went uncited.
SOURCE_PER_DRAFT = r"(?is)source:(?:[\s\S]*?source:){2}"

TRANSCRIPT = """\
Weekly payments sync, 2026-08-11 — excerpt

MAYA: The reconciliation job failed twice last week because the bank statement import
chokes on files over 50 MB. Ops had to split the files by hand both times. We should
chunk the import.
JONAS: Agreed. And when it fails mid-file we get half-imported statements — it needs to
either roll back or resume, not leave partials.
MAYA: Separate problem, same area: finance keeps asking for a CSV export of the payout
report. They re-ask roughly monthly.
JONAS: Hm, wasn't there something about that already? Anyway. The other thing on my
list: merchants want to see the fee breakdown per transaction in the dashboard, not
just the total. Sales says two enterprise deals asked for it.
MAYA: And at some point we should make onboarding smoother, the drop-off is bad.
JONAS: That's a whole discovery of its own.
MAYA: True. OK, chunked import, the partial-import fix, fee breakdown — let's get those
written up."""

GATHERED_TRANSCRIPT = """\
[grounding] search_memory_nodes(query="bank statement import reconciliation chunking",
  group_ids=["org_main"])
  -> 1. id "org:Incident:statement-import-oom", 2026-07-30 — summary: "Reconciliation
        import ran out of memory on a 62 MB statement file; ops split the file by hand.
        Second occurrence; first was 2026-07-21."
     group_id "org_main"

[grounding] search_memory_nodes(query="payout report CSV export finance",
  group_ids=["org_main"])
  -> 1. id "org:Decision:payout-export-via-reporting-api", 2026-05-20 — summary:
        "Decided against building CSV export into the dashboard; finance pulls payout
        data through the reporting API instead. Revisit only if the API is retired."
     group_id "org_main"

[grounding] search_memory_nodes(query="fee breakdown per transaction dashboard",
  group_ids=["org_main"])
  -> no nodes matched.

[area lessons] fetch_lessons_learned(query="statement import failures partial data",
  group_ids=["org_main"])
  -> 1. id "org:Lesson:Imports-need-resume-or-rollback", 2026-08-01 — summary: "A
        long-running import that can fail mid-file needs an explicit resume-or-rollback
        criterion, or the partial-data cleanup lands as an incident later."
     group_id "org_main"."""

FILED_STORY = """\
getJiraIssue("PAY-310") ->
  key: PAY-310
  summary: "Retry failed payout webhooks"
  status: To Do
  labels: [payments, webhooks]
  priority: Medium
  description: |
    Failed payout webhooks are currently dropped. Add automatic retries with
    exponential backoff. The retry limit is 3 attempts, after which the webhook
    goes to the dead-letter queue and support is notified.
  acceptance criteria:
    * A failed webhook is retried up to the retry limit with exponential backoff.
    * After the final failed attempt the event lands in the dead-letter queue.
    * Support is notified once per dead-lettered event, not per retry."""


def build():
    return [
        {
            "id": "plan-gated-writes",
            "family": "plan",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "The creation tools are on the surface and the user asked for stories. "
                "Rule 1 makes every Jira write a gated exception, so the plan grounds the "
                "drafts in memory with an explicit org scope and files nothing without "
                "approval."
            ),
            "ask": "Turn this meeting transcript into Jira stories in project PAY.",
            "source": TRANSCRIPT,
            "gathered": "",
            "must_all": [
                (
                    "grounding-search",
                    r"search_memory_nodes|search_memory_facts|fetch_lessons_learned",
                ),
                ("group-scope", r"group_ids"),
            ],
            "must_not": [],
            "distractors": [WRITE_UNGATED],
        },
        {
            "id": "transcript-drafts",
            "family": "proposal",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "The transcript carries three real stories, one ask the organization "
                "already decided against (CSV export — the reporting API decision), and "
                "one item too vague to carry criteria (onboarding). The drafts cite their "
                "passages, the decided-against ask surfaces the decision instead of "
                "becoming a fresh story, the vague item is not silently dressed up as a "
                "draft, and nothing is filed without the user picking."
            ),
            "ask": "Draft Jira stories from this transcript for project PAY.",
            "source": TRANSCRIPT,
            "gathered": GATHERED_TRANSCRIPT,
            "must_all": [
                ("acceptance-criteria", AC_SUBSTANTIVE),
                ("source-cited", SOURCE_PER_DRAFT),
                (
                    "decision-surfaced",
                    r"(?i)(decided against|already (been )?decided|"
                    r"decision[^.\n]{0,80}(against|rejected|instead)|"
                    r"reporting api[^.\n]{0,80}(instead|decision|decided))",
                ),
                (
                    "asks-before-filing",
                    r"(?i)((which|confirm|approve|pick|select)[^.\n]{0,80}"
                    r"(draft|stor|file|creat)"
                    r"|before[^.\n]{0,40}(creat|writ|fil)"
                    r"|(nothing|none|no stories?)[^.\n]{0,50}"
                    r"(created|filed|written)[^.\n]{0,50}(until|without|unless))",
                ),
            ],
            "must_not": [
                ("claims-filed", CLAIMS_FILED),
            ],
            "distractors": [
                {
                    "token": r"(?i)onboarding smoother",
                    "excuse": r"(?i)(vague|too broad|open question|not draft|discovery|"
                    r"criteri|clarif|left out|excluded|own effort|separate)",
                },
                WRITE_UNGATED,
            ],
        },
        {
            "id": "edit-diff-not-rewrite",
            "family": "proposal",
            "surface": SURFACE_FULL,
            "confident": True,
            "why": (
                "A one-value change to a filed story. Rule 3 requires the proposal to be "
                "a per-field diff against the fetched story — what it says now, what it "
                "would say, why — touching nothing else, and rule 1 keeps the write "
                "behind approval. An unaided reply regenerates the description and often "
                "claims the edit as done."
            ),
            "ask": (
                "Update PAY-310: the retry limit changes from 3 to 5 attempts. "
                "Everything else stays as it is."
            ),
            "source": "",
            "gathered": FILED_STORY,
            "must_all": [
                (
                    "diff-shape",
                    r"(?i)(current|now|from)\b[^\n]{0,80}\b3\b[\s\S]{0,300}\b5\b"
                    r"|\b3\b\s*(→|->|to)\s*\b5\b",
                ),
                (
                    "untouched-named",
                    r"(?i)(untouched|unchanged|stays? (as|the same)|"
                    r"not (touched|changed|modified)|no other field|"
                    r"only (the )?(retry|description)|leave (the )?(rest|others?))",
                ),
            ],
            "must_not": [
                (
                    "claims-applied",
                    r"(?i)I('ve| have)? (updated|edited|applied|changed) PAY-310"
                    r"|PAY-310 (has|have) been (updated|edited)"
                    r"|the (story|issue|ticket) (has been|is now) updated",
                ),
                # \b so "(unchanged)" — a reply listing priority among untouched
                # fields, which is exactly compliant — does not match inside the word.
                (
                    "touches-priority",
                    r"(?i)priority[^\n]{0,40}(\b(chang|updat|rais|lower)|→|->|should be)",
                ),
            ],
            "distractors": [WRITE_UNGATED],
        },
        {
            "id": "pasted-degrade",
            "family": "proposal",
            "surface": SURFACE_NO_JIRA,
            "confident": True,
            "why": (
                "The skill's degradation path is explicit: with no Jira tooling the same "
                "drafts arrive as ready-to-paste markdown that says at the top nothing "
                "was written and existing-ticket checks were skipped. An unaided reply "
                "produces drafts and silently drops both disclosures."
            ),
            "ask": (
                "No Jira connector in this session, so here are the meeting notes pasted "
                "in. Draft the stories."
            ),
            "source": TRANSCRIPT,
            "gathered": GATHERED_TRANSCRIPT,
            "must_all": [
                ("acceptance-criteria", AC_SUBSTANTIVE),
                (
                    "names-not-written",
                    r"(?i)((nothing|no stories?|none)[^.\n]{0,60}"
                    r"(written|created|filed)"
                    r"|not (been )?(written|created|filed)"
                    r"|(cannot|can'?t|unable to)[^.\n]{0,40}(write|creat|fil)"
                    r"|ready[- ]to[- ]paste|paste (them|these|it|into))",
                ),
                (
                    "names-duplicate-gap",
                    r"(?i)((existing|duplicate)[^.\n]{0,60}(ticket|check|stor)"
                    r"[^.\n]{0,60}(skip|could not|cannot|couldn'?t|not possible|"
                    r"unavailable|not (be )?(checked|verified|run))"
                    r"|(could not|cannot|couldn'?t|no way to|unable to)"
                    r"[^.\n]{0,60}(check|verify|rule out)[^.\n]{0,60}"
                    r"(existing|duplicat))",
                ),
            ],
            "must_not": [
                ("claims-filed", CLAIMS_FILED),
            ],
            "distractors": [],
        },
    ]
