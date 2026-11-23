---
name: vault-brief
description: "The weekly output of a public research vault: drafts the brief, its Brief page data and a LinkedIn post from committed findings only, writes the reviewer's weekly Calibration, distills verdict patterns into Insights, proposes repeated rejection patterns as steering, and republishes the vault's Graph and Timelapse pages. The brief waits for the owner on the Console. Use for the scheduled brief routine or when the owner says 'vault brief', 'weekly brief for <slug>', 'agent of the week', 'how is the reviewer doing', 'refresh the vault graph'. Always takes the vault's slug; there is no default vault. Not for publishing the brief (the owner approves it on the Console; vault-commit publishes it) or for research (vault-curate)."
argument-hint: "<slug> [--week YYYY-Www] [--dry-run]"
model: opus
metadata:
  memory-identity: vault-brief
---

# Vault brief

Turn a week of committed findings into something worth sharing, and turn a week of verdicts
into what the agents learn.

`gutt-pro:memory-search` owns recall, `gutt-pro:memory-capture` owns dedup and
`gutt-pro:agent-memory-protocol` owns registration; this skill adds the brief and the
reviewer's Calibration.

## Memory identity

This workflow writes as **`vault-brief`** in `vault_<slug>`, through the group's write tool
(found at run time by `../vault-curate/references/memory-tools.md`), `last_n_episodes=0`. It
also writes the weekly `Calibration:` **as `vault-reviewer`** (it captures the reviewer's
record). The names are short, with no `--<scope>` suffix, on purpose: the dedicated vault group
is the scope. Before the first registration in a group run the first-registration check from
`vault-curate`'s Memory identity section, then:

```
register_agent(name="vault-brief", group_id="vault_<slug>",
  description="Writes a public research vault's weekly brief and LinkedIn draft from committed findings, and distills verdict patterns into Insights.")
```

Recall runs in two passes, own scope (`agent_id="vault-brief"`) then group-wide without
`agent_id`; the group-wide pass is never skipped. On an unknown-agent error re-register once;
then write nothing and put the episodes in the Console run row's notes.

## Hard rules

1. **Committed findings only.** Never a pending, escalated or rejected row, in the brief, its
   page data or the LinkedIn draft.
2. **The brief isn't published here.** The brief, its page data and the LinkedIn draft go to
   the Console `briefs` collection as `draft`. The owner approves; `vault-commit` then
   publishes the Brief page. The Graph and Timelapse pages are the exception: they show only
   what the vault group already holds, so this skill republishes them every week.
3. **Cite everything.** Every claim in the brief links its source. The LinkedIn draft has no
   URLs: it names its sources on one `Sources:` line above the hashtags.
4. **Framing** follows the scope charter. For a vault about agents in roles: agents as roles on
   a team; no headcount-reduction claims unless a cited source makes them, attributed to it.
   Regulatory content ends with "not legal advice".
5. **Calibration counts only human verdicts against reviewer calls on the same rows.** It
   records the stage per class from the ladder (`../vault-review/references/autonomy-ladder.md`)
   with this run's settings, and the eval replay; it never promotes past `ladder.ceiling` or
   a class's own ceiling.
6. **Insights:** at most 5, each naming the Findings whose Verdicts it draws on.
7. **Save this run's memories; expect the Stop hook.** Before your final report, do the
   learning step in `../vault-curate/references/run-end-memory.md`; when gutt-pro's
   `stop-capture` hook asks for memory captures, answer it the same way. Writes stay in the
   vault group, tagged `vault-brief`, within rule 6's cap, as Insights. Never hand a capture
   to an agent; a hook never publishes or changes a draft.

## Workflow

0. **Load the vault.** The slug is required: no slug, an unknown one, or a vault file whose
   `group_id` isn't `vault_<slug>` stops the run with the message in
   `../vault-curate/references/routines.md`. Read the vault file
   (`../vault-curate/references/routines.md` §The vault file), then `meta/vault` and
   `meta/config` from the Console, inline; check every setting per
   `../vault-curate/references/vault-config.md` §Reading the config at boot and keep
   `config_version` and the clamp notes for the Run.
1. **Boot**: find the memory tools (`../vault-curate/references/memory-tools.md`); register;
   effective charter (`../vault-curate/references/charter-assembly.md`); own scope
   (`agent_id="vault-brief"`: past Briefs, which the owner edited and how, which Insights held);
   peers: `vault-librarian` RoleCard history, `vault-reviewer` Calibration; group-wide recall
   for the week.
2. **Gather** the week's committed Findings, Conflicts, RoleCard diffs and Verdicts
   (`search_memory_facts(include_invalidated=true)` for "what changed").
3. **Draft the brief** from `references/brief-template.md`; for a vault whose charter has a
   role taxonomy (`applies_to: roles`), include the board movement and "Agent of the week".
   Draft its **page data** from the same findings, shaped as `brief.json` in
   `../vault-pages/references/page-data.md` §brief.json.
4. **Draft the LinkedIn post** from the brief (`references/brief-template.md` §LinkedIn
   draft): the series line, one real scene from the vault's week as the hook, the closing
   question, `brief.linkedin_cta` as the offer (none set: no offer line, and say so in the
   Run), the `Sources:` line, and an image prompt with its alt text. If the owner's setup has
   its own post-drafting skill, the owner can redo the post with it from the approved brief;
   this skill never depends on one.
5. **Write all three** to the Console `briefs` collection (`brief-<YYYY-Www>`,
   `status: draft`: `body_md`, `linkedin_md`, `page`). First `get` the row: write it only
   when it is absent, or is `draft` or `changes_requested` with no `committed_episode`. An
   `approved` or `published` row, or any row with `committed_episode`, belongs to the owner's
   decision and the commit routine: leave it untouched, skip only this step, say "brief
   <week> already approved, not redrafted" in the Run, and go on with the Calibration and
   the pages. Console reads are inline `get`s of the documents you write, never with
   `out_dir` (`../vault-curate/references/console-data.md` §Reads).
6. **Calibration**: compute per-class agreement (stage classes and steering adjustment from
   `../vault-review/references/autonomy-ladder.md` §Stage class, §Agreement), escalation rate,
   the share of predictions that cited precedents, audit outcomes, overrides; per class,
   approve and reject prediction accuracy separately, written as `stage <s> (auto_reject
on|off, auto_approve on|off)`, using this run's `ladder` and `review` settings; run the
   vault-review replay eval over the last `ladder.replay_size` human verdicts if that many
   exist; write `Calibration: <date>` tagged vault-reviewer (with `config_version` and
   per-direction counts per class, so vault-curate can re-check them). Then write the same
   numbers to the Console in one batch: `meta/reviewer` (the latest week, with `week` and
   `owner_verdicts`) and `calibrations/<YYYY-Www>` (one document per week, replaced if the
   brief reruns that week), shaped as in `../vault-curate/references/console-data.md`. Count
   per class how many of the owner's calls were blind (`human.blind`, made before the page
   showed the prediction) and record it as `blind`; blind and seen calls count alike. The
   Console's Reviewer tab draws each class's agreement trend from `calibrations`.
7. **Distill** verdict patterns (`references/distillation.md`) into Insights; propose each
   rejection pattern seen `brief.steering_after_weeks` weeks running as a Console `steering`
   row with `source: proposed`.
8. **Republish the Graph and Timelapse pages** with `../vault-pages/SKILL.md`: one export
   (§Export) builds `graph.json` and `timeline.json` from the vault group, then §Publish a page
   for `graph` and `timelapse`. The first publish of each creates it and writes
   `meta/vault.graph_url` or `meta/vault.timelapse_url`. Pass the previous `graph.json` so the
   layout stays put. A failure here is reported in the Run and never blocks the brief.
9. **Run**: `Run: vault-brief <YYYY-Www>` with counts, `config_version`, config clamps and
   the page results; `Brief: <YYYY-Www>` is written by vault-commit only after the owner
   approves it.

`--dry-run`: print everything, write nothing, publish nothing.

## Output contract

```
vault <slug> brief <week>: <n> findings · <c> conflicts · <k> card changes
reviewer: rolling agreement <x%> · escalation <y%> · stages <class:stage, …>
insights: <n> · proposed steering: <n>
brief: <on the Console for approval | skipped (<n> findings) | already approved, not redrafted | not written (<error>)>
calibration: <written | stages unchanged (config unavailable) | not written (<error>)>
pages: graph <url|failed: reason> · timelapse <url|failed: reason>
```

## Degradation

- Find the memory server and write tool with `../vault-curate/references/memory-tools.md` at
  the start, and recheck the write tool right before the first write. Two servers exposing
  `vault_<slug>`: write nothing and report both prefixes.
- A memory tool missing doesn't mean memory is down: in a routine the connector can still be
  connecting. Search again after about 15 seconds, once. Only then treat memory as down: write
  nothing, draft nothing, report it.
- Fewer than `brief.min_findings` committed findings in the week: write the Calibration and
  Insights, skip the brief, say so. The Graph and Timelapse are still republished.
- No way to publish a page here (no Artifact tool, or no Node.js for the export script): skip
  step 8 and say so; the next week's run catches up.
- Console unreachable at step 0: the owner's settings can't be read, so config fails closed
  (`../vault-curate/references/vault-config.md`): write the `Calibration:` episode with the
  measured agreement but no stage changes, write nothing to the Console, skip the brief, and
  report `brief: not written (Console unreachable)`.
- A Console write fails (step 5's brief, or step 6's `meta/reviewer` and `calibrations`
  batch): retry once, then report it in the output line for that write as `not written
(<error>)`, never as waiting for approval, and go on with the other steps.

## Grounding Protocol

Committed episodes in the vault group only, plus the reviewer's own records.

## Learning Protocol

Which briefs the owner edited and how: compare the draft with the approved version in the
Console and write an Insight when an edit repeats.

## Example invocation

`/gutt-vaults:vault-brief <slug>` · scheduled: `vault-<slug>-brief`, Fri 13:20
(`../vault-curate/references/routines.md`). Example: `/gutt-vaults:vault-brief example-vault`.
