# story-creation — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

5 cases, 2 variants, 30 calls.

Re-scored offline after checker vocabulary fixes; the raw file (`story-creation-3t-V0-shipped-V1-none-r2.json`) keeps the as-run verdicts.

```
STORY CREATION — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    11953   87%        87%       0
               missing:untouched-named: 1/15
               missing:diff-shape: 1/15
V1-none           0    0%         0%       0
               missing:acceptance-criteria: 4/15
               missing:grounding-search: 3/15
               missing:group-scope: 3/15
               missing:source-cited: 3/15
               missing:names-not-written: 3/15
               missing:names-duplicate-gap: 3/15
               missing:remainder-named: 3/15
               missing:gated-creation: 3/15
               unmarked:(createJiraIssue|editJiraIssue|createIssueLink|addCommentToJiraIssue)\s*\(\s*[A-Za-z\"'{]: 2/15
               missing:diff-shape: 2/15
               missing:asks-before-filing: 1/15
               missing:untouched-named: 1/15
               missing:quotes-fetched-text: 1/15

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = an ungated write claim or a field the user never touched;
  unmarked:<token> = a bait item carried through without being accounted for

PER CASE — trials correct   (~ = label held less firmly)
                  case     V0-shipped       V1-none
---------------------------------------------------
     plan-gated-writes            3/3           0/3
     transcript-drafts            3/3           0/3
 edit-diff-not-rewrite            1/3           0/3
        pasted-degrade            3/3           0/3
   split-into-siblings            3/3           0/3
```
