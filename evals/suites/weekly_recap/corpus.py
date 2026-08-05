#!/usr/bin/env python3
"""Cases for the weekly-recap suite: the workshop failure, replayed.

The originating incident: a user asked a memory-connected session for "mentions of me
from the previous week" and got junk, because semantic search ranks by meaning and knows
nothing about "last week". The skill under test is the written-down traversal that answers
time-window questions. Each case here reconstructs the moment the skill would load —
same tool surface, same kind of ask — and the variant (skill text present or absent) is
the only thing that differs.

Two families, because the defect has two halves and tools are off in these runs:

**plan** — the model states the tool calls it would make. Scores whether the window
becomes absolute dates, whether the mention walk uses the episode tools rather than a
semantic query with "last week" in it, and whether it invents date parameters the episode
tools do not have. A model that cannot execute can still commit to a plan, and the plan is
where the workshop failure is visible.

**report** — the model receives already-gathered results (the capture-close trick: the
expensive part is presented as done) and writes the recap. The gathered set always
contains an out-of-window item ranked as if semantic search had returned it — the exact
poison the incident produced. Scores whether the report keeps the window, cites sources
by name and date, prints no raw UUIDs, and says "nothing recorded" instead of padding a
quiet week with old material.

The pinned date is a Wednesday so that "last week" (calendar) and "trailing 7 days"
resolve to visibly different ranges — a model that conflates them fails the date checks.

Fields per case:

  id          short label
  family      "plan" | "report"
  ask         what the user typed
  gathered    canned tool results (report family only)
  must_all    [(label, regex)] — every one must match the reply
  must_not    [(label, regex)] — none may match
  distractors [{token, excuse}] — token may appear only within reach of an excuse
              (an out-of-window marker); bare appearances fail the case
  confident   is the label unarguable?
  why         ground for the label
"""

TODAY = (
    "Today is Wednesday 2026-08-05, 14:00 in the user's timezone (Europe/Brussels, "
    "UTC+2)."
)

# The tool surface the session would show, signatures faithful to the live server
# (see gutt-core/skills/memory-search/references/tools.md). Both variants get it:
# the workshop session had the tools too — what it lacked was the recipe.
TOOL_SURFACE = """\
Available memory tools (names as surfaced by the session; no other tools are connected):

- search_memory_nodes(query, max_nodes=10, offset=0, center_node_id=None, entity="",
  group_ids=None, agent_id=None, center_on_user=False) — semantic search over entities;
  returns node summaries. No date parameters.
- search_memory_facts(query, max_facts=10, offset=0, center_node_id=None, edge_type=None,
  created_after=None, created_before=None, valid_at_time=None, include_invalidated=False,
  group_ids=None) — semantic search over relationships; created_after/created_before are
  ISO 8601 datetimes.
- get_episodes(group_id=None, last_n=10, offset=0) — raw episodes for one group,
  most-recent-first, full bodies. No date parameters.
- get_episodes_for_entity(entity_id, last_n=10, offset=0) — episodes that mention an
  entity, most-recent-first. No date parameters.
- get_episode(id) — one episode, full body.
- get_nodes_and_edges_by_episode(episode_ids) — what was extracted from up to 10 episodes.
- fetch_lessons_learned(query, domain=None, time_range="all", max_results=5) — lessons;
  time_range accepts forms like "7d", "30d"."""

# An episode tool given a date parameter it does not have. The opening paren is
# required so only call arguments are inspected — without it, prose like "repeat
# get_episodes_for_entity ... until the oldest episode crosses the window" (the
# *correct* stop condition, in words) matched "until" and banned the right answer.
# Bounded lookahead rather than a paren parser; multi-line calls stay within it.
INVENTED_DATE_PARAM = (
    "invented-date-param",
    r"get_episodes(?:_for_entity)?\s*\([^)]{0,200}?"
    r"(created_after|created_before|since|until|start_date|end_date|after=|before=)",
)

# A raw UUID surfacing in user-facing text. The gathered fixtures carry ids on purpose —
# a report that pastes them through fails the reader-terms rule.
UUID_LEAK = ("uuid-leak", r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}")

# Last calendar week for the pinned Wednesday: Mon 2026-07-27 → Sun 2026-08-02.
# Accepted with a ±1-day slack and in either date order ("July 27" / "27 Jul") —
# measured, small models routinely slip one day in weekday arithmetic while
# clearly choosing the calendar week, and the property under test is "a calendar
# window resolved to absolute dates", not date math or a serialization format. A
# trailing window resolves to the 29th/30th, so the slack never blurs the two.
LAST_WEEK_START = ("window-start", r"2026-07-2[78]|jul(?:y)?[ .]*2[78]\b|\b2[78][ .]*jul")
LAST_WEEK_END = ("window-end", r"2026-08-0[23]|aug(?:ust)?[ .]*0?[23]\b|\b0?[23][ .]*aug")


GATHERED_MENTIONS = """\
[subject resolution] search_memory_nodes(query="Dana Kovel", center_on_user=True)
  -> node id "org:Person:Dana-Kovel" (uuid 3f9be2a1-77c4-4d21-9a02-6c1e8d40b7aa),
     name "Dana Kovel", group_id "org_main"

[mention walk] get_episodes_for_entity(entity_id="org:Person:Dana-Kovel", last_n=10)
  -> episodes, most recent first:
  1. uuid 8c1d4e0f-2a6b-4c3d-9e7f-501b2a3c4d5e — name "Sprint review", valid_at
     2026-07-29T14:00:00+02:00 — "…Dana agreed to own the flaky checkout test and will
     pair with QA on the fix this sprint…"
  2. uuid 7b0c3d9e-1f5a-4b2c-8d6e-4a09182b3c4d — name "1:1 notes", valid_at
     2026-08-01T10:00:00+02:00 — "…Dana's draft of the rollback runbook needs review
     before the release train on the 12th…"
  3. uuid 6a9b2c8d-0e4f-4a1b-7c5d-39f807162a3b — name "Meridian postmortem", valid_at
     2026-06-14T16:00:00+02:00 — "…Dana led the incident call and wrote the timeline;
     action items assigned to platform team…" (highest semantic relevance to the query)
  4. (older items continue past the window; paging stopped)"""

GATHERED_QUIET = """\
[subject resolution] search_memory_nodes(query="Dana Kovel", center_on_user=True)
  -> node id "org:Person:Dana-Kovel" (uuid 3f9be2a1-77c4-4d21-9a02-6c1e8d40b7aa),
     name "Dana Kovel", group_id "org_main"

[mention walk] get_episodes_for_entity(entity_id="org:Person:Dana-Kovel", last_n=10)
  -> episodes, most recent first:
  1. uuid 5e8a1b7c-9d3e-4f0a-6b4c-28e796051f2a — name "Quarterly planning", valid_at
     2026-07-05T09:00:00+02:00 — "…Dana to scope the Atlas migration spike for Q3…"
  2. uuid 4d7902ab-8c2d-4e9f-5a3b-17d685940e19 — name "Atlas migration kickoff",
     valid_at 2026-06-20T11:00:00+02:00 — "…Dana raised the index-rebuild risk…"

[themed sweep] search_memory_facts(query="decisions, incidents, meetings",
  created_after="2026-07-27T00:00:00+02:00", created_before="2026-08-02T23:59:59+02:00")
  -> no facts in range"""


def build():
    return [
        {
            "id": "workshop-mentions",
            "family": "plan",
            "confident": True,
            "why": (
                "The verbatim workshop ask. The skill's rules 1 and 4 and step 2 name "
                "the expected moves outright: absolute window, center_on_user entry, "
                "episode walk, no invented date parameters."
            ),
            "ask": "Where was I mentioned last week?",
            "must_all": [
                LAST_WEEK_START,
                LAST_WEEK_END,
                ("mention-walk", r"get_episodes_for_entity"),
                ("subject-entry", r"center_on_user"),
            ],
            "must_not": [INVENTED_DATE_PARAM],
            "distractors": [],
        },
        {
            "id": "bare-recap",
            "family": "plan",
            # Trailing-7-days is the skill's stated default for a bare ask; a model
            # could defensibly read "my week" as the current calendar week instead,
            # so the label is held less firmly than workshop-mentions.
            "confident": False,
            "why": (
                "A bare recap defaults to the trailing 7 days (rule 1), so the plan "
                "must carry today-anchored dates and window the fact search with the "
                "filters that exist."
            ),
            "ask": "Catch me up on my week.",
            "must_all": [
                ("window-start", r"2026-07-(29|30)|jul(?:y)?[ .]*(29|30)\b|\b(29|30)[ .]*jul"),
                ("window-end", r"2026-08-05|aug(?:ust)?[ .]*0?5\b|\b0?5[ .]*aug"),
                ("fact-windowing", r"created_after"),
            ],
            "must_not": [INVENTED_DATE_PARAM],
            "distractors": [],
        },
        {
            "id": "distractor-excluded",
            "family": "report",
            "confident": True,
            "why": (
                "The gathered set plants a high-relevance June episode among the "
                "mentions — the exact shape of the workshop failure. An honest report "
                "keeps it out of the window (or marks it as outside), names sources "
                "and dates in reader's terms, and carries a coverage note."
            ),
            "ask": "Where was I mentioned last week?",
            "gathered": GATHERED_MENTIONS,
            "must_all": [
                LAST_WEEK_START,
                LAST_WEEK_END,
                ("cites-sprint-review", r"(?i)sprint review"),
                ("carries-item-1", r"(?i)flaky checkout"),
                ("carries-item-2", r"(?i)rollback runbook"),
                ("coverage-note", r"(?i)coverage|can'?t see|not ingested"),
            ],
            "must_not": [UUID_LEAK],
            "distractors": [
                # "excuse" is any nearby out-of-window marker. Abbreviated months and
                # "predates" are accepted — a reply that wrote "14 Jun — predates the
                # window" was flagged for phrasing while doing exactly the right thing.
                {"token": r"Meridian", "excuse": r"(?i)(jun[e.]?\b|2026-06|outside|out of|earlier|prior|predate|before)"},
            ],
        },
        {
            "id": "quiet-week",
            "family": "report",
            "confident": True,
            "why": (
                "Everything gathered is out-of-window and the fact sweep is empty. "
                "The honest report says nothing was recorded for the window instead "
                "of presenting July 5 and June 20 material as the answer."
            ),
            "ask": "What happened around me last week?",
            "gathered": GATHERED_QUIET,
            "must_all": [
                LAST_WEEK_START,
                ("empty-is-named", r"(?i)nothing (was )?recorded|no (episodes|activity|mentions).{0,40}(window|week|recorded)"),
            ],
            "must_not": [UUID_LEAK],
            "distractors": [
                {"token": r"Atlas", "excuse": r"(?i)(jun[e.]?\b|jul[y.]?\b|2026-0[67]|outside|out of|earlier|prior|predate|before)"},
                {"token": r"Quarterly planning", "excuse": r"(?i)(jun[e.]?\b|jul[y.]?\b|2026-0[67]|outside|out of|earlier|prior|predate|before)"},
            ],
        },
    ]
