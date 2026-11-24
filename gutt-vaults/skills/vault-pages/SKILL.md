---
name: vault-pages
description: "Builds and publishes a public research vault's shareable pages from the plugin's templates: the weekly Brief page (brief.json), the Graph page (graph.json) and the Timelapse page (timeline.json), plus the owner's Console. Exports the vault group's episodes, nodes and facts into graph.json and timeline.json with a layout that stays put from week to week, checks every data file against its contract, and previews any page on localhost. Used by vault-commit (Brief page, after the owner approves) and vault-brief (Graph and Timelapse, weekly); the owner can also run it to preview a page or set up a new vault's pages. Triggers on: vault pages, publish the vault graph, republish the timelapse, preview the brief page, export the vault graph."
argument-hint: "<slug> <export|publish <page>|preview <page>|check <page> <file>>"
---

# Vault pages

A vault has four pages, each one copy of a template in this plugin's `templates/` folder with
the vault's own `<title>` and data file next to it:

| Page      | Template               | Data file               | Published by                                            | URL kept in                    |
| --------- | ---------------------- | ----------------------- | ------------------------------------------------------- | ------------------------------ |
| Brief     | `templates/brief/`     | `brief.json`            | vault-commit, after the owner approves the week's brief | `meta/vault.brief_url`         |
| Graph     | `templates/graph/`     | `graph.json`            | vault-brief, weekly                                     | `meta/vault.graph_url`         |
| Timelapse | `templates/timelapse/` | `timeline.json`         | vault-brief, weekly                                     | `meta/vault.timelapse_url`     |
| Console   | `templates/console/`   | none (its own database) | vault-steer `--charter`, once per vault                 | the vault file's `console_url` |
| Digest    | `templates/brief/`     | `brief.json` (digest)   | vault-follow, weekly, for one reader                    | the reader's digest routine    |

A Digest isn't a vault page: it belongs to a reader who follows the vault, and
`vault-follow` publishes it with `prepare digest`.

The pages are vault-agnostic: everything about the vault comes from the data file (or, for
the Console, from `meta/vault`). The data contracts are in `references/page-data.md`.

## The script

Every step below runs `scripts/vault-pages.cjs` (Node.js 18 or later, no dependencies). The
Bash tool doesn't inherit `CLAUDE_PLUGIN_ROOT`, so build the path yourself from the "Base
directory for this skill" line in your preamble:

```bash
node "<SKILL_DIR>/scripts/vault-pages.cjs" <command> …
```

From vault-commit or vault-brief, `<SKILL_DIR>` is that skill's own base directory with
`/../vault-pages` appended. `node "<SKILL_DIR>/scripts/vault-pages.cjs" help` lists every
option.

Work in one folder per run, `<work>` (your scratchpad when the host gives you one, else a new
temporary folder). Never write into the plugin's own folder.

## Export

Turns the vault group's memory into `graph.json` and `timeline.json`.

1. **Find the memory tools** per `../vault-curate/references/memory-tools.md` (names are found
   at run time, never assumed).
2. **List the episodes**: one `get_episodes` call with `group_id="vault_<slug>"` and
   `last_n=1000`. One call only: the server ignores an offset, so a second page repeats the
   newest episodes. If it reports more than 1,000, say so in your Run; the export then covers
   the newest 1,000.
3. **Read their nodes and facts**: `get_nodes_and_edges_by_episode` with up to 10 episode ids
   per call, every batch. A batch that fails: retry it once. Still failing: save its raw
   result anyway (step 4), so the script reports the file as skipped, and name the batch's
   episodes as missing from the pages in your Run.
4. **Save what came back, unchanged**, as JSON files in `<work>/export/`: the episode list as
   `episodes.json`, each batch as `batch-<n>.json`. When the host already saved a large result
   to a file, copy that file in as it is. The script reads the tool's own result shapes (the
   JSON body, an MCP content array, or a `{result: …}` wrapper); don't reshape anything by
   hand, and never add, drop or edit a node or fact.
5. **Get last week's layout**: if `meta/vault.graph_url` is set, read that artifact's
   `graph.json` (Artifact `read` with `url` and `path: "graph.json"`) into
   `<work>/previous/graph.json`, and pass it as `--previous`. The two ways to export without
   it are not the same:
   - **No URL yet**: the vault's first Graph. Export without `--previous` and say "first
     layout" in your Run.
   - **The read fails**: every node on the public Graph will move. Export without
     `--previous` only after one retry, and record "layout reset: previous graph.json
     unreadable (<reason>)" in your Run and the output contract.

   Never pass `--previous` with a path you didn't just write: the script stops when that file
   is missing rather than quietly laying the graph out again.

6. **Run the export**:

   ```bash
   node "<SKILL_DIR>/scripts/vault-pages.cjs" export --in "<work>/export" --out "<work>/pages" \
     --name "<vault name>" --slug <slug> [--previous "<work>/previous/graph.json"]
   ```

   It prints the counts (episodes, nodes, facts, superseded facts, agents, days, nodes kept
   in place by `--previous`) and every warning: facts dropped because an endpoint wasn't in
   the export, endpoints settled by name, facts credited to an agent by default, files it
   skipped and why, and whether memory held more episodes than were listed. Put the whole
   line in your Run; the output contract has a slot for each warning. It exits 1, and you
   publish neither page, when the export holds nothing to draw.

What the export decides, so you can explain a page: a fact's time is when memory recorded it;
its agent is the one that wrote the episode it came from: the episode's own `agent_id` (or
`agent`) field first, then its `Recorded by`, `Tagged` or `Written by` line, then its name
(`Run: vault-scout …` and `Feedback: <agent> →` name the agent; `Charter:`, `Steering:` and
`Config:` belong to vault-charter, `Brief:` and `LinkedIn:` to vault-brief, `Calibration:` to
vault-reviewer), else vault-librarian, counted as a default in the export line. A node appears
at its first fact or its own creation, whichever is earlier. Agent nodes become the
Timelapse's actors. The layout is seeded from each
node's id, so the same memory always gives the same picture, and `--previous` keeps every
node that was on last week's Graph exactly where it was.

## Publish a page

For page `brief`, `graph`, `timelapse` or `console`:

1. **Have the data file** in `<work>/pages/`: `brief.json` from the Console row's `page`
   field, written as is; `graph.json` and `timeline.json` from §Export. The Console has none.
2. **Check and copy** the page into its own folder:

   ```bash
   node "<SKILL_DIR>/scripts/vault-pages.cjs" prepare <page> --title "<vault name> <Brief|Graph|Timelapse|Console>" \
     --out "<work>/publish/<page>" [--data "<work>/pages/<data file>"]
   ```

   It refuses a data file that breaks its contract and lists what is wrong. Fix nothing by
   hand: report the problems and stop for that page.

3. **Publish** with the Artifact tool:
   Where the URL lives: `meta/vault.<page>_url` for the Brief, Graph and Timelapse; the
   vault file's `console_url` for the Console, which can't hold its own address.
   - **The page has a URL**: first `read` that URL (a publish to an artifact
     this session hasn't read is refused), then `publish` with that `url`,
     `file_path: "<work>/publish/<page>/index.html"` and `files` mapping the data file's name
     to its path (`{"brief.json": "<work>/publish/brief/brief.json"}`). No `icon` on an
     update.
   - **No URL yet**: `publish` without `url`, with the same `file_path` and `files`, `icon`
     (`newspaper` for the Brief, `graph` for the Graph, `play` for the Timelapse, `inbox` for
     the Console) and a one-sentence `description`. The Console also passes the capabilities
     in `../vault-curate/references/console-data.md`. Then record the new URL so the next
     run updates the same page: for the Brief, Graph or Timelapse, `meta/vault.<page>_url` on
     the Console with `ArtifactData` (`update`); for the Console, the vault file's
     `console_url`, then seed the new Console's `meta/vault`
     (`../vault-curate/references/console-data.md`).
   - Never pass `force`. If the publish is refused because the page changed since you read
     it, report "not republished: the page changed since it was read" and leave it for the
     next run or the owner.

4. **Report** the URL, or why there is none, in your Run.

**No Artifact tool** (some routine hosts have none): don't publish. Leave the prepared folder
where it is, say "not published: no Artifact tool in this run" in your Run, and the owner can
publish it by hand.

These pages are public once the owner shares them. Publish only what the contracts allow: the
Brief page carries committed findings only, and the Graph and Timelapse carry exactly what the
vault group holds, never another group's memory.

## Preview

The owner can look at any page before it goes out, with its fixture or their own data:

```bash
node "<SKILL_DIR>/scripts/vault-pages.cjs" preview <brief|graph|timelapse|console> [--data <file>] [--port 8765]
```

It serves the page on `127.0.0.1` only. The Console preview runs on a stand-in for the
Artifact runtime with sample rows, so its buttons work but save nothing.

## Grounding Protocol

- **Reads only.** This skill reads the vault group (`get_episodes`,
  `get_nodes_and_edges_by_episode`) and writes no memory. The only Console write is a page
  URL into `meta/vault` (and, for a new Console, its first `meta/vault`); the only repo write
  is a new Console's URL into the vault file.
- **One vault, named by its slug.** The group is `vault_<slug>`; never export or publish
  another group's memory on a vault's page.
- **Data comes from memory or from the owner's approved row, never from you.** The script
  shapes it; you don't edit a data file, a node, a fact or a source. A contract failure stops
  that page and is reported.
- **Pages are published from this plugin's templates only.** Don't edit a template's markup or
  script for one vault; the `<title>` is the only per-vault change, and `prepare` makes it.

## Output contract

```
vault <slug> pages: <page> <url | prepared in <folder>, not published (<reason>) | failed: <problems>> …
export: <n> episodes · <n> nodes · <n> facts (<n> superseded) · <n> agents · <n> days · dropped <n>
        · layout <kept <n> nodes | first layout | reset (<reason>)> · credited by default <n>
        · skipped <n> files (<names and reasons>) · <truncated to the newest 1,000 episodes | complete>
```
