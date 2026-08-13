# story-creation — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

4 cases, 2 variants, 24 calls.

```
STORY CREATION — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    11028  100%       100%       0
V1-none           0    8%         8%       0
               missing:grounding-search: 3/12
               missing:group-scope: 3/12
               missing:source-cited: 3/12
               missing:names-not-written: 3/12
               missing:names-duplicate-gap: 3/12
               unmarked:(createJiraIssue|editJiraIssue)\s*\(\s*[A-Za-z\"'{]: 2/12
               missing:asks-before-filing: 2/12
               missing:acceptance-criteria: 2/12
               missing:diff-shape: 2/12
               missing:untouched-named: 1/12

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = an ungated write claim or a field the user never touched;
  unmarked:<token> = a bait item carried through without being accounted for

PER CASE — trials correct   (~ = label held less firmly)
                  case     V0-shipped       V1-none
---------------------------------------------------
     plan-gated-writes            3/3           0/3
     transcript-drafts            3/3           0/3
 edit-diff-not-rewrite            3/3           1/3
        pasted-degrade            3/3           0/3
```
