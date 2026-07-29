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
   before the first write. This skill is often reached from a session-start offer
   the user has not yet responded to — an offer is not an answer.
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
6. **The store is the user's, not the team's.** Default every fact to **personal**
   scope. Publishing someone's working notes to the org group because it was the
   easier default is the one failure here that cannot be undone by restoring a file.

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

Run `status` first — it reports the store path, the fact files, and any decision
already recorded:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/migrate-memory/scripts/store-cli.cjs" status
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
   - _Scope?_ — personal (default) / org group / decide per note

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
   node "$CLAUDE_PLUGIN_ROOT/skills/migrate-memory/scripts/store-cli.cjs" \
     verified "some-fact.md=<episode-id-from-the-search>"
   ```

   Only pass a file whose episode a search actually returned. This is the gate on
   deletion, so guessing here defeats the entire safety property.

9. **Delete.** `store-cli.cjs delete`. It removes only verified facts and, once the
   store holds none, rewrites `MEMORY.md` with the standing note that gutt is the
   store of record and local memory is the fallback for when MCP is unreachable.
   Anything still listed in `kept` did not land — say which, and leave them.
10. **Record the decision.** `record migrated` — but only if `kept` is empty. With
    facts left behind the job is unfinished, so leave the decision unset and the
    offer returns.

## Mapping `metadata.type` onto gutt tiers

The types do not line up with the trust tiers, and the mismatch lands on the gated
side — so this is stated rather than left to judgement:

| `metadata.type` | gutt type                                                                 | tier                         |
| --------------- | ------------------------------------------------------------------------- | ---------------------------- |
| `feedback`      | **Lesson** — a corrective takeaway                                        | gated                        |
| `project`       | **Insight**, or **Decision** when it records a choice _and_ its rationale | Insight auto, Decision gated |
| `reference`     | **Insight** — a pointer to a resource                                     | auto                         |
| `user`          | **Insight** about the user's preferences — personal scope                 | auto                         |

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

## Scope: personal by default

`add_personal_memory` writes to the user's private scope;
`add_memory_to_<group>` publishes to the team. A real store mixes both kinds —
working-style notes about how the agent should behave sit next to project facts a
team would want.

Default to **personal**, and treat these as personal regardless of what the user
picked for the batch:

- anything `metadata.type: user` — preference data about one person;
- anything `feedback` phrased as how the agent should behave with this user.

Offer **org** for `project` and `reference` facts, which are the ones a teammate
could act on. If the user picks "decide per note", ask once per batch, not once per
file.

## Degradation

- **No write tool / MCP unreachable** → nothing written, nothing deleted, one line
  saying so, decision left unset.
- **`backup` returns `ok: false`** → stop. `delete` is a no-op without a backup, so
  continuing would write to the graph while leaving the local copy in place, which is
  the one state that later looks like a completed migration but is not.
- **Some episodes never confirmed** → keep those files, delete the rest, report the
  gap by name, leave the decision unset.
- **`${CLAUDE_PLUGIN_DATA}` unset** (local `--plugin-dir` dev) → `status` reports
  `pluginDataAvailable: false`. No decision can be persisted and no backup taken, so
  do not migrate; say that plugin state is unavailable.

## Reporting back

Short. How many facts moved, the scope they went to, anything left behind and why,
and where the backup is. Skip the procedure — nobody needs the dedup searches
narrated. If this interrupted work the user actually asked for, close with a brief
TL;DR of that work, last, per `memory-capture`.

## References

- `memory-capture` — write discipline: tier gate (rule 2), `last_n_episodes=0`
  (rule 3), tool discovery (rule 4), queued-≠-confirmed (rule 6).
- `memory-search` — rung 1, used here for both dedup and verification.
- `conflict-adjudication` — for a local fact that _contradicts_ something already in
  the graph (step 6). It recommends supersede / coexist / escalate and never rewrites
  memory itself; the approved correction is written back through `memory-capture`.
- `shared/builtin-memory.cjs` — how the store is located and what counts as a fact.
- `shared/builtin-memory-store.cjs` — backup, verification record, and the deletion
  gate; also holds the standing note left in `MEMORY.md`.
