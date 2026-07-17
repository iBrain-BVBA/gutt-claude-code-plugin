---
name: agent-memory-protocol
description: "Register a memory identity and use it — the protocol for any agent that reads and writes the gutt knowledge graph as itself. Register once, recall your own scope before the group's, and tag every write you make. Builds on memory-search (recall) and memory-capture (write) and layers agent identity on top. Triggers on: register agent, agent identity, agent_id, agent-scoped memory, scoped recall, act as an agent, my own memory, role agent, memory protocol, agent registration."
---

# Agent Memory Protocol

How an agent works the gutt knowledge graph as _itself_: register a memory
identity, recall your own scope before the group's, and tag every write you make
so the next run of you can find it. This layers **agent identity** on top of
`memory-search` (how to read) and `memory-capture` (how to write) — it
cross-references them for mechanics rather than restating them. The identity
convention itself — naming, registration semantics, guard rails — lives in one
shared place: `references/agent-identity.md`.

Use this when you act as a **named agent** (a subagent, a role agent). Writing
from the main session with no agent identity is just `memory-capture` — no
registration, no tagging.

## Hard rules (non-negotiable — read first)

1. **Register before you scope.** Call `register_agent` once at the start,
   before any agent-scoped read or tagged write. Idempotent — safe to repeat.
   Naming and semantics: `references/agent-identity.md`.
2. **Group-wide recall is mandatory; your scope is an optional first look.**
   Agent-scoped search is a fast pass over your _own_ history — but it returns
   nothing for a new or thin agent, so never rely on it alone. Always include a
   group-wide pass; lead with scoped only when you specifically want what _you_
   learned before.
3. **Tag every write you make as this agent.** Pass `agent_id="<name>"` on every
   org write, with `last_n_episodes=0` (see `memory-capture`). Main-session
   writes (no agent) stay untagged — that path is `memory-capture`, not this
   skill.
4. **Verify the tag landed.** A write response doesn't prove attribution;
   confirm with `get_episodes_for_entity(<your agent node>)` when it matters. An
   org write can't be undone from a normal session.
5. **Degrade, don't stall.** If `register_agent` / scoping tools are absent
   (server down or profile-gated), run unscoped and untagged, note it in one
   line, and continue.

## The protocol

1. **Register.** `register_agent(name, description)` — resolve the name per
   `references/agent-identity.md` (bound config → git remote → folder).
   Get-or-create; on an unknown-agent error later, re-register and retry.
2. **Recall — your scope first** (when you want your own prior work; skip for
   purely org-knowledge questions — see _Which scope to recall_).
   `search_memory_nodes(query, agent_id="<name>", include_related=True)` and
   `fetch_lessons_learned(query, agent_id="<name>")`. Phrasing, the relevance
   gate, and reformulation are `memory-search`'s job — this only adds `agent_id`.
3. **Recall — then the group.** Re-run the searches **without** `agent_id` for
   org-wide knowledge. Facts have no `agent_id`, so scope relationships by
   pivoting on a node you already found (`search_memory_facts(center_node_id=…)`
   — see `memory-search` rung 2 and `graph-traversal`).
4. **Do the work.**
5. **Capture — tag what you write.** Follow `memory-capture` (classify, dedup,
   trust-tier gate, `last_n_episodes=0`) and add `agent_id="<name>"` to every
   write. Verify the batch (rule 4).

## Which scope to recall

Not every question needs your own scope. Reading only:

| Ask                                                                                   | Recall                                                |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| "What did _I_ conclude/see last time?" — your run history, prior verdicts, signatures | Scoped first, then group-wide as backup               |
| "What does the _org_ know?" — decisions, other teams' lessons, tickets, ownership     | Group-wide; skip scoped or use it only as a long shot |
| New or rarely-run agent (little history of its own)                                   | Group-wide is the workhorse; scoped will be thin      |

Writing is **not** a scope choice: as an agent you tag _every_ write (rule 3).
The table is only about reading.

## Identity template (copy, fill in)

Drop this into a role agent to make it memory-aware — no need to read the
source triage agent it generalizes, or any other skill's internals:

```
# On start, register once (idempotent):
register_agent(
  name="<agent-name>",              # stable; add --<scope> to segregate by team/project
  description="<what this agent does, one or two sentences>")
  # group_id optional — omit for the server default; set it to target a specific graph.

# Recall before work — your scope, then the group:
search_memory_nodes(query="<task>", agent_id="<agent-name>", include_related=True)
fetch_lessons_learned(query="<task>", agent_id="<agent-name>")
#   … then the same two WITHOUT agent_id for org-wide knowledge.

# Capture after work — tag every write (write-tool name varies; see memory-capture):
add_memory(name="<Typed: title>", episode_body="<one self-contained insight>",
           agent_id="<agent-name>", last_n_episodes=0)
#   Verify: get_episodes_for_entity("<alias>:Agent:<agent-name>")
```

The naming rule, the `--<scope>` suffix, registration semantics, and the
never-reuse-another-context's-name guard rail all live in
`references/agent-identity.md` — the single source; don't restate them in the
agent.

## Degradation

`register_agent` and the scoping params are v2.0 / `navigation`-gated — a
restrictive `TOOL_PROFILE` (e.g. `agent-lite`) or a low `ENABLED_TOOL_VERSIONS`
can hide them even when core search stays (`memory-search` → `references/tools.md`
has the map). When identity/scoping is unavailable: skip registration, run
`memory-search` and `memory-capture` unscoped and untagged, note the degradation
in one line, and proceed — never stall.

## References

- `references/agent-identity.md` — the identity convention (naming, `--<scope>`
  suffix, `register_agent` semantics, write-tagging rule, two-step recall order,
  guard rails). Single source; shared with the gutt-core agents.
- Recall mechanics: `memory-search`. Write mechanics (classify, dedup, tiers,
  tool discovery): `memory-capture`. Multi-hop relationships: `graph-traversal`.
