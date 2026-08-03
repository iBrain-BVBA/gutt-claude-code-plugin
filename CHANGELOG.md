# Changelog

## [Unreleased]

### Removed

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
  constants in `shared/session-sweep.cjs`, the `pruneJsonl` helper in
  `shared/plugin-state.cjs` (the step was its only caller), the artifact's rows in
  `docs/runtime-state-convention.md`, and the nine sites in the tests that named the
  file — four `pruneJsonl` cases, three fixtures, and the queue assertions in the
  full-sweep test. No user-visible behaviour changes — nothing ever wrote the file,
  so the sweep step reclaimed nothing on every session it ran. Nothing else in the
  state contract is line-oriented JSON; `pruneJsonl` is recoverable from
  `shared/plugin-state.cjs`'s history if that changes (GP-873)

### Added

- **`/gutt-pro:agent-scope` — per-repo agent identity binding, so one agent run from
  two repos does not silently become one memory.** The bound label becomes the
  `--<scope>` suffix on every agent name registered from that repo, stored per project
  in `${CLAUDE_PLUGIN_DATA}/config.json` alongside the migration record. Repos bound to
  the same label share one agent identity and one pool of agent-scoped memory on
  purpose; different labels stay isolated. `show` reports the effective scope and which
  step of the chain supplied it — bound label, then the git remote's `owner/repo`, then
  the working folder's name.

  Two consequences worth knowing. The convention now says **always suffix**, where it
  previously said to ship a bare base name unless a clash forced otherwise: a clash is
  invisible at the moment it matters, because registration merges on name and group and
  org writes cannot be deleted or reassigned afterwards, so pooling by default is the
  one unrecoverable choice. `agent-creator` and the `agent-memory-protocol` skill teach
  the new default. And a bad type or an unusable label is refused rather than
  normalised, because a silently rewritten label is a different permanent identity from
  the one that was typed.

  Run bare, the command reports what is in force and hands over to an interactive flow
  that lists labels already in use, warns about ones belonging to other repos, and ends
  by telling you the line to type. It cannot apply the choice itself — the effect comes
  from the hook that sees the typed prompt, and a command the model invokes never
  reaches that hook

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
