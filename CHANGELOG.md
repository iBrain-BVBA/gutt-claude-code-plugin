# Changelog

## [Unreleased]

### Fixed

- **gutt could delete or overwrite another plugin's status line.** Ownership of a
  `statusLine` entry was inferred from the path containing any of four fragments, one
  of which was the bare word `plugins` — and Claude Code puts every plugin's data
  under `~/.claude/plugins/data/`, so another vendor's `statusline.cjs` there read as
  ours. `/gutt-pro:statusline off` would have removed it and `/gutt-pro:statusline`
  overwritten it. Attribution now requires a whole path _segment_ naming this plugin,
  which neither the container every plugin shares nor a directory that merely spells
  `gutt` inside a longer word can satisfy (GP-867)
- **A blank status bar reported itself as healthy, twice over.** The generated entry
  point swallowed every load failure identically, so a renderer that was present and
  broken — a half-finished update, or the mangled checkout that shipped 3.0.0 dead on
  Windows — looked exactly like a plugin that had been uninstalled. `status` could not
  see it either: it checked whether _this_ version's renderer existed, which is true
  in essentially every case where there is a command around to ask, rather than
  following the path the entry point actually names. The entry point now distinguishes
  a missing renderer from a broken one and writes the reason down, `status` follows the
  real target and reports a stale entry point, and the renderer's own safety net says
  it caught something instead of showing the glyph for "nothing observed yet" (GP-867)
- **An unreadable transcript withdrew a sign-in warning it could not re-establish.**
  Past the scan cap every prompt answers "unknown", and that abstention overwrote a
  stored disconnection — turning a correct `🟡 - auth needed!` into a neutral glyph for
  the rest of the session, deleting the one instruction the user could act on. An
  abstention may now retire a green and nothing else (GP-867)
- **A repair failure was reported for the rest of the session after it was fixed.**
  SessionStart runs again on resume, `/clear` and compaction against the same record,
  so a field only written on failure was never corrected. It now records every attempt,
  and carries the reason out with it — on the path that can lose `settings.json`, the
  sentence naming where the file went was being dropped in favour of an internal
  token, and nothing could reconstruct it afterwards (GP-867)
- **Two commands framed a lost `settings.json` as a file they had not touched.** The
  distinction between "could not write it, it is unchanged" and "could not write it and
  could not put it back" was made inside the module and then contradicted by both
  callers, which prefixed either with `gutt did not change your settings`. `off` also
  answered "nothing changed" after withdrawing the consent that decides whether the HUD
  ever returns — the one thing its most likely caller wanted (GP-867)
- **A failed settings write could leave `~/.claude/settings.json` missing.** The
  Windows rename fallback unlinks the target before its second attempt; if that
  attempt also failed, the generic cleanup then deleted the temp file holding the only
  remaining copy — losing permissions, model, env and every other plugin's config, and
  reporting it as `could not write`, which reads as a no-op. The cleanup now stops at
  the point of no return, the replacement is left on disk, and the message names both
  it and the backup (GP-867)
- **The HUD printed nothing at all on two stdin shapes.** `JSON.parse("null")`
  succeeds, so the guard around the parse never fired and the null reached the render;
  a `display_name` whose `toString` is shadowed threw the same way. Both blanked the
  bar several times a second. The payload is checked for shape rather than only
  syntax, text fields are coerced safely, and the render as a whole now has a net
  under it — the lesson the cost segment taught was that the net belongs around the
  whole line, not around whichever operation looked risky (GP-867)
- **A connectivity probe that threw was reported as "not configured".** It rendered
  `!` and told the user to run setup on a configuration that may have been fine, and
  it suppressed the amber sign-in prompt, letting an old success paint a dead server
  green. "Could not tell" is now distinct from "nothing there" in the value consumers
  actually read (GP-867)
- **A green glyph could outlive all evidence for it.** Past the transcript scan cap a
  long session reports tool availability as unknown, which overwrote a stored
  disconnection; the pre-drop success then spoke for the server indefinitely. An
  uncorroborated success older than ten minutes now lapses to neutral. Warnings are
  left standing — a stale warning costs one needless check, a stale green costs a
  memory system you do not know has stopped (GP-867)
- **`/gutt-pro:statusline off` could be undone by the next session.** The consent
  record was written after the removal and its result discarded, so a failed write
  left the flag that reinstalls the HUD. Consent is withdrawn first and every failure
  is reported. `status` no longer promises a repair it has not checked, and can now
  see a HUD whose entry point is missing rather than reporting the settings key and
  stopping there (GP-867)
- **PostToolUse no longer spawns a process on every tool call.** The matcher had been
  widened to every tool so a dropped server could be noticed mid-turn; each firing is
  a blocking `node` launch (~89ms against a ~74ms floor), so a 200-call session paid
  around 18 seconds for it. The prompt hook already re-reads availability every turn,
  so the gap that closed was one turn (GP-867)
- **Settings backups no longer accumulate without bound — or evict the wrong ones.**
  They are written on a path nothing sweeps, once per session where the platform drops
  the `statusLine` key, each a verbatim copy of `settings.json` including its `env`
  block. The newest five are kept. The sweep is now namespaced to the backups it
  writes: the 2.x migration puts its own copy in the same directory under the same
  prefix, and that one can be the last image of `settings.json` from before the
  upgrade — it was being evicted within five sessions (GP-867)

### Added

- **The statusline HUD is back, as an opt-in that survives upgrades.** Turn it on
  with `/gutt-pro:statusline`; `off` removes it, `status` reports it. It shows
  connection state, whether recall is `on`, `off` or snoozed (with the time a
  snooze lapses), the capture mode when it is not `auto`, the group being written
  to, the model, and how much of the context window is spent. Segments drop from
  the right as the terminal narrows and the state segment always survives; a
  segment whose data does not exist is omitted rather than rendered as a zero.

  ```
  [gutt 🟢 on acme-eng] | [Opus 5] ctx 38%
  ```

  **Neither session cost nor turns-since-recall is on the bar.** The bar is narrow
  and a segment has to change what you do next to earn the space. A turn counter
  never did. Cost was worse: the figure Claude Code reports is an API price, so on a
  subscription it was a bill you will never be charged, redrawn several times a
  second — and reading it was the one piece of unguarded arithmetic in the renderer,
  so a `total_cost_usd` arriving as `null` or a string threw, and a status line that
  throws prints nothing at all. A single malformed field used to blank the whole HUD
  on every refresh. Context usage is validated the same way now: a bad field costs
  that one segment and never the line.

  It is opt-in because it cannot be anything else: Claude Code accepts a
  `statusLine` only from the user's own `settings.json`, never from a plugin's, so
  the key this plugin used to ship in `hooks.json` was never registered and never
  ran. Nothing writes your settings unless you run the command, your existing file
  is backed up first, and a status line you wrote yourself is never touched.

  **The prefix is required for this one command.** Claude Code has its own
  `/statusline`, so a bare one is left entirely alone — gutt does not read it, reply
  to it, or write anything. `/gutt-pro:statusline` is the only spelling that installs
  the HUD. The plugin's other verbs still answer to their short forms, saying which
  one they ran; this one cannot, because it writes a file in your home directory and
  a prompt aimed at the built-in is not permission to do that.

  What settings point at is `${CLAUDE_PLUGIN_DATA}/statusline.cjs`, a generated
  one-line shim that forwards to the current plugin root and is rewritten whenever
  that root moves. `${CLAUDE_PLUGIN_ROOT}` is version-scoped, so naming it directly
  is what made the 2.x entry rot on the next upgrade. This one does not.

  **The HUD notices a connection change mid-turn, not just at your next prompt.**
  The PostToolUse hook is now matched on every tool rather than only gutt's, because
  a server that has dropped produces no gutt calls to be matched on — which is
  exactly why the old matcher could never see it. Every gutt-specific action stays
  gated on the tool name, so an ordinary Bash response is never mistaken for evidence
  about the memory server, and the transcript read is debounced: a healthy reading is
  held for ten minutes, anything else re-checked after five seconds. So the frequent
  checking happens only while something is wrong and you are waiting for it to clear.
  The per-turn hook ignores the hold, so a drop is still caught by your next prompt at
  the latest.

  **Anything that a sign-in would fix now shows amber, and the glyph no longer
  decays.** A configured server whose tools have disappeared asks you to sign in
  rather than showing a red light you cannot act on — a lapsed remote connector does
  not announce itself, Claude Code simply withdraws the tools, so that is what an
  expired connection looks like from here. Red is left for the one thing only a real
  call can establish: the server answered, and answered with a failure signing in
  would not fix. Green also no longer times out after ten minutes; a session that
  simply has not touched memory for a while is an ordinary session, and the tool list
  catches a server that has genuinely gone. Neutral ⚪ now means exactly one thing —
  nothing observed yet.

  **An unauthenticated memory server now shows amber, not green.** A connector that
  has not been signed in publishes only its sign-in tools, so nothing the plugin
  watches ever gets called and the HUD had no way to notice — it reported a healthy
  connection for the whole session. The tool list is now read for that state, at
  session start as well as on every prompt, and green requires at least one real
  memory tool to actually be present. More than one gutt server can be connected at
  once and they authenticate separately, so a sibling needing sign-in does not count
  against a memory server that is working.

  If the HUD vanishes on its own, that is Claude Code dropping the key while
  rewriting `settings.json`
  ([#62486](https://github.com/anthropics/claude-code/issues/62486), closed as not
  planned). The next session restores it — but only if you installed it, which is
  recorded separately for exactly that reason (GP-867)

### Fixed

- **The HUD's `!` no longer fires at correctly configured sessions.** It was driven
  by whether a `group_id` was set _locally_, but the normal path resolves the group
  from MCP auth and leaves that empty — so a working setup rendered `[gutt⚪!]` and
  was told it was broken. It now fires only when the connectivity probe reports no
  MCP server (GP-867)
- **A failed connectivity probe no longer looks like an unconfigured one.** The probe
  runs inside an error guard, and a throw was flattened into `mcpConfigured: false` —
  so a machine where the probe simply could not tell was shown `!` and told to run
  setup on a configuration that may have been fine. It now records `null` for "could
  not tell", which renders nothing, and a withdrawn tool list is no longer silenced by
  it (GP-867)
- **🔴 now has a writer.** `connectionStatus: "error"` is set by
  `classifyToolResponse` when a real call comes back a non-auth failure, which is the
  only thing that can establish it. Red means the server answered and answered badly;
  a connection that merely needs signing in is amber (GP-867)

- **Every hook crashed on Windows.** gutt-pro 3.0.0 was unusable there: all 7
  hooks died at `require()` with a `SyntaxError` before doing any work. The repo
  stored 19 files as git symlinks, and Windows git defaults to
  `core.symlinks=false` — under which it does not create a link but writes the
  link's _target path_ as the file's contents. `hooks/lib/debug.cjs` arrived as a
  25-byte file reading `../../../shared/debug.cjs`, which is not JavaScript. A
  second defect sat behind it: the links pointed at `../../../shared/`, outside
  the plugin root, which installed plugins may not reference — so the
  marketplace-install path had never been verified end to end either. Fixed by
  removing symlinks from the repository entirely (GP-933)

### Removed

- **BREAKING — `auto-lint-plugin` is deleted.** The standalone lint-on-edit
  plugin is gone from the repo and from `marketplace.json`; anyone who installed
  it keeps their copy but gets no updates. It was the only other consumer of the
  shared hook libs, and removing it is what let `shared/` go. Recoverable from
  git history (GP-933)
- **`shared/` and the whole cross-plugin sharing mechanism.** The 14 surviving
  hook libs are now real files under `gutt-core/hooks/lib/`, owned by the plugin
  that uses them; `agent-identity.md` is a real file under the
  `agent-memory-protocol` skill's `references/`. Each plugin owns its own code
  and a second copy is preferred to a link. `tests/check-shared-libs.cjs`
  enforced the opposite invariant and is replaced by
  `tests/check-no-symlinks.cjs`, which fails if any tracked file is committed
  with git mode `120000`; `npm run check:shared` becomes
  `npm run check:no-symlinks`. `.lintstagedrc.cjs` no longer filters symlinks out
  of prettier, because there are none (GP-933)
- **`platform-detect.cjs`** (`supportsDecisionBlock`, `isCowork`, `isCursor`) as
  dead code. No gutt-core hook or lib had required it; `auto-lint-plugin` was its
  only runtime consumer. Its two test suites go with it — the BOM-stripping and
  `env.cjs` priority suite is unaffected and stays (now `cursor-host.test.cjs`)
  (GP-933)
- **BREAKING — statusline `passthroughCommand` is gone.** The statusline no
  longer chains to a user-supplied command, and `gutt.statusline.passthroughCommand`,
  `showTicker`, and `multiLine` are all ignored. Anyone relying on passthrough
  loses their custom statusline silently on upgrade and should register that
  command directly in `~/.claude/settings.json` instead. Chaining ran the command
  through `spawn(…, {shell: true})`, so a config pointing back at the plugin
  fork-bombed the machine; it was guarded by a `GUTT_STATUSLINE_DEPTH` counter,
  and removing the mechanism removes the whole bug class. GP-844 defers all
  statusline extras (GP-844)
- **HUD counters (`mem:` / `lessons:`) and the toast ticker.** The `PostToolUse`
  hooks that fed them (`post-memory-ops.cjs`, `cowork-periodic-capture.cjs`) are
  removed along with `memory-cache.cjs` and `seed-registry.cjs`; the
  `/gutt-pro:reset-counters` command is deleted (GP-844)
- **The inert `statusLine` key in `hooks.json`**, along with the dead
  `gutt.statusline` block in `config.json.example` and the unreferenced
  `getStatuslineConfig()` in `hooks/lib/config.cjs`. The manifest key was never
  registered by the platform, and shipping a key that does nothing tells every
  future reader it works. A test now asserts it stays out (GP-867)
- **The subagent hooks plugin** (`plugins/gutt-subagent-hooks-plugin/`), which was
  never listed in `marketplace.json` and therefore never shipped. Decision O4
  keeps subagent hooks out of 3.0 (GP-868)
- **`capture-queue.jsonl` and everything that maintained it.** The R37 state
  contract named a third artifact — an append-only capture queue written at Stop
  and drained at the next SessionStart — and its retention was implemented ahead of
  its writer, on the reasoning that a sweep step appearing only alongside its first
  writer is a step nobody notices is missing. The writer never arrived: GP-866 moved
  the judge inline at Stop, where it fails open rather than deferring work, so there
  was no deferred work to queue and GP-873 closed as not needed. Gone with it: the
  `queue` sweep step and its `QUEUE_TTL_MS` / `QUEUE_MAX_ENTRIES` / `QUEUE_FILE`
  constants in `hooks/lib/session-sweep.cjs`, the `pruneJsonl` helper in
  `hooks/lib/plugin-state.cjs` (the step was its only caller), the artifact's rows in
  `docs/runtime-state-convention.md`, and the nine sites in the tests that named the
  file — four `pruneJsonl` cases, three fixtures, and the queue assertions in the
  full-sweep test. No user-visible behaviour changes — nothing ever wrote the file,
  so the sweep step reclaimed nothing on every session it ran. Nothing else in the
  state contract is line-oriented JSON; `pruneJsonl` is recoverable from
  `hooks/lib/plugin-state.cjs`'s history if that changes (GP-873)

### Added

- **Coverage for two sweep behaviours that no test asserted.** The `root-debris` and
  `session-debris` steps could both be deleted outright with the suite staying green;
  the full-sweep test now asserts each reclaims its orphan and that a lock younger
  than `DEBRIS_TTL_MS` survives, since reclaiming a live lock is the failure that
  actually hurts. Separately, `trimLog` is now exercised on a log that is both past
  `DISCARD_BYTES` and free of newlines — the one combination that reaches `readTail`'s
  partial-line drop with nothing behind the cut. Removing the `rest.trim()` guard
  there wipes a 5MB `hook-errors.log` to nothing while still reporting success, and
  until now no test failed when it did (GP-873)

- **Turning recall off now silences the capture judge too, and `mode` finally does
  something.** The `Stop` handler moved from a `type: "prompt"` hook to a command
  hook (`hooks/stop-capture.cjs`) that shells out to `claude -p` for the verdict.
  A prompt hook's `prompt` field takes one substitution and no shell expansion, so
  it could not read `config.json` — it dispatched on every turn regardless of your
  settings, which is why turning recall off used to stop recall while the judge kept
  asking for captures. Off or snoozed now returns before any child is spawned, and
  `mode: hitl` appends an instruction to confirm each subject with you through
  `AskUserQuestion` before anything is written. `mode: auto` is unchanged, and the
  judge's wording is unchanged apart from the skill id the GP-931 rename moved
  (`gutt-pro:memory-capture`), so the only difference on the default path is where the
  model runs.

- **The settings commands** — `/gutt-pro:config`, `/gutt-pro:on`,
  `/gutt-pro:off [minutes|session]`, `/gutt-pro:disable`, `/gutt-pro:mode auto|hitl`.
  The direct power-user ask (R24): a timed snooze that expires on its own, plus a durable
  off that survives restarts. Parsed and applied deterministically by the
  `UserPromptSubmit` hook, which then reports the outcome as injected context — no model
  reads the arguments, so a mistyped minute count cannot become a long silence. Writes go
  only to `${CLAUDE_PLUGIN_DATA}/config.json`, through the existing locked
  atomic-temp+rename path. GP-866 shipped this as one `/gutt` command with subcommands
  specifically to avoid the rename; GP-931 did the rename and dissolved the stem, so this
  release only ever had the sibling spelling (GP-866, GP-931)
  - The bare forms `/on`, `/off`, `/disable` and `/mode` also resolve, measured against a
    real install. `/config` does **not** — Claude Code's own `/config` intercepts it
    before any hook sees it, so `/gutt-pro:config` is the only spelling that works
    (`docs/plugin-platform-reference.md` §8)
  - `enabled` and `mode` now have readers as well as writers. They shipped in the
    documented `config.json` shape in GP-863 and were used by nothing, so a
    hand-written `{"enabled": false}` silently did nothing. The router's suppression
    row reads both halves through one `isSuppressed()` call, so honouring `enabled`
    costs no extra file read on a 50ms path.
  - Out-of-range minute counts are rejected rather than clamped, and an out-of-scope
    `/gutt-pro:off session` with no session id is refused rather than writing a snooze no
    session could ever clear.
  - The HUD's gutt segment shows ` off` or ` zzz` while suppressed.
  - The judge **defers while background agents are still in flight**, reading
    `background_tasks` off the Stop payload (Claude Code ≥ 2.1.145) and waiting only
    on agent-shaped types — `subagent`, `workflow`, `teammate`, `cloud session`. A
    background shell command or MCP monitor does not defer it, and an absent array
    judges rather than defers, so an older CLI behaves as before. `session_crons` is
    deliberately ignored: a recurring wakeup never drains, so gating on it would
    silence capture for the rest of the session. One judge run per fan-out turn
    instead of one per agent completion.
  - The judge reports **why** it stayed quiet. A pass, a missing transcript, a
    timeout, `claude` off the hook's PATH, a non-zero exit and an unparseable verdict
    used to log the single word `quiet`, so a judge broken since an expired token was
    indistinguishable from a quiet month; the failures now also reach
    `hook-errors.log` with the child's `stderr`.
  - A reason that quotes the verdict format is dropped rather than fed back, and an
    over-long one is truncated — GP-921 route 1 in code rather than in prose alone.
- `mentor` agent in `gutt-mentor` — the growth-goal counterpart to the onboarding
  agent, for asks with no new territory to map ("get better at code reviews",
  "grow toward tech lead"). Elicits the goal, grounds it in what the org graph
  has recorded about it — expectations and career paths, working agreements,
  lessons, people to learn from, prior programs — assembles a provenance-marked
  materials list, then builds and resumes the program through the S7.1 skills.
  **Writes to personal scope only:** the program never goes to the org graph, so
  the agent registers no identity and tags nothing. Where the graph is thin on a
  goal it says so explicitly and provides general best practices labeled as
  general rather than org-derived. Also covers a human mentor preparing to
  mentor someone else, read-only. Preloads `memory-search` and the two S7.1
  skills; deliberately not `memory-capture` or `agent-memory-protocol`, whose
  subjects are org writes and registration — things this agent never does
- `onboarding-guide` agent moved from gutt-core into `gutt-mentor` and rebased
  onto dual scope. Reads the org graph for team, architecture, decisions, lessons
  and experts, then builds the joiner's plan through the S7.1 skills and resumes
  it across sessions. Self-service — personal scope follows the authenticated
  login, so the joiner runs it themselves; preparing a brief about someone else
  stays read-only and writes nothing. **The plan goes to both scopes** (personal
  where it is tracked, org on confirmation so later joiners in the role benefit);
  statuses, blockers and open questions stay personal. Registers in org scope only
  and tags its one org write; the legacy person-named "brief prepared" note is
  dropped rather than rebased. Also fixes four pre-convention defects carried by
  the old file: a hardcoded MCP server prefix, an org write missing
  `last_n_episodes=0`, `center_node_uuid` for `center_node_id`, and unscoped org
  reads that silently covered personal memory (GP-884, E7-S7.4)
- `gutt-mentor` declares `gutt-pro` as a plugin dependency — its
  skills and agent reference gutt-core skills by name, and the agent preloads
  `agent-memory-protocol` and `memory-search` across the plugin boundary using the
  namespaced form (`gutt-pro:<skill>`), which resolves
  deterministically where a bare name does not (GP-884)
- New `gutt-mentor` plugin: two domain-neutral skills over the **personal**
  memory scope, for the onboarding agent to consume. Ships no hooks.
  (GP-883, E7 mentor shared skill base)
  - `individual-program-design` — elicit goals, set milestones on a default
    day 1 / week 1 / day 30 / 60 / 90 cadence, and persist the program as one
    self-contained `add_personal_memory` episode with `last_n_episodes=0`.
  - `progress-tracking` — read the program plus its check-in thread back,
    reconstruct goals / milestone status / next actions / last check-in date,
    then write the next check-in chained with an explicit `previous_episodes`.
  - Both forbid `agent_id` in personal scope, and forbid leaking personal
    content into org writes or org query strings — including inbound, since an
    org read without explicit `group_ids` already covers the personal scope.
  - Worked round-trip:
    `gutt-mentor/skills/progress-tracking/references/round-trip.md`.
- Skill-frontmatter guard covering **every** marketplace plugin, not just
  gutt-core: each `skills/*/SKILL.md` must carry a delimited frontmatter block
  whose `name` matches its directory, and a `description`. Plugin list is read
  from `marketplace.json`, so a new plugin is covered without editing a second
  list (`tests/hook-architecture.test.cjs`)
- `memory-search` skill (gutt-core): the adaptive, relevance-gated memory-search discipline — rung 1 = one `search_memory_nodes` + `search_memory_facts` pass, judged for relevance and reformulated (not paginated) when weak; a relevance gate that reports "no relevant memory found" rather than stretching a distractor; rung 2 narrowing filters; rung 3 traversal handoff to `graph-traversal`; summary-first episode rules and tool-tier degradation. Rung-1 shape validated on a 50-query live-graph benchmark (top-3 hit-rate 86% vs 58% for a fixed single pass; zero false answers on absent-topic queries). Exact tool contracts live in `skills/memory-search/references/tools.md` (GP-856, E2 core memory curriculum)

### Fixed

- Repo instructions said the group is determined automatically and must not be
  passed — the opposite of what the shipped skills and the new agent require.
  Omitting `group_id` on a write targets an unspecified one of the caller's groups
  rather than a fixed default, and an unscoped read silently includes personal
  scope. `CLAUDE.md` now points at `shared/agent-identity.md` as the normative
  reference (GP-884)
- `agent-memory-protocol` stated "Register first" unconditionally, omitting the
  read-only exemption its own normative reference carries. A read-only agent's
  scope is empty by construction, so registering buys it nothing — the exemption
  now lives inside the numbered rule, where a weaker model reads it as binding
  rather than advisory. The onboarding agent preloads this skill and runs
  read-only when preparing a brief about someone else (GP-884)
- The onboarding agent's org-reading step listed its twelve searches as one flat
  block, mixing the first pass with the calls that can only follow it and opening
  a group with the one tool `memory-search` says not to open with. Both live
  validation rounds ran the whole battery unconditionally. The calls are now rows
  keyed to the chosen scope, with the first pass and the gap-fillers in separate
  columns; the rung-2 ceiling is stated deliberately, since centered fact searches
  return current facts only while the traversal tools return superseded edges
  unwarned and can fail on a hub
- The onboarding brief asked for a UUID where the cited thing is a node, which
  carries a readable id a joiner can follow; facts and episodes keep theirs. Also
  corrects a scoped-recall pass described as running before the step that makes it
  possible
- The onboarding agent's resume check was a binary — same ramp or plainly
  different — and most real cases fall between: a near-match, several candidates, a
  record whose provenance is doubtful. It now asks which, and says what to do when
  there is nobody to ask. Alongside it, a run with nobody present now writes
  **nothing** in the literal sense, registration and lessons capture included,
  since a run that writes nothing needs no memory identity; the program record uses
  the design skill's headings verbatim, because the tracking skill reads status by
  them and the published record's different shape had been bleeding in; and the org
  group is taken from a returned `group_id` rather than a node's id prefix, which is
  an alias and can differ from the group
- The last two paths in the onboarding agent that could state a wrong answer as
  fact are closed. A centered fact search that never mentions its center node is
  discarded instead of quoted — two runs saw the center parameter silently
  ignored, and the generic facts that come back are about something else. A record
  or group that declares itself test, sandbox, or fabricated content is excluded
  from the briefing rather than merely attributed: a weaker-model run applied
  attribution mechanically and still briefed from a fabricated cluster, so
  exclusion is the rule and attribution covers only what survives it. Alongside:
  the role fallback no longer dead-ends when neither role nor system is stated,
  and the draft variant names its exception to the milestones-track-stated-goals
  rule instead of contradicting it silently

### Changed

- **BREAKING — the core plugin is now `gutt-pro`.** `name` and `displayName` in
  `gutt-core/.claude-plugin/plugin.json`, the `marketplace.json` entry, `package.json`,
  and `gutt-mentor`'s `dependencies` all move from `gutt-claude-code-plugin` to
  `gutt-pro`. Every namespaced id moves with it: skills are now
  `gutt-pro:memory-search`, `gutt-pro:memory-capture`, `gutt-pro:output-style`,
  `gutt-pro:migrate-memory`, and commands are `/gutt-pro:setup`, `/gutt-pro:health`,
  `/gutt-pro:onboard`. **A rename is a new plugin identity, not an update** — installed
  users get no update offer and must `/plugin uninstall gutt-claude-code-plugin` then
  `/plugin install gutt-pro@gutt-plugins`. `${CLAUDE_PLUGIN_DATA}` moves with the name,
  so `config.json`, `sessions/`, `migrationsVersion` and the `migrations/` memory
  backup all orphan; settings reset and must be re-applied. The first session after
  the rename reports what it found in the old directory and what it did not carry
  over — it never moves or deletes anything. Finish and verify any in-flight
  built-in-memory migration **before** uninstalling, and use `--keep-data`: without
  it, uninstalling the old plugin destroys a memory backup that may be the only
  remaining copy of your notes. Never run both plugins at once — duplicate hook registration means
  two recall injections per prompt, two Stop judges, two status lines. The GitHub
  repository keeps its name, so existing `/plugin marketplace add` URLs still work.
  See `docs/migration-3.0.md` (GP-931)
- **BREAKING — `off` and `disable` swapped meanings.** `/gutt-pro:off` is now
  session-scoped and comes back on its own; the durable off that survives restarts is
  `/gutt-pro:disable`. In 3.0 a bare `off` was the durable one. The cheap, reversible
  action is what the short word gets, and turning recall off for good has to be typed
  on purpose. `/gutt-pro:config` now states the _scope_ of whatever is in force — "for
  this session" versus "until `/gutt-pro:on`" — because the reversal is otherwise
  invisible at the point of use. Like the stem removal below, the `off` that changed
  meaning never appeared in a tagged release, so this only affects anyone running 3.0
  from source (GP-931)
- A second round of blind runs closed six more gaps in the onboarding agent. More
  than one org group discovered is now treated as a question rather than a list,
  because a graph can hold a sandbox or fixture group that looks like an org group
  and reads as fact; with nobody to ask, each claim is attributed to the group it
  came from. The role is never inferred to keep the workflow moving — a guessed role
  goes into query strings and returns a briefing about the wrong job. Each row's
  first pass now shows its uncentered fact search in the table rather than only in
  prose, since a run followed the table and missed it. The briefing's final section
  states what it holds on each path — stored, draft, or a brief about someone else.
  And the org-group note no longer carries a worked example drawn from one
  deployment's own group names
- The onboarding agent no longer restates guidance its preloaded skills own —
  degradation, the personal-scope locator rationale, the program cadence and status
  vocabulary, and a failure-modes list that repeated Agent identity, Step 3 and
  Step 6 at length, now an observable-and-response table. An agent body is a system
  prompt with no staged loading, so a restatement competes with the original and
  can drift from it
- `memory-capture`'s degradation note no longer promises a durable
  `capture-queue.jsonl` "coming with the background pipeline". No queue is coming:
  the Stop judge runs inline and fails open, so there is no deferred work to hold,
  and GP-873 is closed as not needed. What the note described as a stopgap — hold
  the drafts, retry when a write tool returns, surface them to the user if the
  session ends first — is the permanent answer, and the surrounding sentences
  already specify it (GP-873)

### Deprecated

- `memory-retrieval` skill redirected to `memory-search`: its trigger phrases moved to `memory-search` so it no longer auto-fires, and the `/gutt-pro:memory-retrieval` command remains only as an alias (GP-856)

### Removed

- **BREAKING — the `/gutt` command stem is gone.** `gutt-core/commands/gutt.md` is
  deleted and replaced by one command per verb: `config.md`, `on.md`, `off.md`,
  `disable.md`, `mode.md`. `/gutt …`, `/gutt:<sub>` and
  `/gutt-claude-code-plugin:gutt <sub>` stop parsing entirely — they are ordinary
  prompt text now, not aliases and not deprecation warnings. A hard cut is the safer
  failure precisely because `off` reversed meaning in the same change: an alias would
  have done something other than what the user typed. Note the stem never appeared in a
  tagged release — it was added and retired inside this same unreleased section — so this
  only affects anyone running 3.0 from source (GP-931)
- Dead routing/intent-extraction engine and orphaned libs with no live callers: `agent-discovery`, `router`, `memory-routing`, `intent-extractor`, `transcript-parser`, `lesson-builder`, `plan-feedback-detector`, root `text-utils`, and the write-only `cross-session-learner` analytics (nothing reads `gutt-analytics.json`) — ~1,840 lines (GP-851, part of the 3.0 E1 foundation)
- Stale `docs/hook-test-plan.md` (described the pre-split hook layout)

## [2.7.1] - 2026-04-14

### Changed

- Centralized session-id sanitization; added subagent-skip logging

### Fixed

- Stop hook skips subagent stops and uses consistent session-id handling

## [2.7.0] - 2026-04-14

### Changed

- Simplified the stop hook to a block-once pattern

## [2.6.0] - 2026-04-14

### Fixed

- Stop hook no longer fires on subagent completions
- Silent failures and error logging hardened across hooks

## [2.5.0] - 2026-04-14

### Changed

- Extracted lint and subagent hooks into standalone plugins
- Moved plugin-dev agents and dev-only commands to repo-only (unshipped)

## [2.4.0] - 2026-04-14

### Changed

- Trimmed marketplace skills and removed prescriptive hooks

## [2.3.0] - 2026-04-08

### Fixed

- Statusline fork-bomb from self-referential passthrough; general hook hardening
- Switched Python formatting from black to ruff; stopped auto-removing unused imports

## [2.2.0] - 2026-04-02

### Fixed

- Hook matcher regex syntax and `connectionStatus` on startup (#33)
- Removed hooks from project settings to prevent double-firing (#32)
- Lessons counter mismatch from an MCP tool-name change (#37)
- Re-run statusline setup on plugin version upgrade (#35)
- Hide empty `group_id` from the statusline (#34)
- Moved memory quality gate into an agent; removed dead playbook code (#36)
- Removed the delegation-guard hook from pre-tool-use

## [2.1.0] - 2026-04-02

### Added

- Debug logging across hooks; memory-search reminder on first prompt

### Fixed

- Case-insensitive / flexible MCP server-name matching (#30, #31)
- Corrected marketplace install command in README
- Enforced dedup in the memory-capture skill; fixed MCP tool names

## [2.0.0] - 2026-04-01

### Added

- Memory classifier framework (5 capture types with trust scoping)
- Lesson builder for consolidated platform output
- Seed registry mtime cache invalidation
- Behavioral tests for memory classifier and decision authority

### Fixed

- Decision authority case sensitivity in claim_type lookup

## [1.6.0] - 2026-04-01

### Added

- /onboard skill with 7-step first-use flow
- diagnoseGuttMcp() for MCP connectivity diagnostics
- Ported external-tool-docs and skills-discovery skills
- Ported commit-push-pr and lint-test commands
- Frontmatter for memory-capture and memory-retrieval skills

### Changed

- README Quick Start rewritten with clear install paths
- Session-start hook uses structured MCP diagnostics

## [1.5.1] - 2026-04-01

### Added

- WORKFLOW_PREFIXES for git/gh commands in delegation guard
- Plan file write exception in delegation guard
- 34 unit tests for delegation guard

### Fixed

- Counter timing in post-task-lessons (increment after output)
- Fallback score reduced from 0.5 to 0.25

### Removed

- diagnostic-capture.cjs (orphan with credential exposure risk)

## [1.5.0] - Previous

- Initial release with memory integration, hooks, skills, agents
