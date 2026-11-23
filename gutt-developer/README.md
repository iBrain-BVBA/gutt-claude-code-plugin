# gutt-developer

Skills for developers working Jira tickets and pull requests, backed by your organization's
gutt memory. Each one reads what the ticket says, adds what memory knows (decisions, meetings,
people, past incidents) and cites both.

```
claude plugin install gutt-developer@gutt-plugins
```

It depends on `gutt-pro`, which installs and enables with it. The ticket side reads Jira through
whatever Atlassian connector your session has; without one, paste the ticket text instead.

## Try it

- "Research PROJ-123 before I start on it."
- "Is PROJ-456 a duplicate of anything?"
- "Review PR 812 against what we already know about this code."

## Skills

| Skill                | What it does                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `ticket-research`    | A cited context brief: what the ticket says, what memory adds, related past work, what is missing |
| `ticket-duplicates`  | Duplicate and overlap candidates from Jira and memory, each with a verdict and its evidence       |
| `ticket-estimate`    | An effort range and risk areas grounded in comparable past work, with honest confidence           |
| `bug-investigation`  | From a bug key: how bad it is against a rubric, where it most likely lives, similar past failures |
| `sub-task-breakdown` | Proposes sub-tasks with acceptance criteria, effort and dependencies; files nothing unless asked  |
| `pr-re-review`       | Reviews a pull request against recorded standards and incident history, each finding verified     |

## What it writes

- **Jira:** the research, duplicate, estimate and bug skills never edit a ticket; each posts at
  most one comment, and only text you approved. `sub-task-breakdown` creates sub-tasks and their
  links only when you ask it to in the session and approve the exact set.
- **Pull requests:** `pr-re-review` posts nothing to the PR unless you ask in the session and
  approve the exact text.
- **Memory:** `bug-investigation` and `pr-re-review` offer a confirmed outcome to
  `memory-capture`, which applies its own rules and asks where it should. They write under the
  workflow identities `bug-investigator--<scope>` and `pr-reviewer--<scope>` (see agent scope in
  the [gutt-pro README](../gutt-core/README.md#commands)), so earlier findings stay reachable.

No hooks and no agents. The review structure of `pr-re-review` is credited in
[ATTRIBUTION.md](ATTRIBUTION.md).
