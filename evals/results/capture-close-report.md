# capture-close — 6 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

4 cases, 7 variants, 168 calls.

```
CLOSING THE TURN AFTER A FIRED CAPTURE
variant            chars    all  confident    closed  unreported   echoed  apology  preamble  pleasantry    next  errors
------------------------------------------------------------------------------------------------------------------------
V0-shipped           878   96%        94%    24/24        1/24     0/24     0/24      0/24        0/24    0/24        0
V1-none                0   67%        67%    23/24        7/24     0/24     0/24      0/24        0/24    0/24        0
V3-no-negatives      719   83%        89%    23/24        3/24     0/24     0/24      0/24        0/24    0/24        0
V5-plus-style       1213   67%        61%    19/24        4/24     0/24     0/24      0/24        0/24    2/24        0
W1-numbered          773   62%        67%    22/24        8/24     0/24     0/24      0/24        0/24    0/24        0
W2-omission          798   83%        83%    21/24        1/24     0/24     0/24      0/24        0/24    0/24        0
W3-presend           700   88%        83%    21/24        0/24     0/24     0/24      0/24        0/24    0/24        0

  closed     = the tail of the reply is the work, not the bookkeeping — the
               measurement this suite exists for
  unreported = never mentioned the capture at all; hiding the write is its own failure
  echoed     = pasted two or more long sentences of the original answer back down
  apology    = framed the capture as an interruption of the work
  next       = offered one concrete next action (diagnostic, not scored)

PER CASE — trials correct   (~ = label held less firmly)
              case         V0-shipped           V1-none   V3-no-negatives     V5-plus-style       W1-numbered       W2-omission        W3-presend
-------------------------------------------------------------------------------------------------------------------------------------------------
        flaky-test                5/6               5/6               6/6               5/6               4/6               5/6               6/6
  cache-regression                6/6               2/6               5/6               2/6               4/6               5/6               5/6
migration-incident                6/6               5/6               5/6               4/6               4/6               5/6               4/6
       advice-turn~               6/6               4/6               4/6               5/6               3/6               5/6               6/6
```
