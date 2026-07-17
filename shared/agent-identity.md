# Agent identity (shared convention)

Single source of truth for how an agent identifies itself in gutt memory: what its
name is, how it registers, how it tags what it writes, and the order it recalls in.
The `agent-memory-protocol` skill and the gutt-core agents build on this — they
reference it rather than restate it.

Scope: this is the **team / org graph** only. Personal-scope memory carries no agent
identity (see Guard rails).

## Name

- A registered agent is a node `{alias}:Agent:{name}` — you supply `{name}`; the server
  adds the `{alias}:Agent:` prefix from the memory group (e.g. `gutt_pro:Agent:pr-reviewer`).
- Pick a stable, descriptive name (`pr-reviewer`, `jira-agent`). To run the same agent
  with separate memory per team, project, or person, add a scope suffix to the name —
  `pr-reviewer--acme-web`. The suffix lives inside the name, because registration is keyed
  on the name (below).
- Resolve which name to use in this order: bound config (the `/gutt:agent-scope` setting,
  when it exists) → the git remote's owner/repo → the working folder's name.

## Register (once, before tagging or scoped recall)

```
register_agent(name="pr-reviewer", description="Reviews PRs for correctness and team standards")
```

- Get-or-create: the same name always resolves to the same identity node (keyed on
  name + group). Re-registering only refreshes the description; it never duplicates.
  Idempotent and cheap.
- No group needed — the server uses its default group.
- If a later scoped call fails with an unknown-agent error, register again and retry.

## Write (as this agent): tag every write

- When you act as this registered agent, pass `agent_id="<name>"` on **every** org-graph
  write you make (`add_memory` / `add_memory_to_<group>`). This stamps the episode as yours
  (provenance) and lets you recall it later from your own scope.
- This rule is about authorship — it applies to writes _an agent_ makes. Memory captured
  from the main session (e.g. the `memory-capture` skill used directly, with no agent)
  carries no `agent_id`; there is no agent identity to attach. See `memory-capture` for that
  path.
- Tagging hides nothing: a tagged write is still found by anyone's un-scoped search — the
  tag only _adds_ it to your scope on top. So as an agent, always tag; there is no
  "leave it untagged" case for your own writes.
- Set `last_n_episodes=0` on org-scope writes (R34).
- The write response does not confirm the tag landed. When it matters, verify with
  `get_episodes_for_entity(<your agent node>)`. Org writes cannot be undone from a normal
  session — write with care.

## Recall (two steps, always both)

1. **Your scope first** — `search_memory_nodes(query, agent_id="<name>", include_related=True)`
   and `fetch_lessons_learned(query, agent_id="<name>")`. This is what you have learned.
2. **Then group-wide** — the same calls without `agent_id`. This is what the whole team knows.

Always do step 2, even when step 1 returns results. Agent scope narrows hard: for a new or
thin agent it returns **nothing at all**, while the group-wide search returns the org's full
knowledge. Scoped-only recall silently misses everything the agent has not written itself.

- `agent_id` and `center_on_user` are mutually exclusive — one at a time.
- Facts carry no `agent_id`. To scope facts, first get one of your scoped nodes, then
  `search_memory_facts(center_node_id=<that node>)`.

## When memory tools are unavailable

If the register/search tools are not loaded (try ToolSearch: `gutt-pro-memory`) or the
server is down, do not stall: proceed unscoped and untagged, note the degradation in one
line, and continue. Never fail the task because memory is down.

## Guard rails (rules)

- **Names are identifiers, not to be reused.** Never adopt a similarly-named existing agent
  node from another context (repo/project) just because the name matches — it pollutes both
  subgraphs. Create a new anchor. Rule of thumb: if more than ~30–50% of an existing anchor's
  edges point at a different repo/project, it is not yours — make a new one.
- **`last_n_episodes=0` on every org-scope write.** (R34)
- **No agent tagging in personal scope.** Personal-scope writes carry no `agent_id`; agent
  identity is org-scope only. (R32)
