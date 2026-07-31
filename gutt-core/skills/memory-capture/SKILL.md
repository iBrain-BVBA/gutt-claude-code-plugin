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

1. **Search before you write — and keep the ids of what you found.** Run
   `memory-search` rung 1 first. If the point already exists, don't duplicate it
   — write a new episode with **only what changed**, and name the near-matches
   as `previous_episodes` on that write (rule 7). Dedup ≠ update: a near-match
   is a reason to write _less_, never to rewrite the old entry. But a near-match
   that _contradicts_ what you were about to write is not a dedup — take that
   pair to `conflict-adjudication` before writing.
2. **Trust-tier gate.** Auto-write only **Insight** and **Incident**.
   **Lesson**, **Decision**, and **WorkingAgreement** need an **explicit human
   signal** — the user asked for it or confirmed it. No signal (you inferred it
   yourself) → **draft it for review, don't write.** Can't confidently type it →
   treat it as gated.
3. **Keep org writes self-contained — `last_n_episodes=0`.** Pass
   `last_n_episodes=0` on every org/group write; the server default of `3` is
   wrong for plugin writes — it pulls unrelated recent episodes into entity/edge
   extraction. Non-zero is meaningful **only** in personal scope, for
   intentionally chaining check-ins. This bans the _blind_ recent-N window, not
   provenance: naming specific related episodes is rule 7, and the two do not
   conflict.
4. **Discover the write surface — the tool _and_ the group. Hardcode neither.**
   Two questions, two sources, both read at call time:
   - **Which tool?** Read your **tool list**. Depending on the deployment you'll
     see per-group `add_memory_to_<alias>` tools (pick the one for your target
     group; there is **no `group_id` argument**), or a generic `add_memory` (pass
     `group_id` to target a group), or `add_personal_memory`. A user who can
     write to 2+ groups often sees **only** the per-group tools — generic
     `add_memory` is hidden. Never hardcode a tool name or the `mcp__…__` prefix.
   - **Which group?** Read the **`group://<group_id>/instructions` MCP
     resources**. Listing them _is_ the discovery step: the listing is
     ABAC-filtered, so the `group://` resources you can see are the scopes you
     may touch, and each payload carries the `group_id` to pass, a display name,
     and — when the deployment has filled them in — prose on what belongs in that
     group. `group://personal/instructions` is the private-scope sibling.

   **A tool alias is not a `group_id`.** The `<alias>` in
   `add_memory_to_<alias>` is frequently _not_ the id of the group it writes to —
   ids carry suffixes aliases drop. Sometimes the two do match, which is what
   makes guessing dangerous: you cannot tell from the tool name which case you're
   in.

   **So pair the two by description, never by name.** Having picked a group, find
   its tool by reading the **tool descriptions** — the per-group write tools name
   their target namespace in the description text, which is the one place the
   `group_id` and the tool are stated together. Never pair them by string-matching
   the alias against the id. If no description names your group unambiguously,
   **ask the user** rather than picking the closest-looking tool: a write to the
   wrong group cannot be moved from here. (`references/tools.md` §"Finding the
   group" has the full map, the payload shape, and what to do when `instructions`
   comes back `null`.)

5. **One focused episode, ≤15,000 chars.** The server hard-rejects anything
   larger, so split it into several self-contained episodes rather than let the
   write fail. Never store raw payloads, logs, secrets, PII, or one-off noise —
   capture the insight, not the transcript.
6. **A write is queued, not confirmed — but don't go looking for it.** A success
   response means the episode was _enqueued_; extraction runs later and can fail
   silently server-side. So **don't claim it landed** — report it as captured, not
   as confirmed. Equally, **don't search to check.** Indexing lags the write by
   long enough that a search straight afterwards returns nothing whether the
   write succeeded or not, which makes the result worthless: it can't distinguish
   pending from lost, and re-queueing on a false negative manufactures the
   duplicate rule 1 forbids. The one exception is a write you are about to take an
   **irreversible action** on — deleting the local source, as `migrate-memory`
   does before removing files. There, verification is mandatory and its cost is
   the point; everywhere else it is waste.
7. **Name what the episode builds on — `previous_episodes`.** When rule 1's
   dedup surfaced related episodes and you have their **episode** ids, pass them
   as `previous_episodes` on the write. A delta episode whose antecedents are
   nowhere in its input reads to extraction as a standalone claim. Three things
   to get right, all covered in `references/tools.md`:
   - **Episode ids, not node ids.** `search_memory_nodes` returns none; take them
     from `search_memory_facts` results, in each fact's `episodes` array.
   - **Only ids a search returned.** Resolution happens before the write, so one
     bad or ambiguous id fails the **whole write** — don't hand-build them.
   - **Nothing to link → omit it.** An unrelated episode in the list is worse
     than an empty one, and most captures have no antecedent at all.

   Supplying it makes `last_n_episodes` a no-op; keep passing `0` anyway per
   rule 3. Prose in the body is not a substitute — extraction reads this field,
   not your cross-references.

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
   the delta as a new episode, or skip. Before you move on, collect the episode
   ids of the near-matches you're writing against — from the `episodes` array of
   the facts the pass returned. This is the only step where they are in front of
   you, and step 5 needs them.
4. **Structure.** `name` with a typed prefix — one of the five tier types
   (`Insight:` / `Incident:` / `Lesson:` / `Decision:` / `WorkingAgreement:`);
   `episode_body` as Context → Insight → Outcome → Guidance, ≤15,000 chars;
   `source="json"` for structured runs, `"text"` for narrative; tz-aware ISO
   `reference_time` only when backdating.
5. **Write.** Resolve tool and group per rule 4. If more than one scope is
   writable, list the `group://` resources and choose deliberately — a write with
   the group left to the server lands in an unspecified one of your groups, which
   is a misfile you cannot undo from here. Pass `last_n_episodes=0`, and
   `previous_episodes` with step 3's ids when there are any (rule 7). Omit
   `group_id` unless you're on the generic tool and must target a specific group.
6. **Report — don't verify.** Say what you captured and stop; no confirmation
   search (rule 6). Verify only if you're about to delete the source.

## Trust tiers

Until the shared trust-tier policy is finalized in a later story, this is the
operative map, from the program's capture policy:

**Auto-write — no confirmation needed:**

- **Insight** — an observation or understanding gained. _"Extraction folds in
  the last N episodes, so org writes should pass `last_n_episodes=0`."_
- **Incident** — something broke, and what happened. _"A marker file was written
  on MCP failure too, permanently poisoning the needs-onboarding gate."_

**Gated — write only on an explicit human signal, otherwise queue for review:**

- **Lesson** — a corrective takeaway. _"Don't hardcode the MCP prefix; read it
  from the tool list."_ (User says "capture that lesson" → write; you inferred
  it → queue.)
- **Decision** — a choice with rationale. _"We kept the marketplace file
  version-free to avoid a second source of version drift."_
- **WorkingAgreement** — a team rule. _"Every PR gets a Copilot review before
  merge."_

Anything you can't cleanly place → treat as gated.

## Batching

Don't write one episode at a time in a tight loop. Collect up to **5–10**
episodes and write them together.

Then stop. Don't run a verification search (rule 6): extraction is asynchronous
and lags far enough behind the write that an immediate search tells you nothing —
an empty result means "not indexed yet" and "never landed" equally, so it cannot
justify either re-queueing or reporting a loss. Report what you wrote and move
on.

Verify only when something irreversible depends on the write having landed — the
`migrate-memory` path, which deletes local files and so treats an unverified
write as unfinished. That skill owns the mechanics; it is the exception, not the
pattern.

## Reporting back after a capture

Say little about the capture itself — a few lines, not a report. What was written,
its type, and anything the user still has to decide. Skip the procedure you just
followed: nobody needs the dedup search narrated back to them.

What comes _after_ that account — how the reply closes, and on what — belongs to the
`output-style` skill and is deliberately **not** restated here. When a Stop-hook
verdict is what brought you to this file, that rule is already in front of you: the
hook injects it into the same reason that named this skill. Otherwise, invoke
`output-style` to read it.

Why the split, since this file used to argue against any procedure reaching the
fired reason: that argument is about **duplication**. The reason is a payload — a
skill name and a bullet per subject — read before this file loads, so a rule written
in both places is paid for twice and the second copy is the one that lands. It holds,
and it is why the capture account above stays here. It does not reach text that
exists in exactly one place and is loaded on no other path. The closing style is
exactly that: nothing on the capture path loads `output-style`, so injecting it
duplicates nothing, and not injecting it means the rule is never read at all.

## Degradation

If no write tool is visible (fail-closed auth with no writable group) or the
memory server is absent, **do not drop the capture.** Hold the full episode
draft(s) — name, body, type, intended scope — in your working notes and retry
when a write tool returns; if the write can't complete this session, surface the
drafts to the user so they aren't lost. State the degradation in one line.

**A missing `group://` resource is not that case.** Resources can be unlistable,
absent, or carry `instructions: null` on a server whose write tools work fine —
rule 4's two halves fail independently. Losing the group prose costs you routing
guidance, not the ability to write: fall back to the **tool descriptions**, which
name each tool's target namespace and are what you pair a group to anyway
(rule 4). If exactly one writable scope is on offer, use it. Only an ambiguous
choice between several groups is worth pausing to ask about — and there, ask
rather than guess.

## References

- `references/tools.md` — exact write-tool contracts (`add_memory`,
  `add_memory_to_<group>`, `add_personal_memory`), params and defaults, the
  group-targeting model, and the queued-not-persisted caveat. Its §"Finding the
  group" covers the `group://` resources: how to enumerate them, the payload
  shape, and what to do when the payload is empty or the resource is missing.
- Dedup and read tools: `memory-search`. Relationship checks: `graph-traversal`.
- Deciding which of two contradicting memories should stand:
  `conflict-adjudication`. It recommends only — the approved correction is
  written back through this skill.
- How the reply closes once the capture is reported: `output-style`. It owns
  where the account sits and everything below it; this file owns what the account
  says and how long it runs. The block `output-style` injects deliberately stops
  short of specifying either, so the two do not state one rule twice on the path
  where both are in context.
