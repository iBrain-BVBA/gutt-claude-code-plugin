---
name: memory-retrieval
description: Search organizational memory for relevant context, past decisions, lessons learned, and established patterns. MANDATORY before starting ANY task including feature implementation, code review, architecture decisions, bug fixes, ticket creation, documentation, or refactoring. Use when user mentions "check memory", "what did we decide", "past lessons", "how did we", "established patterns", or begins any implementation work. This skill MUST run before jira-ticket-creation, code-review, or any coding task. Triggers on implement, create, build, fix, refactor, review, debug, document, plan, design, architect.
---

# Memory Retrieval

**Announce:** "Searching organizational memory for [topic]..."

Search GUTT memory before ANY task to find relevant context, decisions, and lessons.

## Step 1: Get User Preferences

```python
get_user_preferences(context_type="all")
```

## Step 2: Multi-Query Search

Execute ALL three searches:

```python
# Facts - specific relationships
search_memory_facts(query="[topic]", max_facts=10)

# Nodes - entity summaries
search_memory_nodes(query="[topic]", max_nodes=10)

# Lessons - what worked/failed
fetch_lessons_learned(query="[topic]", max_results=5)
```

## Step 3: Report Findings

**If results found:**

```
Memory context for [topic]:
- Decision (uuid: xxx): "[summary]"
- Lesson (uuid: xxx): "[summary]"
- Fact (uuid: xxx): "[summary]"
```

**If no results:**

```
Memory searched: "[query1]", "[query2]"
Result: No relevant organizational memory found.
```

## Query Strategies

| Task Type       | Query Pattern                       |
| --------------- | ----------------------------------- |
| Feature work    | "[feature] implementation patterns" |
| Bug fix         | "[component] [error] bug"           |
| Architecture    | "[system] architecture decision"    |
| Code review     | "[component] coding standards"      |
| Ticket creation | "[topic] requirements scope"        |

## Anti-Rationalization

```
"I already know this" → Search anyway. Memory has team context you don't.
"It's a simple task" → Search anyway. Simple tasks have hidden complexity.
"I'll search later" → No. Search NOW before any other action.
"Search seems slow" → 3 seconds of search saves 30 minutes of rework.
```

## Verification Checkpoint

Before completing this skill:

- [ ] All 3 search types executed (facts, nodes, lessons)
- [ ] Results cited with UUIDs OR "no relevant memory found" stated
- [ ] Findings announced to user

**Report:** "memory-retrieval: VERIFIED - [X facts, Y nodes, Z lessons found] or [no relevant memory]"
