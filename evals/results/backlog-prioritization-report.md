# backlog-prioritization — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

4 cases, 2 variants, 24 calls.

```
BACKLOG PRIORITIZATION — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    10405  100%       100%       0
V1-none           0    0%         0%       0
               missing:group-scope: 3/12
               missing:no-evidence-labelled: 3/12
               missing:basis-stated: 3/12
               missing:labelled-field-sort: 3/12
               missing:bounds-the-slice: 3/12
               missing:criteria-named: 2/12
               unmarked:(editJiraIssue|transitionJiraIssue|createIssueLink|createJiraIssue|addCommentToJiraIssue)\s*\(\s*[A-Za-z\"'{]: 2/12

  failure labels: missing:<check> = a required behaviour never appeared
  (the *-cited labels are the seeded-evidence recall measurement);
  banned:<check> = a reordered-in-Jira or fabricated claim;
  unmarked:<token> = a write shown without its approval gate, or an
  imported framework used rather than refused

PER CASE — trials correct   (~ = label held less firmly)
                    case     V0-shipped       V1-none
-----------------------------------------------------
     plan-criteria-first            3/3           0/3
          seeded-ranking            3/3           0/3
    no-memory-field-sort            3/3           0/3
           unbounded-ask            3/3           0/3
```
