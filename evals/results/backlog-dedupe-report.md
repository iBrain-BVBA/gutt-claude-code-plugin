# backlog-dedupe — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

7 cases, 2 variants, 42 calls.

Re-scored offline after checker vocabulary fixes; the raw file (`backlog-dedupe-3t-V0-shipped-V1-none-r2.json`) keeps the as-run verdicts.

```
BACKLOG DEDUPE — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    12178   90%        90%       0
               missing:names-unverified-ages: 2/21
V1-none           0   14%        14%       0
               missing:group-scope: 3/21
               missing:denominator: 3/21
               missing:similarity-labelled: 3/21
               missing:names-cannot-action: 3/21
               missing:names-unverified-ages: 3/21
               missing:calibration-first: 3/21
               missing:memory-grounding: 2/21
               missing:actions-gated: 2/21
               missing:record-step: 2/21
               missing:cluster-identity-a: 1/21
               missing:cluster-identity-b: 1/21
               missing:cluster-csv-pair: 1/21
               missing:follows-pages: 1/21
               unmarked:(transitionJiraIssue|editJiraIssue|createIssueLink|createJiraIssue|addCommentToJiraIssue)\s*\(\s*[A-Za-z\"'{]: 1/21
               missing:names-truncation: 1/21
               missing:arguable-counted: 1/21

  failure labels: missing:cluster-* = a seeded cluster not found (the recall
  measurement); missing:<other> = a required behaviour never appeared;
  banned:<check> = an acted-on or fabricated claim; unmarked:<token> = a
  mutating call shown without its approval gate

PER CASE — trials correct   (~ = label held less firmly)
                    case     V0-shipped       V1-none
-----------------------------------------------------
       plan-propose-only            3/3           0/3
         seeded-clusters            3/3           1/3
no-memory-similarity-only            3/3           0/3
   pasted-export-degrade            1/3           0/3
     plan-complete-fetch            3/3           0/3
          truncated-page            3/3           2/3
          protocol-steps            3/3           0/3
```
