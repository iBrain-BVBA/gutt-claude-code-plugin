# story-creation — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

4 cases, 2 variants, 24 calls.

```
STORY CREATION — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    11953   50%        50%       0
               missing:names-duplicate-gap: 3/12
               missing:diff-shape: 2/12
               missing:acceptance-criteria: 1/12
               missing:source-cited: 1/12
V1-none           0    0%         0%       0
               missing:grounding-search: 3/12
               missing:group-scope: 3/12
               missing:source-cited: 3/12
               missing:diff-shape: 3/12
               missing:names-not-written: 3/12
               missing:names-duplicate-gap: 3/12
               unmarked:(createJiraIssue|editJiraIssue|createIssueLink|addCommentToJiraIssue)\s*\(\s*[A-Za-z\"'{]: 2/12
               missing:asks-before-filing: 2/12
               missing:acceptance-criteria: 2/12
               missing:untouched-named: 2/12

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = an ungated write claim or a field the user never touched;
  unmarked:<token> = a bait item carried through without being accounted for

PER CASE — trials correct   (~ = label held less firmly)
                  case     V0-shipped       V1-none
---------------------------------------------------
     plan-gated-writes            3/3           0/3
     transcript-drafts            2/3           0/3
 edit-diff-not-rewrite            1/3           0/3
        pasted-degrade            0/3           0/3
```
