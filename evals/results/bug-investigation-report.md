# bug-investigation — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

6 cases, 3 variants, 54 calls.

Round `bug-investigation-3t-V0-shipped-V1-none-V2-order` — 2026-09-14T13:52:49+00:00, tree `857d3d9` (dirty tree).
Variant text measured: V0-shipped:e6372f14dbf7 V2-order:f690d8fb7973 V1-none:e3b0c44298fc.

```
BUG TRIAGE — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    20970   78%        80%       0
               banned:scope-from-folder: 4/18
               missing:registers-scoped-identity: 3/18
               missing:recall-carries-agent-id: 1/18
V2-order      21020   67%        80%       0
               banned:scope-from-folder: 6/18
               missing:registers-scoped-identity: 3/18
V1-none           0    0%         0%       0
               missing:signature-search: 8/18
               missing:group-scope: 7/18
               missing:separate-searches: 6/18
               missing:severity-rubric: 4/18
               missing:registers-at-all: 3/18
               missing:registers-scoped-identity: 3/18
               missing:recall-carries-agent-id: 3/18
               missing:names-the-gap: 3/18
               missing:bare-key-nodes: 3/18
               missing:bare-key-facts: 3/18
               missing:refutable-hypothesis: 3/18
               missing:absence-named: 3/18
               missing:scope-of-absence: 3/18
               missing:cites-a-date: 2/18
               missing:symptom-search: 1/18
               banned:jira-write: 1/18

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = a Jira write, a leaked UUID, or a resemblance asserted as a
  cause; unmarked:<token> = unrelated history presented without a marker

PER CASE — trials correct   (~ = label held less firmly)
                  case     V0-shipped      V2-order       V1-none
-----------------------------------------------------------------
            key-triage            0/3           0/3           0/3
        pasted-degrade~           2/3           0/3           0/3
       identifier-lane            3/3           3/3           0/3
         prose-control            3/3           3/3           0/3
 resemblance-not-cause            3/3           3/3           0/3
       novel-signature            3/3           3/3           0/3
```
