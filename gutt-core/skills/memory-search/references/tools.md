# Memory tool reference

Exact contracts for the gutt-pro-memory MCP search/retrieval tools, verified
against the server source (not the tool descriptions, which can be stale or
truncated). `group_ids` and auth-derived scoping are resolved server-side — see
Scoping. Call tools by **bare name**; the `mcp__…__` prefix varies per install.

## Version tiers and profiles

Two **independent** gates decide whether a tool is visible — probe with
ToolSearch, don't assume:

- **`ENABLED_TOOL_VERSIONS`** — a max version (default `1.0`; may be `2.0` / `3.0`).
- **`TOOL_PROFILE`** — a set of tags (`core` / `navigation` / `schema` / `deep-research`).

A tool shows only if its **version ≤ the enabled max AND its tag is in the
profile.** The axes are orthogonal: `core` is a _tag_, not "v1.0"
(`add_personal_memory` is `core`-tagged but version `3.0`), and a whole tag
(e.g. `navigation` under an `agent-lite` profile) can be hidden even at
version `2.0`.

Read/search tools by tag (writes — `add_memory`, `delete_entity_edge`,
`delete_episode`, `clear_graph`, `add_personal_memory` — belong to
`memory-capture`):

| tag             | ver | tools                                                                                                                                                                       |
| --------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`          | 1.0 | `search_memory_nodes`, `search_memory_facts`, `fetch_lessons_learned`, `get_user_preferences`, `get_episode`, `get_episodes`, `get_entity_edge`                             |
| `navigation`    | 2.0 | `list_entities`, `find_path`, `get_node_edges`, `get_edges_between_nodes`, `get_entity_node`, `get_episodes_for_entity`, `get_nodes_and_edges_by_episode`, `register_agent` |
| `schema`        | 2.0 | `get_available_schemas`, `get_schema`                                                                                                                                       |
| `deep-research` | 3.0 | `search`, `fetch` (OpenAI-compatible)                                                                                                                                       |

## Search & discovery

### search_memory_nodes (v1.0)

| param           | type      | default | notes                                    |
| --------------- | --------- | ------- | ---------------------------------------- |
| query           | str       | —       | required                                 |
| max_nodes       | int       | 10      | `offset + max_nodes` ≤ 1000              |
| offset          | int       | 0       |                                          |
| center_node_id  | str       | None    | UUID or semantic ID                      |
| entity          | str       | `""`    | single label filter                      |
| group_ids       | list[str] | None    | see Scoping                              |
| agent_id        | str       | None    | mutually exclusive with `center_on_user` |
| center_on_user  | bool      | False   |                                          |
| include_related | bool      | False   | one extra hop for agent/person scoping   |

Returns `{message, nodes: [{id, name, summary, labels, group_id, created_at,
attributes}], has_more}`. **No relevance score is exposed.**

### search_memory_facts (v1.0)

| param                          | type        | default     | notes                              |
| ------------------------------ | ----------- | ----------- | ---------------------------------- |
| query                          | str         | —           | required                           |
| max_facts                      | int         | 10          | same 1000 window cap               |
| offset                         | int         | 0           |                                    |
| center_node_id                 | str         | None        |                                    |
| edge_type                      | str         | None        | exact match                        |
| created_after / created_before | ISO8601 str | None        | `after` ≤ `before`                 |
| valid_at_time                  | ISO8601 str | None (=now) | ignored if `include_invalidated`   |
| include_invalidated            | bool        | False       | default returns current-valid only |
| group_ids                      | list[str]   | None        |                                    |

**No `agent_id` / `center_on_user`.** To scope facts to a person/agent, pivot
via `center_node_id` from a node you already scoped.

### fetch_lessons_learned (v1.0)

| param          | type      | default | notes                                                                              |
| -------------- | --------- | ------- | ---------------------------------------------------------------------------------- |
| query          | str       | —       | required                                                                           |
| domain         | str       | None    | **soft signal** — appended to query text, not a hard filter                        |
| time_range     | str       | `"all"` | `\d+[dwm]` (e.g. `30d`, `2w`, `3m`); by `created_at`; invalid → silently no filter |
| max_results    | int       | 5       | hard-capped at 50                                                                  |
| offset         | int       | 0       |                                                                                    |
| agent_id       | str       | None    | mutually exclusive with `center_on_user`                                           |
| center_on_user | bool      | False   |                                                                                    |
| group_ids      | list[str] | None    |                                                                                    |

Returns `{message, lessons: [{id, summary, outcome, guidance, lesson_type,
domain, source_episode_id, relevance_score, timestamp, context_summary}],
total_count, has_more}`. `context_summary` is populated only for node-derived
lessons (edge lessons hardcode `""`); edge lessons also carry a fixed
`relevance_score` of `0.7`. Prefer `summary`. For general recall this tool is
redundant with `search_memory_nodes` (Lesson entities are themselves nodes) —
reach for it only when a task is specifically about lessons/pitfalls.

### search (v3.0, OpenAI-compatible)

`search(query, max_results=10)` — `max_results` hard-capped at 50. Returns
`{results: [{id, title, url}]}` — titles are a lightweight summary surface.
**No `group_ids`** (scoped entirely server-side).

## Navigation / inspection

All navigation tools below are **unbounded** — no pagination, no validity
filter — and belong to the `graph-traversal` skill (rung 3), not routine
search.

| tool                               | tier | signature / notes                                                                                       |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| list_entities                      | v2.0 | `(group_ids?, limit=10 max 100, cursor?)` — cursor-paginated, no query                                  |
| find_path                          | v2.0 | `(source_id, target_id, max_depth=5 max 10)` — no validity filter; won't cross episode-only co-mentions |
| get_node_edges                     | v2.0 | `(node_id, edge_type?)` — returns every edge, `has_more` always false                                   |
| get_edges_between_nodes            | v2.0 | `(source_id, target_id)` — directional source→target                                                    |
| get_nodes_and_edges_by_episode     | v2.0 | `(episode_ids: list, max 10)` — entities + facts extracted from given episodes; no validity filter      |
| get_entity_edge                    | v1.0 | single edge (fact) by id                                                                                |
| get_entity_node                    | v2.0 | single node (entity) by id                                                                              |
| get_available_schemas / get_schema | v2.0 | type introspection for rung-2 filters                                                                   |

## Episodes (full bodies — use late)

| tool                    | tier | notes                                                               |
| ----------------------- | ---- | ------------------------------------------------------------------- |
| get_episode             | v1.0 | single episode, full body — high token cost; cite only              |
| get_episodes            | v1.0 | offset-paginated, chronological (not relevance), full bodies        |
| get_episodes_for_entity | v2.0 | offset-paginated, `last_n=10`                                       |
| fetch                   | v3.0 | `(objectIds: list\|str, max 50)` — mixed nodes/edges/episodes by id |

## Scoping (group_id / agent_id)

- **group_ids is not a reliable client filter.** With OAuth + policy enforcement
  it is validated against your allow-list (denied entries dropped). Without it,
  the server **overwrites** whatever you pass with the identity-derived group.
  Don't rely on `group_ids` to widen or narrow — treat scope as server-decided.
- The literal `"personal"` in `group_ids` resolves server-side to your personal
  scope; it can't be supplied as a raw group name.
- **agent_id** exists only on `search_memory_nodes` and `fetch_lessons_learned`
  (not on `search_memory_facts`). It is a registered agent name (via
  `register_agent`) and filters to entities co-mentioned with that agent; it is
  a soft filter (client-side convention), not a hard wall. `center_on_user` is
  the same mechanism keyed to the authenticated person.
- ID-based tools have no `group_ids`; access is checked against the resolved
  item's own group.

## No truncation controls

No tool accepts `summary_only`, `max_chars`, `char_limit`, or similar. Manage
context only via item-count caps (`max_nodes` / `max_facts` / `max_results` /
`limit`) and by preferring summary-shaped outputs over episode bodies.
