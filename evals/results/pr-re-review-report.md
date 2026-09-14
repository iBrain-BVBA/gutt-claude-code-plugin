# pr-re-review — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

5 cases, 3 variants, 45 calls.

Round `pr-re-review-3t-V0-shipped-V1-none-V2-order` — 2026-09-14T13:57:17+00:00, tree `857d3d9` (dirty tree).
Variant text measured: V0-shipped:5dd4853e04bd V2-order:9375fa56b223 V1-none:e3b0c44298fc.

```
MEMORY-INFORMED PR REVIEW — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    16546   73%        83%       0
               missing:registers-scoped-identity: 2/15
               missing:write-carries-agent-id: 2/15
               banned:scope-from-folder: 2/15
               missing:metadata-gap-named: 2/15
               banned:ungrouped-write: 1/15
V2-order      16596   73%        75%       0
               missing:recall-carries-agent-id: 1/15
               missing:write-carries-agent-id: 1/15
               banned:ungrouped-write: 1/15
               unmarked:(?i)session (leak|is leaked|not closed|left open|cleanup): 1/15
               missing:metadata-gap-named: 1/15
V1-none           0    0%         0%       0
               missing:registers-at-all: 6/15
               missing:registers-scoped-identity: 6/15
               missing:recall-precedes-lanes: 3/15
               missing:group-scope: 3/15
               missing:recall-carries-agent-id: 3/15
               missing:no-history-bleed: 3/15
               missing:read-back: 3/15
               missing:write-carries-agent-id: 3/15
               missing:absence-named: 3/15
               missing:metadata-gap-named: 3/15
               banned:ungrouped-write: 2/15
               missing:coverage-accounting: 2/15
               unmarked:90\s*%: 2/15
               banned:posted-unasked: 1/15
               missing:group-on-write: 1/15
               unmarked:(?i)session (leak|is leaked|not closed|left open|cleanup): 1/15
               missing:quotes-the-agreement: 1/15
               missing:cites-a-source: 1/15

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = a post to the pull request, an ungrouped write, or a house
  rule the graph never supplied; unmarked:<token> = a lane finding forwarded
  without being re-checked at the source

PER CASE — trials correct   (~ = label held less firmly)
                  case     V0-shipped      V2-order       V1-none
-----------------------------------------------------------------
   recall-before-lanes            3/3           2/3           0/3
          capture-gate~           1/3           2/3           0/3
   unverified-findings            3/3           2/3           0/3
          empty-recall            3/3           3/3           0/3
   pasted-diff-degrade            1/3           2/3           0/3
```
