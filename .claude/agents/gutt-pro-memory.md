---
name: gutt-pro-memory
description: Retrieve organizational context from Gutt-Pro-Memory knowledge graph (Graphiti-based). ALWAYS use this skill for ANY task to search organizational memory for relevant context, lessons learned, decisions, people, work items, incidents, and relationships. Provides multi-hop graph exploration strategies to find deep insights by traversing entity connections.
---

# Gutt-Pro-Memory Graph Exploration

Use the Gutt-Pro-Memory MCP tools to retrieve organizational context before and during any task.

## Core Principle: Always Search First

Before starting ANY task, search the organizational memory for:

- Relevant lessons learned and best practices
- Related decisions and their rationale
- People with expertise in the domain
- Similar past work items or incidents
- Applicable procedures and working agreements

## Available MCP Tools

The Gutt-Pro-Memory MCP server is already connected. Call these tools directly (no setup required):

| Tool                    | Purpose                                              | When to Use                                                                                                  |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `fetch_lessons_learned` | Get historical lessons, outcomes, decisions          | First choice for learning from past mistakes/successes                                                       |
| `search_memory_nodes`   | Find entities (people, projects, systems, etc.)      | Find specific entities or explore by type                                                                    |
| `search_memory_facts`   | Find relationships between entities                  | Understand how entities connect                                                                              |
| `get_user_preferences`  | Get user's code style, communication, workflow prefs | Personalize responses to user                                                                                |
| `get_episodes`          | Get recent memory episodes                           | **Use sparingly** - returns large unprocessed data; only when raw episode content provides significant value |
| `get_entity_edge`       | Get specific edge by UUID                            | Deep-dive into a relationship                                                                                |
| `get_episode`           | Get specific episode by UUID                         | Trace source of information                                                                                  |
| `add_memory`            | Store new information                                | Capture lessons, decisions, outcomes                                                                         |

**Important**: These are MCP tools, not bash commands. Invoke them directly as tool calls.

## Search Strategy

### Step 1: Choose Entry Point

**For learning/guidance tasks** → Start with `fetch_lessons_learned`:

```
fetch_lessons_learned(query="authentication implementation", domain="security", max_results=10)
```

**For entity discovery** → Start with `search_memory_nodes` (broad query first, no entity filter):

```
search_memory_nodes(query="payment service", max_nodes=15)
```

**For relationship exploration** → Start with `search_memory_facts`:

```
search_memory_facts(query="who owns the checkout system", max_facts=15)
```

**For time-specific queries** → Include date context in query:

```
search_memory_nodes(query="December 29 2025 meeting discussion", max_nodes=10)
```

> **Tip**: Start with broader queries without entity filters to discover what types of entities exist, then narrow down with filters in follow-up searches.

### Step 2: Explore Connections (1-2 Hops)

After finding relevant nodes, use `center_node_uuid` to explore their connections:

```
# Found node with uuid="abc-123" for "Payment Service"
# Now find related facts centered on this node:
search_memory_facts(query="incidents", center_node_uuid="abc-123", max_facts=15)

# Or find connected nodes:
search_memory_nodes(query="team members", center_node_uuid="abc-123", max_nodes=15)
```

**Combine centered searches with different queries** to get a complete picture:

```
# For a meeting node, explore multiple angles:
search_memory_facts(query="decisions produced", center_node_uuid="[meeting_uuid]", max_facts=15)
search_memory_facts(query="action items", center_node_uuid="[meeting_uuid]", max_facts=10)
search_memory_nodes(query="features discussed", center_node_uuid="[meeting_uuid]", max_nodes=10)
```

### Adaptive Result Fetching

**Start with reasonable limits, increase if results are highly relevant:**

| Scenario               | Initial Limit                   | If Most Results Relevant |
| ---------------------- | ------------------------------- | ------------------------ |
| Exploratory search     | `max_nodes=10` / `max_facts=10` | Increase to 20-25        |
| Focused topic search   | `max_nodes=15` / `max_facts=15` | Increase to 25-30        |
| Comprehensive research | `max_nodes=20` / `max_facts=20` | Increase to 30-40        |

**When to fetch more:**

- If 8+ out of 10 results are directly relevant → double the limit and re-search
- If results reveal multiple related subtopics → run separate searches per subtopic
- If exploring a key entity's connections → use higher limits (20+) with `center_node_uuid`

**Example adaptive flow:**

```
# Initial search returns 10 highly relevant results
search_memory_nodes(query="gutt pro roadmap", max_nodes=10)
# → All 10 results about roadmap features, decisions, meetings

# Increase limit to get complete picture
search_memory_nodes(query="gutt pro roadmap", max_nodes=25)
```

### Step 3: Deep Dive as Needed

- Use `get_entity_edge(uuid)` to examine specific relationships in detail
- Use `get_episode(uuid)` to trace back to source information
- Run additional centered searches on discovered nodes

> **Caution with `get_episodes`**: Returns raw, unprocessed episode data which can be very large. Prefer `search_memory_nodes` and `search_memory_facts` for filtered, relevant results. Only use `get_episodes` when you specifically need the full raw content of recent episodes (e.g., debugging, auditing, or when search doesn't surface what you need).

## Entity Type Filter Guide

Use the `entity` parameter in `search_memory_nodes` to filter by type. Choose based on task:

| Task Type                | Relevant Entity Types                            |
| ------------------------ | ------------------------------------------------ |
| Learning from past       | `Lesson`, `Decision`, `Insight`                  |
| Finding people/expertise | `Person`, `Team`, `Role`                         |
| Understanding systems    | `CodeComponent`, `SystemConcept`, `Repository`   |
| Tracking work            | `WorkItem`, `PullRequest`, `Commit`, `Iteration` |
| Incident response        | `Incident`, `Lesson`, `Document`                 |
| Process/workflow         | `Process`, `Procedure`, `WorkingAgreement`       |
| Requirements             | `Requirement`, `Product`, `Project`              |
| Team dynamics            | `BehavioralSignal`, `TeamClimate`, `Meeting`     |

See `references/schema.md` for complete entity and edge type definitions.

## Multi-Search Patterns

### Pattern A: Comprehensive Topic Research

```
1. search_memory_nodes(query="[topic]", max_nodes=15) → Get all related entities (no filter)
2. Pick key node UUIDs from results
3. search_memory_facts(center_node_uuid="[key_node]", query="[topic] details", max_facts=15)
4. If most results relevant, increase limits and re-search for completeness
5. search_memory_nodes(query="[topic]", entity="Decision", max_nodes=10) → Filter for decisions
```

### Pattern B: Time-Specific Investigation (e.g., "discussed today")

```
1. search_memory_nodes(query="[date] meeting", max_nodes=10) → Find meetings on that date
2. search_memory_facts(center_node_uuid="[meeting_uuid]", query="[topic]", max_facts=15) → What was discussed
3. search_memory_nodes(center_node_uuid="[meeting_uuid]", query="features decisions", max_nodes=15) → Related entities
4. Follow links to Decision, ActionItem, or Project nodes for details
```

### Pattern C: Person-Centric Exploration

```
1. search_memory_nodes(query="[person name]", entity="Person", max_nodes=5) → Find person
2. search_memory_facts(center_node_uuid="[person_uuid]", query="works on", max_facts=20) → Their work
3. search_memory_facts(center_node_uuid="[person_uuid]", query="interacted with", max_facts=15) → Collaborations
4. search_memory_nodes(query="expertise", center_node_uuid="[person_uuid]", max_nodes=10) → Skills/domains
```

### Pattern D: Incident Investigation

```
1. search_memory_nodes(query="[system/issue]", entity="Incident", max_nodes=10) → Find incidents
2. search_memory_facts(center_node_uuid="[incident_uuid]", query="affects caused", max_facts=15) → Impact
3. fetch_lessons_learned(query="[system]", max_results=10) → Lessons learned
4. search_memory_nodes(query="[incident]", entity="Decision", max_nodes=10) → Resulting decisions
```

### Pattern E: Feature/Roadmap Research

```
1. search_memory_nodes(query="[feature] roadmap", max_nodes=15) → Find roadmap items, projects
2. search_memory_facts(center_node_uuid="[project_uuid]", query="priorities features", max_facts=20)
3. search_memory_nodes(query="[feature]", entity="Decision", max_nodes=10) → Implementation decisions
4. search_memory_facts(query="[feature] phase implementation", max_facts=15) → Timeline/phases
```

## Output Guidelines

**For factual queries**: Present structured findings with entity names, relationships, and source references.

**For guidance queries**: Synthesize findings into actionable narrative with:

- Key lessons and their context
- Relevant decisions and rationale
- Recommended approaches based on organizational knowledge
- People to consult for expertise

**For time-specific queries** (e.g., "discussed today"):

1. Lead with the meeting/event context (date, participants, purpose)
2. Highlight key decisions made (with UUIDs for traceability)
3. List action items and assignments
4. Connect to broader context (roadmap, project, ongoing work)

**Synthesis tips:**

- Cross-reference facts from multiple searches to build complete picture
- When nodes reference each other, follow the chain (Meeting → produced → Decision → applies to → Project)
- Include entity UUIDs for key findings so user can request deeper exploration
- Note temporal context (when decisions were made, validity periods)

**Always include**: UUIDs of key entities for traceability when relevant.

## Storing New Knowledge

After completing tasks that generate organizational learning, use `add_memory`:

```
add_memory(
    name="[Descriptive title]",
    episode_body="[What happened, what was learned, outcomes]",
    source="text",
    source_description="[Context: meeting, incident, decision, etc.]"
)
```

Capture: decisions made, lessons learned, process changes, incident resolutions, new procedures.

# Organizational Memory Schema Reference

Complete reference for entity types and relationship edges in the Gutt-Pro-Memory knowledge graph.

## Entity Types

### People & Organization

| Type     | Description                                    | Key Attributes     |
| -------- | ---------------------------------------------- | ------------------ |
| `Person` | Individual in the organization                 | `email`, `aliases` |
| `Team`   | Collection of people (squad, working group)    | -                  |
| `Role`   | Job title or responsibility                    | -                  |
| `Agent`  | Autonomous system with domain responsibilities | -                  |

### Work & Projects

| Type         | Description                                             | Key Attributes                                            |
| ------------ | ------------------------------------------------------- | --------------------------------------------------------- |
| `WorkItem`   | Discrete unit of work (epic, story, task, bug, subtask) | `item_type`, `priority`, `description`, `originator_type` |
| `Project`    | High-level initiative spanning multiple work items      | `description`                                             |
| `Iteration`  | Time-boxed period (sprint, release, quarter, phase)     | `iteration_type`, `start_date`, `end_date`, `goals`       |
| `ActionItem` | Task or follow-up from meetings                         | -                                                         |

### Code & Systems

| Type            | Description                                          | Key Attributes                                    |
| --------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `Repository`    | Code repository                                      | `url`, `description`                              |
| `CodeComponent` | Concrete code (service, library, module, file)       | `component_type`, `path`                          |
| `SystemConcept` | Abstract architectural concept (capability, pattern) | `concept_type`, `description`, `technology_stack` |
| `PullRequest`   | GitHub/GitLab PR                                     | `pr_number`, `description`, `originator_type`     |
| `Commit`        | Version control commit                               | `sha`, `message`, `originator_type`               |

### Knowledge & Learning

| Type       | Description                                                | Key Attributes                                                   |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `Lesson`   | Organizational learning (best practice, mistake avoidance) | `lesson_type`, `principle`, `context_summary`, `originator_type` |
| `Decision` | Formal decision or ADR                                     | `rationale`, `originator_type`                                   |
| `Insight`  | Derived knowledge (customer, market, technical, process)   | `insight_type`                                                   |
| `Document` | Documentation (spec, ADR, how-to, postmortem)              | `doc_type`, `content_summary`, `originator_type`                 |

### Operations

| Type         | Description                                            | Key Attributes                                                                              |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `Incident`   | Operational event (outage, escalation, security issue) | `incident_type`, `severity` (P0-P4), `occurred_at`, `customer_impact`, `impact_description` |
| `Validation` | Human feedback on agent-generated work                 | `feedback`                                                                                  |
| `Status`     | Reified lifecycle status (Done, In Progress, etc.)     | `status_type`                                                                               |

### Process & Agreements

| Type               | Description                                         | Key Attributes                                    |
| ------------------ | --------------------------------------------------- | ------------------------------------------------- |
| `Process`          | Team/org process (deployment pipeline, code review) | -                                                 |
| `WorkingAgreement` | Team norm or SLA                                    | `content`                                         |
| `Requirement`      | Business or technical requirement                   | `req_type` (functional, non_functional, business) |
| `Domain`           | Field of practice (engineering, product, etc.)      | -                                                 |

### Behavioral & Team Dynamics

| Type               | Description                                 | Key Attributes                                                                                                               |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `BehavioralSignal` | Observed pattern or preference              | `signal_category`, `description`                                                                                             |
| `TeamClimate`      | Snapshot of team culture at a point in time | `snapshot_date`, `vision_clarity`, `psychological_safety`, `task_orientation`, `support_for_innovation`, `narrative_summary` |

### Other

| Type               | Description                                    | Key Attributes                           |
| ------------------ | ---------------------------------------------- | ---------------------------------------- |
| `Meeting`          | Calendar event with outcomes                   | `meeting_date`, `practice_type`          |
| `Comment`          | Discussion on work artifacts                   | `comment_type`, `originator_type`, `url` |
| `Source`           | System of record (GitHub, Jira, Confluence)    | `system_type`, `url`                     |
| `Product`          | Customer-facing product or service             | -                                        |
| `QualityAttribute` | Non-functional quality (Performance, Security) | -                                        |

## Edge Types (Relationships)

### Organizational Structure

- `BELONGS_TO` - Person → Team membership
- `WORKS_AS` - Person → Role assignment
- `REPORTS_TO` - Person → Person hierarchy
- `HAS_EXPERTISE_IN` - Person → Domain/skill

### Work Relationships

- `WORKS_ON` - Person → WorkItem active contribution
- `ASSIGNED_TO` - WorkItem → Person formal assignment
- `OWNED_BY` - Entity → Person/Team ownership
- `PART_OF` - Hierarchical containment (story→epic, meeting→iteration)
- `DEPENDS_ON` - Prerequisites (must complete before)
- `BLOCKS` - Active impediments

### Code Relationships

- `AUTHORED_BY` - Artifact → Person/Agent creator
- `IMPLEMENTS` - PR/Commit → WorkItem fulfillment
- `AFFECTS` - Change → CodeComponent impact
- `INCLUDES` - PR → Commit containment
- `CONTAINED_IN` - Artifact → Repository membership
- `REALIZES` - CodeComponent → SystemConcept (concrete→abstract)

### Knowledge Relationships

- `APPLIES_TO` - Lesson/Decision → Domain/Project scope
- `LEARNED_FROM` - Agent/Person → Lesson application
- `LED_TO` - Causal influence (Incident → Decision)
- `DOCUMENTS` - Document → Entity description
- `EXAMPLE_OF` - Concrete entity → Lesson illustration
- `DERIVES_FROM` - BehavioralSignal → source artifact

### Validation & Status

- `NEEDS_VALIDATION` - Agent work → Validation request
- `VALIDATED_BY` - Entity → Person approval
- `PRODUCED` - Activity → Outcome (Meeting → ActionItem)
- `HAS_STATUS` - Entity → Status lifecycle state

### Process & Governance

- `FOLLOWS` - Entity → Process adherence
- `GOVERNED_BY` - Entity → WorkingAgreement/SLA constraint
- `ADDRESSES` - Decision → QualityAttribute resolution
- `SATISFIES` - Implementation → Requirement fulfillment
- `DEFINES` - Requirement → specification

### Interaction & Behavior

- `INTERACTED_WITH` - Person ↔ Person collaboration
- `ATTENDED` - Person → Meeting participation
- `OPERATES_IN` - Agent/Team → Domain scope
- `EXHIBITS` - Person → BehavioralSignal pattern

## Common Query Patterns by Edge

**Find who owns something:**

```
search_memory_facts(query="owned by", center_node_uuid="[entity_uuid]")
```

**Find what lessons apply to a domain:**

```
search_memory_nodes(query="[domain]", entity="Lesson")
search_memory_facts(query="applies to [domain]")
```

**Find what a person worked on:**

```
search_memory_facts(query="works on", center_node_uuid="[person_uuid]")
```

**Find what led to a decision:**

```
search_memory_facts(query="led to", center_node_uuid="[decision_uuid]")
```

**Find examples of a lesson:**

```
search_memory_facts(query="example of", center_node_uuid="[lesson_uuid]")
```
