# backlog-dedupe — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

4 cases, 2 variants, 24 calls.

```
BACKLOG DEDUPE — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    11661   75%        75%       0
               missing:names-cannot-action: 3/12
               missing:names-unverified-ages: 2/12
V1-none           0    0%         0%       0
               missing:cluster-csv-pair: 4/12
               missing:memory-grounding: 3/12
               missing:group-scope: 3/12
               missing:similarity-labelled: 3/12
               missing:names-cannot-action: 3/12
               missing:names-unverified-ages: 3/12
               missing:cluster-identity-a: 2/12
               missing:cluster-identity-b: 2/12
               missing:denominator: 2/12
               missing:actions-gated: 2/12
               unmarked:(transitionJiraIssue|editJiraIssue|createIssueLink|createJiraIssue|addCommentToJiraIssue)\s*\(\s*[A-Za-z\"'{]: 1/12

  failure labels: missing:cluster-* = a seeded cluster not found (the recall
  measurement); missing:<other> = a required behaviour never appeared;
  banned:<check> = an acted-on or fabricated claim; unmarked:<token> = a
  mutating call shown without its approval gate

PER CASE — trials correct   (~ = label held less firmly)
                    case     V0-shipped       V1-none
-----------------------------------------------------
       plan-propose-only            3/3           0/3
         seeded-clusters            3/3           0/3
no-memory-similarity-only            3/3           0/3
   pasted-export-degrade            0/3           0/3
```
