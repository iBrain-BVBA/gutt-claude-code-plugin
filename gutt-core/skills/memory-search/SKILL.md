---
name: memory-search
description: "Search organizational memory efficiently before any non-trivial task — an adaptive, relevance-gated first pass over the gutt knowledge graph, deepening only when needed. Use to recall prior decisions, lessons learned, past work, patterns, owners, or why something was done. Triggers on: previous, before, last time, decision, why did we, what do we know about, prior art, past work, lessons learned, have we done, did we already, history of, who worked on."
---

# Memory Search

How every agent should read the gutt knowledge graph: one strong first pass,
judged for relevance, deepened only when it falls short. This is the most-used
memory operation and the foundation skill — other memory skills
cross-reference it rather than restate it. Its job is to surface the answer as
fast as possible **when it exists**, and to say so plainly when it doesn't.

## Hard rules (non-negotiable — read first)

1. **One adaptive pass first.** Open with a single pass — `search_memory_nodes`
   and `search_memory_facts` in parallel, on your best phrasing. Never open with
   traversal, schema calls, or `fetch_lessons_learned`.
2. **Relevance gate.** Answer only from results that genuinely fit the question.
   If nothing on-topic comes back, say **"no relevant memory found"** — never
   assemble an answer out of loosely-matching distractors.
3. **Reformulate, don't paginate.** If the first pass is weak, **rephrase** the
   query and re-run nodes+facts (up to 2 more times, accumulating). Stop early
   if a rephrase returns essentially the same weak results. Never fetch page 2
   just because `has_more` is true — a different phrasing beats pagination.
4. **Summary-first.** Read summaries (node `summary`, lesson `summary`, `search`
   `title`) before fetching any full episode body. Full bodies only to cite or
   recover a crucial missing detail.
5. **Count caps, not truncation.** No `summary_only` / `max_chars` parameter
   exists — bound context with `max_nodes` / `max_facts` / `limit` and by
   choosing summary-shaped tools. Never invent a truncation flag.
6. **Bare tool names.** Call `search_memory_nodes` etc. by bare name; the
   `mcp__…__` prefix varies per install — use whatever your tool list surfaces.

## When to use

- Before any non-trivial task, to surface prior decisions, lessons, and context.
- To answer "have we done this / why did we / what do we know about X / who owns Y".

For **writing** memory see `memory-capture`; for **multi-hop traversal** see
`graph-traversal` (rung 3).

## The search ladder

### Rung 1 — the adaptive first pass (the workhorse)

1. Run **`search_memory_nodes(query, max_nodes≈10)`** and
   **`search_memory_facts(query, max_facts≈10)`** together on your best phrasing.
   Nodes give entity summaries ("what/who is X"); facts give the relationships
   and specific claims ("why / who decided / what's linked"). Most real
   questions need **both** — facts frequently carry the actual answer and rank
   it higher than the entity summary does.
2. **Judge the results against the question.** If the top few clearly answer it
   → stop and answer. This is the common, cheap case.
3. **If weak** (nothing clearly on-topic) → **reformulate** — different wording,
   synonyms, a more specific angle — and re-run nodes+facts. Repeat at most
   twice; stop as soon as a rephrase adds nothing new. Accumulate across
   phrasings; the best phrasing is often not the first.
4. **Relevance gate before answering:** cite only genuinely on-topic results.
   If after reformulating nothing fits, report "no relevant memory found"
   rather than stretching a distractor into an answer.

Skip `fetch_lessons_learned` in rung 1 — Lesson entities are also nodes, so
`search_memory_nodes` already surfaces them. Reach for it only when the task is
explicitly about lessons/pitfalls, where its `guidance` / `outcome` structure
is worth a dedicated call.

### Rung 2 — narrow with filters (only if rung 1 left a gap)

Introspect types with `get_available_schemas` / `get_schema` (v2.0 — skip if
hidden), then refine:

- Entities: `search_memory_nodes(entity="<Label>", center_node_id=<id>)`.
- Relationships: `search_memory_facts(edge_type="<TYPE>", center_node_id=<id>)`.
- Time-bound: `search_memory_facts(created_after=…, created_before=…)` —
  current-valid is the default; `include_invalidated=true` only for history.
- To scope facts to a person/agent, pivot via `center_node_id` from an
  already-scoped node (`search_memory_facts` has no `agent_id`).

### Rung 3 — deep traversal (hand off)

Multi-hop paths and full neighborhoods — `find_path`, `get_node_edges`,
walking edges — belong to the **`graph-traversal` skill** (GP-857,
forthcoming). Cross-reference it; do not inline traversal here. Those nav tools
are **unbounded** (no pagination, no validity filter) — one more reason to let
that skill own them.

## Summary-first discipline

The three summary surfaces — read these before any episode body:

- **node `summary`** — from `search_memory_nodes`.
- **lesson `summary` / `context_summary`** — from `fetch_lessons_learned`
  (`context_summary` is often empty for edge-derived lessons; `summary` is the
  dependable field).
- **result `title`** — from the OpenAI-compatible `search`, when present.

Full episode bodies (`get_episode`, `get_episodes`, `get_episodes_for_entity`)
only to quote verbatim or recover a crucial detail. These list endpoints return
the **full body of every item**, so page small (`limit`) and call them **last**.
There is no server-side episode-summary retrieval — summary-first is a
reading discipline, not a tool flag.

## Degradation

Probe with ToolSearch before assuming a tool exists — installs hide advanced
tools via `ENABLED_TOOL_VERSIONS` (1.0 / 2.0 / 3.0) and `TOOL_PROFILE`
(agent-lite / agent-full / openai-research / all); hidden tools drop from the
tool list.

- **v1.0-core (always present):** `search_memory_nodes`, `search_memory_facts`,
  `fetch_lessons_learned`. Rung 1 always works.
- **v2.0 (hideable):** schema introspection + traversal.
- **v3.0 (hideable):** the `search` / `fetch` pair.

If v2/v3 tools are hidden: stay on rung 1 and its reformulation loop, skip
schema introspection, drop the `search` titles surface. If the memory server is
absent entirely: state the degradation in one line and proceed — never stall.

## References

- `references/tools.md` — exact per-tool parameters, return shapes, version
  tiers, and scoping behavior.
