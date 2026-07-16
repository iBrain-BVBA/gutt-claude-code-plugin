# Memory write-tool reference

Exact contracts for the gutt-pro-memory MCP **write** tools, verified against the
server source (`gutt_pro_mcp/`), not the tool descriptions (which are stale in
places — noted below). Read/search tools live in the `memory-search`
`references/tools.md`; deletes are out of scope (see end). Call tools by **bare
name**; the `mcp__…__` prefix varies per install.

## Which write tool exists — and how you target a group

The write surface changes by deployment. What matters is what your **tool list**
shows, not env vars you can't see:

- **Per-group tools** — `add_memory_to_<alias>` (e.g. `add_memory_to_board`), one
  per group you can write to. The group is baked into the tool; there is **no
  `group_id` parameter**. Registered only when the server has a dynamic group
  config, and only surfaced under OAuth + policy enforcement. A user who can
  write to **2+ groups** typically sees **only** these — the generic `add_memory`
  is hidden. Target a group by **calling its tool**.
- **Generic `add_memory`** — one tool with a `group_id` parameter. What a
  single-group user sees, or any user when per-group tools aren't deployed, or
  when OAuth/policy enforcement is off. Target a group by **passing `group_id`**
  (honored only under OAuth + policy enforcement; otherwise ignored and the
  server uses the identity-derived group).
- **`add_personal_memory`** — personal scope; no `group_id` (server derives it
  from your login). See Personal scope.

Rule of thumb for the skill: **if you see `add_memory_to_*` tools, use them and
pass no `group_id`; otherwise use `add_memory`.** Never assume a fixed name.
Note that a group can be writable at call time without appearing in the tool
list — tool visibility is filtered independently of execution authorization.

## add_memory (v1.0, `core`)

| param              | type          | default | notes                                                        |
| ------------------ | ------------- | ------- | ------------------------------------------------------------ |
| name               | str           | —       | required; typed prefix + concise title                       |
| episode_body       | str           | —       | required; ≤15,000 chars (split larger); no raw payloads      |
| group_id           | str           | None    | see group targeting above; often ignored/overwritten         |
| source             | str           | `text`  | `text` \| `message` \| `json`; unknown value silently → text |
| source_description | str           | `""`    | provenance, e.g. `"memory-capture skill"`                    |
| uuid               | str           | None    | **don't** use as an idempotency key — see caveats            |
| previous_episodes  | list[str]     | None    | UUIDs or semantic IDs; leave unset when `last_n_episodes=0`  |
| last_n_episodes    | int           | 3       | **pass `0` for all org/group writes (R34)**                  |
| reference_time     | ISO8601 \| dt | now     | use tz-aware ISO 8601 when backdating                        |
| agent_id           | str           | None    | must be `register_agent`-registered or the call errors       |

The per-group `add_memory_to_<alias>` tools take the **same params minus
`group_id`** (it's fixed to that group).

## add_personal_memory (v3.0, `core`)

Same params as `add_memory` **minus `group_id`** — the personal group is derived
server-side from your OAuth identity and can't be supplied. Same entity/edge
schema as org memory (not a different shape). This is the one place
`last_n_episodes` > 0 is meaningful (chaining personal check-ins). Gated by
personal scope being enabled and a resolvable login.

## Caveats (verified in source)

- **Queued ≠ persisted.** A success response means the episode was _enqueued_.
  Background extraction (entity/edge, LLM, DB) can fail and is only logged
  server-side — the caller is not told. Verify a batch with a search before
  trusting it landed. This is why the skill batches then verifies.
- **`uuid` is not an idempotency key.** A fresh/unknown `uuid` raises (silently,
  in the background) instead of creating that id; an existing `uuid` reprocesses
  that episode's _stored_ content and ignores your new body. Dedup by
  **searching first**, not by reusing a uuid.
- **`source` is not validated.** Any unrecognized value silently falls back to
  `text` — no error. Use exactly `text` / `message` / `json`.

## Out of scope: deletes

`delete_entity_edge`, `delete_episode`, and `clear_graph` exist on the server but
are **not part of this curriculum** and aren't used by the capture path. Correct
a stale memory by writing a **new episode** with the current fact (conflict
adjudication supersedes the old one where supported) — not by deleting.
