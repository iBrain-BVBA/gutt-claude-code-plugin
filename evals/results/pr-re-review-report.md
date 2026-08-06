# pr-re-review — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

5 cases, 2 variants, 30 calls.

```
MEMORY-INFORMED PR REVIEW — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    13794   80%        92%       0
               banned:ungrouped-write: 2/15
               missing:metadata-gap-named: 1/15
V1-none           0    0%         0%       0
               missing:group-scope: 3/15
               missing:no-history-bleed: 3/15
               missing:read-back: 3/15
               missing:absence-named: 3/15
               missing:metadata-gap-named: 3/15
               missing:coverage-accounting: 2/15
               unmarked:(?i)session (leak|is leaked|not closed|left open|cleanup): 2/15
               banned:posted-unasked: 1/15
               missing:recall-precedes-lanes: 1/15
               missing:group-on-write: 1/15

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = a post to the pull request, an ungrouped write, or a house
  rule the graph never supplied; unmarked:<token> = a lane finding forwarded
  without being re-checked at the source

PER CASE — trials correct   (~ = label held less firmly)
                  case     V0-shipped       V1-none
---------------------------------------------------
   recall-before-lanes            3/3           0/3
          capture-gate~           1/3           0/3
   unverified-findings            3/3           0/3
          empty-recall            3/3           0/3
   pasted-diff-degrade            2/3           0/3
```
