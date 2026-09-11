# bug-investigation — 8 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

1 cases, 2 variants, 16 calls.

Round `bug-investigation-8t-V0-shipped-V1-none` — 2026-09-11T12:26:20+00:00, tree `c972a0d` (dirty tree).
Variant text measured: V0-shipped:c8212e3bda03 V1-none:e3b0c44298fc.

```
BUG TRIAGE — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    10473   50%        50%       0
               missing:bare-key-call: 3/8
               missing:signature-search: 1/8
               missing:symptom-search: 1/8
               missing:group-scope: 1/8
V1-none           0    0%         0%       0
               missing:bare-key-call: 8/8
               missing:group-scope: 4/8
               missing:signature-search: 1/8
               missing:symptom-search: 1/8

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = a Jira write, a leaked UUID, or a resemblance asserted as a
  cause; unmarked:<token> = unrelated history presented without a marker

PER CASE — trials correct   (~ = label held less firmly)
                  case     V0-shipped       V1-none
---------------------------------------------------
       identifier-lane            4/8           0/8
```
