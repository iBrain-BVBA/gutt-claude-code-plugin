# Charter and steering templates

Every Charter and Steering episode starts with these header lines, which
`charter-assembly.md` parses:

```
applies_to: scope | beat:<name> | sources | review | brief | roles | agent:<name>
date: YYYY-MM-DD
supersedes: <episode name>        (optional)
target_agent: <name>              (optional; steering aimed at one agent)
```

## Charter: scope

Name: `Charter: <vault name> — Scope`

```
applies_to: scope
date: <date>

Audience: <who reads the vault>.
Question the vault answers: <one sentence>.
In scope: <list>. Out of scope: <list>.
Framing: <e.g. agents as roles on a team, never worker replacement; headcount claims only
when a cited source makes them, attributed to it>.
```

## Charter: beat (one per beat)

Name: `Charter: <vault name> — Beat: <name>`

```
applies_to: beat:<name>
date: <date>

Look for: <what>. Window: <n> days. Freshness: <n> days.
Primary-source types: <list>. Max items per run: <n> (optional; without it the beat uses the
Console's run.scout_max_items, which also caps it).
```

## Charter: source rules

Name: `Charter: <vault name> — Source rules`

```
applies_to: sources
date: <date>

Allow (prefer): <domains>. Deny: <domains>.
Counts as primary: <definition>. Freshness windows by beat: <list>.
```

## Charter: review policy

Name: `Charter: <vault name> — Review policy`

```
applies_to: review
date: <date>

Stage ceiling: see Settings.
Always escalate: conflict rows; significance 5; card diffs that change maturity or add the
first independent evidence; <extra classes>.
```

The review policy is written policy only. Its numbers (stage ceiling, precedents needed,
agreement threshold, override window, audit sample) are Console Settings
(`../../vault-curate/references/vault-config.md`); a review-policy charter never states one.

## Charter: role taxonomy (vaults that track roles)

Name: `Charter: <vault name> — Role taxonomy`

```
applies_to: roles
date: <date>

- <Role as a job title> (business function: <sales|support|finance|ops|hr|legal|it|engineering|…>)
```

Companion vaults read this episode to tag `affects_roles`.

## Steering

Name: `Steering: <YYYY-MM-DD> — <instruction in a few words>`

```
applies_to: <…>
date: <date>
supersedes: <episode name>        (when it replaces one)

Instruction: <one instruction, as the owner gave it>.
Source: <owner via /gutt-vaults:vault-steer | owner on the Console (row <id>) | accepted proposal from
rejection pattern <Insight name>>.
```
