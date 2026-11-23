# Run-end memory and the Stop hooks

Shared by vault-curate, vault-commit and vault-brief, plus vault-review and vault-scout for
their parts.

## What to expect

A routine session can end with the gutt-pro plugin's Stop hook, `stop-capture.cjs`. It is
expected and it isn't an error. It fires only when its judge thinks the run produced
something worth keeping, and it arrives after your final report, as a new turn:
"Run the `gutt-pro:memory-capture` skill." followed by bullets naming candidate Insights,
then "Then run the `gutt-pro:output-style` skill".

If the repository a routine runs in has a Stop hook of its own that asks for memory captures,
treat it the same way as stop-capture.

## Before your final report: the learning step

Do it before the hook fires, so it mostly confirms work already done. Do it even when no
hook fires.

1. **Collect candidates from this run:** sources that blocked or misled you, tool errors and
   how you got around them, a step that worked better than your Procedure says, scoring
   offsets against owner verdicts, owner edits that repeat.
2. **Keep what a future run of this vault can use** and couldn't get from the code, the
   charter or the Console. It must be specific, with evidence (URL, row id, error text).
   "Ran successfully" isn't a memory.
3. **Dedup:** `search_memory_facts` in `vault_<slug>` with `include_invalidated=true`. Skip
   what's already there; when you refine an earlier episode, write only the change and pass
   its episode id as `previous_episodes`.
4. **Write** batched, to `vault_<slug>` through the write tool found by `memory-tools.md`,
   `agent_id` = this run's identity, `last_n_episodes=0`, within the skill's budget (vault-curate
   and vault-review: 5 Insights and 2 Procedure deltas per identity; vault-commit: 3 Insights;
   vault-brief: its own Insight cap).

## When the hook fires

- **Never hand the capture to an agent.** Write it yourself, to the vault group; an agent
  spawned for memory doesn't know the vault group or your type gate.
- **stop-capture.cjs:** its bullets are candidates, not orders. For each one:
  - written already this run, or already in the group: skip it;
  - new, reusable and about this vault's work, with budget left: write it as an `Insight:`
    (what broke and how you got around it counts), following steps 2–4 above;
  - otherwise skip it and say why.
    Follow `gutt-pro:memory-capture`'s discipline (dedup, one focused episode,
    `last_n_episodes=0`). Only the target differs: always the vault group, never the org or
    personal group.
- **Type gate:** unattended runs write only the working-memory types their skill lists
  (`Insight:`, `Procedure:` deltas, `Run:`; the vault schema has no Incident). A candidate that reads
  as a Lesson, Decision or WorkingAgreement goes in your reply under "for the owner", and in
  the Run episode if that isn't written yet.
- **output-style:** apply it to the reply.
- **Reply in a few lines:** what you wrote (episode names), what you skipped and why. Then
  stop. A hook never reopens research, changes Console rows or commits vault knowledge.

## Subagents

- **vault-reviewer:** the same rules for its own identity (`vault-reviewer`), but it has no
  write tools: every candidate goes under `unwritten` with its `agent_id`, and vault-curate
  writes it under that identity (the target's name for Feedback).
- **vault-scout:** has no write tools. Candidates go in `scout_notes`, which vault-curate
  writes under the scout's name.
