# sub-task-breakdown — re-scored from a stored round

Judge model: `claude-haiku-4-5-20251001`.

5 cases, 2 variants, 30 calls.

Round `sub-task-breakdown-3t-V0-shipped-V1-none-r3` — replies measured 2026-08-17T07:48:54+00:00, tree `dc5ec4e` (dirty tree).
Variant text measured: V0-shipped:fa8e54c8ca3d V1-none:e3b0c44298fc.
Scored by the checkers in tree `8166f5c` — re-scored offline, not re-run: same replies, new instrument. Comparable with the table it replaces; not comparable with a fresh round, which is a new sample.

```
STORY BREAKDOWN — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    11217   73%        67%       0
               missing:effort-range: 2/15
               missing:names-cannot-file: 2/15
               missing:names-overlap-gap: 2/15
V1-none           0   33%        17%       0
               missing:jira-dependency: 4/15
               missing:confidence: 4/15
               missing:names-cannot-file: 3/15
               missing:names-overlap-gap: 3/15
               missing:comparables-search: 2/15
               missing:group-scope: 2/15
               unmarked:[`*]{0,2}createJiraIssue[`*]{0,2}\s*\(\s*[A-Za-z\"'{]: 2/15
               missing:declines-to-split: 2/15
               missing:effort-range: 1/15

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = an unasked-for issue creation; unmarked:<token> = another
  tracker's reference carried through without being translated

PER CASE — trials correct   (~ = label held less firmly)
                  case     V0-shipped       V1-none
---------------------------------------------------
        plan-no-filing            3/3           0/3
   github-grammar-bait            1/3           1/3
     already-one-slice            3/3           1/3
   untestable-criteria~           3/3           3/3
        pasted-degrade            1/3           0/3
```
