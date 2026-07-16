---
name: memory-capture
description: "Write to the gutt knowledge graph with discipline — the capture counterpart to memory-search. Use when something learned, decided, or agreed is worth persisting for future work; classify it, dedup against what's already there, and write one self-contained episode. Auto-write covers only Insight and Incident — Lesson, Decision, and WorkingAgreement need an explicit human signal first. Triggers on: remember that, capture this, we decided, lesson learned, next time, note that, actually that's wrong, document this decision, store this insight, record this, worth remembering, don't forget."
---

# Memory Capture

How every agent should write to the gutt knowledge graph: classify what you
have, gate it by trust tier, make sure it isn't already there, then write one
self-contained episode. This is the **write** counterpart to `memory-search`
and `graph-traversal` (which only read) — they forward-reference it rather than
restate it. Most captures are cheap; the discipline is in _what_ you write, and
_whether you may write it without asking_.

## Hard rules (non-negotiable — read first)

1. **Search before you write.** Run `memory-search` rung 1 first. If the point
   already exists, don't duplicate it — write a new episode with **only what
   changed**. Dedup ≠ update: a near-match is a reason to write _less_, never to
   rewrite the old entry.
2. **Trust-tier gate.** Auto-write only **Insight** and **Incident**.
   **Lesson**, **Decision**, and **WorkingAgreement** need an **explicit human
   signal** — the user asked for it or confirmed it. No signal (you inferred it
   yourself) → **draft it for review, don't write.** Can't confidently type it →
   treat it as gated.
3. **`last_n_episodes=0` on every org/group write (R34).** Org episodes must be
   self-contained; the server default of `3` is wrong for plugin writes — it
   pulls unrelated recent episodes into entity/edge extraction. Non-zero is
   meaningful **only** in personal scope, for intentionally chaining check-ins.
4. **Discover the write tool — don't assume its name.** Depending on the
   deployment you'll see per-group `add_memory_to_<group>` tools (pick the one
   for your target group; there is **no `group_id` argument**), or a generic
   `add_memory` (pass `group_id` to target a group), or `add_personal_memory`. A
   user who can write to 2+ groups often sees **only** the per-group tools —
   generic `add_memory` is hidden. Read your tool list; never hardcode a tool
   name or the `mcp__…__` prefix. (`references/tools.md` has the full map.)
5. **One focused episode, ≤15,000 chars.** Split anything larger into several
   self-contained episodes. Never store raw payloads, logs, secrets, PII, or
   one-off noise — capture the insight, not the transcript.
6. **A write is queued, not confirmed.** A success response means the episode was
   _enqueued_; extraction can still fail silently server-side. Don't treat
   success as proof it landed — verify (see Batching).

## When to write — and when not to

**Write** when there's a concrete, reusable insight a future agent couldn't get
from `git log` or reading the code: a decision and its rationale, a pitfall and
its cause, a pattern that worked, a working agreement.

**Don't write** trivia, restated task summaries, anything derivable from the
code or history, incomplete or abandoned work, or sensitive data. And don't
fight the tier gate: a Decision you inferred without the user saying so is a
**review** item, not a write.

## The capture path

1. **Worth it?** Apply the significance test above. Cheap, obvious, or transient
   → stop.
2. **Classify + gate.** Pick the type (below) and apply rule 2. Gated type with
   no human signal → draft for review and stop here.
3. **Dedup.** `memory-search` rung 1 on the key terms. Already there? Write only
   the delta as a new episode, or skip.
4. **Structure.** `name` with a typed prefix (`Decision:` / `Pitfall:` /
   `Pattern:` / `Insight:` / `Incident:`); `episode_body` as
   Context → Insight → Outcome → Guidance, ≤15k; `source="json"` for structured
   runs, `"text"` for narrative; tz-aware ISO `reference_time` only when
   backdating.
5. **Write.** Choose the tool per rule 4; pass `last_n_episodes=0`. Omit
   `group_id` unless you're on the generic tool and must target a specific group.
6. **Verify.** After the batch, confirm with a search (see Batching).

## Trust tiers

The tier map is single-sourced from the E4 joint ADR (S4.5); until that lands,
this is the operative map, from the program's capture policy:

**Auto-write — no confirmation needed:**

- **Insight** — an observation or understanding gained. _"Extraction folds in
  the last N episodes, so org writes should pass `last_n_episodes=0`."_
- **Incident** — something broke, and what happened. _"A marker file was written
  on MCP failure too, permanently poisoning the needs-onboarding gate."_

**Gated — write only on an explicit human signal, otherwise queue for review:**

- **Lesson** — a corrective takeaway. _"Don't hardcode the MCP prefix; read it
  from the tool list."_ (User says "capture that lesson" → write; you inferred
  it → queue.)
- **Decision** — a choice with rationale. _"We chose Design B for version-sync
  because AC1 forbids a marketplace version."_
- **WorkingAgreement** — a team rule. _"Every PR gets a Copilot review before
  merge."_

Anything you can't cleanly place → treat as gated.

## Batching and verification

Don't write one episode at a time in a tight loop. Collect up to **5–10**
episodes, write them, then run **one** verification search to confirm they're in
the graph — a success response only means _queued_ (rule 6). If the check comes
back empty, the writes didn't land: re-queue them, don't silently move on.

## Degradation

If no write tool is visible (fail-closed auth with no writable group) or the
memory server is absent, **do not drop the capture.** Record the full episode
draft(s) — name, body, type, intended scope — to the pending capture queue and
move on; flush them once a write tool is available. State the degradation in one
line. (The queue file and its flush are owned by the capture pipeline; here the
rule is simply: never lose a capture to an unavailable tool.)

## References

- `references/tools.md` — exact write-tool contracts (`add_memory`,
  `add_memory_to_<group>`, `add_personal_memory`), params and defaults, the
  group-targeting model, and the queued-not-persisted caveat.
- Dedup and read tools: `memory-search`. Relationship checks: `graph-traversal`.
- Autonomous end-of-session capture is done by the **memory-keeper** agent, which
  follows these same rules.
