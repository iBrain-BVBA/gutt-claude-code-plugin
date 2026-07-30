# evals

A bench for the parts of this plugin whose behaviour is decided by **prose** rather
than by code: the Stop hook's judge prompt, the injected memory pointers, and the
skills. Unit tests can assert that a prompt contains a clause. They cannot tell you
whether the clause makes the model do the right thing. This directory answers that
question by running candidate wordings against turns pulled out of real Claude Code
session transcripts and scoring the verdicts against hand-assigned labels.

Nothing in here ships. It is outside `gutt-core/`, is not referenced by any hook, and
is excluded from `npm run test:all`.

## Running

```bash
python3 evals/run.py stop-judge                    # 1 trial per case
python3 evals/run.py stop-judge --trials 3         # 3 trials, to see variance
python3 evals/run.py stop-judge --variants V0 V6   # only these
python3 evals/run.py --list                        # available suites
```

Python 3 standard library only — no dependencies, no virtualenv. Each case is one
`claude -p` call against a fast model, run eight at a time; a 8-variant × 14-case ×
3-trial matrix is roughly 340 calls and about ten minutes.

Results land in `evals/results/<suite>-<trials>t-<variants>.json` (gitignored, they are
large) alongside a committed `report.md`. The variant set is in the name because a run
keyed on trial count alone overwrote an earlier round's raw records, and rounds are the
unit of comparison here.

## Suites

| Suite            | What it measures                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `stop-judge`     | The `Stop` prompt hook's verdict: does it fire on turns that produced a durable Insight or Incident, and stay quiet otherwise |
| `prompt-pointer` | The `UserPromptSubmit` recall pointer: does the agent consume it, ignore it, or surface it to the user as suspicious          |
| `capture-close`  | After a fired capture has been written: does the reply report it _and_ close on the work, or drop one of the two              |

A suite is no longer confined to scoring verdicts. `run_matrix` takes a `system` argument
and `run.py` passes a suite's own `SYSTEM` when it defines one, so a suite can frame the
model as an ordinary agent rather than as a judge replying with one JSON object —
`prompt-pointer` does exactly that, and has to: framing the model as a judge would be the
largest thing in the prompt and would decide the result. Suites that define no `SYSTEM`
still inherit `JUDGE_SYS`, which is right for `stop-judge`.

Some main-agent behaviour is still easier to probe directly with `ask(system=None)`, which
is what `leak_probe.py` and the offer probe below both do:

```bash
cd evals
python3 -m suites.migrate_offer.probe                    # SessionStart migration offer
python3 -m suites.migrate_offer.probe --case displaced   # offer vs a competing "last line"
python3 -m suites.migrate_offer.variants                 # diff the wordings, spend nothing
```

`suites/migrate_offer/FINDINGS.md` has the results. Headline: the shipped wording is at
ceiling (24/24), and the eleven words `in one line at the end of your next reply` are the
whole mechanism — removing them costs 24/24 → 4/24. It defaults to `claude-sonnet-5`, not
`FAST_MODEL`, because the offer is largely a property of the session model (25% on Haiku).

`suites/capture_close/FINDINGS.md` has rounds 1–3 of the closing suite. Headline: an injected
closing rule beats both the reason-only baseline (59% pooled) and the `memory-capture` rule it
replaced (66%) by 18+ points, in every round — but the two candidate wordings of that rule,
878 and 1213 chars, cannot be separated at all: three rounds ranked them in both directions,
and the shorter one has scored 75%, 100% and 62% on identical inputs. Read that spread before
reaching for this bench to decide a wording. The dominant baseline failure is also not the
predicted one — the reply drops the capture silently rather than closing on it. Its other
lesson is methodological and cost a whole round: the first version told the model to run a
tool it did not have, so no capture appeared in any reply, nothing was buried, and all five
variants scored the same for reasons unrelated to their wording. Presenting the capture as
already complete is what made the property measurable.

`suites/prompt_pointer/FINDINGS.md` has round 1 of the pointer suite. Headline: the retired
2.x "MANDATORY / SYSTEM-LEVEL DIRECTIVE" framing is measurably the failure GP-868 predicted —
it is the only variant that ever leaked, and four of five greetings came back discussing the
directive instead of saying good morning. Cutting the rationale to one sentence costs recall.
The shipped wording, the hedged wording it replaced, and the wording plus GP-866's summary
clause are indistinguishable from each other at n=120. One constraint did fall out: the
summary clause is free to append and expensive to prepend (58% recall misses against 27%).

A verdict is not the only thing a judge prompt has to get right, so `leak_probe.py` sits
beside that suite and asks whether a _fired_ verdict turns into the user's answer — a
defect worth more than any accuracy gap in the tables below, and one the suite cannot see:

```bash
cd evals
python3 -m suites.stop_judge.leak_probe V14 --trials 6      # does a fire become the reply?
python3 -m suites.stop_judge.leak_probe V14 --case trivial  # ... after a false fire
```

Planned: `memory-capture` and `memory-search` skill evals — same corpus machinery, but
the runner needs tool access so the transcript can be scored on which tools the skill
actually led the model to call. `lib/runner.py` takes `allow_tools` for that.

## Screen candidates before spending calls on them

`suites/stop_judge/shippable.py` checks a candidate against the guards in
`tests/hook-architecture.test.cjs` and prints what it violates:

```bash
cd evals && python3 -m suites.stop_judge.shippable
```

This exists because a whole round was spent ranking prompts that could not be deployed.
V8 and V9 topped the accuracy table at 8 and 6 lines; they carry ten and eleven guard
violations respectively, and every guard encodes a live failure — inverted polarity,
a fired verdict printed to the user as the answer, a fire on a human-gated tier. A
number attached to an unshippable prompt is not a result. Run the screen first and
compare only what could actually ship.

The checker is a deliberate mirror of the `.cjs` assertions, not a shared source: the
tests are the contract. If the two drift, this file is the one that is wrong.

## How a suite is put together

A suite is one module exposing five names. `suites/stop_judge/suite.py` is the worked
example.

| Name                          | Purpose                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `NAME`                        | CLI id                                                                              |
| `variants()`                  | `{label: prompt text}` — the candidates being compared                              |
| `cases()`                     | labelled inputs, each with `want_ok` and a `why` recording the ground for the label |
| `build_prompt(variant, case)` | assembles what the model receives                                                   |
| `evaluate(case, raw)`         | parses the reply and scores it                                                      |

## What the numbers are worth

The harness reproduces the judge's inputs closely but not exactly, and the gaps all
run in the same direction for every variant, so comparisons hold even where absolute
accuracy does not.

- **Conversation shape.** The real judge receives the turn as message history;
  the harness passes it inside a single user message. Verified by probe: a prompt hook
  can see the user's prompt, the assistant's prose, tool calls, _and_ tool output.
- **Turn length.** Long turns are elided in the middle. Cuts land on line boundaries
  on purpose — a cut mid-sentence reads to the judge as work left unfinished, which
  every candidate prompt treats as a reason to stay quiet, so sloppy clipping
  manufactures the verdict being measured.
- **Inherited instructions.** `--system-prompt` replaces the default but does not stop
  `CLAUDE.md` discovery, so judge calls run from a temp directory outside the repo
  (`lib/runner.judge_cwd`) to shed the project `CLAUDE.md` and project settings. That is
  a partial isolation and the limit is measured: asked what its instructions mention, a
  judge run from the repo cites this project's `CLAUDE.md`, and one run from the temp
  directory cites the **plugin's own skills and agents** instead — those come from the
  user-scope registration in `~/.claude/plugins/known_marketplaces.json` and are
  inherited whatever the cwd. `~/.claude/CLAUDE.md` loads in both. Shedding the rest
  needs the plugin disabled for the child, and `enabledPlugins` in a `--settings` file
  does not do it (measured; same wall as the e2e double-load). Constant across variants
  either way.
- **Round comparability.** Rounds 1–3 ran from the repo, with the project `CLAUDE.md` in
  the judge's context. Later rounds do not. Compare within a round, not across that line.
- **Noise floor.** Re-run one variant unchanged before believing any ranking. The same
  9-line prompt scored 81.0%, 73% and 70% on three rounds under identical conditions —
  an 11-point spread, wider than every gap the bench has been used to choose between.
  Sample sizes here are 42–70 calls per variant; that buys a direction, not a decimal.
- **Labels.** Ground truth for "should fire" is not a reconstruction: each of those
  turns is one whose finding was actually written to the graph or the memory directory
  at the time. Labels held less firmly are flagged `confident: False` and reported
  separately, so a variant is not marked down for a call the author is unsure of.

## What this bench cannot decide

Two defects in a shipped prompt were found by probing the live hook, and neither was
visible here. The bench feeds a variant one turn and reads one verdict, so it never asks
a variant what an _unset_ field implies, and it never sees the fired reason arrive back
in a real conversation:

- A judge that had correctly named the turn's Insight answered `ok: true` anyway,
  reasoning that "`stop_hook_active=false` means the hook is inactive and cannot itself
  request capture". The prompt said what `true` means and left `false` undefined, so the
  model supplied a meaning — and the one it chose suppresses every fire.
- A prompt that dropped its closing anti-restatement clause put a fenced `{"ok": true}`
  in front of the user as the assistant's answer, 4 times out of 4.

So finish with a live probe, not a green table: run the candidate through
`claude -p --plugin-dir <repo>/gutt-core --debug-file <log>` and read the verdicts out of
the log. Note that `--debug` prints nothing at all in `-p` mode — only `--debug-file`
works — and that a clean reply proves nothing unless the log also shows the judge ran.
Grep `Processing prompt hook` for invocations and `condition was (not )?met` for
verdicts; the count of `Read hooks.json for plugin` lines is **not** a proxy for either
(two reads of the same path still registered and fired once).

## Reading the report

`missed fire` is the column that matters. Staying quiet is cheap and firing wrongly is
expensive, so every candidate leans quiet; the interesting question is how much real
signal that costs. `livelock` counts trials where `stop_hook_active: true` did not
produce `ok: true` — each one is a turn that would have re-entered itself.
