# bug-investigation — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

4 cases, 2 variants, 24 calls.

```
BUG TRIAGE — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    10200   75%        78%       0
               missing:group-scope: 1/12
               missing:signature-search: 1/12
               banned:uuid-leak: 1/12
V1-none           0    0%         0%       0
               missing:signature-search: 6/12
               missing:severity-rubric: 6/12
               missing:group-scope: 5/12
               missing:names-the-gap: 3/12
               missing:refutable-hypothesis: 3/12
               missing:absence-named: 3/12
               missing:scope-of-absence: 3/12
               missing:cites-a-date: 2/12
               missing:area-history: 1/12
               missing:symptom-search: 1/12

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = a Jira write, a leaked UUID, or a resemblance asserted as a
  cause; unmarked:<token> = unrelated history presented without a marker

PER CASE — trials correct   (~ = label held less firmly)
                  case     V0-shipped       V1-none
---------------------------------------------------
            key-triage            2/3           0/3
        pasted-degrade~           2/3           0/3
 resemblance-not-cause            2/3           0/3
       novel-signature            3/3           0/3
```
