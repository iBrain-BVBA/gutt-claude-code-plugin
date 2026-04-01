---
name: skills-discovery
description: "Analyze team workflows to identify missing skills, agent behavior gaps, or repeated corrections that indicate need for new skills. Use when analyzing what skills would help, identifying why agents keep making the same mistakes, conducting skill gap analysis, or when user asks what skills would help, why do agents keep doing X wrong, skill audit. Triggers on repeated corrections, agent failures, workflow inconsistencies, skill gap, missing skill, agents keep."
---

# Skills Discovery

**Announce:** "Analyzing workflows for skill gaps..."

Identify opportunities for new skills based on repeated patterns.

## When to Use

| Trigger                       | Action                  |
| ----------------------------- | ----------------------- |
| Same correction made 3+ times | Skill to prevent error  |
| Complex workflow repeated     | Skill to standardize    |
| Agent confusion patterns      | Skill to clarify        |
| New tool/integration          | Skill to document usage |

## Step 1: Search Memory for Patterns

```python
# Find repeated corrections
fetch_lessons_learned(query="correction mistake error", max_results=20)

# Find behavioral signals
search_memory_nodes(query="correction pattern", entity="BehavioralSignal", max_nodes=10)

# Find decisions that need enforcement
search_memory_facts(query="decision standard process", max_facts=15)
```

## Step 2: Analyze Patterns

Group findings by:

| Category                       | Indicates                         |
| ------------------------------ | --------------------------------- |
| Repeated "Negation" lessons    | Skill to prevent misunderstanding |
| Repeated "Replacement" lessons | Skill to enforce correct approach |
| Multiple decisions in one area | Skill to consolidate guidance     |
| Tool-specific errors           | Skill to document tool usage      |

## Step 3: Propose New Skills

```markdown
## Proposed Skill: [name]

### Evidence

- Lesson (uuid: xxx): [pattern]
- Lesson (uuid: xxx): [pattern]

### Problem

[What keeps going wrong]

### Solution

Skill that:

- [What it would do]
- [When it would trigger]
- [What it would prevent]

### Estimated Impact

[How much time/errors this would save]
```

## Step 4: Capture Discovery

```python
add_memory(
    name="Skill Gap: [area]",
    episode_body="Identified need for [skill type] based on [evidence]. Proposed: [brief description].",
    source="text"
)
```

## Skill Templates

### Error Prevention Skill

```yaml
name: prevent-[error-type]
description: Prevent [common error] by [mechanism]. Triggers on [patterns].
```

### Workflow Standardization Skill

```yaml
name: [workflow]-standard
description: Standardize [workflow] using established patterns. Triggers on [task types].
```

### Tool Documentation Skill

```yaml
name: [tool]-usage
description: Correct usage of [tool] including common pitfalls. Triggers on [tool name], [common errors].
```

## Verification Checkpoint

- [ ] Memory searched for repeated corrections
- [ ] Patterns grouped and analyzed
- [ ] At least one skill proposed with evidence
- [ ] Discovery captured to memory

**Report:** "skills-discovery: VERIFIED - Found [X patterns], proposed [Y skills]"
