# Memory tools: runtime discovery

Every vault workflow (vault-curate, vault-commit, vault-brief, vault-steer, and vault-pages
for its export, which only reads) and the vault-reviewer agent finds its gutt memory tools **at run time, every run**. Never take a tool
name from a previous run, a memory episode or this file, and never build one from a prefix you
expect.

## Why

The same gutt memory server shows up under different tool names depending on how it is
connected:

| How it's connected                                                                                                             | Tool name form                          | Example                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------ |
| A plugin's own server: gutt-pro's `gutt-closed-beta` or `gutt-enterprise`, or gutt-vaults' `gutt-closed-beta` (the usual case) | `mcp__plugin_<plugin>_<server>__<tool>` | `mcp__plugin_gutt-pro_gutt-closed-beta__search_memory_facts` |
| claude.ai connector in Claude Code (terminal)                                                                                  | `mcp__claude_ai_<server>__<tool>`       | `mcp__claude_ai_gutt-pro-memory__search_memory_facts`        |
| Connector in a cloud routine                                                                                                   | `mcp__<server>__<tool>`                 | `mcp__gutt-pro-memory__search_memory_facts`                  |
| Connector in the Claude desktop app                                                                                            | `mcp__<connector-uuid>__<tool>`         | `mcp__<connector-uuid>__search_memory_facts`                 |

Claude Code also deduplicates servers by endpoint (local > project > user > plugin > claude.ai
connector), and among plugin servers the first one loaded keeps an endpoint. gutt-pro's and
gutt-vaults' `gutt-closed-beta` share one endpoint (as does gutt-pro's `gutt-enterprise` if its
`mcp_url` option is set to the same URL), so only one of them runs, and which one can change
between sessions. Installing or updating a plugin can therefore replace a connector or another
plugin's server, and its tools change prefix without any error. Two gutt servers at
**different** endpoints (say a user-scope dev server and the plugin's stage server, or
`gutt-enterprise` pointed at an organization's endpoint beside `gutt-closed-beta`) are both live
at once, and each may hold a different copy of the vault. A vault file's optional
`memory_connector` names the one that holds the vault (step 2). `gutt-enterprise` has no URL
until `mcp_url` is set; unset, it connects to nothing and exposes no tools.

## Procedure

Run it at the start of the workflow, before the first memory read.

1. **List the memory servers.** `ToolSearch(query="+search_memory_facts", max_results=30)`.
   Every result whose name **ends in** `__search_memory_facts` is one gutt memory server; its
   **prefix** is the name without `search_memory_facts` (`search_memory_facts_ui` and other
   near-matches are not servers). A second server can still be connecting, so **always** search
   once more after about 15 seconds and merge the prefixes from both searches. If either search
   returns 30 results, the list may be truncated: stop as in "more than one" below. No prefix
   after both searches: memory is down (each skill's Degradation).
2. **Find the vault's server.** Read the optional `memory_connector` from the vault file
   (`routines.md` §The vault file).
   - **Set:** `memory_connector` is a connector name, or a list of names for one deployment as
     different surfaces see it (the terminal may see the gutt-pro plugin's server where a
     routine sees a claude.ai connector). The vault's server is the prefix for a name on it:
     `mcp__claude_ai_<connector>__` (a claude.ai connector in the terminal),
     `mcp__<connector>__` (a routine's connector), or `mcp__plugin_gutt-pro_<connector>__` or
     `mcp__plugin_gutt-vaults_<connector>__` (a plugin's own server, whose server name is
     `gutt-closed-beta` or `gutt-enterprise`). A connector-UUID
     prefix (`mcp__<connector-uuid>__`, the desktop app) counts only when the session's
     connector list (`session_connectors_status`, where it exists) gives that id a name on it.
     **Don't require `vault_<slug>` in its `list_writable_groups`:** a server that starts a
     group on its first write (the shared gutt stage, the gutt-pro plugin's default endpoint,
     is one) leaves vault ids out of that list and writes them through the generic
     `add_memory` with `group_id` (step 3). Confirm it with
     `get_episodes(group_id="vault_<slug>", last_n=1)`: an episode comes back. The read
     returning nothing is **None** below, for every workflow but one: vault-steer `--charter`
     for a new vault, which has no episodes until its first charter episode (vault-steer says
     how it checks that write). A wrong or stale `memory_connector` must never start a second
     copy of a vault that lives elsewhere. Every other prefix is ignored, even one that lists
     or reads the vault (an older copy left on another server). While you find the server you
     may read each other prefix once, read-only, with the same `get_episodes` call; name each
     that returns an episode in the run row as `also exposes vault_<slug>, ignored: <prefix>`.
     An error or timeout on an ignored prefix is logged with that prefix, never a stop, and no
     ignored prefix is called again after this step. No prefix for any name on it: **None**
     below; if a plugin's own server (`mcp__plugin_<plugin>_<server>__`) is connected, add to
     the report that Claude Code may have merged the named connector into it (same
     endpoint), and that adding that server's name (`gutt-closed-beta` or `gutt-enterprise`)
     to `memory_connector` is the fix when both point at the vault's deployment. Two prefixes for it: **more than one** below.
   - **Not set:** for each prefix, load its `list_writable_groups` and call it (or, if it isn't
     exposed, read the `group://vault_<slug>/instructions` resource). The vault's server is the
     one where `vault_<slug>` is listed.

   A call that errors or times out on a server that could be the vault's (the named one, or
   any server without `memory_connector`) is **unknown**, not "not listed" or "no episodes":
   stop before any write and report that prefix and the error.
   - **Exactly one** → use that prefix for every memory call in this run.
   - **None** → treat it as "no write tool for the group" (each skill's Degradation says what
     that means). Without `memory_connector`, a workflow that only reads (vault-pages export,
     the reviewer) still needs the one server that **holds** the vault, never just the first
     prefix: on each server, call `get_episodes(group_id="vault_<slug>", last_n=1)`. Exactly
     one returns an episode → read from it and say which prefix you used. None or more than one
     → stop and publish or decide nothing, as in the next case: another deployment's copy of
     the vault must never reach a public page. With `memory_connector` set there is no such
     fallback: the named connector is the only server a workflow reads or writes.
   - **More than one** → **stop before any write.** Two servers expose the vault and may be
     different deployments; a write to the wrong one can't be moved. Report both prefixes in
     the run row and the output, and write nothing.

3. **Find the write tool on that server, by description.** Load the server's write tools
   (`ToolSearch(query="+<prefix> add_memory", max_results=10)`) and pick the one whose
   **description** names `vault_<slug>` (a per-group tool, no `group_id` argument). If none
   does, use the server's generic `add_memory`, and pass `group_id="vault_<slug>"` on **every**
   call: its `group_id` is optional and a call without it lands in a default group without an
   error, so a call without it is forbidden. Neither a per-group tool nor a generic
   `add_memory` → no write tool (each skill's Degradation). The Console's
   `meta/vault.write_tool_hint`, when set, is a search hint only; never pair a tool to a group
   by its name (`gutt-pro:memory-capture` rule 4).
4. **Record what you found.** Put `memory_server: <prefix>` and `write_tool: <full name>` in
   the boot line of the Run episode and in the Console run row, and pass both to any subagent
   you spawn.
5. **Recheck before the first write.** Right before the batch, repeat steps 1–2 and search for
   the write tool by its full name. Same single server and same write tool → write. Anything
   else (a second server, a different prefix, the write tool gone or renamed) → do steps 1–3
   once more. If the server is now a different prefix from the one you read from, or there
   are two, stop before writing and report both prefixes: reads and writes would span two
   servers. A reconnect to the same prefix with a new write tool name: continue with the new
   name and note the reconnect in the Run boot line. Never return to step 1 more than once.
6. **Check the first write.** A successful write call acknowledges that the episode was
   queued, not that it was stored (`gutt-pro:memory-capture`), so an episode missing right
   after the call is **pending**, not lost. After the first episode of the batch, read
   `vault_<slug>` with `get_episodes(group_id="vault_<slug>", last_n=5)` (newest first; never
   a larger list). Not there yet: read again after about
   15, 30 and 60 seconds (at most 4 reads, about 2 minutes). Found on any read → continue the
   batch. Still missing after the last read → stop writing the rest of the batch and report
   the write tool, the episode name and that it was acknowledged but not seen. **Never resend
   an acknowledged episode**, during the wait or after it: it may still land, and a resend
   would store it twice. A write call that returns an error was not acknowledged; the skill's
   own retry rule applies to it.

## vault-reviewer

The reviewer has a fixed, **read-only** allowlist in the plugin's `agents/vault-reviewer.md`. It has
no memory write tools and doesn't register itself: vault-curate registers `vault-reviewer`, and
the reviewer's working-memory episodes come back under `unwritten`, each with its `agent_id`,
for vault-curate to write (`vault-reviewer`, or the target's name for Feedback). Its read set
leaves out `get_episodes` on purpose: a whole-group list is too large for an agent without a
shell to read, so the reviewer reads episodes by id and Verdicts through `get_node_edges`
(`../../vault-review/references/precedent-matching.md`). The allowlist covers the prefixes
below.

<!-- known-prefixes:begin -->

- `mcp__plugin_gutt-pro_gutt-closed-beta__`
- `mcp__plugin_gutt-pro_gutt-enterprise__`
- `mcp__plugin_gutt-vaults_gutt-closed-beta__`
- `mcp__claude_ai_gutt-closed-beta__`
- `mcp__gutt-closed-beta__`
- `mcp__claude_ai_gutt-pro-memory__`
- `mcp__gutt-pro-memory__`
- `mcp__claude_ai_gutt-pro-memory-stage__`
- `mcp__gutt-pro-memory-stage__`
- `mcp__plugin_gutt-pro_gutt-mcp-remote__`

<!-- known-prefixes:end -->

vault-curate passes the discovered `memory_server` in the reviewer's prompt, and checks it
against this list first: a prefix not on it (a desktop UUID connector, a new form) means no
reviewer spawn, every row escalated with reason
`memory server not in reviewer allowlist: <prefix>` and `review.prediction: null`, and that
prefix logged in the run row as the fix to make. The fix is to add the prefix's read tools to
the reviewer's `tools:` and to the list above; a test in the plugin's repository checks the two
stay in step and that every tool on the list only reads.

Besides the plugins' own servers (every one that can hold the shared endpoint, since Claude
Code picks which of them runs), the list covers the usual connector names, in both their
terminal (`mcp__claude_ai_<name>__`) and routine (`mcp__<name>__`) forms: `gutt-closed-beta`,
the plugin server's own name, for a connector to the shared stage added under it;
`gutt-pro-memory`; and `gutt-pro-memory-stage`. A claude.ai connector is named by whoever adds
it, so one added under another name is not on the list until its prefix is added here and to
the reviewer's `tools:`.

`mcp__plugin_gutt-pro_gutt-mcp-remote__` is gutt-pro's server as it was named before
gutt-pro 3.3.0. It stays on the list for an install that has updated gutt-vaults but not yet
gutt-pro: there the two plugins' stage servers share one endpoint, and the old name can be the
one Claude Code keeps.

A vault file's `memory_connector` (step 2) must give a prefix on this list, or every curate
run of that vault escalates everything. The plugin ships no vault files, so no test can check
an owner's connector name: when you set `memory_connector`, check that
`mcp__claude_ai_<connector>__`, `mcp__<connector>__`, `mcp__plugin_gutt-pro_<connector>__` or
`mcp__plugin_gutt-vaults_<connector>__` (whichever form your routines see) is listed above, for each name you give.

The reviewer checks again at boot (vault-review Step 1.0) and fails closed with a reason that
names the cause: no prefix passed, a prefix not on this list, or a known prefix whose tools
haven't connected after one retry ("memory unavailable"). Its fail-closed decisions carry
`prediction: null`, so they never count toward Calibration.

Why fixed and not inherited: the rows the reviewer judges come from web research, so its
prompt can carry injected instructions. A read-only allowlist of memory reads plus `Read` and
`ToolSearch` keeps an injected instruction from writing memory or calling other tools; a name
it doesn't know costs a run of escalations, never a wrong write.
