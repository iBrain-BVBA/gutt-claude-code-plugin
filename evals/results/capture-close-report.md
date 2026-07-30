# capture-close — 4 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

4 cases, 5 variants, 80 calls.

```
CLOSING THE TURN AFTER A FIRED CAPTURE
variant            chars    all  confident    closed  unreported   echoed  apology  preamble  pleasantry    next  errors
------------------------------------------------------------------------------------------------------------------------
V0-shipped          1213   88%        83%    16/16        2/16     0/16     0/16      0/16        0/16    2/16        0
V1-none                0   50%        58%    13/16        5/16     0/16     0/16      1/16        0/16    0/16        0
V2-summary-only      312   69%        58%    15/16        3/16     0/16     0/16      1/16        0/16    0/16        0
V3-no-negatives     1054   94%        92%    16/16        1/16     0/16     0/16      0/16        0/16    2/16        0
V4-terse             878  100%       100%    16/16        0/16     0/16     0/16      0/16        0/16    0/16        0

  closed     = the tail of the reply is the work, not the bookkeeping — the
               measurement this suite exists for
  unreported = never mentioned the capture at all; hiding the write is its own failure
  echoed     = pasted two or more long sentences of the original answer back down
  apology    = framed the capture as an interruption of the work
  next       = offered one concrete next action (diagnostic, not scored)

PER CASE — trials correct   (~ = label held less firmly)
              case         V0-shipped           V1-none   V2-summary-only   V3-no-negatives          V4-terse
-------------------------------------------------------------------------------------------------------------
        flaky-test                2/4               3/4               2/4               3/4               4/4
  cache-regression                4/4               1/4               3/4               4/4               4/4
migration-incident                4/4               3/4               2/4               4/4               4/4
       advice-turn~               4/4               1/4               4/4               4/4               4/4
```
