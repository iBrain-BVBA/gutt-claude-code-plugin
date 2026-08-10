# sub-task-breakdown — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

5 cases, 2 variants, 30 calls.

```
STORY BREAKDOWN — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    10293   73%        67%       0
               missing:names-cannot-file: 2/15
               unmarked:#412: 1/15
               missing:declines-to-split: 1/15
               missing:names-overlap-gap: 1/15
V1-none           0    7%         0%       0
               missing:jira-dependency: 5/15
               missing:confidence: 4/15
               missing:comparables-search: 3/15
               missing:group-scope: 3/15
               missing:declines-to-split: 3/15
               missing:names-cannot-file: 3/15
               missing:names-overlap-gap: 3/15
               unmarked:createJiraIssue\s*\(\s*[A-Za-z\"'{]: 2/15
               unmarked:#412: 2/15
               missing:criteria-called-out: 2/15
               missing:effort-range: 1/15
               unmarked:#388: 1/15
               unmarked:(?i)\b(closes|fixes|resolves)\s+#\d+: 1/15

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = an unasked-for issue creation; unmarked:<token> = another
  tracker's reference carried through without being translated

PER CASE — trials correct   (~ = label held less firmly)
                  case     V0-shipped       V1-none
---------------------------------------------------
        plan-no-filing            3/3           0/3
   github-grammar-bait            2/3           0/3
     already-one-slice            2/3           0/3
   untestable-criteria~           3/3           1/3
        pasted-degrade            1/3           0/3
```
