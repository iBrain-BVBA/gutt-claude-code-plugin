# Plugin platform reference (upstream)

**Source:** <https://code.claude.com/docs/en/plugins-reference.md>
**Read:** 2026-08-02 (§1 re-read, unchanged) · 2026-07-29 (§1–§8) ·
**Method:** `WebFetch`, then the fetched page read directly
**Companion:** [`hook-platform-capabilities.md`](./hook-platform-capabilities.md) — same
provenance, hook events and their output contracts.

Not a transcription of the upstream page. This records the parts that bear on decisions
already made here, one conflict with our own docs (§3, half resolved), and capability we
are not using. Read the source for anything else.

## 1. Confirmed: only two keys work in a plugin's `settings.json`

Verbatim, from the file-locations table:

> **Settings** · `settings.json` · "Default configuration applied when the plugin is
> enabled. Only the `agent` and `subagentStatusLine` keys are currently supported"

This settles the HUD question authoritatively: a plugin **cannot** ship the main
`statusLine`, only `subagentStatusLine`. The statusline HUD needs a key in the user's own
`settings.json` — the constraint is upstream, not ours, and no amount of plugin-side work
removes it.

**Re-read 2026-08-02, verbatim unchanged.** This closes a question the earlier read left
open: whether some Claude Code version once honoured a plugin's top-level `statusLine`,
which would have made it a version-floor problem rather than a flat limit. It is a flat
limit. Two related findings from the same pass, both from
<https://code.claude.com/docs/en/statusline.md>:

- **`subagentStatusLine` is not a fallback.** It "renders a custom row body for each
  subagent shown in the agent panel below the prompt", taking a `tasks` array and
  emitting one JSON line per row. A different surface, not a narrower main HUD — it
  cannot show session connection state, so it never was an option for this.
- **The statusline payload carries a `context_window` object**: `total_input_tokens`,
  `total_output_tokens`, `context_window_size`, `used_percentage`,
  `remaining_percentage`, `current_usage.*`, and `exceeds_200k_tokens`. Plus
  `refreshInterval` and `padding` on the settings entry, and `COLUMNS`/`LINES` in the
  environment. Context metrics need no hook.

### 1a. The hazard that shapes how the key is written

Not from the reference page — from
[anthropics/claude-code#62486](https://github.com/anthropics/claude-code/issues/62486),
read 2026-08-02. Claude Code rewrites `settings.json` **mid-session** and the write path
"serialises only the schema fields relevant to the current operation, rather than
round-tripping the full settings object". Keys not in that path are dropped:
`statusLine`, `enabledPlugins`, and `hooks` are all named. **Closed as not planned.**

Two consequences worth carrying beyond the HUD. `enabledPlugins` on that list means any
mechanism depending on a user-settings key can have it removed underneath it, silently,
through no fault of ours. And the only workaround the thread produces is to re-assert
from a SessionStart hook — which is what GP-867 does, gated on a stored consent record so
it only ever restores something the user chose.

Provenance: a public issue thread, not a doc read and not a measurement. Lower than
**Read** on the ladder in the companion file. What it predicts has not been reproduced
here deliberately — reproducing it means waiting for the CLI to eat a key.

## 2. `userConfig` — the field that replaces hand-edited config

> `userConfig` · object · "User-configurable values prompted at enable time."
> "Use this instead of requiring users to hand-edit `settings.json`."

```json
{
  "userConfig": {
    "api_token": {
      "type": "string",
      "title": "API token",
      "description": "API authentication token",
      "sensitive": true
    }
  }
}
```

We ship `config.json.example` and ask users to copy and edit it. `userConfig` prompts at
enable time instead, and supports `sensitive: true`. This is the single largest piece of
unused capability found in this pass. It does **not** obviously subsume the machine-global
`config.json` (that holds runtime state, not user input), so what it replaces is a design
question, not a mechanical swap.

Related: **`defaultEnabled`** (boolean, default `true`) ships a plugin installed-but-off,
for plugins that "add cost or scope a user should opt into". Precedence: the user's
`enabledPlugins` entry, then a dependency requirement, then `defaultEnabled`. Relevant to
the `enabled` config surface.

## 3. Symlinks: settled by abandoning them, not by answering the question

**Measured 2026-08-01 — the question stopped mattering, and the reason is the finding.**

We never resolved whether `--plugin-dir` honours a symlink pointing outside the plugin
root. Windows answered a different and more important question first: on a
`core.symlinks=false` checkout — git's **default** there — git does not create a link at
all. It writes the link's target path as the file's contents. `hooks/lib/debug.cjs`
becomes a 25-byte text file reading `../../../shared/debug.cjs`, and `require()` raises
`SyntaxError`. All 7 hooks in gutt-pro 3.0.0 died this way on a real user's machine.

So the platform's dereferencing rules were never the binding constraint. **Git's checkout
behaviour is**, it applies before the platform sees anything, and it defaults against us
on one of the three platforms we support. GP-933 removed every symlink from the
repository and added `tests/check-no-symlinks.cjs` to keep them out; each plugin now owns
its hook libs as real files.

Keep the rest of this section. It is the reasoning that was available before the failure,
and it is a good record of how a question can be researched carefully and still be the
wrong question — the doc-read conflict below was litigated at length while the actual
defect sat in git's default configuration, unexamined.

Upstream, verbatim:

> **Within the plugin's own directory:** the symlink is preserved as a relative symlink in
> the cache. · **Elsewhere within the same marketplace:** the symlink is dereferenced.
> The target's content is copied into the cache in its place. · **Outside the
> marketplace:** the symlink is skipped for security.
>
> "For plugins installed with `--plugin-dir` or from a local path, **only symlinks that
> resolve within the plugin's own directory are preserved. All others are skipped.**"

`CLAUDE.md` said, until GP-933 deleted the claim along with its subject:

> "`--plugin-dir` / local-path installs do **not** dereference cross-plugin symlinks.
> Running from the repo works (the link resolves in place)."

**Those did not agree.** The `hooks/lib/*.cjs` symlinks then targeted `../../../shared/` —
the marketplace root, i.e. _outside the plugin's own directory_. Upstream said those are
**skipped** under `--plugin-dir`, which would mean a hook whose `require()` of its lib
fails. Our docs said the link resolved in place.

Both could have been true if `--plugin-dir` loads from disk without a copy step, in which
case the "skipped" rule describes only the copy path. That was a guess, and it stayed one.
Note also:

> "Installed plugins cannot reference files outside their directory. Paths that traverse
> outside the plugin root (such as `../shared-utils`) will not work after installation."

Settling it would have taken an actual run against a plugin whose lib symlinks point at a
marketplace-root directory, checking whether the hook loads — the shape guard of the day
checked the _shape_ of the links, not whether the platform honoured them. That run was
never made, and there is now nothing to make it against.

### Historical — partially resolved 2026-07-29: directory-source installs DID resolve them

_Everything below describes the repository as it was before GP-933. No symlinks remain, so
none of it is current guidance; it is kept as the record of what was known when._

Observed, not read. In a live interactive session with the repo registered as an
`extraKnownMarketplaces` entry of `"source": "directory"`:

- `gutt-core/hooks/lib/builtin-memory.cjs` is a symlink to `../../../shared/builtin-memory.cjs`,
  resolving to the marketplace root — **outside** the plugin directory, the case upstream
  says is skipped.
- `session-start.cjs:28` requires `./lib/builtin-memory.cjs`, i.e. that symlink.
- The GP-922 migration offer fired, carrying text byte-identical to `offerContext(35)`.
- `installed_plugins.json` records `installPath` as the 3.0.0 cache directory, and **that
  directory is empty** — it holds no `shared/`, no `gutt-core/`, nothing. Its recorded
  `gitCommitSha` is `accc4b6`, which predates the offer code entirely.

The offer code therefore cannot have come from the cache; it ran from the working tree,
through a symlink that resolves outside the plugin directory. **The symlink was honoured.**

The claim was narrow, and worth restating with its limits since it is the only part of
this section that was ever established by a run:

- **Shown:** a `"source": "directory"` marketplace entry loads in place, with no copy step,
  and cross-plugin symlinks into a marketplace-root directory resolved at runtime.
- **Never tested:** `--plugin-dir` specifically. A different flag that may take a different
  path. Upstream's "all others are skipped" is stated about the _copy_ into the cache, so
  it plausibly never applied to an in-place load — but that stayed inference.
- **Unchanged and still true:** the marketplace-install case, where dereferencing is what
  makes installed plugins self-contained.

Only the in-place-load half was ever confirmed; the `--plugin-dir` half never was, and now
cannot be from this repository.

An operational consequence worth knowing independently of the symlink question: with a
directory-source install whose cache directory is empty, **the working tree is what runs**.
Edits to hooks and skills are live on the next session start with no reinstall — and
equally, an uncommitted local edit is what executes, not what was pushed.

## 4. `${CLAUDE_PLUGIN_DATA}` is deletable on uninstall — and holds the GP-922 backup

> `${CLAUDE_PLUGIN_DATA}` resolves to `~/.claude/plugins/data/{id}/`, where `{id}` is the
> plugin identifier with characters outside `a-z`, `A-Z`, `0-9`, `_`, `-` replaced by `-`.

> "By default, uninstalling from the last remaining scope also deletes the plugin's
> `${CLAUDE_PLUGIN_DATA}` directory. Use `--keep-data` to preserve it."

The `migrate-memory` backup — the only copy of the user's notes once the local store is
deleted — is written under `${CLAUDE_PLUGIN_DATA}/migrations/`. It survives plugin
_updates_, which is what the skill relies on and what the docs confirm. It does **not**
survive an uninstall of the last scope. Worth deciding whether that is acceptable; it is
currently undocumented in the skill.

And on `${CLAUDE_PLUGIN_ROOT}`:

> "`${CLAUDE_PLUGIN_ROOT}` changes when the plugin updates. The previous version's
> directory remains on disk for about two weeks after an update before cleanup, but treat
> it as ephemeral and **don't write state there**."

Consistent with our runtime-state convention. The cache is `~/.claude/plugins/cache`, one
directory per version, orphaned versions removed after 14 days, and Glob/Grep skip them.

## 5. Manifest facts worth knowing

- **The manifest is optional.** Without it, components are auto-discovered at default
  paths and the name comes from the directory. `name` is the only required field.
- **Unrecognized top-level fields are ignored** and reported by `claude plugin validate`
  as warnings, not errors — but **wrong types are load errors**. `--strict` turns warnings
  into errors: `claude plugin validate ./my-plugin --strict`. **We do not run this in CI.**
- **Path fields replace vs. extend, and it differs per field.** `commands`, `agents`,
  `workflows`, `outputStyles`, `experimental.themes`, `experimental.monitors` _replace_
  the default directory. `skills` _adds to_ the default `skills/` scan. `hooks`,
  `mcpServers`, `lspServers` have their own merge rules. All paths must be relative to
  the plugin root and start with `./`.
- **`experimental.*`** now houses `themes` and `monitors`; declaring them top-level still
  works but warns, and a future release will require the nested form.
- `displayName` requires v2.1.143+, `defaultEnabled` requires v2.1.154+.
- **`version` omitted → the git commit SHA is the version**, so every commit reads as a
  new version. `plugin.json` wins over the marketplace entry.

## 6. Component surface we do not use

| Component        | Default path             | Note                                                                      |
| ---------------- | ------------------------ | ------------------------------------------------------------------------- |
| `bin/`           | `bin/`                   | Executables added to the Bash tool's `PATH`, invokable as bare commands   |
| `workflows/`     | `workflows/`             | Workflow script files                                                     |
| `output-styles/` | `output-styles/`         | Output style definitions                                                  |
| `.lsp.json`      | plugin root              | Language Server configs                                                   |
| `monitors/`      | `monitors/monitors.json` | Background monitors, start automatically when the plugin is active        |
| `themes/`        | `themes/`                | Color themes                                                              |
| `channels`       | manifest key             | Channel declarations for message injection (Telegram/Slack/Discord style) |
| `dependencies`   | manifest key             | Other plugins required, with optional semver constraints                  |

`bin/` is the most immediately interesting: our skills shell out via
`node "$CLAUDE_PLUGIN_ROOT/skills/.../store-cli.cjs"`, which `bin/` would shorten to a
bare command.

## 7. One layout rule we already follow, stated

> "The `.claude-plugin/` directory contains the `plugin.json` file. All other directories
> (commands/, agents/, skills/, workflows/, output-styles/, themes/, monitors/, hooks/)
> **must be at the plugin root**, not inside `.claude-plugin/`."

> "A `CLAUDE.md` file at the plugin root **is not loaded as project context.** Plugins
> contribute context through skills, agents, and hooks rather than CLAUDE.md."

The second is worth internalizing: our repo-root `CLAUDE.md` is project context because
the repo root is not a plugin. `gutt-core/CLAUDE.md` would do nothing.

## 8. Bare command resolution, and the `/config` collision — **Measured**

**Measured 2026-07-31** against a real `claude` run with the plugin loaded from this
working tree (GP-931). Not a doc read: the probe sent one prompt per verb through the e2e
harness (`tests/e2e/lib/claude-run.cjs`) and read the resulting `additionalContext`
attachments out of the session transcript. Only `gutt-core/hooks/lib/config-command.cjs` produces those
strings, so an injection is proof the raw text reached `UserPromptSubmit` **and** the
parser matched it. Script: `tests/e2e/probes/bare-verb-resolution.cjs`, committed so this
result can be reproduced rather than taken on trust. It is not named `*.e2e.cjs` on
purpose — it costs real model calls and has no pass/fail, so it stays out of
`npm run test:e2e`.

Plugin `name` was `gutt-pro`, commands `config|on|off|disable|mode`, no other plugin
declaring those names.

| Typed        | Reached `UserPromptSubmit` as typed | Result                                                            |
| ------------ | ----------------------------------- | ----------------------------------------------------------------- |
| `/mode hitl` | yes                                 | our command ran; outcome injected                                 |
| `/off`       | yes                                 | our command ran; outcome injected                                 |
| `/on`        | yes                                 | our command ran; outcome injected                                 |
| `/disable`   | yes                                 | our command ran; outcome injected                                 |
| `/config`    | **no**                              | Claude Code's built-in `/config` answered with its own usage text |

**A bare plugin command does resolve unprefixed and does reach the hook**, arguments
included — four of five verbs behaved exactly as the namespaced form does.

**`/config` is not reachable bare.** The built-in wins, and it wins _before_
`UserPromptSubmit`: that turn produced no injection at all, not even the first-prompt
memory pointer every other ordinary prompt draws. So the built-in intercepts the token
rather than passing it through as prompt text — a plugin cannot observe, shadow, or
recover it. `/gutt-pro:config` is the only spelling that reaches us, which is why the
migration guide and every in-product forms line quote the namespaced form.

The parser still accepts a bare `config`. It costs one array lookup on a path that never
receives it, and removing it would encode a platform behaviour we would then have to
re-probe if the built-in list ever changes.

**Not established:** whether an _interactive_ session behaves as this `-p` run did, and
whether the built-in list is fixed or version-dependent. Both would need their own probe.

**A precondition, not a finding.** This run had no other plugin declaring `on`, `off`,
`mode` or `disable`, so it says nothing about what happens when one does. Routing and
text-matching are independent: `parseCommand` sees raw prompt text, so a bare `/off`
routed to _another_ plugin still matches here and still writes. Nothing enforces the
precondition at runtime, and no probe would — it is a property of the user's install, not
of the platform. What the code does instead is announce itself: a bare-form match
prepends the verb it ran, so a collision is visible the first time rather than never.
Making the four mutating verbs namespaced-only would prevent the write instead of
exposing it, and remains open.

**Also not established:** whether the count in the table rules out `/config` reaching a
hook by any path, or only rules out `configCommandResult` running. Only the second is
claimed. The probe's census is flat across the session, so it cannot attribute a
non-injection to a specific turn — and a config-verb turn emits no recall pointer anyway,
so the absence of one proves nothing extra.

## Follow-ups

Recorded, none done.

1. **Verify §3** with a real `--plugin-dir` run before trusting either sentence.
2. Decide whether `userConfig` should replace the `config.json.example` hand-edit flow.
3. Add `claude plugin validate --strict` to CI.
4. Document the uninstall/`--keep-data` caveat in `migrate-memory`, or move the backup.
5. Consider `bin/` for `store-cli.cjs`.
6. Re-probe §8 interactively, and check whether the built-in command list that beats a
   plugin's own is version-dependent.

## Provenance

One `WebFetch` pass on 2026-07-29; the response exceeded the inline limit and was
persisted, then read directly — so §1–§7 are quoted from the page text rather than from a
model's summary of it, which makes them more reliable than a summarized fetch.

§8 has a different and stronger provenance: it is not from the page at all, but from a real
`claude` run on 2026-07-31 whose evidence is a session transcript. Where §8 and any doc read
disagree, §8 wins.

Everything under "Follow-ups", and every judgement about what this means for our design,
is our inference and not upstream text. §3 is explicitly an unresolved conflict, not a
finding.
