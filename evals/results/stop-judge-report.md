# stop-judge — 5 trial(s) per case

14 cases, 2 variants, 140 calls.

```
VERDICT ACCURACY
variant      lines  chars      all  confident  missed fire  false fire  livelock  errors
----------------------------------------------------------------------------------------
V14              9   2112     64%        74%      20/35        5/35      0/5          0
V15             10   2421     70%        82%      16/35        5/35      0/5          0

REASON SHAPE ON TURNS THAT SHOULD FIRE
variant        n   chars  names skill  all typed  >10 words  gated type  json echo
----------------------------------------------------------------------------------
V14           15     184        100%      100%        0%         0%        0%
V15           19     185        100%      100%        0%         5%        0%

PER CASE — trials correct
       case   want        V14        V15
----------------------------------------
        c01   FIRE         5/5        3/5
        c02   FIRE         4/5        5/5
        c03   FIRE         1/5        4/5
        c04   FIRE         1/5        2/5
        c05   FIRE~        2/5        3/5
        c06   FIRE~        1/5        0/5
        c07   FIRE         1/5        2/5
        c08  quiet         5/5        5/5
        c09  quiet         5/5        5/5
        c10  quiet~        0/5        0/5
        c11  quiet         5/5        5/5
        c12  quiet         5/5        5/5
        c13  quiet~        5/5        5/5
 c14-active  quiet         5/5        5/5
```
