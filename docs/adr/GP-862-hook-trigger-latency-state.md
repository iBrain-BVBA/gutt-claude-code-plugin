# ADR: Hook trigger mechanism, latency budget & state contract

- **Ticket:** GP-862 (S3.1) · Epic E3 "Core plugin hooks redesign" (GP-844) · Program GP-841 (Plugin 3.0)
- **Status:** Proposed (spike findings) — 2026-07-13
- **Owner:** Valentyn
- **Verified against:** Claude Code 2.1.207; code.claude.com/docs (hooks / hooks-guide / plugins-reference / settings)

> This ADR records the decisions coming out of the S3.1 spike. It closes the make-or-break risks and fixes the trigger mechanism. Two items (a measured latency number, the state-contract concurrency validation) and the SessionStart-after-compaction check are called out as **Open** below — GP-862 is not fully closed until those land and this ADR is reconciled against the ticket's literal acceptance criteria (Atlassian was unreachable during the spike).

## Context & problem

E3 needs Claude Code to decide, on every user prompt, whether to inject a "search organizational memory first" directive — always-on, cheap, and safe on a Claude **subscription** (no separate API key). Three questions had to be answered before building GP-863/864/865/866:

1. **Trigger mechanism** — which hook, deciding how, injecting what?
2. **Latency budget** — how much does it add to every prompt? (R25: ≤50 ms deterministic guard, ≤2 s fast-model hook)
3. **State contract** — where do on/off/snooze + per-session state live? (R37)

Hard constraints in play: **R36** (never let a background/headless model call silently use an `ANTHROPIC_API_KEY` — documented $1,800 incident); **O1** (an always-on fast prompt hook was the accepted fallback); **O4** (no subagent hooks in 3.0).

## What the spike tested & found (evidence)

- **Kill-switch — subscription-safe: CONFIRMED.** A `type:"prompt"` UserPromptSubmit hook was driven via nested `claude -p` with `ANTHROPIC_API_KEY` **unset**. It fired and ran its Haiku evaluation via `[API:timing] dispatching to firstParty` — i.e. on the session OAuth, no key, no separate billing path. O1's core assumption holds.
- **Prompt hook is a GATE, not an injector: CONFIRMED (docs + positive control).** A prompt hook's only output is `{"ok": bool, "reason": str}` (docs) → allow / block. When its model was told to _also_ emit `additionalContext`, Claude Code **stripped it** (parsed result was only `{"ok":true,"reason":"allowed"}`; sentinel reached the transcript 0×). Positive control: a `command` hook emitting the same `additionalContext` was accepted (`provided additionalContext (23 chars)`; sentinel in transcript 1×).
- **They cannot cooperate on one event.** All hooks on an event run in **parallel**; a hook cannot read or gate a sibling. `prompt` hooks **cannot** be `async`; `UserPromptSubmit` has **no matcher** support (always fires). So "prompt hook decides → command hook injects based on that decision" is impossible within one UserPromptSubmit pass.
- **Latency preview (prompt hook, n=3):** ~1.3–1.5 s warm, ~4 s cold (first call). Over the 2 s budget on cold calls. Since a prompt hook blocks the turn, this would be paid on every prompt.

## Decisions

### D1 — Trigger = deterministic COMMAND hook (no per-prompt model call)

The "search memory" directive is injected by a **deterministic command hook** on `UserPromptSubmit` returning `hookSpecificOutput.additionalContext`, gated by a keyword/trigger matrix. A `type:"prompt"` hook is **not** used as the memory-search decider — it can only block/allow, cannot inject, and cannot chain to a sibling injector. (A prompt hook may later be used strictly as a _block-gate_ for a different purpose; out of scope here.)

### D2 — Latency budget follows from D1

With no model call on the hot path, the ≤2 s fast-model budget is **deprioritized**. The only hot-path cost is process cold-start. Target the **R25 ≤50 ms** guard budget; if a Node `.cjs` hook can't hit it, use a non-Node fast path (shell/compiled). **Fail-silent-open** is retained (never delay the prompt to wait on the trigger logic). _Actual number: to be measured (Open #1)._

### D3 — State contract (R37) — proposed

A single namespaced directory under `${CLAUDE_PLUGIN_DATA}` (= `~/.claude/plugins/data/{id}/`):

- `config.json` — global (group_id, mode, snooze-until). Atomic temp+rename, last-writer-wins.
- `sessions/<session_id>.json` — per session, **keyed on the stdin `session_id`, not the date**. Eliminates hot-path write contention.
- `capture-queue.jsonl` — append-only; consumed by memory-keeper at the next SessionStart (see D4).
- **TTL cleanup at SessionStart**: expired snooze entries, session files > 24 h, stale queue entries (reuse the existing cleanup routine).
- The statusline **never locks** state files. Migrate today's _global_ memory-cache singleton to per-session. Consolidate the two divergent atomic-write idioms into one shared helper. _Proposed — validate during GP-863 (Open #3)._

### D4 — Subscription-safe capture (R36)

Background capture writes to `capture-queue.jsonl` at **Stop**, processed by memory-keeper at the **next SessionStart** (zero cost at stop, subscription-safe, one-session-deferred). Never default to `claude -p` with an inherited key. (Final mechanism ratified in S4.2.)

## Consequences

**Positive** — simpler than the O1 always-on-model design; **subscription-safe by construction**; and it **removes the biggest latency risk** (no ~1.3–4 s model round-trip per prompt). Deterministic ⇒ trivially testable for the GP-891 CI gate.

**Trade-off** — we give up per-prompt _model_ judgment for the memory-search decision; quality now rests on the trigger-matrix heuristics. The "ambiguous band" is handled by rules, not a model. Accepted; revisit if measured decision quality is insufficient (feeds GP-890).

## Constraints & traps to honor (from the codebase baseline)

- `hooks/hooks.json` is the **authoritative** hook registry. **Never** add a `hooks` key to `.claude/settings.json` — it caused a P2 double-firing incident (fixed twice). Any `/gutt:config` writer must have a test asserting it never introduces one.
- `SessionStart` `source:"compact"` **cannot** distinguish auto vs manual compaction — only `PreCompact`/`PostCompact` `trigger` can.
- `${CLAUDE_PLUGIN_DATA}` is **deleted on uninstall** unless `--keep-data` — nothing irreplaceable lives only there.
- `userConfig` entries require **both** `title` and `description`.
- Stale self-docs: `.claude/agents/{hook-expert,plugin-dev}.md` reference `playbook-matcher.cjs` / `decision-authority.cjs`, which **do not exist**. Fix so the design isn't grounded on fiction.
- The dormant routing engine (`router.cjs` + libs, unit-tested, unwired) is the nearest prior-art for confidence-band logic — review before writing new decision code; don't reinvent, don't force-fit.

## Open items (before GP-862 can close)

1. **Measure** the deterministic guard's cold-start latency (p50/p95); decide Node vs shell/compiled against the ≤50 ms target.
2. **Empirically rule in/out** `SessionStart(compact)` firing & ordering vs `PostCompact` (one auto compaction, one manual `/compact`).
3. **Validate** the D3 state contract under concurrent sessions (per-session files, atomic writes) — during GP-863.
4. **Decision-accuracy** of the trigger matrix (and whether any model judgment is warranted) — feeds GP-890.
5. **Reconcile** this ADR against GP-862's literal acceptance criteria (Atlassian was down during the spike).
6. Produce the deterministic test the **GP-891** CI harness asserts against.

## Appendix — method

Spike run in worktree `spike/gp-862-hook-kill-switch` off `origin/release/3.0`. Throwaway PoCs driven by nested `claude -p --settings … --debug-file …` with `ANTHROPIC_API_KEY` unset; signal read from debug logs + transcript, robust to inherited-hook noise. Related knowledge: reference note on the CC hook/plugin surface; Plugin 3.0 scope & risks.
