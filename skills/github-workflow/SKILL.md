---
name: github-workflow
description: "Enforces the GUTT GitHub workflow: commit to feature branches, create PRs, request Copilot review before merge. Use this skill whenever interacting with GitHub repos — creating PRs, pushing code, branching, reviewing, or any git operation via GitHub MCP. Triggers on: push, commit, PR, pull request, merge, github, branch, deploy, release, code review. Even if the user doesn't explicitly mention GitHub, use this skill when the task involves code delivery to a repository."
---

# GitHub Workflow

**Announce:** "Following GUTT GitHub workflow..."

## The Rule

All code changes go through PRs with Copilot review. This is the quality gate — Copilot reviews every PR and does one last iteration before the code lands.

Committing to feature branches is fine and expected. What's not allowed is pushing directly to `master` or merging without Copilot review.

## What You Can and Can't Do

**Go ahead:**
- Create branches (`create_branch`)
- Commit files to feature branches (`push_files`, `create_or_update_file`)
- Create PRs (`create_pull_request`)
- Request Copilot review (`request_copilot_review`)
- Read anything — files, commits, diffs, PRs, issues
- Search code, issues, PRs
- Create/update issues
- Update PR metadata

**Always ask the user first:**
- Merging PRs (`merge_pull_request`) — the user or Copilot workflow handles this

**Never do:**
- Push directly to `master` or `main`
- Merge without Copilot having reviewed

## Standard Workflow

When delivering code to GitHub, follow this sequence:

1. **Create a feature branch** from the base branch (usually `master`)
2. **Push your code** to the feature branch via `push_files` (preferred for multiple files) or `create_or_update_file`
3. **Create a PR** with a clear title referencing any Jira ticket, and a body describing what changed and why
4. **Request Copilot review** immediately after PR creation
5. **Stop** — let Copilot review and the user decide when to merge

The reason for this workflow is that Copilot catches issues that local testing misses — style inconsistencies, edge cases, potential regressions. Having every change reviewed before it lands in master keeps the codebase healthy.

## PR Format

Title: `type(TICKET-ID): short description` — e.g., `feat(GP-530): Cowork automatic lesson capture`

Body should include:
- Summary of what changed (bullet points are fine)
- Files changed with brief descriptions
- Link to Jira ticket if applicable
- Test results if tests were run
- Acceptance criteria checklist if from a spec

## Repository Details

The organization is **iBrain-BVBA**. Always use `iBrain-BVBA` as the owner for GitHub MCP calls.

Key repos:
- `gutt-claude-code-plugin` — Claude Code/Cowork plugin (hooks, skills, MCP)

If unsure about a repo name, search with `search_repositories` first.

## Commit Messages

Follow conventional commits: `type(scope): description`

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

Include `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` when Claude authored the code.
