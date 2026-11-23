# Page data

The data file each page reads from next to itself, and the export the Graph and Timelapse are
built from. `vault-pages.cjs check <page> <file>` tests a file against these contracts, and
`prepare` refuses one that fails. Every file carries `"schema": 1`, and `check` refuses any
other value; a later change to a contract raises it.

Each template's `fixtures/` folder holds a complete example for an invented vault.

## brief.json

The week's brief as a page. vault-brief drafts it into the Console row's `page` field from
the same findings as the brief text; vault-commit publishes it once the owner approves.

```json
{
  "schema": 1,
  "vault": {
    "name": "Example Vault",
    "slug": "example-vault",
    "question": "The question the vault answers, from its charter (optional)",
    "graph_url": "https://… (optional: meta/vault.graph_url)",
    "timelapse_url": "https://… (optional: meta/vault.timelapse_url)"
  },
  "week": "2026-W45",
  "published_at": "2026-11-06 (set by vault-commit when it publishes)",
  "headline": "One line: the week's biggest change",
  "intro": "One or two sentences (optional)",
  "changes": [
    {
      "finding": "The Finding's name in memory",
      "title": "Headline, with its key figure",
      "claim": "The claim as its source states it",
      "why_it_matters": "One sentence for the charter's audience",
      "beat": "releases",
      "claimant": "Who made the claim",
      "evidence_grade": "primary_source | independent | customer_evidence | vendor_claim | …",
      "published_date": "YYYY-MM-DD",
      "sources": [
        {
          "url": "https://…",
          "title": "…",
          "publisher": "example.com",
          "retrieved": "YYYY-MM-DD",
          "source_class": "primary"
        }
      ]
    }
  ],
  "spotlight": {
    "label": "Agent of the week",
    "title": "…",
    "text": "Paragraphs, separated by blank lines (optional)"
  },
  "board": [{ "role": "…", "change": "…", "note": "…" }],
  "conflicts": [
    {
      "title": "What the two sources disagree on",
      "a": { "claim": "…", "source": { "url": "https://…", "title": "…" } },
      "b": { "claim": "…", "source": { "url": "https://…", "title": "…" } },
      "status": "open",
      "note": "Why it is still open (optional)"
    }
  ],
  "sources": [
    {
      "url": "https://…",
      "title": "…",
      "publisher": "…",
      "retrieved": "YYYY-MM-DD",
      "source_class": "…"
    }
  ],
  "past": [{ "week": "2026-W44", "url": "https://…", "headline": "…" }]
}
```

Rules:

- **`changes` holds committed findings only**: each `finding` names a `Finding:` episode in
  the vault group, and vault-commit checks every one again before it publishes. A row that
  is still pending, escalated or rejected never appears, and neither does anything from
  another group.
- Every change has at least one source with an `http(s)` URL; `retrieved` dates are
  `YYYY-MM-DD`. `sources` lists every source the week's changes and conflicts cite, once.
- `conflicts` are the week's conflicts, each side with its own source: resolved ones from
  `Conflict:` episodes, and open ones from the Console's escalated `conflict` rows (a conflict
  left open never becomes an episode), with `status: "open"`. An open side is a source's claim,
  not a finding, and never appears in `changes`.
- `spotlight` and `board` are for vaults whose charter has a role taxonomy (`applies_to:
roles`); leave them out otherwise.
- `past` lists earlier published briefs, newest first, from the `briefs` rows with
  `published_at`.
- Text is plain: the page shows it as written, never as HTML or Markdown, and only `http(s)`
  URLs become links.

## graph.json

Everything the vault group holds, for the Graph page. Written by `vault-pages.cjs export`.

```json
{
  "schema": 1,
  "vault": { "name": "Example Vault", "slug": "example-vault", "group_id": "vault_example_vault" },
  "exported_at": "2026-11-06T13:00:00Z",
  "nodes": [
    [
      "Finding:Acme-Coder-2.0",
      "Acme Coder 2.0 is generally available",
      "Finding",
      "summary…",
      { "status": "current" },
      412,
      -96
    ]
  ],
  "facts": [
    [
      "1a2b3c4d-0000-4000-8000-000000000001",
      "DRAWN_FROM",
      "The finding … is drawn from …",
      "Finding:Acme-Coder-2.0",
      "SourceDocument:…",
      "2026-11-03",
      0
    ]
  ],
  "stats": {
    "episodes": 18,
    "ambiguous": 3,
    "unresolved": 0,
    "by_default": 0,
    "pinned": 0,
    "more_in_memory": false
  }
}
```

- `nodes`: `[id, name, type, summary, attributes, x, y]`. The id is memory's node id without
  the group prefix; type is the node's first label other than `Entity`; the summary is cut at
  1,400 characters; `email` attributes are dropped. `x` and `y` are whole numbers from -1000
  to 1000.
- `facts`: `[id, relation, fact text, source id, target id, valid date, superseded]`, where
  `id` is the fact's full uuid (or its id when it has no uuid), unique in the file, and
  `superseded` is `1` when the fact has an `invalid_at` or `expired_at`.
- Some node ids name more than one node. The export settles each fact's endpoint by matching
  the fact's words against the candidates' names (`stats.ambiguous` counts those), and the
  page marks them "endpoint inferred". Facts whose endpoint isn't in the export are dropped
  (`stats.unresolved`).
- `stats.by_default` counts facts credited to an agent by default (their episode named no
  writer); `stats.pinned` counts nodes `--previous` kept in place.
- `stats.more_in_memory` is `true` when `get_episodes` said the group holds more episodes than
  it listed; the pages then cover the newest ones, and the export's summary line says so.

## timeline.json

The same memory as events in time, for the Timelapse page (and for any tool that scores or
replays it). Written by `vault-pages.cjs export` alongside `graph.json`.

```json
{
  "schema": 1,
  "vault": { "name": "Example Vault", "slug": "example-vault" },
  "start": "2026-11-02T00:00:00Z",
  "agents": [{ "id": "Agent:vault-scout", "name": "vault-scout", "about": "Researches one beat…" }],
  "types": ["Beat", "Finding", "…"],
  "rels": ["DRAWN_FROM", "…"],
  "nodes": [[412, -96, 1, "Acme Coder 2.0 is generally available", 1547, 2, 4]],
  "facts": [[3, 7, 0, 1547.5, 2, 0, "The finding … is drawn from …"]],
  "days": [{ "day": 1, "date": "2026-11-03", "events": 22 }],
  "stats": {
    "exportedAt": "…",
    "episodes": 18,
    "nodes": 29,
    "facts": 50,
    "invalidated": 1,
    "agentFacts": 20,
    "lone": 1,
    "ambiguous": 3,
    "unresolved": 0
  }
}
```

- `start` is midnight UTC of the earliest episode, fact or node. Every `minute` counts from it.
- `nodes`: `[x, y, type index, name, minute it appears, agent index, weight]`. Agent nodes are
  not here: they are the `agents`. `weight` is the node's number of current facts.
- `facts`: `[source, target, relation index, minute, agent index, superseded, text]`. An
  endpoint `≥ 0` is a node index; a negative endpoint `-1 - i` is agent `i`. The text is cut
  at 600 characters.
- `days`: one marker per day with events, `day` counted from `start`.
- The agents come first in the vault's own order (charter, scout, librarian, reviewer, brief,
  with `vault-curate` kept in its old place for older vaults whose episodes carry that legacy
  identity), then any other identity that wrote an episode, by name.

## The export's input

`export --in` takes one file or a folder of `.json` and `.txt` files, each one of:

- a tool result as the memory server returned it: the `get_episodes` result (`episodes`),
  a `get_nodes_and_edges_by_episode` result (`nodes`, `facts`), as the JSON body, an MCP
  content array whose text items hold the body, or wrapped as `{result: …}` or
  `{payload: …}`;
- one combined object `{vault, episodes, nodes, facts}`.

A file the script can't use is skipped and named with the reason: an error result
(`isError`, or a body that is only an `error`), a text item that isn't JSON (one such item
makes the whole file unreadable), or no episodes, nodes or facts in it.

Episodes, nodes and facts read more than once are merged: one copy each (by uuid, or by id
and name for nodes), chosen the same way whatever order the files were read in. A node keeps
its longest summary; a fact keeps the read that shows it superseded, then the later end. A
graph fact's id is its full uuid (or id), and `check` refuses a graph.json that repeats one,
because the page draws one fact per id. `skills/vault-pages/fixtures/raw-export.json`
is a complete example for the invented vault the page fixtures come from.
