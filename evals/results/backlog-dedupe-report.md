# backlog-dedupe — re-scored from a stored round

Judge model: `claude-haiku-4-5-20251001`.

7 cases, 2 variants, 42 calls.

Round `backlog-dedupe-3t-V0-shipped-V1-none-r2` — replies measured 2026-08-14T15:57:20+00:00, tree `afce5f4` (dirty tree).
Variant text measured: V0-shipped:3dadfee220a2 V1-none:e3b0c44298fc.
The size shown for V0-shipped, V1-none is the skill text as it stands now — this round predates recorded variant lengths, so the length it actually measured is not known. The hashes above still identify the text.
Scored by the checkers in tree `e4420a0` — re-scored offline, not re-run: same replies, new instrument. Comparable with the table it replaces; not comparable with a fresh round, which is a new sample.

```
BACKLOG DEDUPE — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    12178   90%        90%       0
               missing:names-unverified-ages: 2/21
V1-none           0   10%        10%       0
               missing:group-scope: 3/21
               missing:denominator: 3/21
               missing:similarity-labelled: 3/21
               missing:names-cannot-action: 3/21
               missing:names-unverified-ages: 3/21
               missing:calibration-first: 3/21
               missing:buckets-recount: 3/21
               unmarked:[`*]{0,2}(transitionJiraIssue|editJiraIssue|createIssueLink|createJiraIssue|addCommentToJiraIssue)[`*]{0,2}\s*\(\s*[A-Za-z\"'{]: 2/21
               missing:memory-grounding: 2/21
               missing:actions-gated: 2/21
               missing:record-step: 2/21
               missing:completes-or-scopes: 2/21
               missing:cluster-identity-a: 1/21
               missing:cluster-identity-b: 1/21
               missing:cluster-csv-pair: 1/21
               missing:follows-pages: 1/21
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
          truncated-page            3/3           1/3
          protocol-steps            3/3           0/3
```
