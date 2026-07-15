---
name: memory-search
description: "Search organizational memory efficiently before any non-trivial task — a shallow-first ladder, summary-first reading, and strict token discipline over the gutt knowledge graph. Use to recall prior decisions, lessons learned, past work, patterns, owners, or why something was done. Triggers on: previous, before, last time, decision, why did we, what do we know about, prior art, past work, lessons learned, have we done, did we already, history of, who worked on."
---

# Memory Search

How every agent should read the gutt knowledge graph: start shallow, read
summaries, and only go deeper when a rung leaves a real gap. This is the
foundation skill (R13) — other memory skills cross-reference it rather than
restate it.

## Hard rules (non-negotiable — read first)

1. **Ladder order.** Always open at rung 1. Climb only when the current rung
   left a genuine gap. Never start at rung 2 or 3.
2. **Summary-first.** Read the summary layer (node `summary`, lesson `summary`
   / `context_summary`, `search` result `title`) before ever fetching a full
   episode body. Full bodies are for citation or a crucial missing detail only.
3. **Pagination is opt-in.** Never fetch the next page just because
   `has_more` is `true`. Page only when most of the current page was relevant.
4. **Count caps, not truncation.** There is no `summary_only` / `max_chars`
   parameter on any tool. Control context with `max_nodes` / `max_facts` /
   `max_results` / `limit` and by choosing summary-shaped tools. Never invent a
   truncation flag.
5. **Bare tool names.** Call tools by bare name (`search_memory_nodes`). The
   `mcp__…__` prefix varies per install — never hardcode it. Use whatever your
   tool list surfaces.

## When to use

- Before starting any non-trivial task, to surface prior decisions, lessons,
  and context.
- To answer "have we done this / why did we / what do we know about X".
- To find who worked on something or what a work item depends on.

For **writing** memory, see `memory-capture`. For **multi-hop traversal**
(paths, neighborhoods), see `graph-traversal` (rung 3).

## The search ladder

### Rung 1 — shallow (default; always available)

Two calls, then read the summaries and stop if you have enough:

- `search_memory_nodes(query, max_nodes: 10)` — entities (Lessons, Decisions,
  People, WorkItems). Read each node's `summary`.
- `fetch_lessons_learned(query)` — curated lessons. Read `summary` /
  `context_summary` + `guidance`.

Both are v1.0-core tools — present on every install (see Degradation).

### Rung 2 — narrow (only if rung 1 left a gap)

1. **Introspect types first** with `get_available_schemas` / `get_schema` so
   your filters use real labels. (These are v2.0 — if absent, skip and use the
   labels you already saw in rung 1.)
2. **Refine:**
   - Entities: `search_memory_nodes(entity="<Label>", center_node_id=<id>)`.
   - Relationships: `search_memory_facts(edge_type="<TYPE>", center_node_id=<id>)`.
   - Time-bound: `search_memory_facts(created_after=…, created_before=…)`.
     Current-valid facts are the default; pass `include_invalidated=true` only
     for history/audit.
   - Scoping facts to a person/agent: `search_memory_facts` has **no**
     `agent_id` — pivot via `center_node_id` from an already-scoped node
     instead.

### Rung 3 — deep traversal (hand off)

Multi-hop navigation — shortest paths, full neighborhoods, walking edges — is
the **`graph-traversal` skill** (GP-857, forthcoming). Cross-reference it; do
not inline traversal here. Note those nav tools (`get_node_edges`,
`get_edges_between_nodes`, `find_path`) are **unbounded** — no pagination, no
validity filter — one more reason to let that skill own them.

## Summary-first discipline (R14 / R35)

The three summary surfaces — read these before any episode body:

- **node `summary`** — from `search_memory_nodes`.
- **lesson `summary` / `context_summary`** — from `fetch_lessons_learned`.
  (`context_summary` is often empty for edge-derived lessons; `summary` is the
  dependable field.)
- **result `title`** — from the OpenAI-compatible `search`, when present.

Full episode bodies (`get_episode`, `get_episodes`, `get_episodes_for_entity`)
only to quote verbatim or recover a crucial detail the summaries lack. These
list endpoints return the **full body of every item**, so page small (`limit`)
and call them **last**, after summaries have pinned the target. There is no
server-side episode-summary retrieval (R35) — summary-first is a reading
discipline, not a tool flag.

## Degradation

Probe with ToolSearch before assuming a tool exists — installs can hide
advanced tools via `ENABLED_TOOL_VERSIONS` (1.0 / 2.0 / 3.0) and `TOOL_PROFILE`
(agent-lite / agent-full / openai-research / all); hidden tools drop out of the
tool list entirely.

- **v1.0-core (always present):** `search_memory_nodes`, `search_memory_facts`,
  `fetch_lessons_learned`. Rung 1 always works.
- **v2.0 (hideable):** schema introspection + traversal.
- **v3.0 (hideable):** the `search` / `fetch` pair.

If v2/v3 tools are hidden: stay on rung 1, skip schema introspection, use the
labels you already have, and drop the `search` titles surface. If the memory
server is absent entirely: state the degradation in one line and proceed with
the task — never stall or block on it.

## References

- `references/tools.md` — exact per-tool parameters, defaults, return shapes,
  version tiers, and scoping behavior (the detail this skill deliberately keeps
  out of the ladder above).
