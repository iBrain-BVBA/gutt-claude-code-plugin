# Reviewing held drafts

A gated memory is stored only once the user has seen its exact text and said yes
(`SKILL.md` rules 2 and 8). With memory review turned on, the server enforces that
itself: a write of a review-tier type comes back **held** as a draft instead of stored,
and stays held until it is settled. This file is how you settle it — on the surface the
host actually draws. Tool contracts are in `tools.md` §"Memory review".

## What a held write looks like

Every write tool — `add_memory`, `add_memory_to_<alias>`, `add_personal_memory` — answers
a review-tier name with a message instead of a stored episode:

> Not stored yet: '<name>' is a <Type>, which needs the user's review. Batch
> `<batch_id>`, draft `<draft_id>`. …

That reply is neither an error nor a write. Four things follow from it:

- **Nothing was stored.** Don't report it as captured — it is waiting on review until it
  is settled.
- **The server decides what is review-tier, not this skill.** Lesson, Decision and
  WorkingAgreement by default, but a deployment can review more. A held reply on a type
  `SKILL.md` calls auto-write means this deployment reviews it: follow the reply.
- **Personal scope is held too.** A Lesson the user alone will read still needs their
  sign-off on the text.
- **It expires.** Drafts are dropped after 24 hours. Settle them in this session; a draft
  left for later is lost without a trace.

The reply goes on to say to show the review card _if `draft_memories_ui` is available_.
Don't take that test literally — the next section is why.

## Card host or text host — decided by the host, not the tool list

There are two review surfaces:

- **Card hosts** draw the Memory Review card, an MCP Apps UI: desktop and web chat
  clients, Cowork among them. The user approves, edits, rejects, and submits there.
- **Text hosts** draw nothing: a terminal or IDE agent, such as Claude Code. Review
  happens in the conversation, and you settle each draft with `confirm_memory` or
  `discard_draft`.

**A listed card tool is not evidence that a card renders.** The server lists
`draft_memories_ui` and the other `_ui` tools to clients that declared no UI support and
to clients whose support it could not read, so a text host routinely has them in its tool
list. Calling `draft_memories_ui` there succeeds, draws nothing, and leaves the user
unable to see what they are being asked to approve; the drafts sit until they expire.

So decide from what you know about the host you are running in. **When you can't tell,
take the text path.** It works on every host, while the card path strands drafts on any
host that cannot draw the card.

**One surface per batch.** A batch shown in a card is reviewed in the card — don't also
ask about it in chat, or the user is answering the same question in two places.

**Ask at a pause, not mid-task.** Collect the drafts and review them once the work the
turn was for is done. A review question in the middle of a task costs the user their
thread for the sake of something that can wait a few minutes.

## Text host: review in chat with the question tool

1. **Stage the drafts.** If `draft_memories_ui` is in your tool list, stage the batch
   with it even here: one call drafts several, runs the checks, and returns each draft's
   id and check results — in Claude Code as the card's JSON state, under
   `state.drafts`. Related episodes come back for the first draft only there, so link
   context from your own dedup pass (`SKILL.md` rule 7), not from this reply. Its reply says nothing is
   stored "until the reviewer submits the batch in the review card" — on a text host that
   line does not apply, because you settle each draft yourself. If it is not listed,
   write each gated episode with the ordinary write tool; the server holds it and its
   reply carries the draft id. Either way you end up holding draft ids.

   Keep a text-host batch to **four** drafts. The question tool takes four questions per
   call, and each draft gets its own.

2. **Fix what fails before you ask.** A draft with a failed check — an empty name or
   body, over the size limit, a detected secret — cannot be confirmed, so asking about it
   wastes the user's yes. Revise it and stage it again (step 5), or drop it and say why.
   Warnings don't block; a personal-data warning is worth naming in that draft's question.

3. **Ask, one question per draft.** In Claude Code the tool is `AskUserQuestion`:
   - `header` — the type: `Lesson`, `Decision`, `Agreement`. It is capped at twelve
     characters, so shorten rather than truncate mid-word.
   - `question` — what will be stored and where:
     `Store "<name>" in <group display name>?`. The group matters because a write to
     the wrong one cannot be moved from here.
   - `options` — `Store` and `Discard`, single-select. Give `Store` a `preview` holding
     the draft's exact name and Markdown body, so the text the user approves is the text
     that gets stored and not your paraphrase of it.
   - The user can always answer in their own words instead. Treat that as an edit
     (step 5), not as either option.

   With no question tool, show each draft's name and body in the reply, ask which to
   store, and wait for the answer. Silence is never a yes.

4. **Settle every draft the user answered.**
   - `Store` → `confirm_memory(draft_id=…)`. Pass `name` only if the user renamed it.
   - `Discard` → `discard_draft(draft_id=…)`.
   - Dismissed or unanswered → leave it unsettled and say it expires in 24 hours. Don't
     confirm it, and don't discard it either: a discard cannot be undone, and the user
     may still want it.

   There is no submit step on this path. Each settle is final for its draft, and the
   last one closes the batch; `submit_memory_batch_ui` belongs to the card.

5. **An edit is a new draft.** `confirm_memory` can rename a draft and replace its
   context; it cannot change the body. To change the text, call
   `update_memory_draft_ui(draft_id=…, episode_body=…)` if it is listed — it re-runs the
   checks — or else `discard_draft` the old one and stage the revised text. Then ask
   again: the earlier answer was about the earlier text.

6. **Report.** `confirm_memory` names the stored episode id. Say what was stored and what
   was discarded, in a line or two. Stored still means queued (`SKILL.md` rule 6), so
   don't search to check it.

## Card host: show the card, then let the user drive it

1. **Show the batch.** `draft_memories_ui(episodes=[…])` with one to five drafts. For a
   draft a write tool held, `draft_memories_ui(batch_id=…)` reopens its batch in the card.
2. **Hand it over in one line.** Tell the user the drafts are in the review card to
   approve, edit or reject, and then submit. Don't restate them in chat — the card shows
   them, rendered.
3. **Don't decide for the user.** Only the reviewer approves a review-tier draft, and only
   in the card. Your `approve` through `update_memory_draft_ui` or
   `decide_remaining_drafts_ui` leaves a review-tier draft undecided, and
   `submit_memory_batch_ui` refuses while any draft is undecided. That is the design
   working, not an obstacle to route around.
4. **Read the outcome when you need it.** A card submit replies to the card, not to you.
   When you need the stored ids — to cite them in a later `previous_episodes` — call
   `update_memory_draft_ui(draft_id=…)` with nothing else; it returns the draft and, once
   the batch is submitted, its receipt.
5. **If the user answers in chat instead** — "store the first two" — settle those drafts
   with `confirm_memory` / `discard_draft` as on the text path. A decision already made in
   the card stands: a confirm or discard that contradicts it is refused.

## Replies you will see on the text path

| reply                                                             | means                                           | do                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| `Fix the failed checks before confirming`                         | a check failed — size, secret, empty field      | revise (step 5), ask again                           |
| `The reviewer approved <id> in the review card; that stands`      | the card already decided (or `rejected`)        | report the card's decision; don't retry              |
| `<id> was already settled: stored` (or `not stored`)              | the opposite settle already happened            | report it                                            |
| `… Nothing was changed.`                                          | a retry of a settle that already succeeded      | nothing to do                                        |
| `This batch was already submitted`                                | the batch was submitted in a card               | read the receipt (card host step 4)                  |
| `Not stored: the text of … is already stored in another group`    | a duplicate of an episode elsewhere             | report it; don't redraft                             |
| `… was already stored as episode <id>`                            | a duplicate in this group                       | cite that id                                         |
| `Not usable as context: …`                                        | a `previous_episodes` id is bad or out of group | drop that id and confirm again                       |
| `Access denied: you cannot write to <group_id>`                   | the user lost access to the draft's group       | ask the user: move it (step 5's tool) or discard it  |
| `Unknown or expired draft <id>` / `Unknown or expired batch <id>` | past 24 hours, or never this user's             | redraft only if the user still wants it — and re-ask |
