---
name: migrate-memory
description: "Move Claude Code's own per-project memory store into the gutt knowledge graph, once, with the user's consent — back it up, write the episodes, verify they landed, then remove the local copies and leave a note that gutt is the store of record. Use when the user accepts an offer to migrate local memory, or asks to move built-in/local/file-based memory into gutt. Triggers on: migrate memory, migrate my memory, move local memory into gutt, built-in memory, Claude Code memory store, MEMORY.md, local memory files, import my memory, my notes aren't in gutt."
---

# Migrate built-in memory into gutt

Claude Code keeps its own file-based memory store **per project**. Where it is
non-empty, that is organizational knowledge sitting outside the graph — invisible
to teammates, to every other project on the machine, and to gutt search. This
skill moves it across exactly once, and is the only place in the plugin that
deletes a user's memory files.

It builds on `memory-capture` (how to write), `memory-search` (how to dedup and
verify) and `conflict-adjudication` (what to do when a local note and the graph
disagree) rather than restating them. Migration does not get its own dedup or
conflict rules — it is a bulk caller of those skills, and a store is the largest
batch of writes the plugin ever makes. Read this file's rules first; they are
stricter than the general ones because the local copy is destroyed at the end.

## Hard rules (non-negotiable — read first)

1. **Ask before anything.** Use **AskUserQuestion** for consent and for scope
   before the first write. The session-start offer also asks with AskUserQuestion, so
   arriving here usually means consent to _run_ is already given — that answer covers
   starting the skill, not the writes. Scope is still unasked, and so is anything you
   only discovered by reading the files. Where you got here some other way (the user
   named the skill, or the offer was answered in prose), treat consent as unasked:
   an offer is not an answer.
2. **Back up before you write, verify before you delete.** The order is
   fixed: back up → write episodes → **search to confirm they landed** → record the
   confirmations → delete. `memory-capture` rule 6: a write is _queued, not
   confirmed_, so a success response is not evidence. Never delete on a 200.
3. **Deletion is the script's job, not yours.** Do not `rm` anything and do not use
   Write/Edit on the store. `store-cli.cjs delete` removes only files with a
   recorded verification, which is what makes an unlanded write cost nothing.
4. **Record the answer, including "no".** Every terminal answer is persisted per
   project. A decline must never be re-asked; a completed migration must never be
   re-offered.
5. **Degrade by stopping.** No write tool visible, or MCP unreachable → write
   nothing, delete nothing, say so in one line, and leave the decision **unset** so
   the offer returns next session. A partial migration is worse than none.
6. **Default to the org group; screen for what must stay personal.** Visibility to
   teammates is the whole point of migrating, so the group is the default. But
   publishing is the one failure here that restoring a file cannot undo, so read every
   fact before it goes: anything sensitive — a credential, PII, a note about a named
   person, or personal preference data — goes to **personal** scope regardless of what
   the user picked for the batch.

## What the store looks like

`~/.claude/projects/<encoded-cwd>/memory/` holds:

- **`MEMORY.md`** — an index of one-line pointers. **Not a fact.** Never migrate it;
  everything in it is a summary of a file you are already migrating.
- **one `.md` per fact**, with frontmatter `name`, `description`, and
  `metadata.type` ∈ `user` | `feedback` | `project` | `reference`. The body carries
  the fact, and for `feedback`/`project` usually `**Why:**` and
  `**How to apply:**` lines.
- **`[[wikilinks]]`** between facts. The graph builds its own edges from content, so
  resolve each link into a plain reference naming the other memory ("relates to the
  lesson about …") rather than carrying `[[…]]` syntax into an episode.
- **facts with no frontmatter at all** — observed in a real store, so not hypothetical.
  A plain markdown note, often already shaped as a report and self-titled
  (`# Incident: …`, `# Insight: …`). It is still a fact; classify it from that title
  and its content per `memory-capture` rather than skipping it, and note that
  `metadata.type` is only a hint the store sometimes carries, never a precondition.
  Watch the frontmatter you _do_ parse: the nested key is `metadata.type`, and
  `metadata.node_type` sits above it holding the constant `memory` — a loose match for
  `type:` reads that instead and types the entire store identically.

## How to invoke the CLI (get this right before step 1)

**The Bash tool inherits neither `CLAUDE_PLUGIN_ROOT` nor `CLAUDE_PLUGIN_DATA`.** Only
hooks are given those; a command you run is a different process with a different
environment, and both expand to nothing there. So resolve them yourself, from two
values you have been handed directly:

- **`<SKILL_DIR>`** — the "Base directory for this skill" line in your skill preamble.
- **`<DATA_DIR>`** — `${CLAUDE_PLUGIN_DATA}`, interpolated into this sentence for you.

Every call in this file is then:

```bash
node "<SKILL_DIR>/scripts/store-cli.cjs" --plugin-data="<DATA_DIR>" <subcommand>
```

Substitute both before running; do not pass `$CLAUDE_PLUGIN_ROOT` or
`$CLAUDE_PLUGIN_DATA` through to the shell and do not `export` them. If `status`
returns `pluginDataAvailable: false`, **you dropped the flag** — that is the only way
it can be false, since the field is computed after the flag is applied. It is never the
platform's fail-safe and never grounds to stop: re-run the call correctly. A `hint`
field accompanies every such `false`, so treat the two as one signal rather than
looking to the hint to tell them apart.

A data dir that is set but unusable — wrong path, not writable — reports
`pluginDataAvailable: true`. It surfaces at step 5 instead, as `backup` returning
`ok: false`, which is where rule 5 actually bites.

Run `status` first — it reports the store path, the fact files, and any decision
already recorded:

```bash
node "<SKILL_DIR>/scripts/store-cli.cjs" --plugin-data="<DATA_DIR>" status
```

If `settled` is true, stop and say so — this project has already been answered.

## The flow

1. **Status.** As above. No fact files → tell the user there is nothing to migrate
   and stop; do not record a decision.
2. **Read the facts.** Read each `.md`. You need the frontmatter type and the body
   to classify and to write a decent episode; this is also where you notice
   anything the user would not want written anywhere.
3. **Ask.** One **AskUserQuestion** covering both decisions:
   - _Migrate these N notes into gutt?_ — migrate / not now / never
   - _Scope?_ — org group (default) / personal / decide batch by batch

   Show the count and name a few examples so the choice is informed. On "never"
   → `record declined` and stop. On "not now" → `record later` and stop.

4. **Check the write tool.** Read your tool list for `add_personal_memory` /
   `add_memory_to_<group>` / `add_memory` (`memory-capture` rule 4 — never hardcode
   a name). None visible → rule 5, stop here.
5. **Back up.** `store-cli.cjs backup`. It captures every fact's content into one
   JSON under `${CLAUDE_PLUGIN_DATA}/migrations/`, which is exempt from the session
   sweep and so outlives the session. `ok: false` → stop; without a backup nothing
   may be deleted anyway.
6. **Dedup, then write, in batches of 5–10.** For each batch, run `memory-search`
   rung 1 on each fact's `description` and sort what comes back three ways
   (`memory-capture` rule 1):
   - **no match** → write it;
   - **near-match that agrees** → a reason to write _less_, never to rewrite the
     older entry: write only the delta, or skip the fact entirely;
   - **near-match that contradicts** → **not a dedup.** Stop on that fact, take the
     pair to `conflict-adjudication`, and write only what it recommends. Leave the
     file in the store meanwhile: an unwritten fact records no episode id, so the
     deletion gate in step 9 already keeps it without any special handling here.

   The contradicting branch is not a corner case in this skill — a migrating store is
   where contradictions are _most_ likely. These notes accumulated locally over months
   while the team kept writing to the graph, and neither side has seen the other.
   Writing a whole store in batches without checking would let a stale local note
   land as the newest word on something the team already decided differently.

   Write the rest with `last_n_episodes=0` on every org write (rule 3), one episode
   per fact, a typed `name` prefix per the mapping below.

7. **Verify.** After each batch, **one** search for the episodes just written.
   Extraction is asynchronous, so an immediate miss may only mean not-yet-processed —
   re-check once before concluding anything is missing.
8. **Record what landed.** For each confirmed fact:

   ```bash
   node "<SKILL_DIR>/scripts/store-cli.cjs" --plugin-data="<DATA_DIR>" \
     verified "some-fact.md=<episode-id-from-the-search>"
   ```

   Only pass a file whose episode a search actually returned. This is the gate on
   deletion, so guessing here defeats the entire safety property.

9. **Delete.** `store-cli.cjs delete`. It removes only verified facts, then puts the
   standing note at the top of `MEMORY.md` — gutt is the store of record, local memory is
   the fallback for when MCP is unreachable — and drops the pointers whose target files
   have gone. **It does not rewrite the rest of the file.** Headings, hand-written prose,
   plain bullets and links to anything outside the store are all left alone; a line is
   removed only when it points at a fact in this store and every fact it points at is
   gone. Both halves run whenever anything was deleted, not only on a clean finish: a
   pointer to a migrated fact would otherwise be injected into every later session
   describing a file nobody can open, and a partial migration would be left with no
   redirect at all while Claude Code carried on writing locally.

   Read three fields, not one:
   - `kept` — these facts did not land. Say which, and leave them.
   - `note` — `false` means the index could **not** be rewritten. It still lists deleted
     facts and carries no redirect. Report it with the path.
   - `reason` — present when something went wrong; quote it rather than paraphrasing.

10. **Record the decision.** `record migrated` — but only when `kept` is empty **and**
    `note` is `true`. With facts left behind the job is unfinished, so leave the decision
    unset and the offer returns.

    The `note` half matters because `migrated` is terminal and the two failures are not
    symmetric. A partial migration comes back on its own — the decision stays unset and
    the offer fires again. But a run that empties the store and fails to write the index
    is the one state nothing can reach again: record `migrated` there and the store reads
    as empty, both gates fall silent, and the index keeps pointing at deleted files with
    no redirect, permanently. So on `note: false`, leave the decision unset and tell the
    user the index needs a look.

## Mapping `metadata.type` onto gutt tiers

The types do not line up with the trust tiers, and the mismatch lands on the gated
side — so this is stated rather than left to judgement:

| `metadata.type` | gutt type                                                                 | tier                         |
| --------------- | ------------------------------------------------------------------------- | ---------------------------- |
| `feedback`      | **Lesson** — a corrective takeaway                                        | gated                        |
| `project`       | **Insight**, or **Decision** when it records a choice _and_ its rationale | Insight auto, Decision gated |
| `reference`     | **Insight** — a pointer to a resource                                     | auto                         |
| `user`          | **Insight** about the user's preferences — personal scope                 | auto                         |
| _absent_        | classify from the note's own title and body (`# Incident:` → Incident)    | per the type you land on     |

**The gated tiers, and why approval covers them.** `memory-capture` rule 2 holds
Lesson, Decision and WorkingAgreement behind an explicit human signal, and most of a
real store is `feedback` — i.e. Lessons. Left unaddressed, this migration would
become the plugin's largest unprompted write of gated tiers.

It is not unprompted. The user is shown the count, the examples and the scope, and
asked to approve **this specific batch** before any write — which is a stronger
signal than the "capture that lesson" the rule was written for. So their yes at
step 3 _is_ the explicit signal for every gated item in the batch.

That reading is bounded, and the bounds are the point:

- it covers only the facts in this store at the moment they were shown;
- it is not standing permission — a later session re-asks;
- it does not license writing anything you did not show them. If reading the files
  turns up something you did not surface at step 3 (a credential, a note about a
  named person, anything sensitive), surface it and ask again rather than leaning on
  the earlier yes.

## Scope: the org group by default

`add_memory_to_<group>` publishes to the team; `add_personal_memory` writes to the
user's private scope. A real store mixes both kinds — working-style notes about how
the agent should behave sit next to project facts a team would want.

Default to the **org group**. A note left in personal scope is invisible to teammates
and to org search, which is the condition migration exists to end, so keeping the
store's project knowledge private by default would move the facts without delivering
the benefit.

Route to **personal** regardless of what the user picked for the batch:

- anything sensitive — a credential, a token, PII, or a note about a named person;
- anything `metadata.type: user` — preference data about one individual;
- anything `feedback` phrased as how the agent should behave with _this_ user, as
  opposed to a practice a teammate could adopt.

The asymmetry is deliberate: a fact wrongly kept personal can be re-published later,
while one wrongly published cannot be recalled. So when a note is genuinely ambiguous,
that is a reason to ask rather than to guess in either direction.

The third option is named "decide batch by batch" rather than "per note" because that is
the granularity actually offered: one question per batch of 5–10 (step 6), not one per
file. Thirty files would otherwise mean thirty questions, and the option would be a
promise the flow does not keep. Per-note control is still available — it is what the
routing rules above do without being asked.

## Degradation

- **No write tool / MCP unreachable** → nothing written, nothing deleted, one line
  saying so, decision left unset. Having already taken the backup is fine and needs no
  undoing — it authorises nothing on its own, because `verified` is empty and that is
  the only gate `delete` consults. What must not happen is recording a verification to
  make progress look real: with nothing written there is no episode to have found, so
  any id here is invented, and step 8's gate is the whole safety property.
- **`backup` returns `ok: false`** → stop. `delete` is a no-op without a backup, so
  continuing would write to the graph while leaving the local copy in place, which is
  the one state that later looks like a completed migration but is not. This is also
  where a data dir that exists but is unwritable shows up, so do not read it as "the
  store was empty".
- **Some episodes never confirmed** → keep those files, delete the rest, report the
  gap by name, leave the decision unset.
- **`verified` returns a name in `rejected`, or a `reason`** → that fact is not
  authorised for deletion. A `reason` mentioning the backup means nothing was recorded at
  all: do **not** re-write the episodes, which may well have landed — re-run verification
  and fix the backup problem it names.
- **`delete` returns `note: false`** → the facts went, but `MEMORY.md` was not rewritten.
  Report it with the path and **do not** `record migrated`; see step 10 for why that
  particular failure is the unrecoverable one.
- **`pluginDataAvailable: false`** → you omitted `--plugin-data`. Not a degradation:
  re-run the call correctly. Stopping here reports a platform limit that isn't there and
  leaves 30-odd facts stranded for good. There is no second case to distinguish it from —
  the field cannot be false for any other reason.

## Reporting back

Short. How many facts moved, the scope they went to, anything left behind and why,
and where the backup is. Skip the procedure — nobody needs the dedup searches
narrated. Where this followed work the user actually asked for, close with a short
summary of that work, last, per `memory-capture`.

## References

- `memory-capture` — write discipline: tier gate (rule 2), `last_n_episodes=0`
  (rule 3), tool discovery (rule 4), queued-≠-confirmed (rule 6).
- `memory-search` — rung 1, used here for both dedup and verification.
- `conflict-adjudication` — for a local fact that _contradicts_ something already in
  the graph (step 6). It recommends supersede / coexist / escalate and never rewrites
  memory itself; the approved correction is written back through `memory-capture`.
