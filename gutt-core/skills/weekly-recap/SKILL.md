---
name: weekly-recap
description: "Build a cited recap of a time window for a person, project, or team — what happened, what was decided, which incidents and lessons landed, and where the subject was mentioned — from organizational memory, enriched with work-tracker activity when those tools are present. Produces a plain-language, cited report in the reply, never writes anywhere. Use when someone returns from time away, prepares a standup or 1:1, or asks where they were mentioned. Triggers on: recap, catch me up, what did I miss, what happened last week, mentions of me, where was I mentioned, weekly summary, my week, while I was away, since Monday, what changed recently."
---

# Weekly Recap

A recap is a time-window question, and the graph's semantic search has no
sense of time: it ranks by relevance, so asking it for "mentions of me last
week" returns the best matches from any month and silently drops the week.
The knowledge is in the graph; what is missing is the traversal. This skill
is that traversal, written down: pivot from the subject's node to the
episodes that mention it, sweep the window with the date filters that do
exist, and turn what comes back into a brief a human wants to read —
plain language, themed bullets, every line carrying its source and date.

Underneath, `memory-search` owns the search ladder and the relevance gate,
`graph-traversal` owns relationship walking, and `memory-capture` owns any
durable write; they ship with this plugin. The steps below compose those
skills rather than bypass them: subject resolution and the themed sweep
run under `memory-search`'s rules, relationship checks under
`graph-traversal`'s — only the window-paging of episode lists is native
to this skill. Work-tracker access comes from whatever tooling the
session surfaces (issue tracker, wiki, or none); names and prefixes vary
per install.

## Hard rules (non-negotiable — read first)

1. **Resolve the window to absolute datetimes before any call, and print
   it.** The report header states start, end, and timezone. A bare "recap"
   defaults to the trailing 7 days ending now. A named period means that
   calendar period in the user's timezone — "last week" is the previous
   Monday-to-Sunday week, "June" is June 1–30; a named period is never a
   trailing window. Tool calls take the resolved values; a relative
   phrase never reaches a parameter.
2. **Read-only.** No writes to memory or to any external system. If the
   user wants the recap's outcome persisted, that goes through
   `memory-capture`'s gate — hand it over rather than writing here.
3. **Every line is cited and in-window** — each point names its source
   and date in reader's terms: a meeting or document name, a ticket key,
   a page title. Keep the underlying ids at hand for drill-down; don't
   print them through the brief. An item whose timestamp you have not
   seen does not enter the report. Relevance gate per `memory-search`:
   no loosely-matching filler.
4. **Use the time filters that exist; never fake the ones that don't.**
   Fact search takes server-side `created_after` / `created_before` — use
   them for the sweep — and by default it returns only facts still valid
   now, which is the wrong default for a recap: a decision made in the
   window and reversed after it would silently vanish. Windowed sweeps
   pass `include_invalidated=true`, and an item the graph marks as later
   superseded enters the report labelled so — a reversal is part of the
   week's story, not noise. Episode listings take no date parameters; paging
   moves from newest toward oldest — page until the timestamps cross the
   window start; the stop condition is a date, not a count. The two
   listings order by different clocks — the per-group listing by event
   time, the per-entity mention walk by ingestion time — and nothing is
   ingested before it happens, so either way a page that has crossed the
   window start ends the walk: nothing deeper can still be in-window.
   Two cautions: items may present oldest-first inside a page even though
   pages step newest-to-older, so judge the stop on the page's date
   range, not its first row; and verify each further page actually
   advanced — a listing that repeats a page has given all it will give,
   so stop and let Coverage call the audit partial rather than refetch
   in a loop. Node search has no date filter at all — it resolves
   subjects to nodes and answers nothing about "when".
5. **Scope is server-decided; default to all of it.** A recap wants
   everything the user is allowed to see, and that is what the search
   tools deliver when no group filter is passed — so pass none by
   default, and narrow with `group_ids` only when the user asks for one
   slice. Episode listings are the exception: one group per call, and
   omitting the group does not mean all of them — the server picks one
   team group, never the personal scope; passing the literal `personal`
   as the group id is how that scope gets swept. Name the group per
   call, taking ids from the groups already present in search results or
   the session's group listing — never from the user, never invented —
   and sweep each group you saw; Coverage names any you skipped.
6. **Report coverage, not just content.** The graph knows only what was
   ingested: state the episode date range actually observed per group, and
   report an empty window as "nothing recorded for this window", never as
   "nothing happened". Mentions come from extraction, not from a raw text
   scan — say so when a mentions section comes back thin. Content that
   declares itself test or fixture material stays out of the report, and
   Coverage names the group it was found in. An exhausted page is a
   stopping point, not proof of completeness — never present the sweep
   as exhaustive.
7. **Bare tool names**, probed with ToolSearch — prefixes vary per
   install.

## When to use

Catching up after time away, preparing a standup, 1:1, or weekly notes,
answering "where was I mentioned" or "what moved on project X". Not for
authoring an outbound status report of your own work — that is a reporting
task, and where the session carries a status-report skill, that skill owns
it. Not for progress against a personal development program
(`gutt-mentor:progress-tracking`, a separate plugin that may not be
installed), and not for one ticket's background
(`gutt-developer:ticket-research`, likewise separate).

## Step 1 — the window, the subject, the scopes

- **Window** per rule 1, resolved and printed.
- **Subject.** Default is the requesting user. Resolution is a
  `memory-search` first pass with `center_on_user=true` as the entry; if
  it surfaces nothing, search their name and email and confirm the match
  rather than guessing.
  Any other subject — a colleague, a project, a team — resolves the same
  way: node search, confirm when ambiguous. A subject may resolve to more
  than one node (per group, or duplicates within a group); keep them all
  and merge downstream, noting which node each item came from.
- **Scopes** per rule 5.

**Minimum outcome:** a printed window, confirmed subject node(s), and named
groups.

## Step 2 — mentions of the subject

For each subject node: `get_episodes_for_entity`, paged per rule 4 until
past the window start — in small pages (a `last_n` of 3–5), because
every item arrives as the episode's full body and one listed transcript
can be thousands of tokens. Keep the in-window episodes; for each, quote
the line that concerns the subject, with source and date. Episodes carry
two clocks — when the event happened and when it was ingested; filter on
the event time where present, else ingestion time — and the report says
which was used. An item whose event time predates the window but which
entered the graph inside it still belongs, labelled "recorded this
window" — a migrated or late-ingested note is not silently dropped.

The walk can also exceed the response cap outright — a known failure on
quite ordinary entities, not only hubs. When it does, or when the
subject's history is visibly busy, pivot instead of paging harder:
windowed fact search centered on the subject (`center_node_id` with
`created_after` / `created_before`, validity per rule 4), then follow
the `episodes` ids on
the facts that matter with `get_episode`, one at a time. Bounded pages,
but a ranked view, not an exhaustive edge listing — run it once per
step 3 theme rather than as one catch-all query, and never read an
exhausted page as completeness; the walk, where it works, is the fuller
mention record. Where the window holds more than about twenty mentions,
group them by source and offer drill-down instead of quoting every one.

## Step 3 — what else happened

The wide sweep — themed queries against the date filters that exist:

- The themed sweep is `memory-search` narrowed by time — its fact search
  with `created_after` / `created_before` — run once broad and then per
  theme: decisions and commitments, incidents and lessons, meetings, work
  items. The date filter does the windowing; the query does the theming;
  the relevance gate stays in force; validity per rule 4 —
  `include_invalidated=true`, superseded items labelled. Those filters
  window by when the
  graph learned a fact — the right axis for "what landed this week"; the
  episode behind a fact settles when the thing itself happened.
- For the incidents-and-lessons theme, `fetch_lessons_learned` earns its
  dedicated call: it takes a relative `time_range` (`"7d"`, `"30d"` —
  an unrecognized value silently means all time, so keep to that form)
  and returns structured outcome and guidance per lesson. That range is
  anchored to now, not to the window — for a named period that ended
  earlier, fetch a range that covers it and filter by each lesson's own
  timestamp.
- `get_episodes` per group, paged to the window per rule 4, as the audit
  trail behind the ranked results — it catches what relevance ranking
  missed. Full bodies again, so small pages, and it is the last sweep,
  not the first. For episodes worth unpacking,
  `get_nodes_and_edges_by_episode` (up to 10 ids per call) shows what the
  graph extracted from them.
- Sort what comes back into themes — a project, a client, a system, the
  team. The graph's types (decision, lesson, incident) are retrieval
  machinery: query by them, but never let them become the report's
  structure. Deepen a single hop with `graph-traversal` only where an
  item's meaning turns on a relationship — say, whether a decision in
  the window supersedes an older one.

**Minimum outcome:** per theme, either in-window items with citations or
an explicit "nothing recorded".

## Step 4 — work-tracker enrichment (when the session has it)

Probe the tool list for work-tracker tooling; absence is normal, not an
error. When present:

- **Identity first.** Resolve the subject's account id with the tracker's
  own identity or lookup tools; display-name text search is a fallback
  and is labelled as weaker when used.
- **Issues:** a date-bounded query for items the subject was assigned,
  reported, or commented on, updated or resolved inside the window. Ask
  for named fields, never everything — link and comment collections carry
  the full nested body of every related item; fetch those per item only
  where the recap turns on them. Tracker pages overflow too: a couple
  dozen items per page even with named fields, a count query for the
  total, and step 2's twenty-item grouping rule applies here as well.
  Date literals in a tracker query parse in the tracker's own timezone,
  not the user's — pass explicit datetimes where the syntax allows, and
  Coverage carries the residual skew where it does not.
- **Pages:** documents mentioning the subject (a mention operator, where
  the platform exposes one) and documents the subject changed, bounded by
  last-modified.

Each item enters with its key or title and date, like everything else.

## Step 5 — the report

```markdown
# Recap — <subject>, <start> → <end> (<timezone>)

## TL;DR

- <the 3–6 most consequential items, one line each>

## Mentions of <subject>

| When | Source | What was said |
| ---- | ------ | ------------- |

## Decisions & commitments

## Incidents & lessons

## Meetings & documents

## Work items

## Coverage

- Memory groups read: <ids>; episodes observed <oldest> → <newest>
- Work tracker: <read | not available>
- What this can't see: <un-ingested sources; extraction-based mentions>
```

Empty sections say "nothing recorded"; they do not vanish — a reader must
be able to tell "quiet" from "not looked". TL;DR first; reply shape per
`output-style`.

## Degradation

- **No memory tools:** a work-tracker-only activity report, labelled as
  such — issues and pages, with no decisions-and-lessons layer.
- **No work-tracker tools:** memory-only recap; one line says the tracker
  half was skipped.
- **Neither:** say so in one line and offer to recap from pasted material.
- Never stall; the degradation line sits next to the section it limits.

## References

- Search ladder and relevance gate: `memory-search`; relationship walking
  and validity checks: `graph-traversal`; persisting anything durable:
  `memory-capture`; identity when an agent runs this:
  `agent-memory-protocol`; reply shape: `output-style`.
- Adjacent work this skill does not own: outbound status reporting
  (tracker-side skills where installed), personal program check-ins
  (`gutt-mentor:progress-tracking`), one ticket's background
  (`gutt-developer:ticket-research`) — separate plugins that may not be
  installed.
