# Memory tools: runtime discovery

Every vault workflow (vault-curate, vault-commit, vault-brief, vault-steer, and vault-pages
for its export, which only reads) and the vault-reviewer agent finds its gutt memory tools **at run time, every run**. Never take a tool
name from a previous run, a memory episode or this file, and never build one from a prefix you
expect.

## Why

The same gutt memory server shows up under different tool names depending on how it is
connected:

| How it's connected                                                                                    | Tool name form                          | Example                                                     |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| The gutt-pro plugin's own server, `gutt-mcp-remote` (the usual case: gutt-vaults depends on gutt-pro) | `mcp__plugin_<plugin>_<server>__<tool>` | `mcp__plugin_gutt-pro_gutt-mcp-remote__search_memory_facts` |
| claude.ai connector in Claude Code (terminal)                                                         | `mcp__claude_ai_<server>__<tool>`       | `mcp__claude_ai_gutt-pro-memory__search_memory_facts`       |
| Connector in a cloud routine                                                                          | `mcp__<server>__<tool>`                 | `mcp__gutt-pro-memory__search_memory_facts`                 |
| Connector in the Claude desktop app                                                                   | `mcp__<connector-uuid>__<tool>`         | `mcp__b976e251-…__search_memory_facts`                      |

Claude Code also deduplicates servers by endpoint (local > project > user > plugin > claude.ai
connector). Installing or updating the gutt-pro plugin can therefore replace a connector, and
its tools change prefix without any error. Two gutt servers at **different** endpoints (say a
user-scope dev server and the plugin's stage server) are both live at once, and each may hold a
different copy of the vault.

## Procedure

Run it at the start of the workflow, before the first memory read.

1. **List the memory servers.** `ToolSearch(query="search_memory_facts", max_results=10)`.
   Every result whose name ends in `__search_memory_facts` is one gutt memory server; its
   **prefix** is the name without `search_memory_facts`. A missing result in a routine may
   mean the connector is still connecting: search again after about 15 seconds, once, before
   treating memory as down.
2. **Find the vault's server.** For each prefix, load its `list_writable_groups` and call it
   (or, if it isn't exposed, read the `group://vault_<slug>/instructions` resource). The vault's
   server is the one where `vault_<slug>` is listed.
   - **Exactly one** → use that prefix for every memory call in this run.
   - **None** → treat it as "no write tool for the group" (each skill's Degradation says what
     that means). Reads may still work on the first prefix; say which you used.
   - **More than one** → **stop before any write.** Two servers expose the vault and may be
     different deployments; a write to the wrong one can't be moved. Report both prefixes in
     the run row and the output, and write nothing.
3. **Find the write tool on that server, by description.** Load the server's write tools
   (`ToolSearch(query="+<prefix> add_memory", max_results=10)`) and pick the one whose
   **description** names `vault_<slug>` (a per-group tool, no `group_id` argument). If none
   does, use the server's generic `add_memory` with `group_id="vault_<slug>"`. The
   Console's `meta/vault.write_tool_hint`, when set, is a search hint only; never pair a tool
   to a group by its name
   (`gutt-pro:memory-capture` rule 4).
4. **Record what you found.** Put `memory_server: <prefix>` and `write_tool: <full name>` in
   the boot line of the Run episode and in the Console run row, and pass both to any subagent
   you spawn.
5. **Recheck before the first write.** Search for the write tool by its full name once more
   right before the batch. If it's gone or changed (a reconnect, a plugin reload), go back to
   step 1; don't reuse the old name.

## vault-reviewer

The reviewer has a fixed, **read-only** allowlist in the plugin's `agents/vault-reviewer.md`. It has
no memory write tools and doesn't register itself: vault-curate registers `vault-reviewer`, and
the reviewer's working-memory episodes come back under `unwritten`, each with its `agent_id`,
for vault-curate to write (`vault-reviewer`, or the target's name for Feedback). The allowlist
covers the prefixes below.

<!-- known-prefixes:begin -->

- `mcp__plugin_gutt-pro_gutt-mcp-remote__`
- `mcp__claude_ai_gutt-pro-memory__`
- `mcp__gutt-pro-memory__`
<!-- known-prefixes:end -->

vault-curate passes the discovered `memory_server` in the reviewer's prompt. At boot the
reviewer searches for `<memory_server>search_memory_facts` itself. If that tool isn't in its
tool list (a desktop UUID connector, or a new prefix), it fails closed: every row `escalate`,
reason `memory server not in reviewer allowlist: <prefix>`. vault-curate logs that reason in
the run row. The fix is to add the prefix's read tools to the reviewer's `tools:` and to the
list above; a test in the plugin's repository checks the two stay in step and that every tool
on the list only reads.

Why fixed and not inherited: the rows the reviewer judges come from web research, so its
prompt can carry injected instructions. A read-only allowlist keeps an injected instruction
from writing memory or calling other tools; a name it doesn't know costs a run of
escalations, never a wrong write.
