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
   rewrite the old entry. But a near-match that _contradicts_ what you were
   about to write is not a dedup — take that pair to `conflict-adjudication`
   before writing.
2. **Trust-tier gate.** Auto-write only **Insight** and **Incident**.
   **Lesson**, **Decision**, and **WorkingAgreement** need an **explicit human
   signal** — the user asked for it or confirmed it. No signal (you inferred it
   yourself) → **draft it for review, don't write.** Can't confidently type it →
   treat it as gated.
3. **Keep org writes self-contained — `last_n_episodes=0`.** Pass
   `last_n_episodes=0` on every org/group write; the server default of `3` is
   wrong for plugin writes — it pulls unrelated recent episodes into entity/edge
   extraction. Non-zero is meaningful **only** in personal scope, for
   intentionally chaining check-ins.
4. **Discover the write tool — don't assume its name.** Depending on the
   deployment you'll see per-group `add_memory_to_<group>` tools (pick the one
   for your target group; there is **no `group_id` argument**), or a generic
   `add_memory` (pass `group_id` to target a group), or `add_personal_memory`. A
   user who can write to 2+ groups often sees **only** the per-group tools —
   generic `add_memory` is hidden. Read your tool list; never hardcode a tool
   name or the `mcp__…__` prefix. (`references/tools.md` has the full map.)
5. **One focused episode, ≤15,000 chars.** The server hard-rejects anything
   larger, so split it into several self-contained episodes rather than let the
   write fail. Never store raw payloads, logs, secrets, PII, or one-off noise —
   capture the insight, not the transcript.
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
4. **Structure.** `name` with a typed prefix — one of the five tier types
   (`Insight:` / `Incident:` / `Lesson:` / `Decision:` / `WorkingAgreement:`);
   `episode_body` as Context → Insight → Outcome → Guidance, ≤15,000 chars;
   `source="json"` for structured runs, `"text"` for narrative; tz-aware ISO
   `reference_time` only when backdating.
5. **Write.** Choose the tool per rule 4; pass `last_n_episodes=0`. Omit
   `group_id` unless you're on the generic tool and must target a specific group.
6. **Verify.** After the batch, confirm with a search (see Batching).

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

## Batching and verification

Don't write one episode at a time in a tight loop. Collect up to **5–10**
episodes, write them, then run **one** verification search to confirm they're in
the graph — a success response only means _queued_ (rule 6). Extraction is
asynchronous, so an immediate empty result may just mean not-yet-processed:
re-check after a moment before concluding anything was lost, and re-queue only
what's still missing — re-queueing a still-processing write manufactures the
duplicate rule 1 forbids.

## Reporting back after a capture

Say little about the capture itself — a few lines, not a report. What was written,
its type, and anything the user still has to decide. Skip the procedure you just
followed: nobody needs the dedup search narrated back to them.

Then, when the capture followed work that was already finished — a Stop-hook
verdict is the usual way that happens — close the reply with a short summary of
that work, placed last, after everything else. Writing down what a turn learned is
part of finishing it, not an interruption of it, so don't frame it as one: no
"returning to", no "the work this interrupted", no apology for the detour. Give
the summary a plain heading that names the work — "Summary", or better, what the
work actually was ("The eval suite", "What shipped") — and write it as the closing
account of the turn rather than as a recovery from a digression.

Keep it to what the user needs to carry forward: what was delivered, anything that
did not survive verification, and what is still open. It comes last because the
capture is a footnote to the turn and the work is its subject — whatever sits at
the bottom of the reply is what the user is left looking at, and it should be the
work, not the bookkeeping.

These two rules live here rather than in the Stop hook's fired reason on purpose.
That reason is a payload — a skill name and a bullet per subject — and it is read
before this file is loaded; anything procedural written there is repeated on every
firing and duplicated by the moment it matters. This file is in context by the time
either rule applies.

## Degradation

If no write tool is visible (fail-closed auth with no writable group) or the
memory server is absent, **do not drop the capture.** Hold the full episode
draft(s) — name, body, type, intended scope — in your working notes and retry
when a write tool returns; if the write can't complete this session, surface the
drafts to the user so they aren't lost. State the degradation in one line. (A
durable capture queue — `capture-queue.jsonl` — is coming with the background
pipeline; until it lands, retry in-session.)

## References

- `references/tools.md` — exact write-tool contracts (`add_memory`,
  `add_memory_to_<group>`, `add_personal_memory`), params and defaults, the
  group-targeting model, and the queued-not-persisted caveat.
- Dedup and read tools: `memory-search`. Relationship checks: `graph-traversal`.
- Deciding which of two contradicting memories should stand:
  `conflict-adjudication`. It recommends only — the approved correction is
  written back through this skill.
- Autonomous end-of-session capture is done by the **memory-keeper** agent (being
  brought in line with these rules).
