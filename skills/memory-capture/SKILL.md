# Memory Capture Skill

## Overview

The Memory Capture skill provides a structured workflow for capturing lessons, decisions, insights, and patterns into the gutt memory graph. It guides users through pattern-based lesson capture with anti-rationalization enforcement and proper entity classification.

## Capabilities

This skill helps capture organizational knowledge in 4 structured patterns:

1. **Negation** - "X does NOT work because Y"
2. **Replacement** - "Instead of X, use Y"
3. **Decision** - "We decided X because Y"
4. **Lesson** - "Learned that X when Y"

## Pattern Detection & Classification

The skill automatically:

- Detects which pattern the user's input matches
- Classifies into the appropriate entity type (Lesson, Decision, Insight)
- Structures the content for optimal memory storage
- Calls `add_memory` with proper formatting
- Returns confirmation with memory UUID

### Pattern → Entity Type Mapping

| Pattern          | Entity Type       | Example                                                                                                |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| Negation         | Lesson            | "React Context does NOT work for high-frequency updates because it triggers full subtree re-renders"   |
| Replacement      | Lesson            | "Instead of useContext for global state, use Zustand for better performance"                           |
| Decision         | Decision          | "We decided to use PostgreSQL over MongoDB because we need ACID guarantees for financial transactions" |
| Lesson (general) | Lesson or Insight | "Learned that always validate API responses in TypeScript, even with type assertions"                  |

## Anti-Rationalization Protocol

The skill actively fights the "too minor to capture" trap:

- **No lesson is too small**: Micro-patterns compound over time
- **Capture immediately**: Memory fades, context is lost
- **Err on the side of over-capturing**: Better to have it than need it

Common rationalizations the skill rejects:

- "This is obvious"
- "Everyone knows this"
- "It's just one line"
- "I'll remember this"
- "Not worth documenting"

## Usage

### Automatic Invocation

The skill activates automatically when users say:

- "Remember that..."
- "Capture this lesson..."
- "Document this decision..."
- "Store this insight..."
- "Note that [pattern]..."

### Manual Invocation

```
/gutt-claude-code-plugin:memory-capture
```

## Workflow

1. **Detect Pattern**: Analyze user input to identify which of the 4 patterns applies
2. **Extract Components**: Parse the "what" and "why" from the input
3. **Classify Entity**: Map pattern to entity type (Lesson, Decision, Insight)
4. **Structure Content**: Format episode body with clear structure
5. **Enrich Context**: Add source description, timestamp, group_id
6. **Call add_memory**: Invoke MCP tool with proper parameters
7. **Confirm Capture**: Return success message with UUID and classified type

## Implementation

### Pattern Detection Logic

```
IF input contains "does NOT work" OR "doesn't work" OR "fails when":
  → NEGATION pattern
  → Extract: what doesn't work, why it fails

ELIF input contains "instead of" OR "rather than" OR "use X over Y":
  → REPLACEMENT pattern
  → Extract: old approach, new approach, reason

ELIF input contains "decided" OR "chose" OR "selected":
  → DECISION pattern
  → Extract: decision made, rationale, constraints

ELSE:
  → LESSON pattern (general)
  → Extract: what was learned, context
```

### Entity Classification

```
NEGATION → Lesson
  Format: "What: [X] does not work. Why: [Y]. Context: [Z]."

REPLACEMENT → Lesson
  Format: "Old: [X]. New: [Y]. Reason: [Z]."

DECISION → Decision
  Format: "Decision: [X]. Rationale: [Y]. Trade-offs: [Z]."

LESSON → Lesson or Insight
  Lesson: Actionable, specific technique or pattern
  Insight: Broader understanding or principle
  Format: "Learned: [X]. Context: [Y]. Impact: [Z]."
```

### add_memory Call Structure

```javascript
mcp__gutt -
  mcp -
  remote__add_memory({
    name: "<Pattern Type>: <Brief Summary>",
    episode_body: "<Structured content with what/why/context>",
    source: "text",
    source_description: "memory-capture skill - <pattern> pattern",
    group_id: "gutt-claude-code-plugin",
    last_n_episodes: 0, // Self-sufficient episodes
  });
```

## Output Format

Upon successful capture, the skill returns:

```
Memory captured successfully!

Pattern: <Negation|Replacement|Decision|Lesson>
Entity Type: <Lesson|Decision|Insight>
UUID: <uuid>

Stored: <brief summary of what was captured>
```

## Examples

### Example 1: Negation Pattern

**User Input:**
"React useContext does NOT work for frequently updating global state because it causes full component tree re-renders"

**Detected Pattern:** Negation

**Entity Type:** Lesson

**Episode Body:**

```
What: React useContext for frequently updating global state
Why it doesn't work: Causes full component tree re-renders on every update
Impact: Performance degradation in apps with high-frequency state changes
Alternative: Consider Zustand, Jotai, or component composition patterns
```

**add_memory Call:**

```javascript
{
  name: "Negation: React useContext performance issue",
  episode_body: "[structured content above]",
  source: "text",
  source_description: "memory-capture skill - negation pattern",
  group_id: "gutt-claude-code-plugin",
  last_n_episodes: 0
}
```

### Example 2: Replacement Pattern

**User Input:**
"Instead of async/await in tight loops, use Promise.all for parallel execution"

**Detected Pattern:** Replacement

**Entity Type:** Lesson

**Episode Body:**

```
Old Approach: async/await in tight loops (sequential execution)
New Approach: Promise.all for parallel execution
Reason: Dramatically reduces total execution time when operations are independent
Context: Array processing, API calls, file I/O operations
Example: Array.map + Promise.all instead of for-of loop with await
```

**add_memory Call:**

```javascript
{
  name: "Replacement: Promise.all over sequential await",
  episode_body: "[structured content above]",
  source: "text",
  source_description: "memory-capture skill - replacement pattern",
  group_id: "gutt-claude-code-plugin",
  last_n_episodes: 0
}
```

### Example 3: Decision Pattern

**User Input:**
"We decided to use PostgreSQL over MongoDB because we need strong consistency guarantees for financial transactions"

**Detected Pattern:** Decision

**Entity Type:** Decision

**Episode Body:**

```
Decision: Use PostgreSQL as primary database
Alternative Considered: MongoDB
Rationale: Need ACID guarantees for financial transactions
Context: Financial application with complex relational data
Trade-offs:
  - Pro: Strong consistency, mature ecosystem, SQL familiarity
  - Con: Less flexible schema, potentially more complex migrations
Date: [timestamp]
```

**add_memory Call:**

```javascript
{
  name: "Decision: PostgreSQL for financial transactions",
  episode_body: "[structured content above]",
  source: "text",
  source_description: "memory-capture skill - decision pattern",
  group_id: "gutt-claude-code-plugin",
  last_n_episodes: 0
}
```

### Example 4: General Lesson Pattern

**User Input:**
"Learned that TypeScript's type assertions (as) don't provide runtime safety - always validate at API boundaries"

**Detected Pattern:** Lesson (general)

**Entity Type:** Lesson

**Episode Body:**

```
Learned: TypeScript type assertions provide no runtime safety
Context: API boundary validation, external data sources
Why It Matters: Silent failures when API returns unexpected shape
Best Practice: Always validate external data with zod, io-ts, or manual checks
Anti-pattern: Trusting 'as' assertions on unvalidated data
Real-world trigger: Production bug from changed API response structure
```

**add_memory Call:**

```javascript
{
  name: "Lesson: TypeScript type assertions need runtime validation",
  episode_body: "[structured content above]",
  source: "text",
  source_description: "memory-capture skill - lesson pattern",
  group_id: "gutt-claude-code-plugin",
  last_n_episodes: 0
}
```

## Advanced Features

### Context Enrichment

The skill automatically enriches captured memories with:

- **Timestamp**: When the lesson was captured
- **Source**: Identifies this as a memory-capture skill capture
- **Group ID**: Associates with the correct project/context
- **Pattern Type**: Tags with the detected pattern for retrieval

### UUID Return

Every capture returns a UUID that can be used to:

- Reference this memory in future episodes
- Create explicit relationships between memories
- Retrieve or update the memory later

### Self-Sufficient Episodes

Uses `last_n_episodes: 0` because:

- Each capture is self-contained
- Doesn't need historical context for processing
- Reduces token costs
- Faster processing

## Error Handling

The skill handles:

- **Ambiguous patterns**: Asks clarifying questions
- **Missing context**: Prompts for "why" or "what happened"
- **Too vague**: Requests more specificity
- **add_memory failures**: Reports error with actionable next steps

## Integration with Other Skills

Works seamlessly with:

- **memory-retrieval**: Captured lessons can be searched and retrieved
- **planning skills**: Lessons inform future architectural decisions
- **ralph/autopilot**: Captures lessons learned during execution

## Best Practices

1. **Capture immediately**: Don't wait until "later"
2. **Include context**: What were you working on? What triggered this?
3. **Be specific**: "React hooks" vs "useEffect with async functions"
4. **Capture failures**: Especially valuable - what DIDN'T work
5. **Capture alternatives**: What did you choose instead?
6. **No self-censorship**: Capture even "obvious" things

## Configuration

### Group ID

Default: `gutt-claude-code-plugin`

To use a different group ID, set in the prompt:

```
"Capture this for project X: ..."
```

The skill will detect and use the appropriate group_id.

### Source Description Format

Always includes:

- Skill name: "memory-capture skill"
- Pattern detected: "negation pattern", "replacement pattern", etc.

## Monitoring

All captures are logged to:

- gutt memory graph (queryable via memory-retrieval)
- Standard Claude Code conversation history
- Returns UUID for audit trail

## Version

Version: 1.0.0
Compatible with: gutt MCP v1.0+

## Related

- MCP Tool: `mcp__gutt-mcp-remote__add_memory`
- Related Skill: `memory-retrieval`
- Parent Ticket: GP-428
