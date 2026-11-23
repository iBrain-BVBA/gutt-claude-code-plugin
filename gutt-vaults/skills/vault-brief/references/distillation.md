# Distilling verdict patterns

Input: the week's Verdict episodes plus the last 8 weeks for counts.

1. Group human verdicts by class (proposal type, beat, claim type, source domain or class,
   significance band), and group rejections also by the reason on their `Reason:` line
   (the Console's reason chips: Stale, Weak source, Off scope, Duplicate, Not significant,
   Claim not supported, Other). A reason that dominates a class's rejections is the pattern's
   reason, and goes in its Insight's `Use:` line.
2. A class with at least `brief.pattern_min_verdicts` verdicts and at least
   `brief.pattern_share` of them one way is a **pattern**
   (`../../vault-curate/references/vault-config.md`).
3. Write it as an Insight:

```
Name: Insight: <pattern in one statement, with the count>
      e.g. "Insight: vendor blogs restating docs are rejected 9 of 10"
Body:
insight_type: verdict_pattern
Pattern: <class> — <decision> <k> of <n> since <date>.
Drawn from the Verdicts on: <Finding names>.
Use: <what scouts / the librarian should do differently>.
Recorded by vault-brief.
```

4. Source-quality patterns (a domain or source class rejected or approved consistently) use
   `insight_type: source_quality`; method lessons use `research_method`.
5. A rejection pattern seen `brief.steering_after_weeks` weeks running that reads as a standing instruction becomes a
   **proposed** Console steering row (`source: proposed`, the Insight named). It becomes
   Steering only if the owner accepts it.
6. Dedupe against existing Insights first; refine an existing one with `previous_episodes`
   instead of writing a near-duplicate.
