# story-creation — re-scored from a stored round

Judge model: `claude-haiku-4-5-20251001`.

5 cases, 2 variants, 30 calls.

Round `story-creation-3t-V0-shipped-V1-none-r2` — replies measured 2026-08-14T15:59:45+00:00, tree `afce5f4` (dirty tree).
Variant text measured: V0-shipped:86967cdae8af V1-none:e3b0c44298fc.
The size shown for V0-shipped, V1-none is the skill text as it stands now — this round predates recorded variant lengths, so the length it actually measured is not known. The hashes above still identify the text.
Scored by the checkers in tree `42f0c27` — re-scored offline, not re-run: same replies, new instrument. Comparable with the table it replaces; not comparable with a fresh round, which is a new sample.

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
               unmarked:[`*]{0,2}(createJiraIssue|editJiraIssue|createIssueLink|addCommentToJiraIssue)[`*]{0,2}\s*\(\s*[A-Za-z\"'{]: 2/15
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
