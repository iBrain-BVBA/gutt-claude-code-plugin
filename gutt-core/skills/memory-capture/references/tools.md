# Memory write-tool reference

Exact contracts for the gutt-pro-memory MCP **write** tools. Where these
disagree with the MCP tool descriptions, trust these — the descriptions are
stale in places, noted below. Read/search tools live in the `memory-search`
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
  from your login). See the `add_personal_memory` section below.

Rule of thumb for the skill: **if you see `add_memory_to_*` tools, use them and
pass no `group_id`; otherwise use `add_memory`.** Never assume a fixed name —
your tool list is the practical source of truth for what you can target.

## add_memory (v1.0, `core`)

| param              | type          | default | notes                                                                                            |
| ------------------ | ------------- | ------- | ------------------------------------------------------------------------------------------------ |
| name               | str           | —       | required; typed prefix + concise title                                                           |
| episode_body       | str           | —       | required; hard cap 15,000 chars (rejected above it — split, don't truncate)                      |
| group_id           | str           | None    | see group targeting above; often ignored/overwritten                                             |
| source             | str           | `text`  | `text` \| `message` \| `json`; unknown value silently → text                                     |
| source_description | str           | `""`    | provenance, e.g. `"memory-capture skill"`                                                        |
| uuid               | str           | None    | **don't** use as an idempotency key — see caveats                                                |
| previous_episodes  | list[str]     | None    | **episode** UUIDs or semantic IDs; supplying it overrides `last_n_episodes` — see below          |
| last_n_episodes    | int           | 3       | **pass `0` for all org/group writes** (self-contained); unread when `previous_episodes` is given |
| reference_time     | ISO8601 \| dt | now     | use tz-aware ISO 8601 when backdating                                                            |
| agent_id           | str           | None    | must be `register_agent`-registered or the call errors                                           |

The per-group `add_memory_to_<alias>` tools take the **same params minus
`group_id`** (it's fixed to that group).

### `previous_episodes` vs `last_n_episodes` — precedence, not composition

These two are **not** independent inputs. They are two ways to fill the _same_
thing — the set of previous episodes handed to extraction — and an explicit list
wins.

Three consequences worth knowing before you pass either:

- **Supplying `previous_episodes` means `last_n_episodes` is not read at all** (a
  negative value is still rejected). Passing `last_n_episodes=0` alongside it is
  harmless and redundant. Hard rule 3 still says to pass it, because a rule that
  holds unconditionally is cheaper to follow than one with a carve-out — and it
  is what keeps the write self-contained on the paths where you pass no
  predecessors at all.
- **`last_n_episodes=0` alone means genuinely no context** — an empty set, not
  "unspecified". That distinction is the whole point of the rule: left
  unspecified, the server falls back to fetching its own recent window of 10.
- **It is fail-loud.** Ids are resolved _before_ the episode is queued, so a bad
  id costs you the **whole write**, not just the link: missing → an error saying
  "not found"; ambiguous semantic id → "Ambiguous" plus the alternatives; a
  partial failure stops early and nothing is written. Pass only ids a search
  actually handed you.

**They must be _episode_ ids.** Resolution only looks at episodes, so an entity
id like `gutt_pro:Lesson:Some-Lesson` is invalid and will fail the write. This
matters because of where the ids come from: `search_memory_nodes` returns **no**
episode ids at all (`attributes._original_uuid` is a _node_ uuid).
Episode ids come from `search_memory_facts`, in each fact's `episodes` array —
so on a rung-1 dedup it is the **facts** half of the pass that gives you
something you can pass here.

## add_personal_memory (v3.0, `core`)

Same params as `add_memory` **minus `group_id`** — the personal group is derived
server-side from your OAuth identity and can't be supplied. Same entity/edge
schema as org memory (not a different shape). This is the one place
`last_n_episodes` > 0 is policy-permitted at all (chaining personal check-ins) —
though even there an explicit `previous_episodes` is the better chain, since
`last_n_episodes` links you to whatever was written most recently in that
person's personal scope rather than to the thing you mean. `gutt-mentor`'s
`progress-tracking` chains check-ins that way for exactly this reason. Gated by
personal scope being enabled and a resolvable login.

## Caveats

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
a stale memory by writing a **new episode** with the current fact — not by
deleting. Whether the old memory should be retired at all is a human's decision,
made on the `conflict-adjudication` skill's recommendation; the approved
correction is written back through this path.
