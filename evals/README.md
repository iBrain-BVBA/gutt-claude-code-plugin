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

Results land in `evals/results/<suite>-<trials>t.json` (gitignored, they are large)
alongside a committed `report.md`.

## Suites

| Suite        | What it measures                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `stop-judge` | The `Stop` prompt hook's verdict: does it fire on turns that produced a durable Insight or Incident, and stay quiet otherwise |

Planned: `memory-capture` and `memory-search` skill evals — same corpus machinery, but
the runner needs tool access so the transcript can be scored on which tools the skill
actually led the model to call. `lib/runner.py` takes `allow_tools` for that.

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
- **System prompt.** `--system-prompt` replaces the default, but `CLAUDE.md`
  auto-discovery still applies. Constant across variants.
- **Labels.** Ground truth for "should fire" is not a reconstruction: each of those
  turns is one whose finding was actually written to the graph or the memory directory
  at the time. Labels held less firmly are flagged `confident: False` and reported
  separately, so a variant is not marked down for a call the author is unsure of.

## Reading the report

`missed fire` is the column that matters. Staying quiet is cheap and firing wrongly is
expensive, so every candidate leans quiet; the interesting question is how much real
signal that costs. `livelock` counts trials where `stop_hook_active: true` did not
produce `ok: true` — each one is a turn that would have re-entered itself.
