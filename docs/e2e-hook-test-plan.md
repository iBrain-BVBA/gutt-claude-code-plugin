# E2E test plan for the rebuilt hook set (GP-844 → GP-892)

The 3.0 rebuild replaced 13 hook scripts and ~3,500 lines of regex judgement with
**six thin routers**, one of which shells out to `claude -p` for a model judgement. This plan says what the
end-to-end tier must prove about that shape, why each claim can only be proven
there, and what it deliberately does not attempt.

It supersedes the retired `docs/hook-test-plan.md`, which tested hooks that no
longer exist.

## What changed, and what that does to testability

| 2.x                                               | 3.0                                          | Consequence for testing                                                                      |
| ------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 13 hook scripts, regex intent extraction          | 5 command routers, behaviour lives in skills | Unit tests can cover routing decisions; they cannot cover whether a skill is reachable       |
| `stop-lessons.cjs` judged in regex                | `Stop` is a `type: "prompt"` model judge     | **No unit test can run it at all** — the verdict is produced by Claude Code's own model call |
| Nag on every prompt                               | One-shot, consumed-on-read lifecycle flags   | "Silent on later prompts" is a claim about a live session, not a function                    |
| Statusline with counters and passthrough chaining | Read-only single line                        | Never rendered in headless mode — see Known gaps                                             |

The unit tier (`tests/session-lifecycle.test.cjs`, 50+ cases) already covers the
trigger matrix, lock behaviour, TTL sweep, snooze and the R25 latency budget
in-process. **This plan adds only what the unit tier structurally cannot reach.**

## The three claims only e2e can settle

1. **The anti-nag guarantee.** The redesign's headline promise is that the plugin
   points at memory once per session start and then shuts up. Row 4 of the trigger
   matrix is unit-tested against a state file, but the claim users care about — two
   prompts in one live session produce exactly one injection — needs two prompts
   under one `SessionStart`.
2. **The Stop router works and terminates.** `ok:false` feeds the reason back as
   Claude's next instruction. Whether that fires, whether it stops firing, and what
   the user ends up seeing are all emergent properties of a model judge inside a
   turn loop.
3. **Coexistence (R23).** Hooks must share a session with other plugins without
   `{{decision:block}}`.

   **Restated 2026-08-20 against what was measured.** R23 rested on two claims about
   Cowork, and both are false. Hooks are not unsupported there — they fire on both Cowork
   surfaces. And a command Stop hook's blocking decision is not ignored there — it is
   honoured, continuing the turn exactly as on the CLI, with the hook re-invoked carrying
   `stop_hook_active` when that turn ends (`hook-platform-capabilities.md` §9.1).
   R23 also names exit-code 2 as a second blocking channel, though the one-line statement
   above carries only the blocking-decision half — a divergence between the constraint as
   recorded in the 3.0 program and as written down here, worth closing when someone
   rewrites this list. That clause is equally untested against a real Cowork run, and moot
   in practice: no hook in this repository exits 2, every exit point is 0.

   The constraint nonetheless **survives, on a different reason than the one it was
   written for.** A blocking decision in a session shared with another plugin re-enters
   that plugin's turn as well, which is a coexistence problem whether or not the platform
   honours the block. What changes is the scope of the claim: this is a
   multi-plugin-etiquette rule, not a platform limitation, and it should stop being cited
   as evidence that Cowork cannot do something.

## Environment facts, verified not assumed

Every fact below was established by probe runs against `claude 2.1.220` before
any test was written. They are the load-bearing assumptions of the suite.

- **The Stop prompt is wrapped, not passed through.** Claude Code prepends
  _"Based on the conversation transcript above, has the following stopping
  condition been satisfied? Answer based on transcript evidence only.\n\nCondition:"_.
  Our prompt is therefore consumed as a **condition**, and `ok:true` means
  "satisfied → allow the stop". The debug log renders `ok:true` as
  `Prompt hook condition was met`, including when the payload also carries a
  `reason` — which is then discarded.
- **`--resume` re-arms the memory pointer.** A resume fires `SessionStart` with
  `source: "resume"`, and `beginSession()` treats every non-`compact` source as a
  restart. The session id and state file are reused, `rev` keeps climbing, and
  `firstPromptPending` is set again. So a resumed turn is **not** a "later prompt"
  and cannot demonstrate row 4.
- **Two prompts can share one SessionStart** via
  `--input-format stream-json --output-format stream-json --verbose`, writing one
  user message per turn to stdin. This is the only way to observe row 4 e2e.
- **`--session-id <uuid>` fixes the state file path up front**, so a test can plant
  `config.json` keyed to the session it is about to run instead of discovering the
  id afterwards.
- **Plugin skills do load under `--plugin-dir`, and they are namespaced.**
  `skill_listing` in the transcript contains `gutt-pro:memory-search`,
  `:memory-capture` and the rest, so the routers' targets exist at runtime — but only
  under the `<plugin>:<stem>` form. The injected text originally named the bare
  `memory-search`, which is not invocable; it now carries the namespace, and
  `hook-architecture.test.cjs` asserts both halves resolve. A live Stop evaluation
  showed why this matters: the judge copied the stem out of the prompt verbatim into
  the reason it handed Claude as an instruction.
- **`--plugin-dir` is repeatable**, which is how the coexistence run loads
  `gutt-core` and a generated throwaway companion plugin together.
- **`config.json` is global.** Every session on the machine shares one file, so any
  test that plants a snooze must back it up and restore it.
- **The CLI never logs a completion line for the synchronous `session-start.cjs`.**
  `session-end.cjs` gets `[...] completed with status 0`; SessionStart gets nothing
  of the kind. The only per-event record is the async sibling's
  `Registering async hook ... (SessionStart:<matcher>)` line, which is what
  `sessionStartEvents()` reads — and it names the matcher, so it also distinguishes a
  fresh start from a resume.
- **A fixed session id breaks state sampling on re-runs.** The sampler only samples
  files that _appear_ during a run, so reusing an id means the state file already
  exists and is skipped, yielding zero samples. Every run generates a fresh UUID and
  removes its own record afterwards.
- **The Stop judge costs 2.5–4.1s of turn-end latency, and that is not a defect.**
  Measured across three real evaluations: 2.49s (130-message transcript), 3.18s (67
  messages), 4.07s (86 messages), first byte at 1.1–1.3s, dispatched to
  `claude-haiku-4-5`. R25 sets a ≤2s target for the prompt hook and the GP-862 spike
  already recorded that target as unmet (p95 5.4s, max 8.4s over 21–30 runs) — so
  these numbers corroborate a known finding rather than reporting a new problem. The
  explicit `timeout` in hooks.json is what actually bounds it — it must outlive the judge
  child's own cap, and both were raised on 2026-07-31 (judge 30s → 60s, handler 45s → 75s)
  after four `timeout` outcomes, all on turns whose closing message ran past ~2400 chars.
  **Correction, 2026-07-31:** this bullet previously said "the 30s platform hard timeout is
  never reached". There is no 30s platform cap on a `command` hook — the documented default is
  **600s** (30s is the default for `prompt` hooks, which is likely where the number came from).
  So the explicit `timeout` is a tightening of a generous default rather than a value pressing
  against a ceiling, and there is headroom above 75s if it is ever needed. Part of the cost is
  structural: `$ARGUMENTS` expands to the transcript-context JSON including the whole
  `last_assistant_message`.
- **A prompt hook's model call has no tools.** Every evaluation logs
  `Tool search disabled: ToolSearchTool is not available`, plus one
  `Filtering out tool_reference for unavailable tool` warning per MCP tool the main
  agent had loaded. The forked judge inherits the transcript and nothing else. This
  is why the Stop prompt must be written against transcript-only capability — it
  cannot check whether something was already captured, only infer it. Those warnings
  look like a connectivity fault in the log and are not one.

## Run budget

The tier's discipline is _one `claude -p` call per set of claims, not one per
assertion_. Six runs, all with tools denied, on the machine's subscription (R36) —
Haiku except run 4, which needs a Sonnet turn to have something worth judging:

| Run | File                        | Claims                                                       |
| --- | --------------------------- | ------------------------------------------------------------ |
| 1   | `session-lifecycle.e2e.cjs` | startup lifecycle, state contract, AC3, row 2 injection, R36 |
| 2   | `hook-routing.e2e.cjs`      | **row 4 anti-nag** across two prompts, one SessionStart      |
| 3   | `hook-routing.e2e.cjs`      | **row 1 snooze** suppresses without burning the flag         |
| 4   | `hook-routing.e2e.cjs`      | **Stop router fires and terminates**, reply stays clean      |
| 5   | `hook-routing.e2e.cjs`      | **R23 coexistence** with a generated companion plugin        |
| 6   | `hook-routing.e2e.cjs`      | **row 0 `/gutt-pro:` config command** applied, and relayed   |

## Per-run assertions

### Run 2 — the anti-nag guarantee

Two prompts, one invocation, one `--session-id`.

- exactly one `SessionStart` and one `SessionEnd` for two prompts
- **exactly one** `provided additionalContext` event across both turns
- the injection carries the first-prompt text, not the compaction text
- `Stop` is evaluated once per turn (two evaluations, not one, not three)
- every verdict is parseable `{ok: boolean}`
- both result envelopes report the same session id and `is_error: false`

### Run 3 — snooze suppresses, and does not consume

A session-scoped snooze is planted for a known session id before launch.

- **zero** `additionalContext` events for the whole run
- a mid-run state sample still shows `firstPromptPending: true` — the snooze
  suppressed the pointer without burning the one-shot flag. Asserted from samples
  because `SessionEnd` clears the flag, so the final file cannot show it.
- `SessionEnd` removed `snoozeSessionId`/`snoozeUntil` and left `enabled`/`mode`
  untouched. GP-866 made those keys writable from `runtime-config.cjs` too, so the
  claim is now about scope rather than ownership: the sweep goes through
  `withoutSnooze` and only `restore()` (the `/gutt-pro:on` path) deletes `enabled`.
- the run still answers the user normally

### Run 4 — the Stop router fires, and stops firing

A turn where the **assistant** produces the durable content (a design decision with
rationale), since a tools-denied turn cannot discover anything otherwise.

- at least one verdict is `ok:false` — the router reaches `memory-capture` at all
- **the number of Stop evaluations is bounded (≤ 3)**
- the user-visible reply is non-empty
- the reply does not leak the judge protocol (no `{"ok": ...}` / fenced JSON)
- the session terminates with `is_error: false`

Verdict _direction_ is a characterization check, not a hard contract: it comes from
a model call. Observed on the probe shapes — design decision 16/16 `ok:false`,
articulated lesson 2/3 then `ok:true`, plain acknowledgement 0/2. The bound and the
reply cleanliness are the deterministic parts and the real guards.

### Run 5 — coexistence (R23)

`gutt-core` + a minimal companion plugin the run builds in a temp dir, loaded together,
result of one prompt. The companion is generated rather than borrowed so the run does not
depend on some other plugin continuing to exist and continuing to ship hooks.

- both plugins' `hooks.json` are read; exactly one gutt plugin loads, from this repo
- gutt's six handlers still register and the lifecycle still completes
- no hook emits a blocking decision, and the session is not interrupted
- the companion's `SessionEnd` handler actually **runs** to completion alongside gutt's,
  rather than merely being registered, so coexistence is proven at execution time and
  not just at load time. `SessionEnd` is the event that makes this checkable: the CLI
  logs it as `[<command>] completed with status N`, whereas a `SessionStart` handler is
  registered as one opaque async hook whose command never appears in the log, and a tool
  event never fires at all in a run that denies every tool
- the companion's own data dir stays empty, so neither plugin writes into the other's

### Run 6 — the `/gutt-pro:` config command (GP-866, GP-931)

Two command prompts in one session, config planted empty so the run starts from the
documented defaults: `/gutt-pro:off 30`, then `/gutt-pro:config`.

The namespaced spelling is used on purpose, and after GP-931 it is the only one that
works for `config`: Claude Code's own `/config` intercepts the bare form before any hook
sees it (measured, `docs/plugin-platform-reference.md` §8). It is also what the `/` menu
inserts, so it is the form real users produce.

Note what `off 30` writes after the GP-931 D3 reversal: `snoozeUntil`, never `enabled`.
The durable flag is `/gutt-pro:disable`'s alone, so a run that found `enabled` set here
would be a regression of the reversal rather than a snooze that happened to persist.

- both turns return `is_error: false`
- **exactly two** `additionalContext` events, both from `user-prompt-submit.cjs` —
  one per command turn, and no memory pointer, because row 0 returns before the
  pointer rows
- `config.json` afterwards holds a `snoozeUntil` roughly 30 minutes out, and **no**
  `enabled` key — a minute snooze must not touch the durable flag
- a mid-run state sample still shows `firstPromptPending: true` — a config turn does
  not spend the session's one pointer
- the reply to prompt 1 mentions the 30 minutes, i.e. the model **relayed** the
  injected result rather than surfacing it as suspicious (GP-868) or improvising
  about config it never read
- no `"decision": "block"` anywhere in the debug log (R23)

This run is the only tier that can settle two things: that a command's raw text and
arguments reach `UserPromptSubmit` at all, and that injected factual prose is consumed
rather than flagged. Both were unverified anywhere in the repo before GP-866 — the
first was established by reading a real `hook-invocations.log`, and this run is what
keeps it true.

### Run 7 — the nested-run guard, against an installed plugin (not yet written)

The one claim the unit tier structurally cannot make. `tests/nested-run.test.cjs` proves
each hook stays inert **when the env var is already set**; it cannot prove the var survives
into a real `claude -p` child, because that needs a child that actually loads this plugin.

The trap that makes a fake version of this test easy to write, and which a first attempt
already fell into: under `--plugin-dir` the child has **no copy of the hooks to re-enter**,
so the guard never fires, nothing recurses, and the test passes while asserting nothing.
Only an _installed_ plugin reproduces the shape. CLAUDE.md records a `"source":
"directory"` marketplace entry as confirmed to load in place, which makes it the cheapest
honest setup.

One prompt, one turn, durable enough that the judge fires:

- `hook-invocations.log` holds **exactly one** `Stop:` line for the turn — a second would
  mean the child re-entered the Stop hook and judged its own judging
- **no** SessionStart or UserPromptSubmit record attributable to the child, i.e. no
  `sessions/<id>.json` beyond the one the real session owns — the child fires those events
  too, and without the guard it would write a judge subprocess's lifecycle into the user's
  session state
- the run terminates on its own, with no depth limit needed to stop it

Until this exists, `docs/headless-cli-reference.md` Follow-up 2 stands: the recursion guard
is reasoned and unit-tested at one end, and unobserved end to end.

## Unit-tier additions this plan also requires

Free, deterministic, and they close silent-failure holes the thin-router design
creates:

- **Every skill a hook names must exist.** A router that points at a renamed skill
  fails silently — the model just gets a pointer to nothing.
- **The Stop prompt must have a termination condition.** See below.

## Known gaps, and why

- **Row 3 (compaction).** Genuinely triggering a compaction needs a context large
  enough to overflow, which is neither cheap nor reliable in a headless run. Covered
  at the unit tier via `SessionStart[compact]`; the e2e path is left uncovered
  deliberately rather than faked.
- **The statusline — this is GP-867's open question, and the evidence is now in.**
  GP-867 exists to "verify empirically whether a plugin-shipped top-level
  `statusLine` key has any effect in a real Claude Code session". Across seven real
  sessions driven while building this plan, the CLI debug log contained **zero**
  occurrences of `statusline` in any form, and reported
  `Registered 6 hooks from 6 plugins` — exactly gutt-core's six _hook_ handlers,
  with the `statusLine` block not among them. `statusline.cjs` is never invoked by
  the platform. Verified separately that the script itself works when run directly
  (it renders `[gutt⚪!] | [Haiku 4.5] ~$0.01`), so this is a wiring question, not a
  broken script.

  No e2e assertion is written, because encoding a platform limitation as expected
  behaviour would freeze it. The finding belongs to GP-867, which should decide
  whether to drop the key or move to `subagentStatusLine`.

- **MCP-dependent assertions.** Connectivity state is asserted for shape, not for a
  particular verdict: the probe depends on the developer's real MCP config, and a
  contributor without gutt configured must not see a red suite.
- **The ABA lock-inode window** remains untested, as noted in `plugin-state.cjs`.

## Defects this plan found in the Stop router

Writing the plan turned up two real defects in `hooks.json`. Run 4 exists to guard
both.

### 1. The judge livelocked — 16 model calls, and an empty answer

On a turn that produced a durable design decision, the judge answered `ok:false`
**16 consecutive times**. `ok:false` feeds the reason back and the turn continues,
which re-fires Stop, which asks again. `stop_hook_active` was `true` on 15 of those
16 evaluations — Claude Code passes that flag precisely so a Stop hook can break its
own loop — and the prompt never mentioned it, so nothing told the judge to relent.
Sixteen model calls were spent on one turn and the user's reply came back **empty**.

Fixed by adding an explicit stopping rule to the prompt: when `stop_hook_active` is
true, answer `ok:true` regardless of what the transcript shows. Post-fix the same
prompt stays inside the 3-evaluation bound and relents on the first re-entry.

### 2. The judge protocol leaked into the user's answer

The fed-back reason pulled the assistant into answering the _hook_ instead of the
user. Two independent observations, different turn shapes — one reply opened with a
fenced `{"ok": true}`, another was a complete `{"ok": false, "reason": "..."}`
object where the user's design answer should have been.

Root cause is the reason's phrasing. The prompt asked for "a short factual note
naming what is worth recording", which produces a _description_ of a capture rather
than an instruction to perform one, and the model sometimes continues the pattern by
emitting the verdict shape itself. Fixed by requiring the reason to be one imperative
sentence addressed to Claude, and forbidding it from restating the response format.

**Verification limits, stated plainly:** this failure is intermittent — it failed
once and passed once against the _unfixed_ prompt. A green run after the change is
therefore consistent with the fix working and also consistent with luck. The bound
in defect 1 is the deterministic guard; this one is a live-fire check whose value
accrues over repeated runs.

## Results

Both tiers green on `claude 2.1.220`, Node 24:

| Tier                               | Result                                |
| ---------------------------------- | ------------------------------------- |
| `npm test` (unit)                  | 81/81 pass                            |
| `tests/hook-architecture.test.cjs` | 8/8 pass, including the 2 new guards  |
| `npm run test:e2e`                 | **34/34 pass across 5 real sessions** |
| `npm run test:all`                 | pass                                  |

The e2e tier costs six sessions (Haiku except run 4) and roughly 100 seconds of wall clock.

Run 4's bound is known to catch defect 1 rather than assumed to: the pre-fix
behaviour was _measured_ at 16 evaluations with the identical prompt, against an
assertion that allows at most 3.
