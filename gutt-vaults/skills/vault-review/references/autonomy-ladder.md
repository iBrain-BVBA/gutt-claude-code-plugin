# Autonomy ladder

Stages are earned **per class**.
Every threshold is a key in `../../vault-curate/references/vault-config.md`, set on the vault
Console's Settings tab; the defaults are in that file.

| Stage          | Entry (from Calibration)                                                                                                                                                                                                                                              | Allowed                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 0 Shadow       | Start; or no permission earned                                                                                                                                                                                                                                        | Predict only; every row escalates with the prediction                                    |
| 1 Auto-reject  | ≥ `ladder.stage1_calls` **reject** predictions in the class at ≥ `ladder.stage1_agreement` (steering-adjusted)                                                                                                                                                        | `auto_reject` in the class                                                               |
| 2 Auto-approve | ≥ `ladder.stage2_approve_calls` **approve** predictions in the class at ≥ `ladder.stage2_agreement` (steering-adjusted), no override in the class within `review.override_cooloff_days`, eval replay of at least `ladder.replay_size` verdicts ≥ `ladder.replay_pass` | `auto_approve` at significance 1–3; `auto_reject` only if the class also meets stage 1   |
| 3 Steady       | `auto_approve` on and rolling 30-day agreement ≥ `ladder.stage3_agreement` in the class                                                                                                                                                                               | plus `auto_approve` at significance 4; escalation stays under `ladder.escalation_target` |

**Each direction is earned on its own.** A class's auto-reject is earned by the accuracy of its
reject predictions, its auto-approve by the accuracy of its approve predictions, and stage 2
doesn't wait for stage 1. Overall agreement mixes the two and hides the risk. For example, a
card-diff class can stand at 88% overall with approve predictions 35/35 but reject predictions
1/5: a ladder on overall agreement would open auto-reject, the direction it gets wrong, first. Calibration writes each class as `stage <s> (auto_reject on|off, auto_approve on|off)`.

**A row that rests on another row** (a card diff on its Finding, a `rests_on` link) is
auto-approved only when that row is approved, committed or auto-approved in the same batch;
otherwise it escalates. Without it, a card diff can be approved while the owner rejects the
Finding it rests on.

## Stage class

Stages are kept per **stage class**, one key shared by the reviewer's output, the Calibration
table, the Console's Settings (class ceilings) and this ladder:

| Proposal type | Stage class                                               |
| ------------- | --------------------------------------------------------- |
| finding       | `finding/<beat>` (e.g. `finding/pricing`)                 |
| card_update   | `card_update`                                             |
| reverify      | `reverify`                                                |
| conflict      | `conflict` (always escalates; tracked for agreement only) |

The fine features (claim type, source class, domain, significance) serve precedent similarity
only (`precedent-matching.md`). Hard rule 2's always-escalate list still applies inside a
promoted class (significance 5, unseen domains, maturity diffs, the charter's classes).
Auto-approve stays capped at significance 1–3 below stage 3, and the audit sample
(`review.audit_rate`, at least `review.audit_min` per run) keeps the owner producing labels.

## Who moves the stage

- **The weekly Calibration** (`vault-brief`) computes each class's numbers from human verdicts
  and the eval replay, and sets its stage with the thresholds in force.
- **Each curate run** re-checks those numbers against the thresholds in force that day
  (`vault-config.md` §Promotion re-check), so a threshold changed in Settings applies at the
  next curate run, raising or lowering a class, without waiting for Friday. New evidence still
  waits for the Calibration.
- **The reviewer** reads the stage vault-curate passes; it never sets it, and may only lower a
  class for an override vault-curate didn't see.

Demotion is automatic, per class: an override removes that class's permission for the
overridden direction at once (in the same run that sees the override); a class whose accuracy
for a direction falls below that direction's entry bar loses it at the next Calibration or
curate re-check. There is no vault-wide demotion: it held every class at stage 0 whatever its
own record.

**Ceiling:** `ladder.ceiling` caps every class, and `ladder.class_ceilings` caps one class.
Both live only in the Console's Settings; a vault can be pinned at stage 1. A lower ceiling
drops a class at the next curate run.

## Agreement

Agreement for a class = share of your predictions (shadow) or auto decisions (audited) that
match the human decision on the same row. Audit-sample confirmations count; overrides count
as disagreements.

**Steering-adjusted.** Leave out rows whose topic a later Steering episode stopped the
librarian from proposing (for example, Steering that took a topic out of scope). Those rows can't recur, so a miss on them says nothing about future
rows. Calibration reports both numbers, raw and adjusted, and lists the excluded rows by
Steering; the ladder's entry criteria and demotion use the adjusted one.
Predictions with an empty `precedents` list count, as misses or hits, like any other.
In a stage-0 class the Console hides the prediction until the owner decides ("called blind"
in the Verdict); blind and seen calls count alike, and Calibration reports how many were blind.

## Calibration episode (written by vault-brief, tagged vault-reviewer)

```
Calibration: <YYYY-MM-DD>
Vault: <name>. Config version: <n>. Owner verdicts to date: <n>. Rolling 30-day agreement:
<x%> raw, <y%> steering-adjusted (<k> rows excluded: <Steering names>).
Escalation rate this week: <x%>. Eval replay: <k>/<ladder.replay_size>.
Stage by class:
- <stage class>: stage <s> (auto_reject on|off, auto_approve on|off); reject predictions
  <k>/<n>, approve predictions <k>/<n>, <x%> adjusted agreement, <p%> with precedents,
  last override <date|none>
Moved by config since the last Calibration: <class: old → new (config v<n>)|none>.
```

The per-direction counts are what vault-curate re-checks against new thresholds, so every
class line carries both.
