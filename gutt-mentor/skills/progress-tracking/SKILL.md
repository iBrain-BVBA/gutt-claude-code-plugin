---
name: progress-tracking
description: "Read a person's development program and its check-in history out of personal memory, report where they actually stand, and write the next check-in chained to the last one — so a fresh session reconstructs goals, milestone status, and open questions without the user re-explaining any of it. Use for check-ins, progress updates, and status summaries against a program that already exists. Triggers on: check in, progress update, how am I doing, where am I, status of my plan, log a check-in, milestone done, what's next, my progress, review my goals, standup on my plan."
---

# Progress Tracking

Pick up a person's development program cold and move it forward: read the program
and its check-ins from their **personal** memory scope, report where they stand,
then write the next check-in chained to the last. The point is continuity — a
fresh session reconstructs goals, milestone status, next actions and open
questions from the record alone.

`individual-program-design` owns the program record; this skill reads it and owns
the check-in record. Underneath, `memory-search` owns read discipline,
`memory-capture` write discipline, `graph-traversal` multi-hop questions, and
`agent-memory-protocol` identity for when an agent runs this — all four from the
gutt-core plugin. Without it, follow the rules below and note the gap in one line.

## Hard rules (non-negotiable — read first)

1. **Scope every personal read explicitly, and mind the asymmetry.** There is no
   `search_personal_memory` tool. Pass `group_ids: ["personal"]` — plural, an
   array — to `search_memory_nodes`, `search_memory_facts`,
   `fetch_lessons_learned` and `list_entities`; `get_episodes` takes singular
   `group_id: "personal"`. That scope is **the authenticated user's own**, derived
   from the login — so you are always reading and writing your own program, never
   someone else's.
2. **Chain the check-in explicitly** with
   `previous_episodes=["<predecessor id>"]` from the read — an episode UUID or a
   semantic ID. `last_n_episodes` applies **only** when `previous_episodes` is
   omitted, and its default of `3` chains you to whatever was written most
   recently in that person's personal scope, not to this program's last check-in.
3. **No agent identity in personal scope.** Do not pass `agent_id` on a personal
   read or write. The parameter exists and works — leaving it off is a deliberate
   policy for 3.0, not a server limitation. Registration and tagging happen in
   org scope only, and that is `agent-memory-protocol`'s business.
4. **Privacy runs both ways.** Never copy personal-scope content into an
   org-scope write or into an org-memory query string. And every org-scope read
   issued while program content is in context must pass explicit `group_ids`
   naming only org groups: omit it and the user's personal scope is _already_ in
   the default search scope, so private notes leak into what may become a shared
   briefing. An org write carries nothing personal and passes
   `last_n_episodes=0` (`memory-capture`).
5. **Report the record; never fill in its gaps.** A milestone is `done` only
   because the record or the user says so — inferring one corrupts every later
   summary. No program found → say so and hand off to
   `individual-program-design`; never rebuild one from what you were just told.
6. **Never hardcode a tool prefix.** The `mcp__…__` prefix varies per install,
   so call `add_personal_memory`, `get_episodes`, etc. by whatever name your
   tool list actually surfaces — and never assume a write tool's name.

## When to use

A check-in is due, a milestone was reached, or someone asks where they stand,
what is next, or what is still open. Not for creating or replacing a program
(`individual-program-design`), nor for org-scope reads about the team or the
codebase (`memory-search`).

## Reading the thread

1. **Find the program in the episode list — not by searching for it.**
   `get_episodes(group_id="personal", last_n=25)`, then match episode **names**:
   the program is `Development program — <slug>`, its check-ins
   `Program check-in <date> — <slug>`. This is the only locator that works, and
   the trap is worth stating plainly: `search_memory_nodes` searches **extracted
   entities**, and a `<slug>` is never an entity — it exists only in an episode
   name. Searching the slug returns nothing whether or not the program is there,
   so it can neither find a program nor prove one is absent.
2. **Read the list carefully.** A generous `last_n` beats paging, because a page
   smaller than the scope can leave a recent write out altogether. **Never read
   order off position:** the list is ordered by each episode's _reference time_,
   which the writer can set, so a backdated episode sorts by its own date rather
   than by when it arrived — the newest is usually the last row, but not
   dependably. Sort on the `## Date` line in each body.
   `search_memory_nodes(query="<the program's subject>", group_ids=["personal"])`
   is useful for a different question — what the graph has extracted about the
   work itself — never for locating the thread.
3. **Keep the thread** — the program plus the check-ins carrying the same
   `<slug>`. The rest of that person's personal scope is not this skill's
   business.
4. **Reconstruct.** Latest wins: a check-in's milestone update supersedes the
   program's table, and the newest check-in supersedes older ones.
5. **Name what is missing.** Gaps and contradictions get reported and asked
   about, never smoothed over.

An org-scope read is usually unnecessary here. If you make one it asks a
genuinely different question — "what does the org expect of this role?", never
"how is this person doing" — with explicit `group_ids` (rule 4), naming a group
you got from a per-group write tool in your list or from the user. Cannot name
one? Skip it; a guessed group name is a fabricated identifier, not a search.

**Minimum outcome before you summarize or write:** the goals and milestone table,
every check-in with its date, and the identifier of the newest one — your
chaining predecessor. **Stop rule:** one `get_episodes`, widened once if the
thread looks truncated. If it is still not there, report "no program found" and
hand off; never sweep a person's personal scope hoping it turns up.

**Anchors** — take each from a read, never hand-build an id:

| Anchor                   | From   | What it anchors                           |
| ------------------------ | ------ | ----------------------------------------- |
| the program `<slug>`     | step 1 | which episodes belong to the thread       |
| the newest check-in's id | step 1 | `previous_episodes` for the next check-in |
| the program episode's id | step 1 | the predecessor for the _first_ check-in  |

## The status summary

Four things, in this order, from the record and nothing else: **goals** as the
program states them, each still-current or dropped; **milestones** done versus
open with their targets, where open is any latest status that is not `done` and
`blocked` is called out; **next actions** from the newest check-in; and the
**last check-in date**, or "no check-ins yet". Then any question still
unanswered. Short enough to read at a glance — the detail is in the episodes.

## The check-in record

`name`: `Program check-in <YYYY-MM-DD> — <slug>`, reusing the program's `<slug>`
verbatim. Headings stay as written — the next session parses them.

```markdown
## Date

<YYYY-MM-DD>

## Milestone updates

| Milestone | Status      | Note                |
| --------- | ----------- | ------------------- |
| <name>    | in progress | <one line, or none> |

## What moved

- <what changed since the last check-in>

## Open questions

- <question> (raised <YYYY-MM-DD>)

## Next actions

- <action> (by <YYYY-MM-DD>)
```

Status vocabulary and dates are the program record's. Carry an unanswered
question forward; drop it once it is answered. The `(by <date>)` on a next action
is **optional** — attach one only if the person gave one, because inventing a
deadline is inventing a fact (rule 5).

```
add_personal_memory(
  name="Program check-in <YYYY-MM-DD> — <slug>",
  episode_body="<the skeleton above, filled in>",
  source="text",
  previous_episodes=["<the previous check-in, or the program for the first>"])
```

**Then verify, once,** the same way you found the thread — re-run
`get_episodes(group_id="personal", last_n=25)` and match the check-in's name.
Success means _queued_, not stored; personal episodes process sequentially in
arrival order, so a miss on the first look is ordinary and **never means the write
was lost**. Two causes look identical; `has_more` tells them apart. Still `true`
means the page was truncated — widen `last_n`. Already `false` means the page was
complete and the episode is merely still processing — pause briefly and re-run the
same call, because widening reaches nothing that is not there yet. Either way: one
re-check, never a second write. **Do not batch a chain:** take each predecessor id
from a read — never mint or pre-assign one — so write one check-in, verify, then
chain the next. Read that id fresh rather than reusing one from earlier in the
session: these short ids carry a collision suffix, and an episode's id gains one
(`…:Progr` becoming `…:Progr:0`) as siblings with the same name stem appear.
Batch only episodes that do not chain.

## Degradation

Probe with ToolSearch before concluding a tool is missing; `add_personal_memory`
can be hidden by a deployment's version gate (`memory-search` →
`references/tools.md` maps the gates). If reads are unavailable, say plainly that
you cannot see the program rather than working from what the user just told you.
If the write is unavailable or denied for want of a login, put the filled-in
check-in in your reply so it is not lost, note the degradation in one line, and
retry when a write tool returns — never write it to an org group. Never stall.

## References

- `references/round-trip.md` — the worked example: a program, two chained
  check-ins, the summary they reconstruct, and legitimate versus leaking org
  queries. Read it when the format or the chaining is unclear.
- The program record, its headings, the status vocabulary, the default cadence:
  `individual-program-design`.
- Read discipline, and the per-tool contracts in `memory-search` →
  `references/tools.md`. Write discipline: `memory-capture`. Still-true and
  relationship questions: `graph-traversal`.
- Registration and tagged org writes: `agent-memory-protocol` — personal reads
  and writes stay untagged (rule 3).
