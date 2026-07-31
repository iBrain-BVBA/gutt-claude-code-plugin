# capture-close — 6 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

4 cases, 3 variants, 72 calls.

```
CLOSING THE TURN AFTER A FIRED CAPTURE
variant            chars    all  confident    closed  unreported   echoed  apology  preamble  pleasantry    next  errors
------------------------------------------------------------------------------------------------------------------------
V0-shipped           804   54%        44%    20/24        7/24     0/24     0/24      0/24        0/24    0/24        0
V1-none                0   54%        56%    24/24        9/24     0/24     0/24      2/24        2/24    0/24        0
R1-reanchor          841   62%        61%    20/24        6/24     0/24     0/24      0/24        0/24    0/24        0

  closed     = the tail of the reply is the work, not the bookkeeping — the
               measurement this suite exists for
  unreported = never mentioned the capture at all; hiding the write is its own failure
  echoed     = pasted two or more long sentences of the original answer back down
  apology    = framed the capture as an interruption of the work
  next       = offered one concrete next action (diagnostic, not scored)

PER CASE — trials correct   (~ = label held less firmly)
              case         V0-shipped           V1-none       R1-reanchor
-------------------------------------------------------------------------
        flaky-test                3/6               2/6               3/6
  cache-regression                3/6               2/6               5/6
migration-incident                2/6               6/6               3/6
       advice-turn~               5/6               3/6               4/6
```
