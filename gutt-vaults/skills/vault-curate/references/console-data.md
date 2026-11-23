# Vault Console data

The Console is a private Artifact (`console_url` in the vault file, `routines.md` §The vault
file) with the `db` capability. Skills read and write it with the `ArtifactData` tool (`url` =
`console_url`). The page reads the same collections live, so the Summary tab needs no
republish.

## Collections

```
findings   id, vault, type (finding|conflict|reverify|card_update), title, claim,
           why_it_matters, beat, sources[{url,title,retrieved,source_class}], confidence,
           significance, features{domain,claim_type,source_class},
           conflict{a_finding, b_finding, a_claim, b_claim}            # type conflict
           card{role, section, diff, maturity_change, first_independent_evidence}  # card_update
           status (pending|auto_approved|auto_rejected|escalated|approved|rejected|committed),
           review{decision, prediction, confidence, precedents[] (Verdict episode uuids),
                  reason, stage, class, run_id},
           human{decision (approved|rejected|edited), note, edited_claim,
                 reason (rejections: a reason key below), resolution (a|b|both, conflicts),
                 confirm (bool, audit), blind (bool), at},
           left_open{revisit (YYYY-MM-DD), note, at}                   # conflicts the owner left open
           revealed (bool: the page has shown the owner this row's prediction)
           audit (bool), committed_finding_episode, committed_episode, commit_pending{episode, acked_at}, run_id, created
steering   id, vault, text, applies_to, target_agent, supersedes,
           source (typed|proposed|clash), status (new|accepted|dismissed|committed), at
briefs     id, vault, week, body_md, linkedin_md, page (the week's brief.json),
           status (draft|approved|changes_requested|published), human_decision, note, at,
           committed_episode, published_at
runs       id, vault, routine, started, finished, config_version, memory_server,
           counts{found, dropped, dropped_by_reason{}, pending, auto_approved, auto_rejected,
                  escalated, by_beat{<beat>: n}},
           charter_ids[], stage_by_class{<class>: {stage, auto_reject, auto_approve}}, boot,
           injection_attempts[], flagged_beats[], errors[], notes
config_changes  id (v<n>), version, at, by (viewer id), changes[{key, old, new}],
                class_ceilings{old, new}, reset (section name, or null), committed_episode
                                                                    (the Settings tab; vault-commit)
meta/vault     name, slug, group_id, owner, question, beats[], brief_url, graph_url,
               timelapse_url, timezone, commit_times[], companion_groups_read_only[],
               write_tool_hint             (seeded once; vault-steer, vault-pages, vault-commit
                                                                    and vault-routines update)
meta/config    config_version, values{<key>: value}, class_ceilings{<class>: 0–3}, saved_at,
               saved_by                                             (the Settings tab; every skill reads)
meta/charter   status (assembled|draft), assembled_at, episode_ids[], clashes[],
               sections[{applies_to, title, text}]                  (vault-curate, every run)
meta/reviewer  at, week, calibration, config_version, owner_verdicts, counted_through, rolling_agreement,
               escalation_rate, replay{k, n}, stage_by_class{<class>: {stage, auto_reject, auto_approve,
               predictions, agreement, reject{n, agree}, approve{n, agree}, rolling_30d,
               last_override}}                                      (vault-brief, weekly)
calibrations   id (<YYYY-Www>), week, at, config_version, owner_verdicts, rolling_agreement,
               escalation_rate, replay{k, n}, by_class{<class>: {stage, auto_reject,
               auto_approve, agreement, reject{n, agree}, approve{n, agree}, rolling_30d,
               blind}}
                                                                    (vault-brief, weekly)
```

`reject{n, agree}` and `approve{n, agree}`: `n` predictions in that direction, `agree` of them
matching your call (whole numbers, steering-adjusted). `agreement` is a fraction (`0.91`).
`owner_verdicts` is your calls to date at the Calibration, counted from committed Verdicts;
`counted_through` is the latest `human.at` among the Console rows those Verdicts came from (rows
with `committed_episode` set when the brief ran). The Reviewer tab adds the calls made after
`counted_through` (after `at` when it is missing), so a call made before the Calibration but
committed after it is still counted. `calibrations` keeps one document per week, so the tab can draw each class's
agreement over time; `meta/reviewer` is always the latest week.

`meta`, `runs`, `config_changes` and `calibrations` are writable only by the owner and Editors
(access rules on the Console); routines write them through `ArtifactData` as the owner.

**Optional `meta/vault` fields:** `commit_times` (`["12:10", "19:10"]`) and `timezone` (an IANA
name such as `Europe/Brussels`), the commit routine's times and the owner's zone. The page
shows the next commit time in the viewer's own time; without them it assumes those two times
in the viewer's zone. vault-commit names its Run in `timezone` (UTC when unset). `brief_url`,
`graph_url` and `timelapse_url` are written by `../../vault-pages/SKILL.md` the first time it
publishes each page.

**Settings** (`meta/config`): keys, defaults and ranges are in `vault-config.md`; `values` holds
every key the owner saved (Reset removes a section's keys). The db has no transactions, so a
Save on the Settings tab takes a short lease on `meta/config_lock` (`acquire`, one holder per
page load, so two tabs contend like two viewers), re-reads `meta/config` and refuses if its
`config_version` moved since the page read it, then writes `config_changes/v<n>` and
`meta/config` with `config_version` n. A runtime without `acquire` can't save Settings (the
page says to republish). A save while another holds the lease, or after someone else saved, is
refused with a message, never merged. Under the lease, a `config_changes/v<n>` row left by a
save whose `meta/config` write failed is replaced; a failed `meta/config` write is re-read
before the log row is rolled back, so a write that landed keeps its log row. The db can't
reject a write from a holder whose lease expired, so the page renews the lease before each
write and stops the save, sending nothing more, if any call settles after the last grant's
request time plus the lease length; the editor is told to check Settings and the change log.
Save waits until
the page knows the viewer's id: `by` and `saved_by` are viewer ids from the `user` capability,
never names, and a change is never recorded without one; the page resolves names when it shows the change log. Skills only read `meta/config`;
vault-commit marks `config_changes` rows with `committed_episode` once their `Config:` episode
is written.

The page is `templates/console/index.html` in the gutt-vaults plugin, vault-agnostic: it reads
the vault's name and beats from `meta/vault`. `vault-steer --charter` publishes a new vault's
Console (`../../vault-steer/SKILL.md` §Workflow) as a copy with its own
`<title>` (`<vault name> Console`) as a new Artifact (`../../vault-pages/SKILL.md` §Publish a
page) with capabilities
`{db: {rules: [{path: "meta", write: "admin"}, {path: "runs", write: "admin"},
{path: "config_changes", write: "admin"}, {path: "calibrations", write: "admin"}]},
user: {scopes: ["profile"]}}`, writes its URL to the vault file's `console_url` (the Console
can't hold its own address: every skill reaches it from the vault file), then seeds
`meta/vault`. No `meta/config` is needed at first:
every key starts at its default. An existing Console gets the `config_changes` and
`calibrations` rules and the `user` capability when it is republished from this template.

Row ids: `<run_id>-<n>` for findings; `steer-<YYYYMMDD>-<n>`; `brief-<YYYY-Www>`;
`<routine>-<YYYY-MM-DD>` for runs (`-2` etc. if a routine runs twice a day); `<YYYY-Www>` for
calibrations.

## Review on the page

The page has one **Inbox** for everything that waits on the owner, most urgent first:
conflicts whose revisit date has come and significance-5 rows, then other conflicts, then
escalated rows by significance, then audit samples, the week's brief draft and proposed
steering. Filters narrow it by kind. The other tabs are Summary, Reviewer, Settings, Steer and
Archive. Links to the old tabs (`#needs-you`, `#audit`, `#conflicts`, `#briefs`) open the Inbox
on the matching filter.

- **Blind calls.** In a class at stage 0 (and for every conflict), the page hides the
  reviewer's prediction, confidence and reason until the owner decides, then shows whether
  they agreed. The page records `human.blind` on every call (true only when there was a
  prediction to hide), and sets `revealed: true` on the row once a decision has shown it; the
  card shows the prediction only after that write has landed. `revealed` survives undo, Reopen and reload, so
  a second call on the same row is never counted as blind. The reviewer is graded on the
  owner's calls, so a call made after seeing its prediction is weaker evidence.
- **Rejection reasons.** Rejecting takes one reason chip, stored as `human.reason`; the note
  stays optional. Overriding an auto-approval takes a reason chip too; overriding an
  auto-rejection takes a note.

  <!-- reject-reasons:begin -->

  | `human.reason`     | Shown as            |
  | ------------------ | ------------------- |
  | `stale`            | Stale               |
  | `weak_source`      | Weak source         |
  | `off_scope`        | Off scope           |
  | `duplicate`        | Duplicate           |
  | `low_significance` | Not significant     |
  | `unsupported`      | Claim not supported |
  | `other`            | Other               |

  <!-- reject-reasons:end -->

- **Undo.** Every Inbox action can be undone for five seconds from the toast, and from the
  card while it stays on screen; undo writes back the fields the action changed, except
  `revealed`, which stays set so a second call on the row is never counted as blind. Before the
  next commit, Reopen in the Archive does the same. Both re-read the row and refuse once it is
  committed (or a brief is published), or when the row is gone.
- **Leave open.** A conflict left open keeps `status: escalated` and gets `left_open{revisit,
note, at}`; it leaves the Inbox, shows on Summary with its revisit date, and comes back to
  the Inbox on that date. The revisit date is tomorrow or later; the page refuses an earlier
  one. It is not a decision, so vault-commit never sees it. Deciding a left-open conflict
  clears `left_open` in the same write (undo puts it back).
- **In-place updates.** A routine writing rows doesn't redraw the page: cards whose row didn't
  change stay as they are, with their typed notes, open sections and scroll position.

## Status rules

- curate writes `pending`, then the reviewer's outcome (`auto_approved`, `auto_rejected`,
  `escalated`).
- The page writes `human{}` and sets `approved` / `rejected`. A human decision on an
  `auto_*` row is an **override** only when it differs from the reviewer's decision; the
  same decision with `confirm: true` is an audit confirmation.
- Leave open on a conflict writes only `left_open{}`; the status stays `escalated`.
- Reopen (before commit) sets the status back to the reviewer's outcome and `human: null`.
- commit records `committed_finding_episode` after a row's first episode, then sets
  `committed` and `committed_episode` after its last. Committed rows are never edited.
- commit sets a brief `published` once its page is live, or `changes_requested` when the
  brief names a finding that isn't committed (`vault-commit` hard rule 9).
- `human{}` always wins over `review{}`.

## Reads

- **Inline, never `out_dir`.** Read with `get`, `list` or `query` and no `out_dir`. Console
  rows count as content other people may have written, and ArtifactData saves those to files
  only with a person's consent. A routine has nobody to give it, so the read is denied.
- **Only what the step needs.** `query` with a `where` status filter instead of listing a
  whole collection, which grows every run:
  - curate dedupe: `findings` with `status` in `pending`, `escalated`, `approved`,
    `auto_approved`, `rejected`, `auto_rejected` (an approved row has no Finding in memory
    until vault-commit writes it; committed claims are deduped against the vault's Findings in
    memory);
  - curate run id: `get` `runs/<routine>-<YYYY-MM-DD>`, then `-2`, `-3`, until one is free;
  - commit: `findings` with `status` in `approved`, `rejected`, `auto_approved`,
    `auto_rejected`; `steering` with `status` in `accepted`, `new`; `briefs` with
    `status: approved` (approved and not yet published); `config_changes` without
    `committed_episode`;
  - brief: `get` only the documents it reads or writes (`meta/vault`, `meta/config`,
    `briefs/brief-<YYYY-Www>`, `meta/reviewer`, `calibrations/<YYYY-Www>`), plus one `query`
    of `findings` with `type: conflict` and `status: escalated` for the open conflicts (a
    conflict left open never becomes a `Conflict:` episode), and one `query` of `findings`
    with `committed_episode` set for the Calibration (per-row `human.at`, `human.blind`, and
    `counted_through`, the latest `human.at` among them);
  - every skill at boot: `get` `meta/vault` and `meta/config`; curate also `meta/reviewer` for
    the promotion re-check (`vault-config.md`).
- **Pin writes to what you read:** every read returns each document's `version`; pass it as
  `if_version`.

## Writes

One `ArtifactData` `batch` per step, never a write per row. Never touch a row's `human{}`,
`left_open{}` or `revealed` from a routine.
