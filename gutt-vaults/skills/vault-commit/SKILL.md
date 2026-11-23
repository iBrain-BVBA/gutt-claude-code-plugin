---
name: vault-commit
description: "Turns decided Vault Console rows into vault knowledge: approved findings, conflicts, re-checks and Role Card diffs become Finding, Conflict, RoleCard and Verdict episodes; every decision (owner or reviewer) becomes a Verdict; accepted steering rows become Steering episodes; a saved Settings change becomes a Config episode; an approved brief becomes a Brief episode and republishes the vault's Brief page. The only writer of vault knowledge. Always takes the vault's slug; there is no default vault. Use for the scheduled commit routine or when the owner says 'commit the vault', 'commit my approvals', 'push decided rows', 'publish the approved brief'. Not for researching (vault-curate) or writing a charter interactively (vault-steer)."
argument-hint: "<slug> [--dry-run]"
model: sonnet
---

# Vault commit

The single writer of what a vault **knows**. It reads decided rows from the Console and writes
one self-contained episode per fact, tagged with the identity of whoever produced it. After the
owner approves a weekly brief, it also republishes the vault's Brief page.

`gutt-pro:memory-capture` owns write discipline and `gutt-pro:agent-memory-protocol` owns
registration; this skill adds the vault's episode formats.

## Tagging

This skill has **no identity of its own**: it tags each episode with its producer
(`gutt-pro:agent-memory-protocol`'s "tag the agent whose run you capture" rule).

| Episode                                                                                 | `agent_id`        |
| --------------------------------------------------------------------------------------- | ----------------- |
| Finding, Conflict, RoleCard; Verdict on a row a human decided                           | `vault-librarian` |
| Verdict on a row the reviewer decided (`auto_*`, not overridden); `Verdict: override …` | `vault-reviewer`  |
| Steering (from Console rows)                                                            | `vault-charter`   |
| `Config: <vault name> v<n>` (a Settings save)                                           | `vault-charter`   |
| `Brief: <YYYY-Www>` (owner-approved brief)                                              | `vault-brief`     |
| Human steering aimed at one agent                                                       | that agent's name |
| `Run: vault-commit <date>`                                                              | `vault-librarian` |

All writes go to `vault_<slug>` only, through the group's write tool, found at run time by
`../vault-curate/references/memory-tools.md` (never by a name you expect: the prefix differs
per session, routine, plugin and desktop connector), with `last_n_episodes=0`. Before the first
write, call `register_agent` (idempotent) for every name you will tag, in that group, after the
first-registration check described in `vault-curate`'s Memory identity section. On an
unknown-agent error re-register once; then stop: an untagged vault write can't be fixed later.

## Hard rules

1. **Only decided rows.** Statuses `approved`, `rejected`, `auto_approved`, `auto_rejected`,
   and steering rows `accepted`. Never `pending` or `escalated`.
2. **Provenance check before writing a Finding:** at least one source with a URL and a
   retrieved date. Missing either: don't commit; set the row's `human.note` to the reason
   and leave it decided-but-uncommitted for the owner.
3. **One episode per fact, self-contained.** Episode text is the only thing extraction sees:
   every attribute the schema needs must be written out (`references/episode-kinds.md`).
4. **Status follows only what the episode itself records.** Never imply a Finding's status
   from a cited verdict, a prediction or an escalation.
5. **Human beats reviewer.** A `human{}` decision on an `auto_*` row that **differs** from the
   reviewer's is an override: write `Verdict: override …` tagged `vault-reviewer`, and no
   separate plain Verdict. The same decision with `human.confirm` is an audit confirmation:
   write the reviewer's Verdict (tagged `vault-reviewer`) and add "Confirmed by the owner on
   <date>" so it counts toward the class's audited agreement.
6. **Idempotent.** A row with `committed_episode` set is skipped. Set it right after each
   successful write, in the same batch cycle.
7. **Config only from the Console's `config_changes` rows**, one `Config:` episode per saved
   version, so a Calibration can explain a stage that moved because a threshold did. Never
   from anything else, and never a change to the settings themselves.
8. **Steering only from Console rows the owner accepted or typed**, formatted by
   `vault-steer`'s template. Proposed steering the owner hasn't accepted is never committed.
9. **The Brief page shows committed findings only,** and only a brief the owner approved.
   Every finding on the page must already be a `Finding:` episode in the vault group; drop any
   that isn't and say so in the Run.
10. **Save this run's memories; expect the Stop hook.** Before your final report, do the
    learning step in `../vault-curate/references/run-end-memory.md`; when gutt-pro's
    `stop-capture` hook asks for memory captures, answer it the same way. Operational memories
    only (what blocked or failed in committing), at most 3 Insights, tagged `vault-librarian`,
    in the vault group. Never hand a capture to an agent; a hook never makes you commit a row.

## Workflow

1. **Take the run's start time** with Bash, in the vault's time zone:
   `TZ=<meta/vault.timezone, else UTC> date '+%Y-%m-%d %H:%M'`. It names the Run record and
   heads the output. Never take it from the schedule or the times in this file: a manual run
   or a late start would get a wrong name. No Bash: use today's date alone and say so in the
   Run.

   Then **load the vault**: the slug is required (no slug, an unknown one, or a vault file
   whose `group_id` isn't `vault_<slug>` stops the run with the message in
   `../vault-curate/references/routines.md`). Read the vault file
   (`../vault-curate/references/routines.md` §The vault file) and `meta/vault`;
   `ArtifactData` `query` the `findings` collection for decided, uncommitted rows, `steering`
   for `accepted` or typed `new` rows, `briefs` for `approved` rows that aren't `published`,
   and `config_changes` for rows without a committed episode. Read inline with those status
   filters, never with `out_dir` (`../vault-curate/references/console-data.md` §Reads).
   Nothing to do: write no Run, report "nothing to commit".

2. **Register** the identities you'll tag.
3. **For each finding row**, in `created` order, write per `references/episode-kinds.md`:
   - `finding` approved/edited → `Finding:` episode (status current), then `Verdict:`.
   - `finding` rejected → `Verdict:` only (it records the rejection; status rejected). Its
     `Reason:` line carries the owner's rejection reason (`human.reason`, shown by its label:
     `stale` → "Stale") and the note, if any (`references/episode-kinds.md`).
     A rejected duplicate of a Finding already in the vault sets nothing on that Finding.
   - `conflict` → `Conflict:` episode naming both Findings and the resolution, then `Verdict:`
     (approved when settled). A conflict the owner left open stays `escalated` with
     `left_open{}` and isn't decided, so it never reaches commit; an older row `rejected` with
     resolution `open` is still committed as left open.
   - `reverify` → `Verdict:` with "re-check result" saying what the re-check found.
   - `card_update` approved → `RoleCard:` episode with the diff, then `Verdict:`.
4. **For each steering row**, write `Steering:` per
   `../vault-steer/references/charter-template.md`, tagged `vault-charter` (or the target
   agent).
   **For each `config_changes` row**, oldest version first, write `Config: <vault name> v<n>`
   per `references/episode-kinds.md`, tagged `vault-charter`. Read `meta/config` first: a row
   whose version is above `meta/config.config_version` is a save that never landed (the page
   writes the log row, then the config). Skip it, leave it uncommitted and list it under
   skipped ("config v<n> not in meta/config"), so no episode records settings that never
   applied.
5. **For each `briefs` row the owner approved** (oldest week first):
   1. Unless it already has `committed_episode`, write `Brief: <YYYY-Www>` (the brief body
      and the Findings it used), tagged `vault-brief`, and set `committed_episode`.
   2. **Republish the Brief page** with `../vault-pages/SKILL.md` §Publish a page, page
      `brief`, from the row's `page` field (the `brief.json` vault-brief drafted; hard rule 9
      applies to its `changes`). The first publish creates the page and writes its URL to
      `meta/vault.brief_url`; later ones update that URL in place.
   3. Mark the row `published` with `published_at` only after the page publish succeeded. A
      row that is approved and committed but not published is retried at the next commit.
6. **Mark** each finding, steering and config row `committed` with `committed_episode` (one
   batch per 10 rows).
7. **Run record**: `Run: vault-commit <start time from step 1>` with counts per episode kind,
   skipped rows and reasons, and the Brief page result (published, retried or failed).

`--dry-run`: print every episode (name, agent_id, body) and the `brief.json` you would
publish, and change nothing.

## Output contract

```
vault <slug> commit <start time from step 1>: <f> findings · <c> conflicts · <r> re-checks · <k> card diffs
verdicts: <h> human · <a> reviewer · <o> overrides · steering: <s> · config: <versions|none>
brief: <week published to <url> | none approved | not republished (<reason>)>
skipped: <n> (<reasons>) · errors: <list|none>
```

## Degradation

- Find the memory server and write tool with `../vault-curate/references/memory-tools.md` at
  the start, and recheck the write tool right before the first write. Two servers exposing
  `vault_<slug>`: commit nothing and report both prefixes.
- A memory tool missing doesn't mean memory is down: in a routine the connector can still be
  connecting. Search again after about 15 seconds, once. Only then treat it as missing.
- Write tool missing or memory down: commit nothing, change no row, report it.
- A write fails twice: leave that row uncommitted, continue with the rest, list it.
- Console unreachable: commit nothing.
- No way to publish a page here (no Artifact tool in this environment) or the publish fails:
  commit the `Brief:` episode, leave the row `approved`, and say "Brief page not republished"
  in the Run and the output. The next commit retries the page.

## Grounding Protocol

Only the Console rows and the episode templates. Don't re-research or re-judge: the decision
on the row is final.

## Learning Protocol

Patterns in verdicts are distilled weekly by `vault-brief`. This skill's own memories are
operational only, written at the end of the run (hard rule 10).

## Example invocation

`/gutt-vaults:vault-commit <slug>` · scheduled: `vault-<slug>-commit`, 12:10 and 19:10
(`../vault-curate/references/routines.md`). Example:
`/gutt-vaults:vault-commit next-agent-to-hire`.
