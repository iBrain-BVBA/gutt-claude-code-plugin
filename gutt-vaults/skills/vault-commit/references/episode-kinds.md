# Episode kinds

The vault schema (`get_schema` on the group) extracts nodes and attributes **only from the
episode text**. Each template below writes out everything its nodes need.

Names keep nodes apart: memory merges nodes whose names match ignoring case or are nearly the
same string, whatever their type. Use the name formats exactly.

## Finding

Episode name: `Finding: <claimant> (<YYYY-MM-DD>): <headline ≤ 60 chars>`

```
Finding <claimant> (<YYYY-MM-DD>): <headline> is current: the owner approved its entry into the
<vault name> vault on <decision date>.

Claim: <claim as the source states it, with numbers>
Claimant: <Organization>, a <company|public_body|standards_body|research_group|investor|other>.
Quote: "<verbatim passage>"            (omit when none)
Why it matters: <one sentence>
Beat: <beat name>. Significance: <1–5>.
About: <AgentRole(s) with business function>, <Product(s) and maker>, <Concept(s) with type>.

Sources (evidence grade: <primary_source|independent_study|customer_case|vendor_claim|anecdotal>):
- <publisher domain> (<published YYYY-MM-DD>): <title>. <url>. Source class: <class>.
  Published by <Organization>. Retrieved <YYYY-MM-DD>.

Recorded by vault-librarian. Effective charter: <episode ids>.
```

An edited approval says "approved with edits" and gives the edited claim only.

## Verdict

Episode name: `Verdict: <Finding name>` (override: `Verdict: override <Finding name>`)

```
Verdict (<human|agent> <approved|rejected|edited>[ conflict resolution| re-check result],
<YYYY-MM-DD>): <Finding name>

What was decided: <a new finding entering the vault | a resolution of the conflict between
<A> and <B> | the result of re-checking <Finding> | a Role Card change for <role>>.
Decision: <approved|rejected|edited>. Decided by: <human|agent>.
Proposal type: <finding|conflict|reverify|card_update>.   (card_update isn't in the vault
schema's proposal_type yet: extraction drops it and logs vault_attribute_dropped; the reviewer
counts card-diff precedents from the episode text)
Claim type: <launch|pricing|outcome|benchmark|risk|regulation|practice|other>.
Source domain: <domain>. Source class: <primary|vendor|customer|independent|press|community>.
Beat: <name>. Significance: <1–5>.
Card section: <section>.                                   (card_update only)
Reason: <the decider's own reason: for a human, the rejection reason label and the note,
"Stale: superseded by the March price list"; omit when a human gave neither>.
Called blind.                          (only when the owner decided with the prediction hidden)
Reviewer prediction: <approve|reject|edit>, confidence <x>, stage <s>
(a prediction, not a decision).                                  (omit when none)
Effect on the Finding: <current | rejected | retired, replaced by <name> | none>.
Recorded by <vault-librarian|vault-reviewer>.
```

Rules:

- A **finding** verdict: approved/edited → "Effect: current"; rejected → "Effect: rejected",
  except a rejected duplicate of a Finding already in the vault → "Effect: none".
- A **conflict** verdict names the first Finding the conflict names; approved when settled
  (say which won or that both stand: the loser is "retired"). A conflict left open on the
  Console isn't decided and gets no Verdict until it is; an older row rejected with
  resolution `open` is written as rejected, left open ("Effect: none").
- A **re-check** verdict says what was found: still holds → "Effect: current"; no longer
  holds → "retired"; rejected re-check → "Effect: none".
- An **override** starts "Override (human <decision>, <date>): <Finding name>" and adds:
  "Reverses: Verdict (agent <decision>, <date of the original call>): <Finding name>.
  Why: <the owner's reason label and note>." Tagged vault-reviewer.

**Rejection reasons.** `human.reason` is one key from the Console's reason list
(`../../vault-curate/references/console-data.md` §Review on the page). Write its label, not
the key, so the episode reads as plain text and `vault-brief` can group rejections by it. A
Verdict also says "Called blind." when `human.blind` is true (the owner decided before the
page showed the reviewer's prediction).

## Conflict

Episode name: `Conflict: <A Finding name> vs <B Finding name>`

```
Conflict between Finding <A> and Finding <B>: <A> disagrees with <B>.
<A>: <claim>, sources <url (retrieved date)>.
<B>: <claim>, sources <url (retrieved date)>.
Resolution: <A won and <B> is retired | B won and <A> is retired | both stand | open>.
Decided by <human|agent> on <date>. Recorded by vault-librarian.
```

Both Findings must be named in the same episode, or the CONTRADICTS edge won't form.

## RoleCard

Episode name: `RoleCard: <role> — <section> <YYYY-MM-DD>`

```
Role Card change for the AgentRole <role> (business function <function>), section <section>.
Change: <diff>. Rests on Finding <name>.
Maturity: <unchanged | now Emerging | Proven in pilots | Proven at scale>.
Approved by the owner on <date>. Recorded by vault-librarian.
```

## Config

Episode name: `Config: <vault name> v<n>`, one per `config_changes` row (`n` = its version).

```
Config v<n> of the <vault name> vault, saved on the Console's Settings tab on <YYYY-MM-DD>
by the owner or an Editor. It applies from the next curate run.
Changed: <key> <old> → <new>; <key> <old> → <new>.   ("unset" when a side had no saved value)
Class ceilings: <class> <old> → <new>.               (omit when unchanged)
Settings that differ from the defaults after this save: <key> <value>; … (or "none").
Recorded by vault-charter.
```

The keys are those in `../../vault-curate/references/vault-config.md`. A Calibration or Run
that sees a class move because of a threshold names this episode.

## Steering

Template and header lines: `../../vault-steer/references/charter-template.md`.

## Brief

Episode name: `Brief: <YYYY-Www>`, one per brief the owner approved on the Console.

```
Brief for week <YYYY-Www> of the <vault name> vault, approved by the owner on <YYYY-MM-DD>.
Headline: <the brief's one-sentence headline>.
Findings it reports: <Finding names, each as written in its Finding episode>.
Conflicts it reports: <Conflict names, or none>.
Brief page: <URL, or "not published yet">.

<the approved brief body, as Markdown>

Recorded by vault-brief.
```

## Run

`Run: vault-commit <YYYY-MM-DD HH:MM>`, the run's start time in the vault's time zone from
`date` (SKILL.md step 1), never the schedule slot: counts by kind, verdicts by decider, skipped
rows with reasons, and the Brief page result. Tagged vault-librarian.
