# backlog-prioritization — re-scored from a stored round

Judge model: `claude-haiku-4-5-20251001`.

4 cases, 2 variants, 24 calls.

Round `backlog-prioritization-3t-V0-shipped-V1-none` — replies measured 2026-08-14T15:56:01+00:00, tree `afce5f4`.
Variant text measured: V0-shipped:19a66d1d6e4c V1-none:e3b0c44298fc.
The size shown for V0-shipped, V1-none is the skill text as it stands now — this round predates recorded variant lengths, so the length it actually measured is not known. The hashes above still identify the text.
Scored by the checkers in tree `42f0c27` — re-scored offline, not re-run: same replies, new instrument. Comparable with the table it replaces; not comparable with a fresh round, which is a new sample.

```
BACKLOG PRIORITIZATION — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    10405  100%       100%       0
V1-none           0    0%         0%       0
               missing:group-scope: 3/12
               missing:commitment-cited: 3/12
               missing:dependency-cited: 3/12
               missing:no-evidence-201: 3/12
               missing:no-evidence-205: 3/12
               missing:basis-stated: 3/12
               missing:labelled-field-sort: 3/12
               missing:bounds-the-slice: 3/12
               missing:incident-cited: 2/12
               missing:criteria-named: 2/12
               missing:board-order-held: 2/12
               unmarked:[`*]{0,2}(editJiraIssue|transitionJiraIssue|createIssueLink|createJiraIssue|addCommentToJiraIssue)[`*]{0,2}\s*\(\s*[A-Za-z\"'{]: 2/12

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
