# Scout method

How a `vault-scout` researches its one beat. vault-curate passes this file's path on the
`method_file:` line of every scout prompt; the scout reads it first. The scout's agent prompt
holds the output contract and the hard rules; this file is the method.

## Scope

You cover one beat of one vault. Other scouts cover the other beats in parallel, so stay inside
yours: what the beat charter says to look for, inside its window, from the source types it
names. Your brief's order of authority is charter, then owner steering, then feedback addressed
to you, then your own procedures.

## The loop

1. **Name the gaps.** Before each round, say to yourself what the beat still lacks: a kind of
   source not yet tried, a subject in scope with nothing found, a claim that needs its
   original.
2. **Search short.** Two to five words per query works better than a sentence. Vary every
   query; the same query twice returns the same results.
3. **Fetch before you trust.** A search snippet is easy to take out of context. Fetch the full
   page of anything you might return, and read the date and the claim on the page itself.
4. **Repeat** until a stop condition holds. Run searches and fetches in parallel when they
   don't depend on each other.

Fetch index pages before searching when the charter names a publisher: a vendor's newsroom, a
regulator's press page or a changelog surfaces dated items that keyword searches bury under
listicles and aggregators.

## When to stop

- The beat's max items are found and sourced.
- New rounds bring nothing new and relevant.
- About 10 tool calls is normal. Stop at 15 whatever else is true.

## Judging a source

Before you keep an item, ask:

- **Fact or forecast?** "Could", "may", "is expected to" and future-tense stories are not
  findings. Keep only what has happened or is in force.
- **Original or copy?** Prefer the party that made the claim: the vendor's own launch post, the
  regulator's text, the study itself. An aggregator or a press write-up is a pointer to the
  original; fetch the original when you can and cite it.
- **Who stands behind it?** Nameless sources, passive voice with no actor, general qualifiers
  with no numbers, and reports that repeat an unconfirmed claim are weak. Say so in
  `confidence`.
- **Is it in the window?** The page's own date decides, not the date a search result shows.
  A "last updated" stamp in a sidebar or a related-content card is not the page's date.
- For recent topics, trust what you fetch over what you remember: facts change.

When two sources disagree, keep both and say they disagree; the librarian turns that into a
conflict row. When you find nothing reliable, say so in `scout_notes.run`: an empty beat is
signal, not failure.

## Never invent

Every URL, date, number and quote you return comes from a page you fetched in this run. If you
can't find a figure, leave it out and say in `scout_notes` what you looked for. A wrong item
costs the vault more than a missing one: the librarian re-fetches every source and drops what
the page doesn't support.

## Texts you can't read

A page that blocks automated fetches, a page that returns only metadata, a compressed PDF:
don't spend more calls on it and don't drop it. Return it under `leads` with what identifies it
(an official identifier such as a CELEX number, or the URL), where you found it, and why it
matters. vault-curate fetches it with a tool you don't have. Prefer an HTML version of the same
document when one exists.
