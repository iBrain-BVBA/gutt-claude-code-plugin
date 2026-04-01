---
name: external-tool-docs
description: "Search official documentation before using external MCP tools like Atlassian, GitHub, or Slack APIs. Use when unfamiliar with tool syntax, getting errors from MCP calls, exploring new capabilities, or performing write operations (create, update, delete). Triggers on: how do I use, what's the syntax, API errors, 400/422/500 status codes, or first-time use of any MCP method. Also triggers on JQL, CQL, GraphQL query construction."
---

# External Tool Documentation Search

**Announce:** "Checking documentation for [tool name]..."

Search official docs before using external MCP tools to avoid errors.

## When to Search

| Trigger                                | Action                |
| -------------------------------------- | --------------------- |
| First time using method                | Search docs           |
| Got error from MCP call                | Search docs for error |
| Write operation (create/update/delete) | Search docs           |
| Complex query (JQL, CQL)               | Search syntax docs    |
| Unfamiliar parameters                  | Search docs           |

## Documentation Sources

| Tool       | Search Pattern                                   |
| ---------- | ------------------------------------------------ |
| Jira       | `site:docs.atlassian.com jira [method] REST API` |
| Confluence | `site:docs.atlassian.com confluence [method]`    |
| GitHub     | `site:docs.github.com [method] API`              |
| Slack      | `site:api.slack.com [method]`                    |

## Search Pattern

```python
# Step 1: Search
web_search(query="site:[docs-url] [method-name] [specific-need]")

# Step 2: Fetch relevant page
web_fetch(url="[doc-page-url]")

# Step 3: Extract
# - Required parameters
# - Return format
# - Common errors
```

## Common Searches

**JQL Syntax:**

```
web_search("site:docs.atlassian.com jira JQL syntax operators")
```

**Jira Custom Fields:**

```
web_search("site:docs.atlassian.com jira create issue custom fields REST API v3")
```

**GitHub PR Comments:**

```
web_search("site:docs.github.com pull request review comments API")
```

## Anti-Rationalization

```
"I've used this before" -> Check if using NEW parameters
"Error is clear"       -> Docs often have better solutions
"Faster to just try"   -> One search < multiple failed calls
```

## Verification Checkpoint

- [ ] Documentation searched for unfamiliar operations
- [ ] Key parameters identified before API call
- [ ] Error handling understood

**Report:** "external-tool-docs: VERIFIED - Found [parameter/syntax] documentation"
