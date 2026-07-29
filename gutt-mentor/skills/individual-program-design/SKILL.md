---
name: individual-program-design
description: "Turn what a person says they want into a written development program — elicit the goals and the constraint that shapes them, set milestones and a check-in cadence, then persist it to that individual's personal memory scope as one self-contained episode a later session can pick up cold. Use when starting an onboarding, a ramp-up, or a coaching engagement, or when an existing program has to be replaced. Triggers on: design a program, build me a plan, onboarding plan, ramp-up plan, my goals, 30 60 90, learning path, development plan, set milestones, personal roadmap, what should I focus on."
---

# Individual Program Design

Turn a person's stated goals into a program that survives the session: goals,
milestones, a check-in cadence, and the questions still open — written once to
their **personal** memory scope so any later session can reconstruct it without
asking them to explain themselves again. Domain-neutral: this shapes the
container, never the subject matter.

`progress-tracking` is the other half — it reads this record back and writes the
check-ins against it. Underneath, `memory-capture` owns write discipline
(classify, dedup, size caps, write-tool discovery, queued≠persisted),
`memory-search` owns query phrasing and the relevance gate, and
`agent-memory-protocol` owns identity for when an agent runs this. Those ship
with the gutt-core plugin; without it, follow the rules below and note the gap in
one line.

## Hard rules (non-negotiable — read first)

1. **Personal scope, written with `add_personal_memory`.** That tool takes **no
   `group_id` at all** — the namespace is derived server-side from the login and
   authorized on every call. Without an OAuth login carrying a stable user id the
   call is **denied, not downgraded**. Never write a person's program to an org
   group instead; hand the draft back (see Degradation). Because the namespace
   comes from the login, it is **the authenticated user's own** scope — there is
   no way to write into someone else's. This skill serves whoever is running it,
   for themselves; run on someone else's behalf it would file their program under
   your name, so say that rather than doing it.
2. **No agent identity in personal scope.** Do not pass `agent_id` on a personal
   read or write. The parameter exists and works — leaving it off is a deliberate
   policy, not a server limitation. Registration and tagging happen in
   org scope only, and that is `agent-memory-protocol`'s business.
3. **Privacy runs both ways.** Never copy personal-scope content into an
   org-scope write or into an org-memory query string. And every org-scope read
   issued while program content is in context must pass explicit `group_ids`
   naming only org groups: omit it and the user's personal scope is _already_ in
   the default search scope, so private notes leak into what may become a shared
   briefing. An org write carries nothing personal and passes
   `last_n_episodes=0` (`memory-capture`).
4. **The goals are the user's.** Elicit them; never infer a program and write it.
   Read the filled-in skeleton back and get an explicit yes first. No
   confirmation → it stays a draft, and you say so.
5. **One self-contained program episode, `last_n_episodes=0`.** The program is
   the root of the thread and has nothing to chain to, and the server default of
   `3` would fold unrelated recent personal episodes into extraction. Use the
   naming and skeleton below, and do **not** invent a new typed name prefix — the
   five (`Insight:` through `WorkingAgreement:`) belong to org captures in
   `memory-capture`.
6. **Never hardcode a tool prefix.** The `mcp__…__` prefix varies per install,
   so call `add_personal_memory`, `get_episodes`, etc. by whatever name your
   tool list actually surfaces — and never assume a write tool's name.

## When to use

Someone is starting out — new hire, new role, new skill — and needs a program
with milestones rather than a conversation that evaporates; or an existing
program is stale and should be replaced. Not for logging progress or reading
status (`progress-tracking`), nor for any org-scope capture (`memory-capture`).

## Recall before you design

Two passes that ask **different questions** — not one question twice:

1. **Personal — "does this person already have a program?"**
   `get_episodes(group_id="personal", last_n=25)`, looking for an episode named
   `Development program — <slug>`, and widened once if `has_more` comes back
   `true` — a truncated page can leave the newest episodes out altogether. Match
   the **name**; do not search for the slug. `search_memory_nodes` searches
   extracted entities, and a `<slug>` is never an entity — it lives only in an
   episode name, so searching it surfaces only near-matching extracted entities,
   never the episode itself: it can neither find a program nor prove one absent.
   If one comes back you are amending, not designing — reading the whole thread
   is `progress-tracking`'s job.
2. **Org — "what does the org know about ramping up in this role?"** Only when
   the org plausibly has a path worth reusing, and only with explicit `group_ids`
   naming org groups (rule 3). Phrase it about the _role_ — "platform on-call
   ramp expectations" — never their name, their gaps, or anything they told you
   in confidence. **Name that org group from something real, and it is there to be
   read:** every node and fact a memory read returns carries its own `group_id`,
   so take the name off any org result already in the session, or ask. If you
   need an unscoped read to learn the name, make it _before_ program content is
   in play, since an unscoped search covers personal scope too. Never take it
   from a per-group write tool's name — that suffix is a display alias, not
   necessarily a group id, and a read scoped to a name that is not a real group
   is denied outright. Only when none of those yields a name do you **skip this
   pass** — a guessed group name is a fabricated identifier, not a search.

**Minimum outcome before you elicit anything:** whether a program already exists,
and its `<slug>` if it does. Cannot establish that? Say so in one line rather
than designing over the top of something already there. **Stop rule:** one
episode list, widened once if `has_more` says it was truncated, plus at most one
org search — then treat the program as absent and design. Never walk a person's
personal scope looking for it.

**Anchor:** the program `<slug>`, taken verbatim from the program episode's
name — every search on the thread carries it. Episode ids are chaining anchors,
and chaining is `progress-tracking`'s business.

## The design path

1. **Elicit.** Goals in the user's own words, the constraint that shapes them
   (time available, a deadline, the role), and what _done_ looks like for each
   one. Two or three goals beat eight.
2. **Set milestones.** Default cadence: **day 1 / week 1 / day 30 / day 60 / day
   90**, with check-ins triggered by reaching a milestone rather than by the
   calendar. Offer it and take the user's override — a six-week ramp or a weekly
   rhythm is fine; keep the shape, move the marks. Every milestone marks progress
   toward a goal the person actually stated: filling a cadence slot is never a
   reason to introduce a goal, a tool, or a person they never mentioned. Fewer
   rows beats invented ones. **One condition per row** — a milestone that bundles
   two ("confirm the reviewer _and_ how access works") cannot be scored later,
   because the fixed statuses have no way to say half-done.
3. **Record the open questions.** Whatever you could not settle: an undecided
   owner, missing access, an unclear success measure. They belong in the record,
   not in your head.
4. **Confirm, then write** one episode per the record below. Replacing an
   existing program is a new episode naming what changed — never a silent
   rewrite, never an edit of the old one.
5. **Verify once,** the same way you looked for it in the first place — re-run
   `get_episodes(group_id="personal", last_n=25)` and match the program's name.
   Success means _queued_, not stored, so a miss on the first look is ordinary and
   **never means it was lost**. Two causes look identical; `has_more` tells them
   apart. Still `true` means the page was truncated — widen `last_n`. Already
   `false` means the page was complete and the episode is merely still processing —
   pause briefly and re-run the same call. One re-check either way; never
   re-write, because a second write is a duplicate.

## The program record

`name`: `Development program — <slug>`, where `<slug>` is a short kebab-case
focus (`platform-onboarding`, `staff-engineer-ramp`). Every check-in repeats the
same `<slug>`, so one search on it returns the whole thread. Keep the headings
verbatim — `progress-tracking` reconstructs status by reading them, and a renamed
heading reads as a missing section.

```markdown
## Goals

1. <goal, in the user's words> — done when <observable outcome>

## Milestones

| Milestone | Target | Status      |
| --------- | ------ | ----------- |
| <name>    | day 1  | not started |

## Cadence

<what triggers a check-in — default: on reaching each milestone, at day 1 /
week 1 / day 30 / day 60 / day 90>

## Open questions

- <question> (raised <YYYY-MM-DD>)
```

Status vocabulary is fixed — `not started`, `in progress`, `blocked`, `done` —
and anything not `done` counts as open. Dates are ISO `YYYY-MM-DD`.

```
add_personal_memory(
  name="Development program — <slug>",
  episode_body="<the skeleton above, filled in>",
  source="text",
  last_n_episodes=0)
```

## Degradation

Probe with ToolSearch before concluding a tool is missing; `add_personal_memory`
can be hidden by a deployment's version gate (`memory-search` →
`references/tools.md` maps the gates). If it is hidden, or
the call is denied for want of a login: **do not drop the program.** Put the
filled-in skeleton in your reply so the user keeps it, note the degradation in
one line, and retry when a write tool returns. Never substitute an org-scope
write. Never stall.

## References

- `progress-tracking` — reads this record back and owns the check-in record. Its
  `references/round-trip.md` is the worked example: a program, two chained
  check-ins, the summary they reconstruct, and legitimate versus leaking org
  queries.
- Write discipline (classify, dedup, size caps, write-tool discovery,
  queued≠persisted): `memory-capture`. Query phrasing, the relevance gate, and
  the per-tool contracts in `memory-search` → `references/tools.md`.
- Registration and tagged org writes: `agent-memory-protocol` — personal-scope
  writes stay untagged (rule 2).
