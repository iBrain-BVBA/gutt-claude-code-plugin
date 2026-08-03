# Agent identity (shared convention)

Single source of truth for how an agent identifies itself in gutt memory: what its
name is, how it registers, how it tags what it writes, and the order it recalls in.
The `agent-memory-protocol` skill and the gutt-core agents build on this — they
reference it rather than restate it, and where they compress it, this file wins.

Contents: Name · Register · Write · Recall · Unavailable · Guard rails · Template.

## Name

- A registered agent is a node `{alias}:Agent:{name}` — you supply `{name}`; the server
  derives the `{alias}:Agent:` prefix from the memory group (e.g. `gutt_pro:Agent:pr-reviewer`).
- Pick a stable, descriptive name (`pr-reviewer`, `jira-agent`). Those two, and every
  `pr-reviewer` below, are illustrative — no agent by that name ships in this repo.
- Identity is keyed on **name + group** (see Register), so different groups separate
  same-named agents on their own. Inside one group they do not separate themselves:
  **always carry a `--<scope>` suffix** — `pr-reviewer--acme-web` — so that one agent
  run from two repos is two identities unless someone chose otherwise. The double dash
  marks where the name ends and the scope begins; a single dash would be ambiguous
  inside kebab-case names.
- **Why always, and not only when a clash appears:** a clash is not visible at the
  moment it matters. Registration merges on name + group, so the first write under a
  bare name silently joins whatever else already registered under it, and org writes
  cannot be deleted or reassigned afterwards. Suffixing by default is recoverable —
  a scope deliberately shared is one command away — while pooling by default is not.
- Two handles, two uses: the registered **name** (keeps the `--`) is the identity key —
  pass it to `register_agent` and as `agent_id` on writes and scoped searches. The
  **node ID** is the slugified semantic ID, which collapses `--` to a single `-`
  (`gutt_pro:Agent:pr-reviewer-acme-web`) — it is what ID parameters (`center_node_id`,
  `get_episodes_for_entity`, …) expect. Don't build it by hand: `register_agent` returns
  it (`id`, plus the `uuid`).
- Resolve the scope in this order, taking the first that yields a value: the scope bound
  to this repo (`/gutt-pro:agent-scope show` reports it, and says which step supplied it)
  → the git remote's `owner/repo` → the working folder's name. The chain always yields
  something, so there is no unsuffixed case to fall back to.
- A bound scope is the only step a person chose, so it is the only one that survives
  moving or re-cloning the checkout. Two repos bound to the same value share one identity
  and therefore one pool of agent memory — that is how several repos of one product get a
  single agent — and two different values stay isolated. Where that sharing is wanted,
  bind it; do not rely on two remotes happening to resolve alike.

## Register (once, before tagging or scoped recall)

```
register_agent(
  name="pr-reviewer",
  description="Reviews PRs for correctness and team standards",
  group_id="<group>")
```

- Get-or-create, keyed on **name + group**: the same pair always resolves to the same
  identity node. Re-registering only refreshes the description; it never duplicates.
  Idempotent and cheap. The response returns your node handles — `id` (the semantic ID)
  and `uuid`; keep one for ID-based calls like write verification.
- **Choosing the group:** if you can write to more than one group, pass `group_id`
  explicitly — omitting it targets an unspecified one of your groups, not a fixed
  default. With exactly one group you may omit it.
- If a later scoped call fails with an unknown-agent error, register again and retry.
- **Read-only agents don't register.** Agent scope is provenance over _writes_, so an agent
  that never writes has an empty scope by construction — registering buys it nothing, and
  step 1 of Recall could only ever answer "No memories found for agent …". Skip registration,
  skip tagging, recall group-wide only, and say so in one line where the agent describes itself.

## Write (as this agent): tag every write

- When you act as this registered agent, pass `agent_id="<name>"` on **every** org-graph
  write you make (`add_memory` / `add_memory_to_<group>`). This stamps the episode as yours
  (provenance) and lets you recall it later from your own scope.
- This rule is about authorship — it applies to writes _an agent_ makes. Memory captured from
  the main session with no agent involved (e.g. the `memory-capture` skill used directly)
  carries no `agent_id`; there is no agent identity to attach.
- **When you capture another agent's run, tag that agent instead of yourself.** An episode
  carries exactly one `agent_id` — a single scalar, with no list and no metadata
  side-channel — so the choice is exclusive. A capture agent writing on its own account stamps
  its own name; capturing a `gutt-mentor` run on that agent's behalf, it stamps
  `agent_id="gutt-mentor"`. Decide **per episode, not per invocation** — one end-of-session run
  can yield both. The delegating agent names itself in its delegation prompt; default to your
  own name when it doesn't.
- Tagging hides nothing: a tagged write is still found by anyone's un-scoped search — the
  tag only _adds_ it to your scope on top. So as an agent, always tag; there is no
  "leave it untagged" case for your own org writes.
- Set `last_n_episodes=0` on org-scope writes.
- The write response does not confirm the tag landed. When it matters, verify with
  `get_episodes_for_entity(<node id or uuid from registration>)`. Org writes cannot be
  undone from a normal session — write with care.

## Recall (two steps — the group-wide one is never optional)

1. **Your scope first** (default; skip only for purely org-wide questions) —
   `search_memory_nodes(query="…", agent_id="<name>", include_related=true)` and
   `fetch_lessons_learned(query="…", agent_id="<name>")`. This is what you have learned.
2. **Then group-wide, always** — the same calls without `agent_id`. This is what the
   whole team knows.

Agent scope contains only what has been tagged to your identity — it is provenance
scoping, not access control, and it never falls back on its own: a new or thin identity
has an empty scope by construction, and the server answers "No memories found for
agent …" even when the group graph is rich. Scoped-only recall silently misses
everything the agent has not written itself.

- `agent_id` and `center_on_user` are mutually exclusive — one at a time.
- Facts carry no `agent_id`. To scope facts, first get one of your scoped nodes, then
  `search_memory_facts(center_node_id=<that node>)`.

## When memory tools are unavailable

Probe with ToolSearch (`gutt-pro-memory`) before assuming. `register_agent` can be
hidden by a deployment's version/profile gates while the `agent_id` parameters stay
available on the core search and write tools — an identity that is **already
registered keeps working**. Degrade — run unscoped and untagged, note it in one line,
and continue — only when the server is absent, or scoped calls fail with an
unknown-agent error and you cannot re-register. Never fail the task because memory
is down.

## Guard rails (rules)

- **Names are identifiers, not to be reused.** Never adopt a similarly-named existing agent
  node from another context (repo/project) just because the name matches — it pollutes both
  subgraphs. Check _before_ you register, because there is no opting out afterwards:
  registration MERGEs on **name + group**, so the same name in the same group always resolves to
  the existing node — you cannot ask for a separate one. The only escapes are a different base
  name or a `--<scope>` suffix, which lives in the name and so changes the merge key. Spotting a
  foreign anchor: if more than ~30–50% of its edges point at a different repo/project, it isn't
  yours.
- **`last_n_episodes=0` on every org-scope write.**
- **Personal scope stays untagged.** The server supports agent identity in personal scope
  too — don't use it: register in an org group, and keep personal-scope writes untagged.

## Identity template (copy, fill in)

Drop this into a role agent to make it memory-aware:

```
# On start, register once (idempotent; the response returns your node id + uuid):
register_agent(
  name="<agent-name>",              # stable; --<scope> only to separate contexts in one group
  description="<what this agent does, one or two sentences>",
  group_id="<group>")               # omit only if you can write to exactly one group

# Recall before work — your scope, then the group:
search_memory_nodes(query="<task>", agent_id="<agent-name>", include_related=true)
fetch_lessons_learned(query="<task>", agent_id="<agent-name>")
# … then the same two WITHOUT agent_id, for org-wide knowledge.

# Capture after work — tag every write (write-tool name varies; see memory-capture):
add_memory(name="<Typed: title>", episode_body="<one self-contained insight>",
           agent_id="<agent-name>", last_n_episodes=0)
# Verify when it matters: get_episodes_for_entity("<node id or uuid from registration>")
```
