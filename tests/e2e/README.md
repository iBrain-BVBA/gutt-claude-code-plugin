# End-to-end tests against a real `claude -p` session

These tests install the plugin **from the current working tree** into a
throwaway project and drive a real headless Claude Code session against it, then
assert on what the session actually left behind.

They exist because the hook behaviour that matters most is emergent: Claude Code
runs sibling hooks on one event **in parallel**, and no unit test in this repo
observes that. The lost-update bug the write lock fixes was invisible to the unit
suite and obvious on the first real run.

## Running

```bash
npm run test:e2e
```

Requires the `claude` CLI on `PATH` and a logged-in subscription. If `claude` is
missing the suite skips rather than fails.

**Cost:** seven Haiku sessions, a few cents. The discipline is one `claude -p` call per
set of claims, never one per assertion. Wall clock is not stated for the suite as a whole
because it has not been measured since the GP-922 suites landed; the
`migrate-memory-skill` run alone was 55–90s across five observed runs.

Four suites:

| Suite                              | Runs | Covers                                                                         |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------ |
| `session-lifecycle.e2e.cjs`        | 1    | startup lifecycle, state contract, AC3, first-prompt pointer, R36              |
| `hook-routing.e2e.cjs`             | 4    | anti-nag row 4, snooze row 1, the Stop router, R23 coexistence                 |
| `builtin-memory-migration.e2e.cjs` | 1    | GP-922 the migration **offer** reaches a conversation, and changes nothing     |
| `migrate-memory-skill.e2e.cjs`     | 1    | GP-922 the **skill**: body delivery, its CLI running for real, the safety gate |

The two GP-922 suites split along what each can prove. The offer suite covers detection
and injection; the skill suite covers the flow that runs after the user accepts. Neither
completes a migration, because a completed one writes episodes to the real graph that no
test can retract, and its verify step races asynchronous extraction — so the write,
prune and note mechanics live in the mutation-checked unit tier instead. The skill suite
allowlists only `Bash` and `Read`, which is what holds that boundary: with no MCP write
tool in the session there is nothing for the flow to reach the graph with. (`Bash` is
allowed, so this is an argument about the absent tools, not a sandbox.)

See `docs/e2e-hook-test-plan.md` for what the first two suites assert and why, and for the
two Stop-router defects this tier found. It does not yet cover the two GP-922 suites; what
each of those asserts is documented in its own file header instead.

**Not part of `npm test`.** These files are named `*.e2e.cjs`, not `*.test.cjs`,
so the `node --test tests/**/*.test.cjs` glob does not pick them up. Keep it that
way: `npm test` must stay free, offline, and deterministic.

## What gets asserted, and against what

One run produces three independent artifacts. Every assertion reads one of them,
so a passing suite means three separate systems agree.

| Artifact                                                 | Evidence it provides                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `<project>/claude-debug.log` (`--debug-file`)            | which hooks Claude Code registered, which plugin they came from, async backgrounding, per-hook exit status |
| `~/.claude/plugins/data/<plugin>-inline/sessions/*.json` | the state SessionStart / the connectivity probe / SessionEnd actually wrote                                |
| `~/.claude/projects/<encoded-cwd>/<session>.jsonl`       | how hook output reached the conversation, plus per-hook `exitCode` and `durationMs`                        |

Notable checks:

- **The branch's code ran, not the installed plugin.** `--plugin-dir` shadows an
  installed plugin of the same name; the suite asserts exactly one gutt plugin
  loaded and that its `hooks.json` path is inside this repo.
- **The connectivity write survives.** `session-start.cjs` and the `async`
  `session-connectivity.cjs` write the same file at once. The suite asserts the
  probe's verdict reached disk — the regression that motivated the write lock.
  Treat this one as a smoke check: the interleaving happens in roughly one run in
  four, and a control run with the lock disabled still passed it. The
  deterministic guard lives in `tests/session-lifecycle.test.cjs` — the test
  named "no update is lost when processes contend for one session file" forces
  the window open and fails every time without the lock.
- **Transient flags are sampled, not inferred.** `firstPromptPending` is set by
  SessionStart and cleared by SessionEnd, so the final file cannot show it was
  ever set. The harness polls session state every 40ms during the run and asserts
  against the samples.
- **The TTL sweep really runs.** The harness plants a backdated session file
  before launching and asserts SessionStart reclaimed it while sparing a fresh
  one.
- **R37/AC3 holds.** Nothing appears in the project directory, and the user's
  `~/.claude/settings.json` is byte-identical afterwards — the regression guard
  for the retired `sessionstart-setup.cjs`, which used to write a statusline
  command there.

## Environment facts these tests depend on

All verified empirically, not assumed:

- **`--resume` re-arms the memory pointer.** A resume fires SessionStart with
  `source: "resume"`, which `beginSession()` treats as a restart, so
  `firstPromptPending` is set again. A resumed turn is therefore a _first_ prompt and
  cannot show that later prompts stay silent. Two prompts under one SessionStart need
  `--input-format stream-json` (`runClaudeStream()`).
- **The CLI logs no completion line for the synchronous `session-start.cjs`** — only
  the async sibling's registration line, which is what `sessionStartEvents()` reads.
- **A prompt hook has no side effects at all.** Its verdict never touches disk, so a
  hook that was never evaluated is indistinguishable from one that returned `ok:true`.
  The debug log is the only evidence, via `stopVerdicts()` /
  `promptHookEvaluations()`.
- **Claude Code wraps a prompt hook's text as a stopping _condition_** ("has the
  following stopping condition been satisfied?"), and logs `ok:true` as
  "condition was met" — discarding any `reason` sent alongside it.
- **A fixed `--session-id` breaks state sampling on re-runs**, because the sampler
  ignores files that already existed. Each run generates a fresh UUID and deletes its
  own record afterwards.
- **`CLAUDE_PLUGIN_DATA` is not read from the inherited environment.** Exporting
  it does not relocate plugin state. The harness therefore _resolves_ the data
  dir after the run by locating the session file, and separately asserts that a
  `--plugin-dir` load lands in `<plugin-name>-inline`.
- **stdout can carry a warning line ahead of the result JSON.** The harness scans
  stdout from the end for the `type: "result"` envelope instead of parsing the
  whole stream.

## Safety

The harness strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child
environment and refuses to launch if either survives (R36 — headless runs stay on
the subscription and never bill an API account).

It writes only to a temp project directory and to its own planted bait files,
both of which it removes afterwards. It never deletes another session's state.
