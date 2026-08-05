# weekly-recap — 3 trial(s) per case

Judge model: `claude-haiku-4-5-20251001`.

4 cases, 2 variants, 24 calls.

```
TIME-WINDOW RECAP — skill text vs no skill
variant       chars    all  confident  errors
---------------------------------------------
V0-shipped    12446  100%       100%       0
V1-none           0   17%        22%       0
               missing:window-start: 9/12
               missing:window-end: 9/12
               missing:mention-walk: 3/12
               missing:coverage-note: 3/12
               missing:subject-entry: 1/12
               missing:fact-windowing: 1/12
               missing:empty-is-named: 1/12

  failure labels: missing:<check> = a required behaviour never appeared;
  banned:<check> = an invented parameter or UUID surfaced; unmarked:<token> =
  out-of-window material presented without an out-of-window marker

PER CASE — trials correct   (~ = label held less firmly)
                case     V0-shipped       V1-none
-------------------------------------------------
   workshop-mentions            3/3           0/3
          bare-recap~           3/3           0/3
 distractor-excluded            3/3           0/3
          quiet-week            3/3           2/3
```
