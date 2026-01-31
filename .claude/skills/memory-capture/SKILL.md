---
name: memory-capture
description: Store corrections, decisions, lessons learned, and discoveries to organizational memory. MANDATORY after any correction from user, unexpected finding, architectural decision, successful pattern discovery, or task completion with learnings. Use when user says "remember this", "don't forget", "we decided", "lesson learned", "actually that's wrong", "the correct way is", or after ANY task completion. Triggers on correct, fix, wrong, actually, remember, decided, learned, discovered, realized, changed, updated.
---

# Memory Capture

**Announce:** "Capturing [correction/decision/lesson] to organizational memory..."

Store learnings so future agents don't repeat mistakes.

## When to Capture

| Trigger                     | What to Store                               |
| --------------------------- | ------------------------------------------- |
| User corrects you           | The correct approach (Negation/Replacement) |
| User makes decision         | Decision + rationale                        |
| Something unexpected works  | The pattern + context                       |
| Something fails             | What failed + why + fix                     |
| Task completes successfully | Key learnings from task                     |

## Capture Patterns

### Pattern 1: Negation

When something is NOT what was assumed:

```python
add_memory(
    name="Negation: [topic]",
    episode_body="[X] is NOT [Y]. Correct understanding: [Z]. Context: [when this applies].",
    source="text"
)
```

### Pattern 2: Replacement

When one approach replaces another:

```python
add_memory(
    name="Replacement: [topic]",
    episode_body="Use [X] instead of [Y] for [context]. Rationale: [why]. Previous approach caused: [problem].",
    source="text"
)
```

### Pattern 3: Decision

When team makes a choice:

```python
add_memory(
    name="Decision: [topic]",
    episode_body="Decided: [choice]. Alternatives considered: [options]. Rationale: [why]. Applies to: [scope].",
    source="text"
)
```

### Pattern 4: Lesson

When something is learned:

```python
add_memory(
    name="Lesson: [topic]",
    episode_body="Context: [situation]. What happened: [event]. Learning: [insight]. Apply when: [future trigger].",
    source="text"
)
```

## Capture Quality Checklist

Good captures include:

- [ ] Specific context (not generic)
- [ ] Clear trigger for when to apply
- [ ] Rationale (why this matters)
- [ ] Scope (where this applies)

## Anti-Rationalization

```
"This is too minor" → Minor corrections compound. Capture it.
"I'll remember this" → You won't exist next session. Memory will.
"It's obvious" → Not to future agents. Capture it.
"User didn't ask" → Proactive capture is expected. Do it.
```

## Verification Checkpoint

Before completing this skill:

- [ ] Memory stored with appropriate pattern (Negation/Replacement/Decision/Lesson)
- [ ] add_memory returned success confirmation
- [ ] Capture includes context, rationale, and trigger

**Report:** "memory-capture: VERIFIED - Stored [type] about [topic]"
