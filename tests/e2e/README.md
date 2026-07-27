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

**Cost:** one Haiku session, a few cents. The suite makes a single `claude -p`
call and asserts against its artifacts, rather than one call per test.

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

Both verified empirically, not assumed:

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
