# bug-investigation — 8 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

6 cases, 2 variants, 96 calls.

Round `bug-investigation-8t-V0-shipped-V1-none-r4` — 2026-09-11T14:31:32+00:00, tree `7618233` (dirty tree).
Variant text measured: V0-shipped:5681149bc1d4 V1-none:e3b0c44298fc.

```
BUG TRIAGE — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    18194   98%        98%       0
               missing:absence-named: 1/48
V1-none           0    0%         0%       0
               missing:signature-search: 23/48
               missing:group-scope: 23/48
               missing:severity-rubric: 10/48
               missing:names-the-gap: 8/48
               missing:bare-key-nodes: 8/48
               missing:bare-key-facts: 8/48
               missing:cites-a-date: 8/48
               missing:refutable-hypothesis: 8/48
               missing:scope-of-absence: 8/48
               missing:absence-named: 6/48
               missing:area-history: 1/48
               missing:symptom-search: 1/48

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = a Jira write, a leaked UUID, or a resemblance asserted as a
  cause; unmarked:<token> = unrelated history presented without a marker

PER CASE — trials correct   (~ = label held less firmly)
                  case     V0-shipped       V1-none
---------------------------------------------------
            key-triage            8/8           0/8
        pasted-degrade~           8/8           0/8
       identifier-lane            8/8           0/8
         prose-control            8/8           0/8
 resemblance-not-cause            8/8           0/8
       novel-signature            7/8           0/8
```
