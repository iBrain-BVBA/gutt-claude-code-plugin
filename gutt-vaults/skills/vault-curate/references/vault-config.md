# Vault config: the numbers a vault runs on

Every number an owner may tune lives in the vault's Console, in the `meta/config` document,
and is changed on the Console's **Settings** tab. This file holds each key's default, its
allowed range and who reads it. Skills name the key in their rules, never the number.

Read by vault-curate, vault-review (through vault-curate's prompt) and vault-brief;
vault-commit records each saved version as a `Config:` episode; vault-steer sends owners here
for any number they ask to change.
The Console's Settings tab carries the same keys, defaults and ranges in its
`config-fields` block, and a test in the plugin's repository keeps the two in step.

## Keys

Percentages are stored as fractions (`0.90`), shown as `90%` on the Console.

<!-- config-keys:begin -->

| Key                               | Default          | Min  | Max       | Read by                                   | What it does                                                                  |
| --------------------------------- | ---------------- | ---- | --------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| `run.pending_cap`                 | 25               | 5    | 50        | vault-curate                              | New Console rows per curate run; the highest significance is kept             |
| `run.significance_floor`          | 2                | 1    | 4         | vault-curate                              | Findings scored below this are dropped and counted                            |
| `run.scout_max_items`             | 8                | 3    | 15        | vault-curate → scouts                     | Items per scout for a beat whose charter states no max; no beat goes above it |
| `review.precedents_min`           | 5                | 3    | 20        | vault-reviewer                            | Similar human-decided precedents a row needs to be auto-eligible (N)          |
| `review.precedent_agreement`      | 0.90             | 0.80 | 1.00      | vault-reviewer                            | Time-decayed share of those precedents that must agree                        |
| `review.precedent_half_life_days` | 60               | 14   | 365       | vault-reviewer                            | Age at which a precedent counts half                                          |
| `review.override_cooloff_days`    | 30               | 7    | 90        | vault-reviewer, vault-curate              | No auto decision in a class for this long after an override in it             |
| `review.recent_steering_days`     | 7                | 1    | 30        | vault-reviewer                            | Rows touching Steering newer than this always escalate                        |
| `review.audit_rate`               | 0.10             | 0.05 | 0.50      | vault-reviewer                            | Share of auto decisions sampled for the owner's audit                         |
| `review.audit_min`                | 2                | 1    | 10        | vault-reviewer                            | Smallest audit sample when the run made at least that many auto decisions     |
| `ladder.ceiling`                  | 3                | 0    | 3         | vault-curate, vault-reviewer, vault-brief | Highest stage any class may reach                                             |
| `ladder.stage1_calls`             | 10               | 10   | 100       | vault-curate, vault-brief                 | Reject predictions a class needs for auto-reject (stage 1)                    |
| `ladder.stage1_agreement`         | 0.90             | 0.80 | 1.00      | vault-curate, vault-brief                 | Steering-adjusted accuracy of those reject predictions                        |
| `ladder.stage2_approve_calls`     | 20               | 5    | 50        | vault-curate, vault-brief                 | Approve predictions a class needs for auto-approve (stage 2)                  |
| `ladder.stage2_agreement`         | 0.95             | 0.80 | 1.00      | vault-curate, vault-brief                 | Steering-adjusted accuracy of those approve predictions                       |
| `ladder.stage3_agreement`         | 0.95             | 0.85 | 1.00      | vault-curate, vault-brief                 | Rolling 30-day agreement in the class for stage 3                             |
| `ladder.escalation_target`        | 0.20             | 0.05 | 0.50      | vault-brief                               | Escalation rate a stage-3 vault aims to stay under                            |
| `ladder.replay_size`              | 20               | 10   | 50        | vault-brief, vault-curate                 | Held-out human verdicts the eval replay predicts                              |
| `ladder.replay_pass`              | 0.85             | 0.80 | 1.00      | vault-curate, vault-brief                 | Share of the replay that must agree before a class gains auto-approve         |
| `brief.min_findings`              | 3                | 1    | 10        | vault-brief                               | Committed findings a week needs before a brief is drafted                     |
| `brief.pattern_min_verdicts`      | 5                | 3    | 20        | vault-brief                               | Human verdicts a class needs before it can be a verdict pattern               |
| `brief.pattern_share`             | 0.80             | 0.60 | 1.00      | vault-brief                               | Share one way that makes those verdicts a pattern                             |
| `brief.steering_after_weeks`      | 3                | 1    | 8         | vault-brief                               | Weeks running a rejection pattern is seen before it is proposed as steering   |
| `brief.linkedin_series`           | the vault's name |      | 60 chars  | vault-brief                               | First words of the LinkedIn draft's first line                                |
| `brief.linkedin_cta`              | none             |      | 280 chars | vault-brief                               | The offer after the closing question; none means no offer line                |

<!-- config-keys:end -->

`ladder.class_ceilings` is a map of stage class to stage (`{"finding/pricing": 1}`), each
from 0 to 3. A class in it may not go above its own number or above `ladder.ceiling`. The
`conflict` class always escalates and takes no ceiling. It is stored as the top-level
`meta/config.class_ceilings`, not inside `values`: read it from there, and always pass it in
the reviewer's `config:` line as `ladder.class_ceilings` (`{}` when the field is absent).

Every key takes effect at the **next curate run**, the brief keys at the next brief run. A
lower `ladder.ceiling` or class ceiling, like a changed promotion threshold, moves a class at
the next curate run, not at the weekly Calibration (§Promotion re-check).

## `meta/config` document

```
meta/config   config_version (int), values {<key>: <value>}, class_ceilings {<class>: 0–3},
              saved_at, saved_by (viewer id)
```

`values` holds every key the owner saved, even one saved at its default value: a saved value
always wins over an older review charter's number. A key missing from it is unset and falls
back as below; Reset on the Settings tab unsets a section's keys.
`config_version` starts at 1 on the first save and goes up by one on each. Each save also
adds a `config_changes/v<n>` row (`console-data.md`) that vault-commit turns into a `Config:`
episode.

## Reading the config at boot

Every skill that reads a key does this once per run, before the first step that uses one:

1. `ArtifactData` `get` `meta/config`, inline (`console-data.md` §Reads).
2. **Per key:** the value in `values` if present; else, for the four review-policy keys
   below, a number the effective review-policy charter still states; else the default from
   the table above. A charter number is noted as `from charter` in the Run.
3. **Check every value**, whatever the Console accepted (the page's checks are a
   convenience, not the guard). A number outside its range is clamped to the nearer bound;
   a value that isn't a number (or, for the two text keys, isn't text) falls back to its
   default, except the `ladder` keys, which fail closed: an unreadable `ladder.ceiling` or
   class ceiling counts as 0 (shadow) for this run, because its default is the most
   permissive stage and the owner may have pinned it lower. Text longer than its cap is cut
   at the cap. Each change is a line in the run row's
   `notes` and in the Run episode: `config: run.pending_cap 500 → 50 (clamped)`. Unknown keys
   are ignored and listed the same way.
4. **Record** `config_version` (0 when `meta/config` is missing) in the run row and in the
   Run episode's boot line. With `meta/config` missing, every key is at its default and the
   run behaves exactly as before the Console held settings.

Console unreachable: the owner's saved limits can't be read, so autonomy **fails closed**.
`ladder.ceiling` and every class ceiling count as 0 for this run (every row escalates), the
other keys use their defaults (and charter numbers), and the run records `config_version:
unavailable`. vault-brief writes no Calibration stage change in such a run. Never let an
outage raise the reviewer above what the owner allowed.

### Numbers still in an older review-policy charter

Review-policy charters written before Settings existed state a stage ceiling, N, the
agreement threshold and the override cool-off. Until the owner saves those keys in Settings,
they are read from the charter (step 2): stage ceiling → `ladder.ceiling`, precedents needed
→ `review.precedents_min`, agreement threshold → `review.precedent_agreement`, override window
→ `review.override_cooloff_days`. New review-policy charters say "Stage ceiling: see
Settings" and state no number (`../../vault-steer/references/charter-template.md`).

## What vault-curate passes to the reviewer

The `review` and `ladder` sections as JSON, with `config_version`, plus the stage per class
from the promotion re-check below:

```
config: {"config_version": 8, "review": {"precedents_min": 5, …}, "ladder": {"ceiling": 2, …,
         "class_ceilings": {"finding/pricing": 1}}}
stage_by_class: {"finding/pricing": {"stage": 1, "auto_reject": true, "auto_approve": false}, …}
```

A third line, `charter:`, carries the charter and steering episode ids the reviewer reads by
id (`../SKILL.md` Step 5); it holds no numbers.

Always send both lines, even when every value is a default (`config_version: 0`) or no class
has a stage yet (`stage_by_class: {}`). Without them the reviewer holds every class at stage 0
for the run; it never falls back to a Calibration or the defaults. The reviewer checks the
values again (clamps out-of-range ones and says so in `notes`) and never reads the Console
itself.

## Promotion re-check (every curate run)

Stages are set by the weekly Calibration, but a threshold changed in Settings applies at the
next curate run. vault-curate re-checks each class at boot:

1. Take the latest per-class numbers from `meta/reviewer` (`stage_by_class`: reject and
   approve predictions with their adjusted accuracy, rolling 30-day agreement, last override)
   and the latest replay (`k` agreeing of `n` replayed); if `meta/reviewer` is missing, has no
   `calibration`, or its `calibration` isn't the name of the latest `Calibration:` episode
   (newest by the date and time in its name; the brief's Console write failed, a rerun
   included), from that episode, and note the mismatch. Compare names, never `at` with an
   episode's creation time: the brief writes the episode before `meta/reviewer`, and
   ingestion lags. If the latest Calibration episode can't be read either, every class is
   stage 0 for the run. No Calibration yet: every class is stage 0. A
   `meta/reviewer` read that fails: every class is stage 0 for the run, listed in the run
   row's errors. A source without per-direction counts (a Calibration written before them):
   keep the Calibration's stage and permissions, capped by step 4, and note `re-check skipped:
Calibration <date> has no per-direction counts`; never read missing counts as zero. A
   missing replay never skips the re-check: `auto_reject` is still re-checked on its own, and
   only `auto_approve` needs a qualifying replay (it stays off without one).
2. Apply `../../vault-review/references/autonomy-ladder.md` to those numbers with this run's
   config: `auto_reject` on when the reject predictions meet `ladder.stage1_calls` at
   `ladder.stage1_agreement`; `auto_approve` on when the approve predictions meet
   `ladder.stage2_approve_calls` at `ladder.stage2_agreement` and a replay of at least
   `ladder.replay_size` verdicts meets `ladder.replay_pass` (a smaller replay, run before the
   owner raised the size, doesn't count until the next Calibration replays the new size);
   stage 3 when `auto_approve` is on and the class's own rolling 30-day adjusted agreement
   meets `ladder.stage3_agreement`. A source without that number (a Calibration written
   before it) keeps the Calibration's own stage 3 call, as step 1 does for missing counts, and
   notes `stage 3 re-check skipped: no class rolling agreement`; the vault-wide rolling
   agreement never stands in for it.
3. An override since the Calibration turns off the overridden direction for that class (the
   ladder's immediate demotion). `auto_approve` also stays off while the class has any
   override within `review.override_cooloff_days` (stage 2's entry rule).
4. Cap at `ladder.ceiling` and the class's own ceiling.
5. Write the result to the run row's `stage_by_class` and pass it to the reviewer. A class
   whose stage differs from the Calibration's is listed in the run row's notes as `moved by
config v<n>`.

The re-check never uses predictions newer than the Calibration: new evidence still waits for
the weekly Calibration, only new thresholds apply at once.

## What stays in the skills

Not tunable, because they are boundaries or definitions rather than settings: the memory
budget per identity per run (Insights, Procedure deltas), retries and waits, the scout's tool
call budget, one extra scout round at most, the significance scale (1–5) and which bands each
stage may auto-approve, the 30-day window of rolling agreement, the 8-week lookback for
verdict patterns, and the always-escalate list (written policy in the review charter).

## What the vault file keeps

The vault file (`routines.md` §The vault file) keeps only what a routine needs before it can
reach the Console:

```json
{
  "slug": "<slug>",
  "group_id": "vault_<slug with - as _>",
  "console_url": "https://claude.ai/artifact/…",
  "memory_connector": "<connector name, or a list of names; optional>"
}
```

`memory_connector` is optional. When set, it names the gutt connector that holds the vault,
or a list of names for that one deployment as different surfaces see it (for a vault on the
shared gutt stage, `gutt-closed-beta` where a plugin's own stage server is used, and
the stage connector's name where a routine connects through claude.ai). `memory-tools.md`
step 2 uses that server, ignores any other that also exposes the group, doesn't require the
vault in its `list_writable_groups`, and stops when it holds no episode of the vault (except
for a new vault's first charter). Unset: the vault's server is the one that lists
`vault_<slug>` as writable. Each name's prefix must be on the reviewer's allowlist
(`memory-tools.md` §vault-reviewer).

Everything else is on the Console. `meta/vault` (`console-data.md`) holds name, owner,
question, beats, the page URLs, `companion_groups_read_only` and an optional `write_tool_hint`;
the LinkedIn series and offer are `brief.linkedin_series` and `brief.linkedin_cta` above.
