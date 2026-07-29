# Worked round-trip — program, two check-ins, one summary

One end-to-end example of the format defined by `individual-program-design` and
this skill. It exists to settle two things a rule cannot show: what a filled-in
record actually looks like, and how the chain is resolved across sessions. The
rules themselves live in the two SKILL.md files — this file adds nothing binding.

Slug throughout: `platform-onboarding`.

## Session 1 — the program

Written by `individual-program-design` after the user confirmed it.
`name`: `Development program — platform-onboarding`, `last_n_episodes=0`, no
`previous_episodes` (it is the root), no `agent_id`, no `group_id`.

```markdown
## Goals

1. Ship a change to the ingest service unaided — done when a PR of mine merges
   without a correctness comment.
2. Take a weekday on-call shift — done when I close one shift with no escalation
   I could not triage myself.

## Milestones

| Milestone                   | Target | Status      |
| --------------------------- | ------ | ----------- |
| Local stack running         | day 1  | not started |
| First PR opened             | week 1 | not started |
| First PR merged             | day 30 | not started |
| Shadow an on-call shift     | day 60 | not started |
| Own a weekday on-call shift | day 90 | not started |

## Cadence

On reaching each milestone, at day 1 / week 1 / day 30 / day 60 / day 90.

## Open questions

- Who approves ingest-service PRs? (raised 2026-03-02)
- Which runbook covers the nightly reconciliation job? (raised 2026-03-02)
```

## Session 2 — first check-in

A new session. It pulls `get_episodes(group_id="personal", last_n=25)` and finds
the program by matching the episode **name** `Development program —
platform-onboarding`; searching for the slug would not have found it, because a
slug is never an extracted entity. It then takes the program episode's id as the
predecessor — this is the first check-in, so there is no earlier one to chain to.

`name`: `Program check-in 2026-03-03 — platform-onboarding`.

```markdown
## Date

2026-03-03

## Milestone updates

| Milestone           | Status | Note                              |
| ------------------- | ------ | --------------------------------- |
| Local stack running | done   | Needed the seed dump, not in docs |

## What moved

- Stack runs end to end locally; seeded from the ops dump rather than fixtures.

## Open questions

- Who approves ingest-service PRs? (raised 2026-03-02)

## Next actions

- Pick a starter issue in the ingest service (by 2026-03-06)
```

The runbook question is gone because it was answered; the approver question is
carried forward because it was not. Carrying open questions forward is what keeps
them visible without the user re-raising them.

## Session 3 — second check-in, chained to the first

Same read, but now the predecessor is the **2026-03-03 check-in**, not the
program: `previous_episodes=["<id of the 2026-03-03 check-in>"]`.

`name`: `Program check-in 2026-03-11 — platform-onboarding`.

```markdown
## Date

2026-03-11

## Milestone updates

| Milestone       | Status  | Note                             |
| --------------- | ------- | -------------------------------- |
| First PR opened | done    | Ingest retry backoff             |
| First PR merged | blocked | Waiting on an approver being out |

## What moved

- PR open and reviewed once; blocked on approval rather than on the change.

## Open questions

- Is there a backup approver for the ingest service? (raised 2026-03-11)

## Next actions

- Ask the team lead for a backup approver (by 2026-03-12)
- Start the on-call shadowing conversation (by 2026-03-18)
```

## Session 4 — the summary a cold session reconstructs

Read only: program plus both check-ins, latest status winning per milestone.

```markdown
**Goals** — ship an ingest-service change unaided; own a weekday on-call shift.
Both still current.

**Milestones** — done: local stack (day 1), first PR opened (week 1). Open:
first PR merged (day 30, **blocked** on an absent approver), shadow a shift
(day 60), own a shift (day 90).

**Next actions** — ask the team lead for a backup approver (by 2026-03-12);
start the on-call shadowing conversation (by 2026-03-18).

**Last check-in** — 2026-03-11.

**Open** — is there a backup approver for the ingest service?
```

Four things make that reconstruction reliable rather than lucky: the shared
`<slug>` in every name, the fixed headings, the fixed status vocabulary, and the
explicit chain. Drop any one and a later session starts guessing.

## Privacy, concretely

The same run may legitimately read org memory. The difference is in the query
string and the scope, not the intent:

| Org query issued while the program is in context                                                                | Verdict                                                                              |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `search_memory_nodes(query="ingest service on-call expectations", group_ids=["<org group>"])`                   | Fine — asks about the role                                                           |
| `search_memory_nodes(query="ingest service on-call expectations")`                                              | Leaks inbound — no `group_ids`, so the personal scope is in the default search scope |
| `search_memory_nodes(query="who can mentor someone blocked on ingest PR approvals", group_ids=["<org group>"])` | Leaks outbound — the person's blocker is now in an org query string                  |

And no org write ever repeats a goal, a milestone note, or an open question from
the program. A general observation about the _format_ is fine to capture org-side;
a person's progress is not.
