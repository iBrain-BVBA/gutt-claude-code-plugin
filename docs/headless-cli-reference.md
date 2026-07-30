# Headless `claude -p` (upstream)

**Source:** <https://code.claude.com/docs/en/headless.md>
**Read:** 2026-07-30 · **Measured:** 2026-07-30 (§2 auth, §7 cost) · **Method:** one
`WebFetch` pass returning the page verbatim, plus local runs against `claude` 2.1.220 for
§2, §4 and §7 (see [Provenance](#provenance))
**Why this file exists:** GP-866 moves the Stop capture judge from a `type: "prompt"` hook
to a command hook that invokes the model itself by shelling out to `claude -p`. That makes
this page load-bearing: the flags here are the whole contract for how the judge is called,
bounded, and parsed.

Companion to `docs/hook-platform-capabilities.md`, which establishes _why_ the judge has to
move (§6: a prompt hook's field is not shell-expanded; §7: a command sibling cannot gate it).

## 1. What `-p` loads, and `--bare`

Verbatim: "Add `--bare` to reduce startup time by skipping auto-discovery of hooks, skills,
plugins, MCP servers, auto memory, and CLAUDE.md. Without it, `claude -p` loads the same
context an interactive session would, including anything configured in the working
directory or `~/.claude`."

And: "`--bare` is the recommended mode for scripted and SDK calls, and will become the
default for `-p` in a future release."

In bare mode Claude still has Bash, file-read and file-edit tools. Context must be passed
explicitly:

| To load                 | Use                                                     |
| ----------------------- | ------------------------------------------------------- |
| System prompt additions | `--append-system-prompt`, `--append-system-prompt-file` |
| Settings                | `--settings <file-or-json>`                             |
| MCP servers             | `--mcp-config <file-or-json>`                           |
| Custom agents           | `--agents <json>`                                       |
| A plugin                | `--plugin-dir <path>`, `--plugin-url <url>`             |

## 2. `--bare` cannot authenticate on a subscription install — and that decides our design

Verbatim: "Bare mode skips OAuth and keychain reads. For Anthropic authentication, set
`ANTHROPIC_API_KEY` or configure an `apiKeyHelper` in the JSON you pass to `--settings`."

**Checked locally 2026-07-30 on this machine:** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX` are all unset,
and no `apiKeyHelper` appears in `~/.claude/settings.json` or `settings.local.json`. This is
an OAuth/subscription install, which is also what `tests/e2e/lib/claude-run.cjs` assumes —
it **scrubs** those keys precisely so a run cannot be billed to an API key.

**Consequence, and it is the awkward one:** the mode upstream recommends for scripted calls
is the one mode a subscription-authenticated plugin cannot use. So the judge child must run
**non-bare**, which means it loads `~/.claude` config, every installed plugin, and therefore
**our own hooks — including the Stop hook that spawned it.** Recursion is not hypothetical;
it is the default. The guard has to be ours: an env var set on the child that our hooks check
and exit on. `--bare` is not available to do it for us.

Two further reasons the guard must cover more than Stop: a non-bare child fires
`SessionStart`/`UserPromptSubmit` too, writing session records and polluting
`${CLAUDE_PLUGIN_DATA}`; and on SIGTERM (§5) the child runs `SessionEnd` hooks on the way out.

## 3. Structured output — `--json-schema` beats parsing prose

`--output-format` takes `text` (default), `json` (single result), `stream-json`.

With `--output-format json` the payload carries "result, session ID, and metadata", and
`total_cost_usd` plus a per-model cost breakdown, "so scripted callers can track spend per
invocation".

Better for a judge: "To get output conforming to a specific schema, use
`--output-format json` with `--json-schema` and a JSON Schema definition. The response
includes metadata about the request (session ID, usage, etc.) with the structured output in
the `structured_output` field."

This is the field to read for a verdict — a schema-constrained `{ok, reason}` rather than a
regex over `result`. Caveats quoted: an invalid schema exits with
`Error: --json-schema is not a valid JSON Schema`; `format` is accepted but treated as an
annotation and **not enforced**. Before v2.1.205 an invalid schema was silently ignored and
returned unstructured text — so pin a version assumption or tolerate a missing field.

## 4. Bounding the run

- **Prompt size / stdin.** `-p` reads stdin, so material can be piped instead of passed in
  argv. Piped stdin is capped at **10MB** (v2.1.128+); over the cap it exits non-zero with a
  clear error. Preferable to argv for anything variable-length — argv has an OS limit of its
  own and needs quoting.
- **Permissions.** `--allowedTools` / `--disallowedTools`, or a baseline via
  `--permission-mode`. `dontAsk` "denies anything not in your `permissions.allow` rules or the
  read-only command set, which is useful for locked-down CI runs", and denies
  `AskUserQuestion` outright even when an allow rule matches. A judge should need no tools at
  all.
- **No `--max-turns` on this page.** Not documented here; do not assume it.
- **`--max-budget-usd <amount>`** — "Maximum dollar amount to spend on API". Not on this page;
  found in `claude --help` on 2.1.220. It reads like the right primary bound for a per-turn
  judge, and it is not: §7 measured it aborting the run with exit 1, an empty `result` and
  `structured_output: null`, while still billing what it had spent. **GP-866 deliberately does
  not set it** — a judge that sometimes returns no verdict is worse than a judge that
  occasionally costs more, and the spawn timeout (30s) is the bound we rely on.
- **`--json-schema` confirmed present on 2.1.220** (`claude --help`), the version measured in
  `hook-platform-capabilities.md` §5–§7. So §3's caveat about pre-2.1.205 silent-ignore does
  not apply to this install.

## 5. Exit and signal behaviour

- SIGTERM — "Claude Code aborts the in-progress turn, terminates the process tree of any
  running Bash command, runs `SessionEnd` hooks, and exits with code **143**." So a timeout
  kill is not silent: it runs hooks in the child. See §2.
- Background Bash tasks are killed ~5s after the final result. Background subagents and
  workflows are waited for, capped at ten minutes by default
  (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, `0` for no limit).
- Unreadable stdin logs a warning to stderr and continues with the argv prompt.

## 6. Other fields worth knowing

- `system/api_retry` stream events carry `attempt`, `max_retries`, `retry_delay_ms`,
  `error_status`, and an `error` category — including `authentication_failed`,
  `model_not_found`, `rate_limit`, `overloaded`. Useful to distinguish "judge failed to
  authenticate" from "judge said nothing".
- `system/init` reports `plugins` / `plugin_errors` and `mcp_servers` / `mcp_server_errors`,
  so a run can detect that a plugin never loaded rather than assuming it did.
- Skills and custom commands work in `-p`: put `/skill-name` in the prompt string.

## 7. Measured: what a judge child actually costs, and what makes it worse

**Measured 2026-07-30**, `claude` 2.1.220, on this machine. One trivial judging call
(`--output-format json --json-schema {ok,reason} --model claude-sonnet-5 --permission-mode
dontAsk`, material piped on stdin), three flag variants:

| Variant                                             | Cost    | Wall | `cache_read` | Verdict |
| --------------------------------------------------- | ------- | ---- | ------------ | ------- |
| baseline, non-bare, full context                    | $0.0705 | 4.1s | 17,374       | valid   |
| `--strict-mcp-config` (no MCP servers)              | $0.0391 | 5.6s | 22,612       | valid   |
| `--strict-mcp-config` + `--system-prompt` (replace) | $0.1164 | 5.0s | **0**        | valid   |

Four things follow, three of them not obvious:

1. **`--json-schema` delivers.** `structured_output` came back schema-valid on every variant
   — e.g. `{"ok":true,"reason":"Routine mechanical rename with no…"}`. A verdict does not have
   to be parsed out of prose.
2. **`--strict-mcp-config` roughly halves the cost.** With no `--mcp-config` alongside it, the
   child gets no MCP servers at all, and the tool definitions turn out to be the bulk of what a
   non-bare child pays for.
3. **Replacing the system prompt makes it three times _more_ expensive, not less.**
   `--system-prompt` dropped `cache_read` from ~22.6k to **0**: the default system prompt is
   prompt-cached across runs, a custom one is not, so the saving on prompt size is dwarfed by
   losing the cache. The intuitive optimisation is the wrong one.
4. **Latency is a non-issue** at 4–6s against GP-866's 30s budget. Cost is the constraint, not
   time.

**`--max-budget-usd` is a footgun as a primary bound.** An earlier run of the same shape cost
$0.168 against a `--max-budget-usd 0.10` cap: the child exited **1** with an empty `result` and
`structured_output: null` — the cap aborts the run and yields **no verdict**, while still
billing what it spent up to that point. It is a spend ceiling, not a graceful degrade. Set it
well above expected cost, or leave it off and bound with the spawn timeout.

Cost also **varies substantially run to run** — $0.0391 to $0.168 for the same work — tracking
how warm the prompt cache is. Budget on the pessimistic figure.

## Implications for this plugin

- The judge child runs **non-bare** and therefore re-enters our hooks. An env-var guard on
  every gutt hook is a correctness requirement of the GP-866 design, not a nicety.
- Read the verdict from `structured_output` with `--json-schema`, not from `result`.
- Pipe the material to judge on **stdin**; keep argv to flags.
- Give the child no tools and `--permission-mode dontAsk`; a judge that can call tools is a
  judge that can hang.
- Pass `--strict-mcp-config` with no `--mcp-config`: measured at roughly half the cost (§7),
  and a judge has no business holding MCP tools.
- Do **not** pass `--system-prompt`; it busts the prompt cache and triples the bill (§7).
- Do **not** cap spend with `--max-budget-usd` — decided against on GP-866 (§4).
- `total_cost_usd` per invocation is available, so the cost of moving the judge into a
  subprocess is measurable rather than guessed: ~$0.04/turn best case, up to ~$0.17 cold.

## Follow-ups

1. **Done — see §7.** Wall-clock is 4–6s, well inside 30s; cost is the binding constraint at
   ~$0.04/turn best case. Still worth pricing an `apiKeyHelper`, which would unlock `--bare`
   and should cut the context load far below what `--strict-mcp-config` achieves.
2. Confirm the env-var guard actually prevents recursion, by observing that the child's Stop
   hook exits without spawning. **Still untested.** A first attempt was vacuous: the probe
   plugin was loaded into the parent with `--plugin-dir`, which the child does not inherit, so
   the child had no copy of the hook to re-enter and the guard was never exercised. A real test
   needs the hook reachable by the child the way an _installed_ plugin is.
3. `--bare` becoming the `-p` default "in a future release" is a scheduled break for any
   subscription-authed caller. Re-read this page before upgrading the CLI.
4. Check whether `--json-schema` is honoured on this CLI version, and what `structured_output`
   holds when the model answers off-schema.

## Provenance

One `WebFetch` pass on 2026-07-30 is what this snapshot rests on. A second pass with a
different prompt was also run and returned **byte-identical page text**, adding nothing — this
page is small enough that `WebFetch` returns the whole markdown rather than a model summary,
so the sibling snapshots' two-pass convention does not apply here. That convention exists for
pages `WebFetch` compresses, where a single prompt can silently drop detail. **Read the first
result before deciding a second pass is needed**; for this page it was not.

Confidence:

- **§1, §3, §4, §5, §6 are quoted or closely paraphrased upstream text.** Reliable, with the
  caveat that this page defers all-flag detail to `/docs/en/cli-reference`, which has **not**
  been read. Anything not named here may still exist.
- **§2's local half is measured**, not read — `printenv` and a grep over this install's
  settings. Highest confidence, and the narrowest scope: it describes _this machine_, and a
  teammate with an API key exported would get different behaviour from the same code.
- **§ "Implications" and "Follow-ups" are our inference**, not upstream text.
