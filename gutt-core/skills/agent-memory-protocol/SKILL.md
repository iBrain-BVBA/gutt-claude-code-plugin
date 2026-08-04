---
name: agent-memory-protocol
description: "Register a memory identity and use it — the protocol for any agent that reads and writes the gutt knowledge graph as itself. Register once, recall your own scope before the group's, and tag every write you make. Builds on memory-search (recall) and memory-capture (write) and layers agent identity on top. Triggers on: register agent, agent identity, agent_id, agent-scoped memory, scoped recall, act as an agent, my own memory, role agent, memory protocol, agent registration."
---

# Agent Memory Protocol

How an agent works the gutt knowledge graph as _itself_: register a memory
identity, recall your own scope before the group's, and tag every write you make
so the next run of you can find it. This layers **agent identity** on top of
`memory-search` (how to read) and `memory-capture` (how to write). The identity
convention — naming, registration, tagging, recall order, guard rails — lives in
one normative place: `references/agent-identity.md`. This file is the operative
digest; on any conflict, the reference wins.

Use this when you act as a **named agent** (a subagent, a role agent). Writing
from the main session with no agent identity is just `memory-capture` — no
registration, no tagging.

## Finding the scope bound to this directory (do this before step 1)

Your registered name carries a `--<scope>` suffix, and the first place to look for its
value is the binding a person set with `/gutt-pro:agent-scope`. You cannot run that
command to ask — it only takes effect when a human types it — so read the stored value
directly:

- **`<DATA_DIR>`** — `${CLAUDE_PLUGIN_DATA}`, interpolated into this sentence for you. Do
  not pass `$CLAUDE_PLUGIN_DATA` through to a shell and do not `export` it: only hooks are
  given it, so it expands to nothing in a command you run.
- Read `<DATA_DIR>/config.json` and look under `projects`. The key is the **name Claude Code
  gives this project's transcript directory**, which you can derive from your working
  directory: resolve its symlinks, then replace every path separator, drive-letter colon,
  `.` and `_` with a single `-`. So `/Users/me/my_app` is `-Users-me-my-app`, and on Windows
  `C:\dev\my.app` is `C--dev-my-app`. Take `projects.<that key>.agentScope.value`.
  - Resolve the symlinks first (`pwd -P`): on macOS `/tmp` and `/var` are links into
    `/private`, and the unresolved spelling gives a key that never matches.
  - Match the key **exactly**. If nothing matches, treat it as unbound and fall through —
    never pick the closest-looking entry, because a wrong match binds this directory to
    another one's identity, permanently.

Use that value as your scope when it is present. When the file is missing, the key is
absent, or the record does not carry a plain `value` string, **there is no binding** — fall
through to the derived steps in the reference (git remote, then folder name) and normalise
as it describes. Falling through is the normal case, not an error; do not report it.

Never invent a scope, and never register a bare base name because the lookup came back
empty — the derived steps always yield something.

## The protocol

1. **Register first.** `register_agent(name="…", description="…", group_id="…")`
   before any agent-scoped read or tagged write — idempotent, keyed on name +
   group. Pass `group_id` explicitly when you can write to more than one group;
   keep the returned node `id`/`uuid` for verification (step 5). The name always
   carries a `--<scope>` suffix; resolve and normalise it per the reference, taking
   the first step that yields a value (scope bound here → git remote's `owner/repo`
   → working folder's name). Never register a bare base name — it merges with
   whatever already holds that name in the group, and that cannot be undone. If a scoped call later
   fails with an unknown-agent error: re-register, retry. **Read-only agents skip
   this step** — agent scope is provenance over writes, so an agent that never
   writes has an empty scope by construction: skip registration, skip tagging,
   recall group-wide only, and say so in one line where the agent describes itself.
2. **Recall — your scope** (default; skip only for purely org-wide questions —
   see the table below).
   `search_memory_nodes(query="…", agent_id="<name>", include_related=true)` and
   `fetch_lessons_learned(query="…", agent_id="<name>")`. Phrasing, the relevance
   gate, and reformulation are `memory-search`'s job — this only adds `agent_id`.
3. **Recall — group-wide. Never skip this.** The same calls **without**
   `agent_id`. Your scope holds only what you have already tagged — empty for a
   new identity — while the group graph holds the org's knowledge. Facts have no
   `agent_id`: pivot via `search_memory_facts(center_node_id=…)` (see
   `memory-search` rung 2 and `graph-traversal`).
4. **Do the work.**
5. **Capture — tag every write.** Follow `memory-capture` (classify, dedup,
   trust-tier gate) and add `agent_id="<name>"` plus `last_n_episodes=0` to every
   org write. The response does not confirm the tag — when it matters, verify
   with `get_episodes_for_entity(<node id or uuid from registration>)`.
   Personal-scope writes stay untagged (see the reference's guard rails).

## Which scope to recall

Not every question needs your own scope. Reading only:

| Ask                                                                                   | Recall                                                |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| "What did _I_ conclude/see last time?" — your run history, prior verdicts, signatures | Scoped first, then group-wide as backup               |
| "What does the _org_ know?" — decisions, other teams' lessons, tickets, ownership     | Group-wide; skip scoped or use it only as a long shot |
| New or rarely-run agent (little history of its own)                                   | Group-wide is the workhorse; scoped will be thin      |

Writing is **not** a scope choice: as an agent you tag _every_ org write (step 5).
The table is only about reading.

## Degradation

Probe with ToolSearch before assuming a tool exists. `register_agent` can be
hidden by a deployment's version/profile gates (`memory-search` →
`references/tools.md` has the map) while the `agent_id` params stay on the core
tools — an already-registered identity keeps working. Run unscoped and untagged,
noting it in one line, only when the server is absent or scoped calls error and
you cannot re-register. Never stall.

## References

- `references/agent-identity.md` — **the normative identity convention**: naming
  and the `--<scope>` suffix, registration and group targeting, the
  tag-every-write rule, two-step recall, guard rails, and the copy-paste identity
  template for role agents. On any conflict with this file, it wins.
- Recall mechanics: `memory-search`. Write mechanics (classify, dedup, tiers,
  tool discovery): `memory-capture`. Multi-hop relationships: `graph-traversal`.
