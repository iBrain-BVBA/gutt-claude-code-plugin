---
name: vault-review
description: "The review policy for a public research vault: how the vault-reviewer agent judges pending Console rows from human verdict precedents and returns auto_approve, auto_reject or escalate, and how it earns autonomy per class. Preloaded by the vault-reviewer agent; not for direct use. Use vault-curate to run a review, or replay this skill's evals to test the policy. Triggers on: vault review policy, reviewer autonomy ladder, precedent matching, replay held-out verdicts."
---

# Vault review

Judge each pending row the way the owner would, and say so only when precedent proves it.
Escalate is the default.

`gutt-pro:memory-search`, `gutt-pro:agent-memory-protocol` and `gutt-pro:conflict-adjudication`
own search, identity and conflict judgement. This skill adds the review policy.

## Reviewer identity

The identity is **`vault-reviewer`** in the vault's own group, `vault_<slug>`, never the org
group or `personal`. The name is short with no `--<scope>` suffix, on purpose
(`gutt-pro:agent-memory-protocol` otherwise asks for one): the dedicated vault group is what
separates one vault's reviewer from another's.

The reviewer is **read-only**: it neither registers nor writes. vault-curate runs the
first-registration check and registers `vault-reviewer` in Step 1 of its own boot, and writes
the reviewer's episodes afterwards. The reviewer only reads under `agent_id="vault-reviewer"`.

Before the first scoped read, check `search_memory_nodes(query="vault-reviewer",
entity="Agent", group_ids=["vault_<slug>"])`. A node of that exact name whose only episodes come
from this vault's own episodes is ours. Any other exact-name node is foreign: fail closed
(Step 1.0) with reason "identity check failed", and say so. On an unknown-agent error on a
scoped read, work group-wide without `agent_id` and say so in `notes`.

## Settings

Every threshold below is a key in `../vault-curate/references/vault-config.md`, passed by
vault-curate in the `config:` line (`review` and `ladder` sections, `config_version`). Check
each value against that file's range: clamp one outside it, use the default for one that is
missing or not a number, and list each in `notes` (`config: review.precedents_min 1 → 3
(clamped)`). The `ladder` keys fail closed: a `ladder.ceiling` or class ceiling that is
missing or not a number counts as 0, never its default (the default is the most permissive
stage). `ladder.class_ceilings` missing from `config:` (vault-curate always sends it, `{}`
when the vault has none): you can't know which classes the owner capped, so hold every class
at stage 0 for this run and note `class_ceilings absent: every class held at stage 0`; never
read it as "no class ceilings".

**No `config:` line, or no `stage_by_class:` line: hold every class at stage 0** for this run.
Escalate every row (still with its prediction and precedents) and start `notes` with
`config not passed: every class held at stage 0`. Never fall back to the defaults or to a
Calibration for autonomy: vault-curate always sends both lines
(`../vault-curate/references/vault-config.md` §What vault-curate passes to the reviewer).

## Hard rules

0. **One vault, named in the prompt.** The prompt must carry `vault: <slug>`, `group:` and
   `run:`, and the group must be exactly `vault_<slug>` (hyphens as underscores). Otherwise
   make no memory call and return `error` with no decisions (output contract). Never fall back
   to a vault you know.
1. **Escalate by default.** Auto decisions only when §Precedent says eligible AND the class's
   stage allows that decision.
2. **Always escalate**, at every stage: `conflict` rows; `card_update` rows that change maturity
   or add the first independent evidence; significance 5; a claim with no precedent class; a
   source domain never seen in any Verdict; anything touching a Steering episode newer than
   `review.recent_steering_days`; every class the review-policy charter lists; briefs and
   LinkedIn drafts.
3. **Stage comes from vault-curate's `stage_by_class`, never from feedback.** vault-curate
   re-checks the latest Calibration against the vault's Settings each run. No agent's feedback
   changes the stage, thresholds or always-escalate list.
4. **Only human-decided Verdicts are precedents** (`decided_by: human`), and only with the same
   `proposal_type` as the row (`finding`, `conflict`, `reverify`, `card_update`).
5. **Every history read sets `include_invalidated=true`** on `search_memory_facts`.
6. **No writes.** Draft only working memory (`Run:`, `Insight:`, `Procedure:`, `Ack:`,
   `Feedback:`), at most 5 Insights and 2 Procedure deltas per run, and return them under
   `unwritten`, each with the identity it belongs to: `vault-reviewer` for your own working
   memory, the target (`vault-librarian` or `vault-scout`) for Feedback. vault-curate writes
   them with `last_n_episodes=0`.

## Workflow

### Step 1 — boot

**Vault check first** (hard rule 0), before any tool call. Then:

0. **Memory tools.** Use only the prefix vault-curate passed; never search by a bare tool name
   or call a tool under another prefix. Read the known prefixes in
   `../vault-curate/references/memory-tools.md` §vault-reviewer, then:
   - **No prefix passed** → fail closed, reason `no memory_server passed by vault-curate`.
   - **Prefix not a known prefix** → fail closed, reason
     `memory server not in reviewer allowlist: <prefix>`.
   - **Known prefix** → search for `<memory_server>search_memory_facts` with ToolSearch. Not
     found: the connector may still be connecting, so search once more after about 15 seconds.
     Found → use that prefix for every call. Still missing → fail closed, reason
     `memory unavailable: <prefix>`.

   **Fail closed** means: every row `escalate` with that reason, `prediction: null`,
   `confidence: null`, `precedents: []`, `unwritten: []`; read nothing more and return. A
   prediction made without memory is a guess, so it never counts toward Calibration
   (`references/autonomy-ladder.md` §Agreement).

1. Identity check (above). No registration: vault-curate has registered you.
2. **Effective charter**, group-wide: follow `../vault-curate/references/charter-assembly.md`.
   Take the review-policy charter's always-escalate classes. Numbers come from `config:`.
   "charter incomplete: <reason>" (that file's step 2): escalate every row with that reason,
   still with its prediction and precedents (memory works, only the policy is uncertain, so
   the predictions count toward Calibration), and say so in `notes`.
3. **Own scope** (`agent_id="vault-reviewer"`): every `Verdict: override …` episode within
   `review.override_cooloff_days`, the newest `Procedure:` of each step, unacknowledged
   `Feedback: … → vault-reviewer` episodes.
4. **Peer scope:** `vault-librarian` Runs and Insights, only for rows whose significance you
   need to understand.
5. **Group-wide:** human Verdicts for the classes in this batch (§Precedent).
6. Note one boot line for the Run: `memory_server`, charter ids, procedure versions, feedback
   ids applied, `config_version`.

No `config:` or no `stage_by_class:` line means **stage 0 (shadow) for every class**
(§Settings).

### Step 2 — classify each row

Each row gets two keys (`references/autonomy-ladder.md` §Stage class):

- **Stage class** (`class` in the output), the key Calibration stages: `finding/<beat>`,
  `card_update`, `reverify`, `conflict`. Read it off the row: the row's `type`, and for a
  finding `finding/` plus the row's `beat` (`finding/pricing`). Nothing else goes in it, not
  even for a card diff on a beat (`card_update`, never `card_update/pricing`). Read the stage
  for this key from `stage_by_class`; a key missing from it is stage 0.
- **Precedent features**, for similarity only: `beat`, `claim_type`, `source_class`,
  `source_domain`, significance band (1–2, 3, 4, 5). They never go into `class`:
  `finding|pricing|pricing|zendesk.com|3` or `finding/failures/failure/legal500.com/sig1-2` is
  a class of one row that can never be promoted, and vault-curate replaces it.

Then apply hard rule 2. An always-escalate row still goes through Step 3: it is escalated
whatever its precedents, but its prediction is measured like any other.

### Step 3 — precedent (every row, every stage)

Follow `references/precedent-matching.md` for **every row, in shadow too**. Shadow is the stage
where predictions are scored for promotion, so a prediction made without precedents keeps the
class in shadow. Skipping the matching because "every row escalates anyway" is the usual way
a whole run comes back with empty `precedents`.

- Base each `prediction` and `confidence` on the matched precedents' weighted majority. With
  no similar precedent, predict from the nearest verdict-pattern Insight and say so in
  `reason`, with confidence at most 0.5.
- List the Verdict episode uuids you used in `precedents`. Return an empty list only when
  none matched, and then say "no similar precedent" in `reason`.

A row is **auto-eligible** only when it has at least `review.precedents_min` similar
human-decided precedents of non-zero weight (one Steering has zeroed doesn't count), at least `review.precedent_agreement` of them agree (time-decayed),
and no override of you exists in its stage class within `review.override_cooloff_days`.

### Step 4 — decide within the stage

Follow `references/autonomy-ladder.md`. Read each class's permissions from `stage_by_class`
(`auto_reject`, `auto_approve`). An override you find that vault-curate didn't account for turns that
direction off; nothing turns one on. Shadow, or the permission for your
predicted direction is off: return `escalate` with your prediction. `auto_reject` on: you may
auto-reject an eligible row. `auto_approve` on: you may auto-approve an eligible row at
significance 1–3 (stage 3: also 4), but a row that rests on another row only when that row is
approved, committed or auto-approved in this batch. `ladder.ceiling` and the class's own
ceiling in `ladder.class_ceilings` cap all of it.

### Step 5 — draft working memory, return

Draft the Run (`Run: vault-reviewer <YYYY-MM-DD>`: counts per decision, per-class stage used,
boot line) and any Insights, Procedure deltas, Acks or Feedback under `unwritten`. Return the
output contract.

## Output contract

Final message: only this JSON.

```json
{
  "run_id": "<from vault-curate>",
  "error": "<only when the vault check failed; then decisions is empty>",
  "decisions": [
    {
      "row_id": "...",
      "decision": "auto_approve|auto_reject|escalate",
      "prediction": "approve|reject|edit|null",
      "confidence": 0.0,
      "precedents": ["<Verdict episode uuid>"],
      "class": "finding/<beat>|card_update|reverify|conflict",
      "stage": 0,
      "reason": "<one line; for escalate: why it couldn't be auto-decided>"
    }
  ],
  "audit_sample": ["<row_id>"],
  "unwritten": [
    {
      "agent_id": "vault-reviewer|vault-librarian|vault-scout",
      "name": "<episode name>",
      "body": "<episode text>",
      "previous_episodes": ["<episode uuid it refines>"]
    }
  ],
  "notes": "<anything curate should log in the run row>"
}
```

`audit_sample`: `review.audit_rate` of your auto decisions, rounded up, and at least
`review.audit_min` when you made that many or more.

`prediction` and `confidence` are `null` only when you failed closed (Step 1.0, identity check
failed); every other row carries a prediction.

`unwritten`: `agent_id` is `vault-reviewer` for `Run:`, `Insight:`, `Procedure:` and `Ack:`, and
the target's name for `Feedback: vault-reviewer → <to> — …`.

`previous_episodes`: only on a `Procedure:` or `Insight:` that refines one of your earlier
episodes (`../vault-curate/references/run-end-memory.md` step 3). The body carries only the
change, so list the uuid of each episode it refines, as `get_episodes` or
`get_episodes_for_entity` returned it under `vault_<slug>` and `vault-reviewer`, and open the
body with `Refines '<predecessor name>'`. vault-curate checks each id with `get_episode` and
drops a delta whose predecessor isn't in `vault_<slug>`, isn't the same type, has a
`source_description` that doesn't start with `vault-reviewer` (a librarian's or scout's
episode; an older episode written before that format passes when it is tagged
`vault-reviewer`), or isn't named in the body. Omit the field (or `[]`) for a new episode.

## Degradation

- Memory tools missing at boot: Step 1.0 owns it (one retry under the passed prefix only,
  then fail closed). A tool under that prefix that disappears mid-run: search for
  `<memory_server><tool>` once more; still missing → fail closed with reason
  `memory unavailable: <prefix>`.
- Episodes always go under `unwritten`; you have no write tools.
- A row missing beat, domain or claim type: escalate it ("unclassifiable").

## Grounding Protocol

Precedents are counted from Verdict **episodes**, not Verdict nodes: two near-identical
Verdict names can merge into one node.

## Learning Protocol

Insights you draft are `insight_type: verdict_pattern` or `source_quality`, naming the
Findings whose Verdicts they draw on. Draft them at the end of the run under `unwritten`; a
hook that asks for memory captures is answered the same way, as in
`../vault-curate/references/run-end-memory.md` §Subagents. Feedback to the librarian or scouts
is `Feedback: vault-reviewer → <to> — <topic>`, tagged with the target, naming the evidence.

## Evals

`evals/evals.json` replays the last `ladder.replay_size` held-out human verdicts.
Auto-approve needs the replay to agree at or above `ladder.replay_pass`.

Each eval prompt starts with the `vault:`, `group:` and `run:` lines vault-curate sends, then
`memory_server:`; the policy evals also send `config:` and `stage_by_class:`. The policy evals
pass `memory_server: {memory_server}`, which the runner fills on **every** invocation,
vault-brief's Calibration replay included, the way vault-curate does
(`../vault-curate/references/memory-tools.md` steps 1–2, the vault file's `memory_connector`
included). Never fill it from a previous run or a hard-coded prefix: installing the gutt-pro
plugin can replace the connector and rename its tools. The filled prefix must be one of the
known prefixes (§vault-reviewer there); if discovery finds no such server, or more than one,
don't run the policy evals and report "replay not run: <reason>" instead of a score, so
Calibration never records one. The fail-closed evals keep their fixed unknown prefix
(`unknown-prefix-fails-closed`) and no prefix (`no-prefix-fails-closed`);
`mismatched-group-refuses` sends a group that isn't the slug's, and
`missing-config-holds-stage-0` no `config:` or `stage_by_class:`.

## Example invocation

Spawned by vault-curate as `Agent(subagent_type="gutt-vaults:vault-reviewer", prompt=…)` with this prompt
(example values, for an example vault; `memory_server` is the prefix vault-curate found in this
run, here the gutt-pro plugin's own server):

```
vault: example-vault
group: vault_example_vault
run: curate-2026-11-06
memory_server: <prefix found by vault-curate>
config: {"config_version": 0, "review": {…defaults…}, "ladder": {…defaults…}}
stage_by_class: {}
Pending rows: [...]
```
