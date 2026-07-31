# gutt Claude Code Plugin

## Project Overview

This is a Claude Code plugin that integrates gutt (Graph-based Unified Thinking Tool) memory capabilities into Claude Code workflows. The plugin provides:

- **Memory Integration**: Connect Claude Code to gutt's knowledge graph for persistent organizational memory
- **Skills & Hooks**: Custom skills and hooks for enhanced agent workflows
- **MCP Tools**: Additional MCP server configurations for extended capabilities

## Architecture

```
gutt-plugins/               # marketplace repo (root is NOT a plugin)
├── .claude-plugin/         # marketplace.json — lists gutt-core + auto-lint-plugin + gutt-mentor
├── shared/                 # single source for hook libs; plugins symlink these (GP-853)
├── gutt-core/              # core plugin (name: gutt-claude-code-plugin, displayName: gutt-core)
│   ├── .claude-plugin/     # plugin.json
│   ├── hooks/              # Claude Code hooks (.cjs); hooks/lib/* symlink → shared/
│   ├── skills/ agents/ commands/
│   └── rules/ mcp.json config.json.example
├── auto-lint-plugin/       # standalone lint-on-edit plugin (no gutt dependency)
├── gutt-mentor/            # mentor plugin (depends on gutt-core) — onboarding + mentor agents, personal-scope program design/tracking
├── .claude/                # repo-dev tooling (agents, commands, settings) — not shipped
├── tests/                  # Unit and E2E tests
├── evals/                  # prompt/skill bench — not shipped, not in test:all (see below)
├── docs/                   # Documentation and assets
└── package.json
```

## Evals

`evals/` scores the parts of the plugin whose behaviour is decided by prose rather than
by code — the Stop judge prompt, the injected pointers, the skills. A unit test can
assert a prompt contains a clause; only an eval tells you whether the clause changes
what the model does. Candidate wordings are run against turns lifted from real session
transcripts and scored against hand-labelled verdicts: `python3 evals/run.py --list`.

Python 3 stdlib, no dependencies. Outside `gutt-core/`, referenced by no hook, and
deliberately out of `npm run test:all` — the calls cost money and take minutes.

## Platform Reference Docs — read before designing against the platform

The Claude Code plugin and hook platform changes under us, and the changes are silent: a
field we were told does not exist starts working, an event appears, a constraint lifts.
Designing from memory is how we end up ruling out an option that has since opened up.

Three snapshots of the upstream docs live in `docs/`, each carrying its **source URL, the
date it was read, and per-section confidence**:

| File                                 | Covers                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `docs/hook-platform-capabilities.md` | hook events, which accept `additionalContext`, Stop/SessionStart output contracts      |
| `docs/plugin-platform-reference.md`  | `plugin.json` schema, `userConfig`, env vars, caching, symlinks, component paths       |
| `docs/headless-cli-reference.md`     | `claude -p` flags, `--bare` auth limits, `--json-schema` output, exit/signal behaviour |

**Consult these before** choosing a hook event, adding a manifest field, reasoning about
`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}`, invoking the CLI from a hook, or
concluding the platform cannot do something. They are more current than this file and than
anything in the graph.

Sections headed **Measured** rather than **Read** were established by a real run against a
real install and outrank a doc read where the two disagree — `hook-platform-capabilities.md`
§6–§7 and `headless-cli-reference.md` §2 are the current examples, and each records how the
probe was built so that a negative result could not be faked.

**They are snapshots, not the source of truth.** Two rules:

1. **Check the `Read:` date.** More than ~4 weeks old, or the answer decides a design →
   re-read the upstream URL, don't trust the snapshot.
2. **Never "correct" our own docs from a snapshot alone.** Where upstream and our docs
   disagree, both files record the conflict as unresolved and name the run that would
   settle it. A doc read is evidence; only a real run against a real install is proof.
   `docs/plugin-platform-reference.md` §3 is a live example — it contradicts the local-dev
   symlink claim below, and neither sentence has been verified.

### Refreshing them

Periodically — and always before a story that turns on platform behaviour — re-read both
source URLs, then update the snapshot: bump `Read:`, revise what changed, and **keep the
Follow-ups sections**, appending rather than replacing. A refresh that finds nothing new
still earns a new `Read:` date; that is the useful signal. Anything a refresh falsifies in
the graph needs a correction episode via `memory-capture` (through
`conflict-adjudication` first if it contradicts a stored memory) — the graph does not
expire on its own, and a stale Insight there outlives the doc that made it wrong.

## Shared Hook Libraries

Hook libraries have a single source in `shared/*.cjs`. Each plugin's `hooks/lib/<name>.cjs` is a **symlink** into `shared/` (`../../../shared/` from `gutt-core` and `auto-lint-plugin`). Edit the file in `shared/` once — every plugin sees it. No manual copying, no propagation table.

- **Guard:** `npm run check:shared` (run in CI) fails if any plugin ships a divergent real copy of a shared lib instead of a symlink.
- **Install-time:** Claude Code dereferences intra-marketplace symlinks when copying a plugin to its cache, so installed plugins get real files and stay self-contained. ([docs](https://code.claude.com/docs/en/plugins-reference#share-files-within-a-marketplace-with-symlinks))
- **Plugin-local libs** with no `shared/` counterpart stay as real files — allowed by the guard.
- **Local dev:** `--plugin-dir` / local-path installs do **not** dereference cross-plugin symlinks. Running from the repo works (the link resolves in place); to exercise a real install, install from the git marketplace source.
  - **Directory-source: confirmed 2026-07-29 by observation.** A `"source": "directory"` marketplace entry loads in place with no copy step, and `hooks/lib/*.cjs` symlinks into `shared/` resolve at runtime — proven by a hook that requires one of them running correctly while the recorded cache directory was empty. Consequence: with that setup **the working tree is what executes**, so an uncommitted edit runs and no reinstall is needed.
  - ⚠ **`--plugin-dir` specifically is still unverified.** The docs say "only symlinks that resolve within the plugin's own directory are preserved; all others are skipped", which would break every `hooks/lib/*.cjs` link. That statement is made about the _copy_ into the cache, so it plausibly never applies to an in-place load — but that is inference, and `--plugin-dir` is a different flag from a directory source. See `docs/plugin-platform-reference.md` §3. `check:shared` guards the links' shape, not whether the platform honours them.
- **Windows:** symlinks need `git config core.symlinks true` (or Developer Mode); without it the links check out as plain text files.

When adding a new shared lib: put the real file in `shared/`, then symlink it into each consuming plugin's `hooks/lib/`.

## Writing Skills — instructions for an agent, not documentation

A `SKILL.md` and its `references/*.md` are **prompt text an agent reads at
call time to decide what to do**. They are not changelogs, design records, or
release notes. Everything in them should still be true and still be worth reading
in a year, on a deployment nobody here has seen. Concretely:

- **No ticket references.** Never `GP-123` in skill text. The ticket explains why
  the guidance was added — the agent needs the guidance. Rationale that survives
  belongs as prose; rationale that only makes sense next to a ticket belongs in
  the commit message or the PR.
- **No implementation or provenance notes.** No `_Measured 2026-07-31_`, no "on
  this install", no "verified by a probe", no dated observations. Those are
  authoring evidence. Write the behaviour as a standing rule and let the
  behaviour be the claim. (This is the opposite of `docs/` — see Platform
  Reference Docs above, where dated `Read:` / **Measured** markers are the whole
  point. Skills instruct; `docs/` records.)
- **No real group names, tenant ids, org names, or user names.** Use placeholders
  (`<group_id>`, `<alias>`, `add_memory_to_<alias>`). A real name both dates the
  file and tells an agent on another deployment that a scope exists which does
  not — a naming coincidence read as a rule is worse than no example.
- **Describe shapes, not instances.** "ids carry suffixes aliases drop" beats
  "`add_memory_to_foo` writes to `foo_v2`". The agent needs the invariant it can
  apply to whatever it actually sees in its tool list.
- **Prefer discovery over enumeration.** Where the platform exposes a live
  surface for something — MCP resources, the tool list, a status endpoint — tell
  the agent to read it, and say what to do when it comes back empty or missing.
  A hardcoded list is stale by the next deployment.
- **Renumbering hard rules is a breaking change.** Rules are cross-referenced by
  number from other skills, hooks, and tests (`grep -rn "rule [0-9]"`). Extend a
  rule in place rather than inserting one and shifting the rest.

## Development Guidelines

### Code Style

- Use ES modules (`type: "module"` in package.json)
- Follow ESLint configuration for linting
- Use Prettier for formatting
- Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/)

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`

### Running Locally

```bash
npm install          # Install dependencies
npm run lint         # Run ESLint
npm run format       # Format with Prettier
```

## MCP Servers

This project is configured to use:

- **gutt-pro-memory**: gutt memory graph for organizational knowledge
- **atlassian**: Jira/Confluence integration
- **github**: GitHub API integration

## Memory Integration

When working on this project, use the gutt memory graph to:

- Store architectural decisions
- Track lessons learned
- Capture user preferences
- Record project patterns

Note: pass the group explicitly. Omitting `group_id` on a write targets an unspecified one of your allowed groups, not a fixed default — so pass it whenever you can write to more than one; with exactly one group you may omit it. On reads, pass `group_ids` naming the groups you mean: omitting it includes personal scope. `shared/agent-identity.md` is the normative reference.

## Related Tickets

- GP-421: Create gutt Plugin for Claude Code (parent story)
- GP-435: Repository Tooling Setup
