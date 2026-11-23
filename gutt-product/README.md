# gutt-product

Skills for product leads working a Jira backlog, backed by your organization's gutt memory.
They put the evidence next to each item (decisions, client commitments, dependencies, incident
history, overlap with neighbours) so a backlog is not re-decided from ticket fields alone.

```
claude plugin install gutt-product@gutt-plugins
```

It depends on `gutt-pro`, which installs and enables with it. It reads and writes Jira through
whatever Atlassian connector your session has. Without one, paste the backlog or source text,
and drafts come back as ready-to-paste markdown.

## Try it

- "Turn yesterday's planning call transcript into stories."
- "Find duplicates in project = PROJ AND status = Backlog."
- "Rank the top 20 backlog items and give me a one-page summary for leadership."

## Skills

| Skill                    | What it does                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `story-creation`         | Drafts stories from transcripts, pages and asks, and updates, splits and links filed ones      |
| `backlog-dedupe`         | Clusters a backlog slice into duplicates and overlaps, proposes consolidations and stale items |
| `backlog-prioritization` | Ranks a slice on your project's own criteria, each position cited, plus a leadership summary   |

They compose: a dedupe run's clusters feed prioritization, and an approved consolidation is
refined into a story by `story-creation`. All three read your project's fields, issue types,
transitions and link names at run time, so they work on any team's Jira configuration.

## What it writes

- **Jira:** `story-creation` and `backlog-dedupe` write only what you approve, per action or as
  a batch whose text names every key. `backlog-prioritization` never changes a ticket field (no
  rank, priority, sprint or status); its one permitted write is a comment, posted only after
  you approve the exact text.
- **Memory:** once you have decided, `story-creation` and `backlog-dedupe` offer the outcome to
  `memory-capture`, into the engagement's group, so the next run starts from it.
  `backlog-prioritization` writes nothing to memory.

No hooks and no agents.
