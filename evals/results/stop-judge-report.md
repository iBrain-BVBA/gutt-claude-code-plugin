# stop-judge — round 3 was VOID

Round 3 (`--trials 4 --variants V8 V9 V10`) hit the org monthly spend limit partway
through. The CLI returns that notice on stdout with exit 0, so 52 of V9's 56 calls and
55 of V10's were scored as wrong answers rather than as failures: V9 was reported at 5%
having measured 81% on the identical prompt twenty minutes earlier. V8 ran first and
completed legitimately (84% overall, 100% on confidently-labelled cases, 5/28 fires
missed), which corroborates its round-2 numbers but does not rank it against V9 or V10.

`lib/runner.py` now detects the quota notice, halts the matrix and prints RUN VOID, so
this cannot be misread again.

**The standing result is round 2** — see `stop-judge-round2-report.md`. Round 1, taken
before two corpus labels were corrected, is in `stop-judge-round1-report.md`.
