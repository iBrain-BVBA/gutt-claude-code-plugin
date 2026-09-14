# bug-investigation — findings

The suite asks whether the skill text turns a bug report into a triage somebody can
check. `V0-shipped` is the skill body read from the working tree; `V1-none` is the same
task, same tool surface, no skill — which is the interesting control here, because an
unaided model produces a confident-looking severity, a suspected area and a cause
without difficulty. What it does not produce is the part that makes any of them
checkable.

Judge model: `claude-haiku-4-5-20251001` (FAST_MODEL), 3 trials per (variant, case).
Raw files are keyed on suite-trials-variants, so **rounds at the same depth overwrite
each other's raw records** — the tables below are the surviving record of rounds 1–6.

## Round 1 — first cut

```
variant       chars    all  confident  errors
V0-shipped    10196   50%        67%       0     missing:group-scope 5/12 · banned:cause-asserted 1/12
V1-none           0    0%         0%       0     signature-search 6/12 · group-scope 6/12 · severity-rubric 4/12
                                                 names-the-gap 3/12 · refutable-hypothesis 3/12 · absence-named 3/12
                                                 scope-of-absence 3/12 · cites-a-date 2/12

per case (V0 / V1): key-triage 1/3 · pasted-degrade~ 0/3 · resemblance-not-cause 2/3 ·
novel-signature 3/3   (V1: 0/3 on all four)
```

Both V0 failure modes turned out to be the suite's, not the skill's, and reading the
raws is what separated them.

**`missing:group-scope` — the corpus was demanding what the skill forbids.** The plan
cases never named an org group anywhere in the session, and rule 7 says never to guess
one. So an ungrouped read was the compliant answer and the check was scoring compliance
as failure. Confirmed rather than assumed: the failing replies contained no mention of a
group or a scope at all — the model had no name available, not a rule it ignored. **Fixed
in the corpus:** the tool surface now carries the line a real session would supply —
earlier reads returned records carrying `group_id "org_main"`.

**`banned:cause-asserted` — the pattern could not tell whose cause was being stated.**
The flagged reply said: "Helios incident (org:Incident:Helios-pool-exhaustion,
2026-04-18) had identical PoolTimeout signature, caused by missing index holding
connections for minutes." That is the earlier incident's cause, reported in the column
the skill's own output template asks for. The pattern matched `caused by … missing index`
wherever it appeared. **Fixed in the scorer:** the ban now requires the claim to attach to
_this_ bug — `GP-1042`, "this bug", "the checkout failure" — so reporting history stays
legal and diagnosing from a resemblance does not.

## Round 2 — after both fixes

```
variant       chars    all  confident  errors
V0-shipped    10196   83%        78%       0     missing:signature-search 1/12 · unmarked:Borealis 1/12
V1-none           0    0%         0%       0     signature-search 6/12 · group-scope 6/12 · severity-rubric 4/12
                                                 names-the-gap 3/12 · cites-a-date 3/12 · refutable-hypothesis 3/12
                                                 absence-named 3/12 · scope-of-absence 3/12

per case (V0 / V1): key-triage 2/3 · pasted-degrade~ 3/3 · resemblance-not-cause 3/3 ·
novel-signature 2/3   (V1: 0/3 on all four)
```

`group-scope` and `cause-asserted` both went to zero for V0, which is what a corpus fix
looks like when the diagnosis was right. V1 lost `group-scope` 6/12 even with the group
named in the session — the name being available changes nothing without the rule that
says to use it.

## Round 3 — with the distractor rule relaxed

The distractor mechanism was changed (all three new suites) from "every occurrence of the
token needs a marker within reach" to "at least one does". `suite.py` carries the reason
and the hole it accepts.

```
variant       chars    all  confident  errors
V0-shipped    10196   75%        89%       0     missing:group-scope 2/12 · signature-search 1/12 · names-the-gap 1/12
V1-none           0    0%         0%       0     group-scope 6/12 · severity-rubric 5/12 · names-the-gap 3/12
                                                 cites-a-date 3/12 · refutable-hypothesis 3/12 · absence-named 3/12
                                                 scope-of-absence 3/12 · signature-search 2/12 · unmarked:Borealis 1/12

per case (V0 / V1): key-triage 2/3 · pasted-degrade~ 1/3 · resemblance-not-cause 3/3 ·
novel-signature 3/3   (V1: 0/3 on all four)
```

`all` moved 83% → 75% while `confident` moved 78% → 89%. Both are inside the trial noise
at three trials, and the movement is one case: `pasted-degrade`, which is the case whose
label is held least firmly — a model may reasonably open by asking for the ticket key
rather than working the pasted text. Treat 75–83% as one measurement, not two.

## Rounds 4 and 5 — against the text that ships

Rounds 1–3 measured the skill body before it was run through the repo's formatter, which
reflowed it. Round 4 re-measured the formatted text, and round 5 repeated it after scorer
fixes made in the two sibling suites (nothing in this suite's scoring changed between them).

```
round 4    V0-shipped 10200  83% all  78% confident   group-scope 1/12 · unmarked:Borealis 1/12
           V1-none        0   0%       0%              group-scope 6/12 · severity-rubric 6/12 · +6 more
round 5    V0-shipped 10200  75% all  78% confident   group-scope 1/12 · signature-search 1/12 · uuid-leak 1/12
           V1-none        0   0%       0%              signature-search 6/12 · severity-rubric 6/12 · group-scope 5/12 · +7 more

per case, round 5 (V0 / V1): key-triage 2/3 · pasted-degrade~ 2/3 · resemblance-not-cause 2/3 ·
novel-signature 3/3   (V1: 0/3 on all four)
```

**Read rounds 2–5 as one measurement: 75–83% for V0, 0% for V1.** Four rounds at three
trials put V0 in a nine-point band with no rule accounting for more than one failure in
twelve, and V1 at zero every time. The residual V0 failures move between rounds — a
signature search phrased past the pattern, a degradation line omitted, one reply pasting a
raw UUID into the brief — which is what a noise floor looks like rather than a defect with
a location.

## Round 6 — after the 3.0.4 follow-up edits

The pre-PR follow-up reworded rule 1 (the permitted comment is one the user explicitly
asked for), cut the proactive "Offering the comment" section, extended rule 7's output
filter to asked-for comments, and fixed the advertised `fetch_lessons_learned` signature
to carry `group_ids` — it had dropped the one parameter the suite scores (found by
Copilot review).

```
variant       chars    all  confident  errors
V0-shipped     9890  100%       100%       0
V1-none           0    0%         0%       0

per case (V0 / V1): key-triage 3/3 · pasted-degrade~ 3/3 · resemblance-not-cause 3/3 ·
novel-signature 3/3   (V1: 0/3 on all four)
```

First clean sweep for this suite — the cuts cost nothing the checks can see, and the
signature fix did not move the group-scope behaviour, which V0 carried before and after.

## Round 7 — the identifier lane, on the two new cases only

`identifier-lane` and `prose-control` were added after round 6; every per-case line above
is four cases wide because those rounds ran before the pair existed. This round scores
only the pair, so its `all` column is not comparable with rounds 1–6.

They are one measurement rather than two. The keyed case scores the bare-key call _and_
the phrasings that have to keep running beside it, because the lane is an addition to the
pass and a version that replaced the phrasings would pass half of it. The control is
key-triage's report with its key taken off and nothing else changed — not the keyed case's
— so a lane that leaked into key-free asks shows up as the control losing checks it used
to win.

```
variant       chars    all  confident  errors
V0-shipped    10473   50%        50%       0     missing:group-scope 1/6 · bare-key-call 1/6 · signature-search 1/6
V1-none           0    0%         0%       0     signature-search 4/6 · bare-key-call 3/6 · group-scope 3/6

per case (V0 / V1): identifier-lane 1/3 · prose-control 2/3   (V1: 0/3 on both)
```

**The lane check alone is 2/3 for V0 and 0/3 for V1.** The case-level 1/3 is lower than
that because the case deliberately requires all four calls, and one trial that did issue
the bare key lost the case on `group-scope` — the residual that rounds 3–5 already show as
V0's most common single failure, and nothing to do with identifiers.

**As first scored the lane check read 0/3, and that was the pattern's fault.** A model
asked for concrete parameter values types a plan three ways — `query="X"` inside a call,
`query: "X"` in a block under a heading that names the tool, and `- **query**: "X"` as a
bullet — and the first version of `bare-key-call` recognised only the first. One trial had
planned `search_memory_facts(query: "GP-1088", …)` and scored as never having planned it.
**Fixed in the corpus:** the pattern now takes the tool name, then either a `query` marker
or an open paren, then the delimited key — the delimiter still has to close immediately
after the key, which is what keeps "the bare key and nothing else" enforced. The numbers
above are the re-score of the same replies through the fixed instrument.

**The one real miss is a real miss.** V0 trial 2 read the ticket with `getJiraIssue` and
went straight to four phrased searches with no bare-key call on either memory surface. So
the rule lands twice in three trials at three trials — a signal, not yet a rate.

**V1 planned no bare-key memory call in any trial.** All three used the key only as
`getJiraIssue(issueIdOrKey="GP-1088")`, which is the ticket read, not the lookup. The
behaviour does not appear without the skill text, which is the comparison the pair exists
to make.

**Left unfixed, and visible here: `signature-search` breaks on a parenthesis.** The
pattern is `search_memory_(nodes|facts)[^)]{0,240}<term>`, and `[^)]` stops at the first
`)` — so a reply writing ``search_memory_facts`** (signature-focused)`` above
`query: "PoolTimeout acquire timed out 30s …"` scores as never having searched the
signature. That is one of the three V0/V1 misses in this round's `prose-control` column,
and the same pattern is what `key-triage` and `pasted-degrade` have used since round 1,
so some part of the historical `missing:signature-search` count is this and not the model.
Fixing it re-baselines three cases at once, which is why it was left for a decision of its
own rather than folded into this round.

## Round 8 — `identifier-lane` at eight trials

Round 7 left the lane at 2/3, which sizes nothing. This round runs the keyed case alone at
eight trials per variant to find out whether the miss is one in three or one in ten.

```
variant       chars    all  confident  errors
V0-shipped    10473   50%        50%       0     missing:bare-key-call 3/8 · signature-search 1/8 · symptom-search 1/8 · group-scope 1/8
V1-none           0    0%         0%       0     missing:bare-key-call 8/8 · group-scope 4/8 · signature-search 1/8 · symptom-search 1/8

per case (V0 / V1): identifier-lane 4/8   (V1: 0/8)
```

**The bare-key call fires in 5 of 8 V0 trials and 0 of 8 V1 trials.** With round 7 that is
7 of 11 with the skill and 0 of 11 without. The skill is doing something no model does
unprompted, and it is doing it about two times in three.

**All three misses are real, and two of them share a shape.** Trials 0 and 4 spend the key
on the ticket read — `getJiraIssue(…, "GP-1088")` — and then run only phrased memory
queries; the key never becomes a memory query at all. Trial 2 never uses the key anywhere,
having pinned the failure from the pasted text. Nothing here is a pattern artefact: the
widened `bare-key-call` matches all three of the syntaxes these replies use, and it found
the call in the five trials that made one.

**Trial 2 is also the sharpest evidence yet for the `[^)]` fragility left unfixed above.**
It searched the signature (`query: "TemplateRenderError locale fallback exhausted"`) and
the symptom (`query: "invoice PDF blank rendering"`), and scored as having done neither —
because it wrote the tool name as `search_memory_nodes()` with empty parens, so `[^)]`
stops one character in. Two rounds, three manifestations: a parenthesised aside, an empty
parameter list, and a heading. The `bare-key-call` pattern was believed not to use `[^)]`; it
does (`[^)]{0,80}?`), and round 9 records the first miss that caused. The three sibling
checks are affected in every case that carries them.

## Round 9 — the instrument changes: both bodies, and the pair scored as a pair

Two things changed before this round, and they make every table above a different sample
from every table below. **The variant text.** Rounds 1–8 loaded the bug-investigation body
alone, so any check that turned on a memory-search rule — the identifier lane is the first —
was scoring the four-line pointer in bug-investigation, not the rule. From here V0 is the
bug-investigation body and the memory-search body together, which is what a session running
the skill has in front of it: the skill delegates the whole search ladder to memory-search,
and both shipped agents preload the pair. **The lane check.** Rule 7 now names both search
tools and says the identifier is the entire query of each; rounds 7 and 8 had recorded
replies that sent it to one tool only, and `(?:nodes|facts)` scored those as complete.
`bare-key-call` is now `bare-key-nodes` and `bare-key-facts`, and the keyed case owes five
checks.

The memory-search text under measurement is the rewrite that followed the PR #99 review:
rule 7 restated as a pair of calls with no `agent_id`, `center_node_id` or `center_on_user`;
a rung-1 lead that mirrors step 1's own "run both calls" shape; rule 3 carrying the two
result cases on that lane — an empty pair is its own finding, a pair with `has_more` is
paged, because a rephrase leaves the exact route. V0 measured 18,169 chars, `3738ec39fdea`.
Eight trials, all six cases, 96 calls.

```
variant       chars    all  confident  errors
V0-shipped    18169   65%        75%       0     missing:group-scope 16/48 · signature-search 2/48 · names-the-gap 2/48 · bare-key-nodes 1/48 · bare-key-facts 1/48 · symptom-search 1/48
V1-none           0    0%         0%       0     missing:group-scope 23/48 · signature-search 22/48 · severity-rubric 11/48 · bare-key-nodes 8/48 · bare-key-facts 8/48 · names-the-gap 8/48 · refutable-hypothesis 8/48 · scope-of-absence 8/48 · absence-named 7/48 · cites-a-date 5/48 · symptom-search 4/48 · severity-label 1/48

per case (V0 / V1): key-triage 6/8 · pasted-degrade 1/8 · identifier-lane 1/8 · prose-control 7/8 ·
                    resemblance-not-cause 8/8 · novel-signature 8/8   (V1: 0/8 on all six)
```

**The pair fires as a pair: 7 of 8 as scored, 8 of 8 in fact.** Seven trials planned
`search_memory_nodes(query="GP-1088", …)` and `search_memory_facts(query="GP-1088", …)`
both; none planned one without the other. The eighth planned both as well and lost them to
the instrument: it wrote the tool name, then `(identifier lane — exact key)`, then
`query: "GP-1088"` — and `[^)]` stops at the aside. V1 planned no bare call in any of its
eight trials.

**What the lane check no longer hides: `group_ids` went missing in 16 of 48 V0 trials.**
Six of eight on identifier-lane, seven of eight on pasted-degrade, two on key-triage, one on
prose-control — and it is what sank the two 1/8 cases, not the lane. Round 8, with
bug-investigation alone, lost `group-scope` once in eight. Every failing trial wrote its
calls as `search_memory_nodes(query="…", max_nodes=10)`, which is memory-search step 1's
example signature copied verbatim; every passing trial wrote the same shape with
`group_ids=["org_main"]` appended. The memory-search body did not mention `group_ids`
anywhere, so once it entered the prompt the one line in bug-investigation that asks for an
explicit org scope was competing with a concrete signature, and lost. Whether the rewrite's
"no `agent_id`, `center_node_id` or `center_on_user`" clause added to that is not separable
here — a control arm with the pre-rewrite memory-search text would settle it — but the
mechanism is visible without it and fixes the same way either way: step 1's signature now
reads `search_memory_nodes(query, group_ids, max_nodes≈10)`, one token per call. Round 10
measures that.

**The `[^)]` spans are gone, and round 9 was re-scored under their replacement.** The
sibling checks had been left on `[^)]` since round 1 because fixing them re-baselined three
cases; this round re-baselined all six anyway. A term is now bound to the nearest tool call
before it — `(?:(?!<tool name>).){0,240}?` — so the span crosses a parenthesised aside, an
empty parameter list or a heading, and never another tool name, which is the false positive
the old stop was guarding against. Re-scored, the same 96 replies read: V0 67% / 78%
confident, identifier-lane 2/8, `bare-key-nodes` and `bare-key-facts` 0 missing, and the only
V0 labels left are `group-scope` 16/48 and `names-the-gap` 2/48. Two verdicts moved, both
in the direction the artefact predicted; V1 did not move at all.

## Round 10 — the same instrument, with `group_ids` in step 1's signature

One token changed between rounds 9 and 10: memory-search's step 1 reads
`search_memory_nodes(query, group_ids, max_nodes≈10)` and its facts twin, where round 9's
text had `(query, max_nodes≈10)`. Nothing else in either body moved. V0 measured 18,194
chars, `5681149bc1d4`. Eight trials, all six cases, 96 calls, scored under the nearest-call
span from round 9's re-score.

```
variant       chars    all  confident  errors
V0-shipped    18194   98%        98%       0     missing:absence-named 1/48
V1-none           0    0%         0%       0     missing:signature-search 23/48 · group-scope 23/48 · severity-rubric 10/48 · bare-key-nodes 8/48 · bare-key-facts 8/48 · names-the-gap 8/48 · cites-a-date 8/48 · refutable-hypothesis 8/48 · scope-of-absence 8/48 · absence-named 6/48 · area-history 1/48 · symptom-search 1/48

per case (V0 / V1): key-triage 8/8 · pasted-degrade 8/8 · identifier-lane 8/8 · prose-control 8/8 ·
                    resemblance-not-cause 8/8 · novel-signature 7/8   (V1: 0/8 on all six)
```

**`group-scope` went from 16 of 48 to 0 of 48 on one token.** The mechanism round 9 named
is confirmed the cheap way: the models copy the example signature, so the example signature
is where the parameter has to be. The four plan cases are 32 of 32, which they had never
been at eight trials, and pasted-degrade's two `names-the-gap` misses did not recur.

**The pair is 8 of 8, on both tools, in every keyed trial — and 0 of 8 without the skill.**
With rounds 7 and 8 this is the third round in which V1 planned no bare identifier query
at all; the behaviour does not appear unprompted on this model.

**The one V0 miss is the instrument again, on a check this ticket did not touch.** The
novel-signature reply wrote "No other similar failures found" and "No incident or lesson
history found" — the absence named twice, with its scope — and `absence-named` accepts `no`
only when `similar`, `matching`, `comparable`, `prior` or `past` follows it directly. A
widening is a checker change with its own re-score, and is left for a round of its own.

**What this round says about the 7 of 11.** Rounds 7 and 8 measured the lane through a
four-line pointer in bug-investigation, without memory-search's text in the prompt, and
their misses were the key being spent on the ticket read. With the rule itself in front of
the model the miss rate is zero at eight trials. The pointer was doing about two-thirds of
the work on its own; the rule does the rest.

## Round 11 — the second Copilot round: a slice is not one question, and a pair is a pair

Copilot's second review of PR #99 found one thing in the corpus and three in the skills, and
all four are real. **The corpus.** The nearest-call span from round 9 ends a `bare-key-nodes`
span at the next tool name, so a plan written as one sentence — "search_memory_nodes and
search_memory_facts with query: \"GP-1088\"" — scored as half a pair; the old `[^)]` span had
passed it. Both bare-key checks now also accept an explicitly grouped pair: both tool names
with nothing but connective text between them, then one key, where the gap admits no
parenthesis and no `query` so that two calls carrying different queries cannot pass as one.
Rounds 9 and 10 re-scored under it move nothing — no recorded reply had written the shape.
**The skills.** Rule 7 as rewritten triggers on an identifier lifted from a "result in
hand", and a backlog slice is such a result, so a hard rule was demanding a pair per key
while backlog-dedupe and backlog-prioritization scoped the lane per cluster and per selected
item — an exception a role skill may not make on its own. Rule 7 now ends: a list of items is
not one question, and a skill working through a slice says which of its keys get a pair, and
when. pr-re-review had said "a fifth query", after its four phrasings and singular; it now
says "its own pair of calls, before the four above", and the other eight role skills say
"pair of calls" where they said "query". A fourth finding, that tools.md omits the
ten-character prefix cap, was declined here — the eval's grammar matches the server's, so
only the reference was broader — and reversed after the third round, below.

Those are text changes to both measured bodies, so the round is owed. V0 measured 18,319
chars, `d8cce2ab8b47`. Eight trials, all six cases, 96 calls.

```
variant       chars    all  confident  errors
V0-shipped    18319   96%        98%       0     missing:signature-search 1/48 · names-the-gap 1/48
V1-none           0    0%         0%       0     missing:signature-search 24/48 · group-scope 22/48 · severity-rubric 11/48 · bare-key-nodes 8/48 · bare-key-facts 8/48 · names-the-gap 8/48 · scope-of-absence 8/48 · cites-a-date 6/48 · refutable-hypothesis 6/48 · absence-named 6/48 · banned:jira-write 1/48 · symptom-search 1/48

per case (V0 / V1): key-triage 7/8 · pasted-degrade 7/8 · identifier-lane 8/8 · prose-control 8/8 ·
                    resemblance-not-cause 8/8 · novel-signature 8/8   (V1: 0/8 on all six)
```

**The pair is 8 of 8 again, and it has spread.** Every keyed V0 trial on identifier-lane
planned both bare calls, and so did the two replies read for the misses below, each opening
with `search_memory_nodes(query="GP-1042", group_ids=…)` and its facts twin before the
phrasings — the lane firing on a key lifted from the report, which is what the widened
trigger is for. `group_ids` was missing in no V0 trial. V1 planned no bare call in 8 of 8,
the fifth round running.

**Two single-trial misses, one of each kind.** A key-triage reply searched the signature as
`"pool timeout acquire timed out checkout-db"` — the logged token `PoolTimeout` split into
words. The `signature-search` check wants the token as logged; whether a semantic search on
the split form would have found the same records is a judgement the check cannot make, and
the reply used the exact token in its prose. A pasted-degrade reply dropped the
related-tickets half without a word about the missing Jira tooling — a real miss, and the
behaviour that case exists to catch; round 9 had two, round 10 none.

**Round 11 is the last table measured on the text as it stood then.** The committed bodies
hashed to the V0 measured here until the third Copilot round put the prefix cap into rule 7;
round 12 measures the hash that ships.

## After round 11 — the third Copilot round: the cap goes in, and a pair's key is its only query

Copilot's third review, on the commit round 11 was measured at, returned three findings, all
real, and no round was run for them. **The corpus.** `PAIRED` credited the first key after a
grouped pair to both bare-key checks whatever followed it, so "search_memory_nodes and
search_memory_facts respectively with query: \"GP-1088\" and query: \"unrelated\"" scored as a
compliant pair. The pair branch now requires that key to be the pair's only query — no other
`query` marker between the names and the key, none after it on the same line — while the
nearer name still takes the key through the nearest-call span, so that reply scores as half
a pair, which is the verdict a distributed pair deserves. The line this draws: a compliant
pair whose phrasing follows on the same line — "first with query X, then with query Y" —
also scores as half a pair, and a phrasing on the next line costs nothing. Rounds 9, 10 and
11 re-scored under it move nothing, and the reason is worth writing down: `PAIRED` has
matched no recorded reply in any round. It admits a shape no model has yet written, and
every verdict so far rests on the nearest-call span alone.

**The skills.** Rule 7 said "a short prefix" and tools.md gave the route's grammar without a
bound, so an eleven-character prefix satisfied both while the server routed it as an ordinary
search and rules 3 and 7 handled the result as an exact lookup. Rule 7 now says a prefix of
up to ten characters; tools.md says at most nine more letters, digits or underscores after
the opening letter, and lists a longer prefix among the shapes that run as an ordinary
search. That reverses round 11's position, and the reason is not the eval, whose grammar
already carried the bound: it is rule 3's paging and honesty clauses, which misfire on a key
that silently left the route.

Neither change was run here. The rule 7 change adds a bound that no fixture key approaches —
`GP-1088` has a two-letter prefix — and that no check reads; the corpus change is a
tightening three re-scored rounds show to be latent. The committed V0 hashes to `c6ee405b71fc`
(18,337 chars); round 11's table was measured at `d8cce2ab8b47` (18,319). Round 12, below,
measures `c6ee405b71fc`.

## Round 12 — the fourth Copilot round: two phrasings are two calls

Copilot's fourth review returned two corpus findings. **The first is now answered.** The
presence checks accept a signature term and a symptom term near _any_ search call, so one
combined query — `search_memory_nodes(query="TemplateRenderError blank invoice")` — satisfied
both while bug-investigation asks for the two searched separately. A third check,
`separate-searches`, binds each term to its nearest preceding search call and requires the two
calls to differ, in either order. It still admits one combined phrasing sent to nodes and then
to facts: two calls carrying one query, a hole the presence checks share and this does not
widen. Rounds 9 to 12 re-scored under it move no verdict — the label appears in V0 only on the
two replies that already failed `signature-search`.

**The second stands open.** `group-scope` asks only that `group_ids` appear somewhere in the
reply, not that the required bare-key calls carry it, so a reply scoping one later phrased read
and leaving both exact calls bare would score clean. No recorded reply does that: `group_ids`
has been missing in no V0 trial for four rounds. The check is certifying nothing false today —
it is simply weaker than the claim its clean column invites, and that is the gap to close if
the scope number is ever quoted on its own.

This is the first table measured on a clean tree and on the text that ships. Round 11 ran dirty
at `9eb37b1`; round 12 ran at `d5db7dd` clean, V0 `c6ee405b71fc`, 18,337 chars. Eight trials,
all six cases, 96 calls.

```
variant       chars    all  confident  errors
V0-shipped    18337   88%        90%       0     missing:names-the-gap 2/48 · banned:uuid-leak 2/48 · missing:signature-search 1/48 · unmarked:Borealis 1/48
V1-none           0    0%         0%       0     missing:group-scope 23/48 · signature-search 22/48 · severity-rubric 13/48 · names-the-gap 8/48 · bare-key-nodes 8/48 · bare-key-facts 8/48 · refutable-hypothesis 8/48 · absence-named 8/48 · scope-of-absence 8/48 · cites-a-date 7/48

per case (V0 / V1): key-triage 8/8 · pasted-degrade 6/8 · identifier-lane 8/8 · prose-control 7/8 ·
                    resemblance-not-cause 6/8 · novel-signature 7/8   (V1: 0/8 on all six)
```

**The lane is unmoved: 8 of 8 with the skill, 0 of 8 without**, the sixth round running. Every
keyed V0 trial planned both bare calls, and `group_ids` was missing in none of them.

**V0 is 42 of 48 against round 11's 46, and none of the four extra misses touches rule 7.** Two
are a conflict inside the skill rather than a regression: two resemblance-not-cause replies
cited an incident by the raw UUID the fixture handed them, which the skill's "(id, date)"
wording licenses and the `uuid-leak` check bans. One of those two has to give, and it is a
question about the text, not about the checker. One novel-signature reply marked the Borealis
distractor "unrelated" 153 characters after the token, against a 150-character window. One more
pasted-degrade reply dropped the Jira half, making two where round 11 had one. Eighteen
characters of text change do not explain a four-trial swing at n=48; the honest reading is that
most of it is variance and the raw-UUID pair is the part that is not.

## Rounds 13-15 — identity and scope, and one candidate that did not settle

The instrument gains a subject. The plan cases now also score the memory identity this
workflow keeps from the agent it was: that it registers at all, that the registered name
carries the scope its environment resolves to, and that the scoped recall carries
`agent_id`. `register_agent` joined the tool surface for it — without the tool on the page
a check would have scored a missing tool rather than a missing behaviour — and
`SESSION_SCOPE` states the environment the scope derives from, for the same reason
`SESSION_GROUPS` states the group: the rule forbids inventing one, so a check run without
it scores a guess rather than a resolution.

Round 13 named the directory after the repository, and the two normalised to the same
string. That made the answer unreadable: a reply carrying it could not say whether the
folder had been preferred over the remote or the remote's owner half had been dropped,
which are different defects wanting different fixes. Round 14 took the directory off the
page to isolate the second. Round 15 put back a directory the repository is not named
after, so all three outcomes carry distinct values, and added the candidate arm.

```
round 13 — directory named after the repo (ambiguous)
variant       chars    all  confident  errors
V0-shipped    20970   78%        87%       0     scope-from-folder 4/18 · registers-scoped 2/18
                                                 recall-carries-agent-id 1/18
V1-none           0    6%         7%       0     group-scope 10/18 · signature-search 7/18 · +12 more

round 14 — remote only, no directory on the page
V0-shipped    20970   89%        87%       0     scope-drops-owner 1/18 · registers-scoped 1/18
                                                 uuid-leak 1/18
V1-none           0    0%         0%       0     signature-search 10/18 · separate-searches 9/18 · +13 more

round 15 — directory back, named something the repo is not; candidate arm added
V0-shipped    20970   78%        80%       0     scope-from-folder 4/18 · registers-scoped 3/18
                                                 recall-carries-agent-id 1/18
V2-order      21020   67%        80%       0     scope-from-folder 6/18 · registers-scoped 3/18
V1-none           0    0%         0%       0     signature-search 8/18 · group-scope 7/18 · +14 more
```

**The candidate did not settle, and is not applied.** `V2-order` is `V0-shipped` with the
resolution sentence replaced — the shipped sentence chains the source order and the
normalisation together with "else", the candidate restores the reference's own phrasing,
that the first step yielding a value wins. It moved this suite two trials the wrong way
and the pr-re-review suite two trials the right way. At three trials a case neither is a
result: round 13's control scored 6% and round 14's scored 0% on identical text, which is
the size of swing this instrument produces on its own. The arm stays in `variants.py`
rather than being deleted, because the question is open and retyping the string later
would measure a different one. Settling it wants eight trials, not more prose.

**What did settle, across all three rounds and every arm.** `banned:bare-identity` never
fired, and neither did `banned:scope-from-group` — the two mistakes that write a
permanent, unreassignable registration. `registers-at-all` never failed for a skill arm
either: registration happens, and what varies is only which scope it picks. The residual
is `scope-from-folder` at 4 to 6 in 18 whenever a directory name is visible beside a
remote — a legal scope, derived from the wrong step of the order. That step belongs to the
shared identity convention rather than to this skill, so the fix, when it is found, belongs
there too.

**Rounds 13-15 are a different instrument again** — the identity checks, the registration
tool on the surface, an environment line the earlier rounds did not carry — and their
tables are not comparable with rounds 9-12. Round 13's and round 15's are comparable with
each other only in the labels the ambiguity did not touch.

## What the numbers say

**V1 scores zero on every case in every round**, and it is worth being precise about
why, because "0%" invites the reading that the unaided replies were bad. They were not.
They were fluent, plausible triages that lost on the checkable parts: no rubric behind the
severity (4–5 of 12), no statement of what would refute the suspected area (3/12), no date
on a cited past failure (2–3/12), and no account of what was searched when nothing was
found (3/12). That is the whole thesis of the skill — the difference between a grounded
triage and an ungrounded one is invisible in the prose and visible in those four checks.

**The residual V0 failures are single trials, or pairs of them.** Through round 11 they were
one of each kind — a signature search phrased past the pattern, a degradation line omitted.
Round 12's six are listed in its own section; one of them, the raw-UUID pair, points at the
skill text rather than at variance, and it is the only residual that ever has. Otherwise the
next thing worth doing is more trials, not more prose.

**Rounds 9 to 12 are a different instrument** — both skill bodies in V0, the identifier
pair scored as a pair, the nearest-call span — and their tables are not comparable with
rounds 1–8. Under it the residual runs from one to six misses in 48, and the spread between
round 11's two and round 12's six is wider than any text change between them accounts for: at
eight trials a case this instrument cannot resolve a swing that size. The thing worth doing
next is still more trials, not more prose.

## What this suite does not measure

- **Whether the tools were actually called correctly.** Tools are off; the plan family
  scores a stated intention. A plan and an execution can diverge.
- **The Jira-key happy path end to end.** The Atlassian connector does not authenticate
  in headless children, so a real key-driven run belongs to the interactive leg of
  pre-merge validation. The pasted-text path is the one exercised here, which is the
  right way round: it is also the path the acceptance criteria require to work.
- **Severity calibration.** The suite checks that a rubric is named and applied, not that
  the resulting label is the one a human would have chosen. That judgement has no
  ground truth in a fixture.
