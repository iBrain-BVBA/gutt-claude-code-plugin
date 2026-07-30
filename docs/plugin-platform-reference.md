# Plugin platform reference (upstream)

**Source:** <https://code.claude.com/docs/en/plugins-reference.md>
**Read:** 2026-07-29 · **Method:** `WebFetch`, then the fetched page read directly
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
`settings.json`, which is what GP-867 has to solve — the constraint is upstream, not ours,
and no amount of plugin-side work removes it.

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

## 3. Symlinks: resolved for directory-source, open for `--plugin-dir`

Confirmed by observation for a directory source; still unverified for `--plugin-dir`. The
doc-read conflict is kept below because the reasoning is what bounds the resolution.

Upstream, verbatim:

> **Within the plugin's own directory:** the symlink is preserved as a relative symlink in
> the cache. · **Elsewhere within the same marketplace:** the symlink is dereferenced.
> The target's content is copied into the cache in its place. · **Outside the
> marketplace:** the symlink is skipped for security.
>
> "For plugins installed with `--plugin-dir` or from a local path, **only symlinks that
> resolve within the plugin's own directory are preserved. All others are skipped.**"

`CLAUDE.md` currently says:

> "`--plugin-dir` / local-path installs do **not** dereference cross-plugin symlinks.
> Running from the repo works (the link resolves in place)."

**These do not agree.** Our `hooks/lib/*.cjs` symlinks target `../../../shared/` — the
marketplace root, i.e. _outside the plugin's own directory_. Upstream says those are
**skipped** under `--plugin-dir`, which would mean a hook whose `require()` of its lib
fails. Our docs say the link resolves in place.

Both can be true if `--plugin-dir` loads from disk without a copy step, in which case the
"skipped" rule describes only the copy path. That is a guess. Note also:

> "Installed plugins cannot reference files outside their directory. Paths that traverse
> outside the plugin root (such as `../shared-utils`) will not work after installation."

**Do not edit `CLAUDE.md` from this doc read alone.** The resolution is an actual run
against a plugin whose lib symlinks point at `shared/`, checking whether the hook loads.
`check:shared` guards the _shape_ of the links, not whether the platform honours them.

### Partially resolved 2026-07-29 — directory-source installs DO resolve them

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

Scope this claim carefully — it is narrower than the sentence in `CLAUDE.md`:

- **Proven:** a `"source": "directory"` marketplace entry loads in place, no copy step, and
  cross-plugin symlinks into `shared/` resolve at runtime.
- **Still untested:** `--plugin-dir` specifically. It is a different flag and may take a
  different path. Upstream's "all others are skipped" is stated about the _copy_ into the
  cache, so it plausibly never applies to an in-place load — but that remains inference.
- **Unchanged:** the marketplace-install case, where dereferencing is what makes installed
  plugins self-contained.

So `CLAUDE.md`'s "running from the repo works (the link resolves in place)" is **confirmed
for directory-source**, and its `--plugin-dir` half is still unverified. The flag in
`CLAUDE.md` is narrowed to match rather than removed.

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

## Follow-ups

Recorded, none done.

1. **Verify §3** with a real `--plugin-dir` run before trusting either sentence.
2. Decide whether `userConfig` should replace the `config.json.example` hand-edit flow.
3. Add `claude plugin validate --strict` to CI.
4. Document the uninstall/`--keep-data` caveat in `migrate-memory`, or move the backup.
5. Consider `bin/` for `store-cli.cjs`.

## Provenance

One `WebFetch` pass on 2026-07-29; the response exceeded the inline limit and was
persisted, then read directly — so §1–§7 are quoted from the page text rather than from a
model's summary of it, which makes them more reliable than a summarized fetch.

Everything under "Follow-ups", and every judgement about what this means for our design,
is our inference and not upstream text. §3 is explicitly an unresolved conflict, not a
finding.
