# gutt Claude Code Plugin

## Project Overview

This is a Claude Code plugin that integrates gutt (Graph-based Unified Thinking Tool) memory capabilities into Claude Code workflows. The plugin provides:

- **Memory Integration**: Connect Claude Code to gutt's knowledge graph for persistent organizational memory
- **Skills & Hooks**: Custom skills and hooks for enhanced agent workflows
- **MCP Tools**: Additional MCP server configurations for extended capabilities

## Architecture

```
gutt-plugins/               # marketplace repo (root is NOT a plugin)
├── .claude-plugin/         # marketplace.json — lists gutt-core + gutt-mentor + gutt-developer
├── gutt-core/              # core plugin (name + displayName: gutt-pro; dir name kept)
│   ├── .claude-plugin/     # plugin.json
│   ├── hooks/              # Claude Code hooks (.cjs); hooks/lib/* are real files, owned here
│   ├── skills/ agents/ commands/
│   └── rules/ mcp.json config.json.example
├── gutt-mentor/            # mentor plugin (depends on gutt-core) — onboarding + mentor agents, personal-scope program design/tracking
├── gutt-developer/         # developer plugin (depends on gutt-core) — Jira ticket skills: research, duplicates, estimate; no hooks
├── .claude/                # repo-dev tooling (agents, commands, settings) — not shipped
├── tests/                  # Unit and E2E tests
├── evals/                  # prompt/skill bench — not shipped, not in test:all (see below)
├── docs/                   # Documentation and assets
└── package.json
```

**The plugin is `gutt-pro`; its directory is `gutt-core/`.** GP-931 renamed the plugin
(`name` and `displayName`) and deliberately left the directory alone — renaming it would
re-point the marketplace `source` for no user-visible gain. So `gutt-core/` is a path and
`gutt-pro` is an identity, and they do not match on purpose. The GitHub repository keeps
its own name too
(`gutt-claude-code-plugin`), which is why that string still appears in repository URLs and
in filesystem paths derived from this checkout. Anywhere else it is a stale reference.

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
   `docs/plugin-platform-reference.md` §3 shows how one ends: the disagreement it records
   was never settled by a run, it was retired when GP-933 deleted the symlinks the
   question was about. A conflict can close because the subject went away — say so in the
   file rather than quietly dropping it, so the next reader knows no run ever happened.

### Refreshing them

Periodically — and always before a story that turns on platform behaviour — re-read both
source URLs, then update the snapshot: bump `Read:`, revise what changed, and **keep the
Follow-ups sections**, appending rather than replacing. A refresh that finds nothing new
still earns a new `Read:` date; that is the useful signal. Anything a refresh falsifies in
the graph needs a correction episode via `memory-capture` (through
`conflict-adjudication` first if it contradicts a stored memory) — the graph does not
expire on its own, and a stale Insight there outlives the doc that made it wrong.

## Hook Libraries — every plugin owns its own, as real files

**No symlinks anywhere in this repository, and no code shared between plugins.** A
plugin's `hooks/lib/*.cjs` are real files inside that plugin's own directory. If two
plugins ever need the same helper, each gets a copy.

- **Guard:** `npm run check:no-symlinks` (in the pre-commit hook, `test:all`, and CI)
  fails if any tracked file is committed with git mode `120000`. It reads the git index
  rather than the working tree on purpose — mode `120000` is what gets cloned, and it is
  recorded the same on every platform, whereas a Windows checkout of a symlink looks like
  an ordinary file to `lstat`. It fails rather than passes when it reads an empty index or
  an entry it cannot parse: a guard that inspected nothing must not report success, and
  `tests/check-no-symlinks.test.cjs` exercises each of those red paths against throwaway
  repositories so they cannot rot into no-ops.
- **The symptom, separately:** `tests/hook-architecture.test.cjs` asserts every lib in
  every plugin is a real file holding JavaScript. The guard above blocks the _cause_ (a
  mode in the index), which is all CI can see on Linux; this catches the _effect_ a
  Windows checkout actually produces. `CI` also smoke-runs the hooks on `windows-latest`.
- **Why the ban.** Hook libs used to live in a marketplace-root `shared/` with each
  plugin symlinking in. That shipped 3.0.0 broken on Windows: git there defaults to
  `core.symlinks=false` and writes the _link target path_ as the file's contents, so
  every hook died in `require()` parsing `../../../shared/debug.cjs` as JavaScript. The
  links also pointed outside the plugin root, which installed plugins may not do. A
  per-machine `git config core.symlinks true` fixes neither problem for someone who
  merely installs the plugin.
- **The duplication is the price, and it is the cheaper side.** A copy that drifts
  costs one stale helper in one plugin. A symlink costs every Windows user the entire
  plugin, silently, at load time.
- **Local dev:** a `"source": "directory"` marketplace entry loads in place with no copy
  step, so **the working tree is what executes** — an uncommitted edit runs, and no
  reinstall is needed. To exercise the packaging path an end user gets, install from the
  git marketplace source instead.

When a hook needs a new lib, add the real file under that plugin's `hooks/lib/`.

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

Note: pass the group explicitly. Omitting `group_id` on a write targets an unspecified one of your allowed groups, not a fixed default — so pass it whenever you can write to more than one; with exactly one group you may omit it. On reads, pass `group_ids` naming the groups you mean: omitting it includes personal scope. The `agent-memory-protocol` skill's
`references/agent-identity.md` is the normative reference.

## Related Tickets

- GP-421: Create gutt Plugin for Claude Code (parent story)
- GP-435: Repository Tooling Setup
