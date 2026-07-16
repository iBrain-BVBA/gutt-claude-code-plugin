---
name: graph-traversal
description: "Walk the gutt knowledge graph's relationships to answer what a summary can't — how things connect, what depends on or blocks what, and whether a fact still holds. The deep rung of memory search (rung 3): it runs after a first pass has surfaced the relevant entities, never as the first call. Triggers on: how is X connected to Y, what does X depend on, what blocks X, is X still true, is X still current, trace the chain, downstream of, upstream of, X's relationships, related to, why is X blocked."
---

# Graph Traversal

The deep-dive rung of memory search. Once memory-search (rungs 1–2) has
surfaced the relevant entities, walk their relationships to answer questions a
summary can't: how things connect, what depends on what, and whether something
is _still_ true. You enter already holding entry results — so you **start at
PICK**, never at a fresh search.

## Hard rules (non-negotiable — read first)

1. **Never the first call — and try rung 2 before rung 3.** Enter from
   memory-search's rung 1–2 results already in context. Crucially, rung 2 —
   `search_memory_facts(center_node_id=…, edge_type=…)` — is **valid-only by
   default**, so it often settles "is X still …?" without the unbounded nav
   tools. Drop to rung-3 traversal only for what rung 2 can't give: exhaustive
   neighborhoods, multi-hop chains, affirmative history (an edge _and_ when it
   died), or reconciling duplicate nodes. If invoked with no entry node in hand,
   run memory-search rung 1 first.

2. **Never trust an edge's currency without checking dates — and one date isn't
   enough.** The nav tools return superseded edges with no warning (on an active
   item, ~a third are stale). Before presenting any edge as current:
   - drop edges with `expired_at` or `invalid_at` set;
   - when two _live_ edges of the same kind disagree (duplicate `HAS_STATUS`,
     etc. — it happens), prefer the newest `valid_at`;
   - for "is X still blocked / true?", also look for a **replacement** — an old
     edge can expire while a _narrower_ one takes its place the same day.

   Never trust a node `summary` for currency: summaries fold old and current
   facts together with no date.

3. **`find_path` is not for typed chains.** It is undirected _and_ edge-type-
   blind, so it routes through shared hubs — two tickets both "To Do" or sharing
   a creator get a bogus 2-hop "path" through the `Status` or `Person` node,
   often over a _stale_ edge. Use it only for "are these connected _at all_", and
   distrust any path running through a status/person hub. For a dependency or
   impact chain, walk `get_node_edges(edge_type=BLOCKS|DEPENDS_ON)` hop by hop.

4. **Re-center when a node is big — it may not just flood, it can error.**
   People, sprints, and epics can have hundreds of edges, and `get_node_edges`
   has no limit; on a busy person it can exceed the tool's output cap and fail
   outright. Don't traverse harder — re-center on a smaller, specific neighbor
   (the exact comment, episode, or story) that carries the same fact.

5. **Verify identifiers.** The same real thing often exists as several nodes,
   each holding only part of its edges (a short `…:GP-860` and a long
   `…:GP-860-Rebuild-…`). A thin or surprising result may mean you're on a
   duplicate — confirm by full title and expand each duplicate. Only nodes have
   readable ids (`alias:Label:slug`); edges and episodes are raw UUIDs — never
   invent a semantic id for an edge.

6. **Bare tool names.** Call `get_node_edges` etc. by bare name; the `mcp__…__`
   prefix varies per install.

## When to go deeper — and when to stop

**Traverse (rung 3)** when the entry results show one of:

- **Currency you can't settle at rung 2** — you need the affirmative history
  (the edge _and_ its `expired_at`), not just "is it in the valid set".
- **Named but not restated** — a summary _names_ a decision, lesson, or ticket
  without its content. Hop to it. (If it paraphrases it inline, stop.)
- **Chain / "how are these connected"** — walk it hop by hop.
- **Named entity, specifics missing** — identity is shallow but the fact is a
  hop away.

**Stop** when:

- A node summary already answers it, or rung-2 valid-only facts already answer
  it — traversing anyway is wasted work and a failure mode.
- The answer is already echoed across the entry results.
- The fact simply isn't in the graph (no edge of that type exists) — say so;
  traversal can't manufacture a missing edge.

## The loop: pick → navigate → inspect

Search already ran (memory-search rung 1–2), so you enter at **pick**.

1. **Pick** — choose the most promising node id(s). Prefer specific, low-degree
   nodes over hubs (rule 4).
2. **Navigate** — expand with the tool that fits the goal (below), filtering
   stale edges (rule 2). One or two hops answers most questions; three for a
   cascade.
3. **Inspect** — fetch a single node, edge, or episode only to confirm or quote.

| Goal                                | Tool                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| All of a node's neighbors           | `get_node_edges` (then filter stale)                                            |
| A typed dependency / impact chain   | `get_node_edges(edge_type=…)` hop by hop — **not** `find_path`                  |
| How X relates to topic Q            | `search_memory_facts(query=Q, center_node_id=X)` — valid-only, partial          |
| Are two nodes connected at all      | `find_path` — undirected; distrust hub-routed paths                             |
| A directed link A→B                 | `get_edges_between_nodes(source_id=A, target_id=B)`                             |
| Entities co-mentioned in a snapshot | `get_nodes_and_edges_by_episode(episode_ids)` — from an edge's `episodes` field |
| A named node / edge                 | `get_entity_node` / `get_entity_edge`                                           |
| Provenance or a verbatim quote      | `get_episode`                                                                   |

**Depth:** one or two hops wins; three at most, for a real cascade. `find_path`'s
default `max_depth=5` is headroom — don't raise it.

## Degradation

Navigation is gated two independent ways — probe with ToolSearch, don't assume:
a tool shows only if its **version** ≤ the install's `ENABLED_TOOL_VERSIONS`
_and_ its **tag** is in the `TOOL_PROFILE`. So the nav tools can vanish either
because the version is below 2.0 _or_ because the profile (e.g. `agent-lite`)
omits the `navigation` tag — the whole rung can disappear at once.

Without nav tools you lose reliable enumeration and pathfinding — a real
downgrade. Fall back to `search_memory_facts(center_node_id=…)` (relevance-
biased, valid-only, partial) plus `get_entity_edge` / `get_episode` by id, and
**say in your output that the traversal was degraded.**

## References

- Tool parameters, return shapes, version/tag gating, and scoping — the memory
  tool reference in the `memory-search` skill (`references/tools.md`). Single
  source; not restated here.
- Entry search (rungs 1–2): `memory-search`. Writing memory: `memory-capture`.
