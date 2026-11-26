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

Where memory review is on, all three hold a review-tier episode instead of writing
it — see §"Memory review" below.

## Finding the group — the `group://` MCP resources

Your tool list tells you _that_ you can write somewhere. The **`group://`
resources** tell you _where_, and _what belongs there_. Read them instead of
carrying a hardcoded list of groups — the server's list is current, yours goes
stale the moment a group is added or renamed.

**Discovery is a resource listing.** List the memory server's resources and keep
the `group://` ones. Team-group resources are tagged `group:<group_id>` and the
listing is access-filtered, so **the `group://` resources you can see are the
scopes you may touch** — the listing is your roster. Never guess a group id or
probe for one.

**Payload** — `application/json`, one object:

| field          | notes                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| `group_id`     | the exact string to pass as `group_id`, or inside `group_ids` on reads    |
| `display_name` | human label for prose and prompts — a label, not an id; never pass it     |
| `instructions` | prose on what the group holds and when to write to it — **may be `null`** |

`group://personal/instructions` is the private-scope sibling: untagged, visible
to every authenticated user, and authoritative on personal mechanics — write with
`add_personal_memory`, read by putting the literal `"personal"` in `group_ids`
(`get_episodes` takes the singular `group_id="personal"` instead). Expect it to
carry prose even when the team groups don't.

**`instructions: null` is normal, not a failure.** The prose comes from a
server-side config a deployment may simply not have filled in, and team groups
returning `null` while `personal` returns prose is a common shape. Null means _no
routing guidance available_: fall back to `display_name` plus the tool
description, and ask the user if the choice is still ambiguous. It does **not**
mean the group is unwritable.

**Enumerate per-group resources; don't depend on an aggregate.** A
`group://all/instructions` returning every accessible group at once may or may not
be reachable on a given deployment — it can be absent, or present but restricted.
A denial does **not** tell you which: the URI template matches any segment, so
`Access denied for group: all` is what you get either way, and it is not evidence
about whether an aggregate exists. Don't infer a cause from it and don't report it
as a permissions fault. Treat the aggregate as unavailable, fall back to
enumerating the per-group resources, and never make it a prerequisite.

**The alias in a tool name is not a `group_id`.** The `<alias>` in
`add_memory_to_<alias>` is often not the id of the group it writes to — ids carry
suffixes aliases drop. Sometimes the two do match, and that is the trap: stripping
`add_memory_to_` yields a string that may or may not be a real id, and the tool
name alone never tells you which. Read the id from the resource; call the tool by
its listed name.

On the read side this is **fail-loud**: an id you hold no grant for is rejected
with `Access denied: you are not authorized for the requested group scope` — not
silently ignored, and not an empty result set. So a guessed id fails visibly
instead of quietly narrowing a search to nothing. This is narrower than
`memory-search` §Scoping's "treat scope as server-decided": the server may
override or widen a scope you are **entitled** to, but an unauthorized id is an
error, not an override.

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

## Memory review — drafts, the card, and the settle tools

Present only where the deployment has memory review on. **`confirm_memory` in your tool
list is the sign**: it, `discard_draft` and `list_writable_groups` are registered for every
client whenever review is on. The `_ui` tools are added when the server also serves the
review card, and are listed to clients that may not be able to draw it — `review.md`
§"Card host or text host" is why that listing proves nothing.

### The hold, on every write tool

`add_memory`, `add_memory_to_<alias>` and `add_personal_memory` all hold a **review-tier**
episode instead of writing it, and reply with a message rather than a stored episode:

> Not stored yet: '<name>' is a <Type>, which needs the user's review. Batch
> `<batch_id>`, draft `<draft_id>`. If draft_memories_ui is available, call it with
> batch_id='<batch_id>' to show the review card. Otherwise show the draft to the user
> and, only once they agree, call confirm_memory(draft_id='<draft_id>'); if they decline,
> discard_draft(draft_id='<draft_id>'). Drafts expire after 24 hours.

- **The tier is read from the name.** The prefix before the first colon is the type; a
  prefix that names a review tier anywhere in it is held (`Insight on a Decision:` is a
  Decision). A name with no colon, or a lower-case prefix, is untyped and not held.
  The review tiers are a deployment setting — Lesson, Decision and WorkingAgreement by
  default.
- **Sending the same capture twice** returns the same held draft, not a second one.
- **A group the review cannot write to** is refused outright, with nothing held:
  `Not stored: '<name>' needs review, and memory review cannot write to <group_id>`.

### draft_memories_ui (card tool)

`draft_memories_ui` stages one to five drafts as a batch, runs their checks, and on a card
host shows them in the review card. Nothing is stored by this call.

| param      | notes                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `episodes` | 1–5 drafts; omit when reopening. Each: `name`, `episode_body`, and optionally the fields below |
| `batch_id` | alone, reopens a batch — including one a write tool held                                       |
| `agent_id` | one per batch; stamps every draft in it (`agent-memory-protocol`)                              |

Each episode takes `name` (typed), `episode_body` (Markdown, `## Context` / `## Insight` /
`## Outcome` / `## Guidance`), `group_id` (defaults to your first writable group — pass it,
per rule 4), `previous_episodes`, `source`, `source_description`, and `uuid`.

- **There is no `last_n_episodes`.** The store step always writes with
  `last_n_episodes=0`, so rule 3 holds by construction.
- **`previous_episodes` arrive pre-selected as context**, but only ids in the draft's own
  group are used; the rest come back as warnings. Besides episode ids it accepts the
  contextual ids search returns (an entity id stands for the newest episodes mentioning
  it) and the `uuid` of an earlier draft in the same batch.
- **`uuid` is for citing within a batch.** Give a draft a fresh uuid only when a later
  draft in the batch cites it; it must not already belong to a stored episode. Otherwise
  omit it — the server assigns one and `confirm_memory` reports it.
- **Returns** the card's state and a text summary written for the model; which one
  reaches you depends on the client. The summary has one line per draft,
  `<draft_id> <name> → <group label>`, with each warning and failure named, then the
  related episodes found — `linked:` or `suggested:`, each with its id and match score.
  A client that passes on the state instead, as Claude Code does, gets a JSON object:
  draft ids and per-draft checks under `state.drafts`, and related episodes for the
  open draft only, under `state.cur.related`. Review-tier drafts start undecided; the
  rest start approved.
- **Drafting the same episodes twice** reopens the open batch instead of making another.

### Checks — what blocks and what only warns

Run on every draft and again on every body edit.

- **Fail** — blocks approve, confirm and submit: an empty name, an empty body, a body
  over 15,000 characters, a detected secret.
- **Warn** — never blocks: no type prefix, a missing body section, personal data, a
  context id dropped or belonging to another group.

### confirm_memory / discard_draft (text path)

|                  | params                                           | effect                                                                        |
| ---------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `confirm_memory` | `draft_id`; optional `name`, `previous_episodes` | stores one draft; `name` renames it, `previous_episodes` replaces its context |
| `discard_draft`  | `draft_id`                                       | drops one draft without storing it — irreversible                             |

- **Call `confirm_memory` only after the user saw the draft and said yes.** That is the
  tool's whole contract; the server cannot check it, so the agent's restraint is the
  enforcement.
- **One draft at a time**, inside whichever batch holds it; the batch's other drafts are
  untouched. A batch whose drafts are all settled is finished.
- **The reply names the episode id**: `'<name>' (<draft_id>) is stored as episode <id>` —
  the id to cite in a later `previous_episodes`.
- **Idempotent.** Repeating a settle returns the first answer, ending
  `Nothing was changed.` A settle that contradicts an earlier one is refused.
- **The body cannot change here.** Edit it with `update_memory_draft_ui`, or discard and
  draft again.
- **`previous_episodes` is resolved first**: any id that is not usable refuses the call
  and names it (`Not usable as context: …`).

### The other card tools

- **`update_memory_draft_ui`** (`draft_id`; optional `rev`, `name`, `episode_body`,
  `group_id`, `decision`, `previous_episodes`, `reject_reason`) — edit or decide one
  draft; with only `draft_id` it returns the draft, and the receipt once its batch is
  submitted. A body
  edit re-runs the checks; a `group_id` moves the draft and searches the new group. A
  `decision` is `approve` or `reject`, cannot go back to undecided, and cannot approve a
  failed check. **Your `approve` leaves a review-tier draft undecided** — only the
  reviewer approves those, in the card. A stale `rev` returns `conflict` with the
  current draft.
- **`decide_remaining_drafts_ui(batch_id, decision)`** — decide every undecided draft;
  failed checks force `reject`, and your `approve` skips review-tier drafts.
- **`submit_memory_batch_ui(batch_id, approved?)`** — store every approved draft and
  discard the rejected; refused while any draft is undecided, a no-op the second time.
  `approved` is the count you expect, and a mismatch refuses. On a text host, settle with
  `confirm_memory` / `discard_draft` instead.
- **`list_writable_groups()`** — read-only; the groups you can write to, with the label
  and kind the card shows. Handy for the group name in a review question; rule 4's
  `group://` resources remain the source of what belongs where.

### Expiry

A batch lives 24 hours from its last change, scoped to the user who drafted it. After
that, every call on it answers `Unknown or expired batch` / `draft`, and the text is gone.

## Caveats

- **Queued ≠ persisted.** A success response means the episode was _enqueued_.
  Background extraction (entity/edge, LLM, DB) can fail and is only logged
  server-side — the caller is not told. So don't report a write as confirmed. But
  don't search to check either: indexing lags the write, so a search taken
  straight afterwards returns nothing whether or not the write will land, and
  reads as a loss when it isn't. Verify only when an irreversible step depends on
  it (see the skill's rule 6).
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
