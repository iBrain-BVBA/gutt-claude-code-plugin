# capture-close — 2 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

4 cases, 5 variants, 40 calls.

```
CLOSING THE TURN AFTER A FIRED CAPTURE
variant            chars    all  confident    closed  unreported   echoed  apology  preamble  pleasantry    next  errors
------------------------------------------------------------------------------------------------------------------------
V0-shipped           878   62%        67%     7/8         2/8      0/8      0/8       0/8         0/8     0/8         0
V1-none                0   75%        83%     8/8         2/8      0/8      0/8       0/8         0/8     0/8         0
V2-summary-only      312   62%        50%     8/8         3/8      0/8      0/8       0/8         0/8     0/8         0
V3-no-negatives      719  100%       100%     8/8         0/8      0/8      0/8       0/8         0/8     0/8         0
V5-plus-style       1213  100%       100%     8/8         0/8      0/8      0/8       0/8         0/8     0/8         0

  closed     = the tail of the reply is the work, not the bookkeeping — the
               measurement this suite exists for
  unreported = never mentioned the capture at all; hiding the write is its own failure
  echoed     = pasted two or more long sentences of the original answer back down
  apology    = framed the capture as an interruption of the work
  next       = offered one concrete next action (diagnostic, not scored)

PER CASE — trials correct   (~ = label held less firmly)
              case         V0-shipped           V1-none   V2-summary-only   V3-no-negatives     V5-plus-style
-------------------------------------------------------------------------------------------------------------
        flaky-test                1/2               2/2               1/2               2/2               2/2
  cache-regression                1/2               1/2               0/2               2/2               2/2
migration-incident                2/2               2/2               2/2               2/2               2/2
       advice-turn~               1/2               1/2               2/2               2/2               2/2
```
