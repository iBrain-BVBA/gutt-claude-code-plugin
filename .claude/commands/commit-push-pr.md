# Commit, Push, and PR Command

`/commit-push-pr` - Commit changes, push to remote, and create a pull request.

## Usage

```
/commit-push-pr [PROJ-XXX]           # With ticket reference
/commit-push-pr                       # Will prompt for details
/commit-push-pr --draft              # Create as draft PR
```

## Workflow

### Step 1: Check Memory for Commit Standards

```python
search_memory_nodes(query="commit message format git workflow", entity="WorkingAgreement", max_nodes=5)
```

### Step 2: Stage Changes

```bash
git status
git add -A  # Or selective staging
```

### Step 3: Create Commit Message

**Format:** `type(scope): PROJ-XXX message`

| Type       | Use When                             |
| ---------- | ------------------------------------ |
| `feat`     | New feature                          |
| `fix`      | Bug fix                              |
| `refactor` | Code restructure, no behavior change |
| `docs`     | Documentation only                   |
| `test`     | Adding/fixing tests                  |
| `chore`    | Maintenance, deps, config            |
| `style`    | Formatting, no code change           |

**Examples:**

```
feat(auth): PROJ-123 Add OAuth2 token refresh
fix(api): PROJ-456 Handle null response in user endpoint
refactor(db): PROJ-789 Extract connection pooling logic
```

### Step 4: Commit and Push

```bash
git commit -m "type(scope): PROJ-XXX message"
git push -u origin [branch-name]
```

### Step 5: Create Pull Request

```python
create_pull_request(
    owner="[owner]",
    repo="[repo]",
    title="type(scope): PROJ-XXX Brief description",
    body="""
## Summary
[What this PR does]

## Ticket
[PROJ-XXX](https://your-tracker.example.com/browse/PROJ-XXX)

## Changes
- [Change 1]
- [Change 2]

## Testing
- [ ] Unit tests pass
- [ ] Manual testing done

## Screenshots (if UI)
[Add screenshots]
""",
    head="[branch-name]",
    base="main",
    draft=False
)
```

### Step 6: Link PR to Ticket (Optional)

If using Jira integration, add a comment to the ticket with the PR link:

```python
addCommentToJiraIssue(
    cloudId="[cloudId]",
    issueIdOrKey="PROJ-XXX",
    commentBody="PR created: [PR-URL]"
)
```

## Branch Naming Convention

```
type/PROJ-XXX-brief-description
```

**Examples:**

```
feat/PROJ-123-oauth-token-refresh
fix/PROJ-456-null-response-handling
refactor/PROJ-789-connection-pooling
```

## Pre-PR Checklist

- [ ] Lint passes (`/lint-test`)
- [ ] Tests pass
- [ ] Branch is up to date with main
- [ ] No merge conflicts

## Memory Capture

After PR creation:

```python
add_memory(
    name="PR Created",
    episode_body="Created PR #[number] for [PROJ-XXX]: [title]. Changes: [summary]",
    source="text"
)
```
