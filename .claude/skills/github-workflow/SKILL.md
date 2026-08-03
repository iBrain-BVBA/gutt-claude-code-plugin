---
name: github-workflow
description: "Enforces the gutt GitHub workflow: commit to feature branches, create PRs, request Copilot review before merge. Use this skill whenever interacting with GitHub repos — creating PRs, pushing code, branching, reviewing, or any git operation against a remote, whether via GitHub MCP or the gh CLI. Triggers on: push, commit, PR, pull request, merge, github, branch, deploy, release, code review. Even if the user doesn't explicitly mention GitHub, use this skill when the task involves code delivery to a repository."
---

# GitHub Workflow

**Announce:** "Following gutt GitHub workflow..."

## The Rule

All code changes go through PRs with Copilot review. This is the quality gate — Copilot reviews every PR and does one last iteration before the code lands.

Committing to feature branches is fine and expected. What's not allowed is pushing directly to the default branch or merging without Copilot review.

## Which toolchain — check, don't assume

Two paths exist and **most sessions have only one of them**. Establish which before you plan the delivery, not after you've announced a sequence you can't run:

- **GitHub MCP** (`mcp__github__*`) — present in Cowork and in sessions with the GitHub MCP server connected. Probe with ToolSearch; do not assume it from the fact that this skill names those tools.
- **`gh` CLI + local `git`** — the path in a normal Claude Code terminal session, where `mcp__github__*` tools are typically **absent**. Verify once with `gh auth status`.

The rules below are toolchain-independent. Tool names are given for both.

## What You Can and Can't Do

**Go ahead:**

- Create branches (`mcp__github__create_branch` / `git checkout -b`)
- Commit to feature branches (`mcp__github__push_files`, `mcp__github__create_or_update_file` / `git commit` + `git push -u origin <branch>`)
- Create PRs (`mcp__github__create_pull_request` / `gh pr create --base <base> --head <branch>`)
- Request Copilot review (`mcp__github__request_copilot_review` / see the `gh` recipe below)
- Read anything — files, commits, diffs, PRs, issues
- Search code, issues, PRs
- Create/update issues
- Update PR metadata

**Always ask the user first:**

- Merging PRs (`mcp__github__merge_pull_request`) — the user or Copilot workflow handles this

**Never do:**

- Push directly to `main`
- Merge without Copilot having reviewed

## Standard Workflow

When delivering code to GitHub, follow this sequence:

1. **Pick the base branch deliberately** — see below. It is not automatically the default branch.
2. **Create a feature branch** from that base
3. **Push your code** to the feature branch
4. **Create a PR** against the same base, with a clear title referencing any Jira ticket, and a body describing what changed and why
5. **Request Copilot review** immediately after PR creation
6. **Stop** — let Copilot review and the user decide when to merge

The reason for this workflow is that Copilot catches issues that local testing misses — style inconsistencies, edge cases, potential regressions. Having every change reviewed before it lands keeps the codebase healthy.

### Picking the base branch

**Confirm the base carries the layout you are about to edit.** The default branch is `main`, and it carries the 3.0 layout (`gutt-core/`, `gutt-mentor/`, `gutt-developer/`) — so for new work it is normally the right base. What is no longer right is `release/3.0`: it still exists for the PRs that were already open against it, but it sits behind `main`, and a branch cut from it will not have what landed since.

The general trap remains: a base chosen by name rather than by content gets you the wrong layout, and then every path in the plan is wrong. So, before `git checkout -b`:

- Take the base from the ticket, the epic, or the user. If the story belongs to a release program, its release branch is the base.
- **Verify by looking at the base's tree**, not its name: `git ls-tree --name-only origin/<base>` should contain the directories you are about to edit. This is the cheap check that catches a wrong base before any work is committed to it.
- Base the PR on the same branch you cut from (`gh pr create --base <base>`), or the diff will include everything that branch is ahead by.

If you discover the wrong base only after branching, `git branch -D` and recreate from the right one — rebasing a branch whose whole layout moved is more error-prone than starting over.

### Requesting Copilot review with `gh`

There is no `gh pr review --copilot`. Use the REST endpoint with the bot's slug:

```bash
gh api -X POST repos/iBrain-BVBA/<repo>/pulls/<N>/requested_reviewers \
  -f "reviewers[]=copilot-pull-request-reviewer[bot]"
```

**Verify from the response body or the timeline, not from `gh pr view`.** A successful POST echoes `"requested_reviewers":[{"login":"Copilot","type":"Bot"}]`. But `gh pr view <N> --json reviewRequests` reports `[]` for a pending **bot** reviewer, so reading it back looks like the request failed when it didn't. The dependable read is the timeline:

```bash
gh api repos/iBrain-BVBA/<repo>/issues/<N>/timeline \
  --jq '[.[] | select(.event=="review_requested") | .requested_reviewer.login]'
```

Copilot posts its review a few minutes later (4m22s on PR #64), and the review author appears as `copilot-pull-request-reviewer`, not `Copilot`. An empty `reviews` array right after the request means "not yet", not "not requested" — check the timeline before re-requesting.

## PR Format

Title: `type(TICKET-ID): short description` — e.g., `feat(GP-530): Cowork automatic lesson capture`

Body should include:

- Summary of what changed (bullet points are fine)
- Files changed with brief descriptions
- Link to Jira ticket if applicable
- Test results if tests were run
- Acceptance criteria checklist if from a spec
- Any known gap the PR deliberately does not close — reviewers should not have to rediscover it

## Repository Details

The organization is **iBrain-BVBA**. Always use `iBrain-BVBA` as the owner.

Key repos:

- `gutt-claude-code-plugin` — Claude Code/Cowork plugin (hooks, skills, MCP). Default branch `main`, which carries the 3.0 layout and is the base for new work.

If unsure about a repo name, search with `mcp__github__search_repositories` or `gh repo list iBrain-BVBA`.

## Commit Messages

Follow conventional commits: `type(scope): description`

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`

Include `Co-Authored-By: Claude <model> <noreply@anthropic.com>` when Claude authored the code, using the **actual** model of the session — e.g. `Claude Opus 5 (1M context)`. Don't copy a model name out of this file or out of an earlier commit; it is a record of who wrote the change.
