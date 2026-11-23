# Brief template

## Brief (`body_md`)

```markdown
# <Vault name> — week <YYYY-Www>

<One-sentence headline: the most significant thing the evidence says this week.>

## What changed

- <Finding headline> — <one line on why it matters>. [<publisher>](url)
  (<evidence grade>)

## Agent of the week: <role> (vaults with a role taxonomy)

**The job:** <tasks it takes over, who it works with, how humans stay in the loop>
**Evidence:** <vendor claim / customer case / independent study, each cited>
**Maturity:** <Emerging | Proven in pilots | Proven at scale>
**Cost & time to value:** <pricing models seen, setup effort>
**Watch out for:** <risks, regulatory flags>

## Board movement (vaults with a role taxonomy)

| Role | Evidence strength | Effort | Change |
| ---- | ----------------- | ------ | ------ |

## Claimed vs measured

<Open or resolved conflicts: one claim against the other, both cited.>

## Sources

<Every source used, with retrieved dates.>
```

Rules: committed findings only; every claim cited; no ranking of vendors; for a vault about
agents in roles, roles on a team, never replacement.

## Brief page data (`page`)

The same week as `brief.json` (`../../vault-pages/references/page-data.md` §brief.json): the
headline, each "What changed" finding with its sources, the conflicts, and every source. Only
findings that are committed `Finding:` episodes; vault-commit checks again before it publishes.

## LinkedIn draft (`linkedin_md`)

Headings, in this order:

1. **Title candidates:** 3 to 5, ranked. One word each, a pun or a dry jab at the week's
   subject, never at a person.
2. **Post:**
   - first line `<brief.linkedin_series> E<nn>. <Title>.`, where `<nn>` is the number of
     `Brief:` episodes in the vault group plus one (the owner corrects it on the Console if a
     brief went unposted);
   - the hook on line 2: one real scene from the vault's own week;
   - parallel items as ` •` bullets;
   - one closing question;
   - `brief.linkedin_cta` as the offer, if set;
   - the `Sources:` line naming the sources, no URLs, above the hashtags.
3. **Image prompt:** one picture for the post, built from the week's subject.
4. **Alt text:** one or two plain sentences describing that picture.

The Console counts the post's characters for the owner; LinkedIn cuts a post at 3,000.
