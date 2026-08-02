# Migrating to gutt-pro 3.0

**Status:** the rename section below was written by GP-931. GP-894 owns the full 2.x → 3.0
migration guide and should absorb this file rather than duplicate it.

---

## The plugin is now `gutt-pro`

The core plugin's `name` changed from `gutt-claude-code-plugin` to `gutt-pro`. In Claude
Code, a plugin's `name` is its identity — it namespaces every skill and command, and it
determines where the plugin's runtime state lives. So this is a rename with consequences,
not a cosmetic change.

**A rename is a new plugin identity, not an update.** You will not be offered an update.
The version-keyed cache path (`plugins/cache/<marketplace>/<name>/<version>`) changes
wholesale, so the old install and the new one are two different plugins as far as the
platform is concerned.

### Before you uninstall anything

1. **Finish any in-flight built-in-memory migration, and verify it.** If you started
   `migrate-memory` and have not confirmed the episodes landed in gutt, finish that
   first. Once the local store's files are deleted, the only remaining copy of your
   notes is the backup under `${CLAUDE_PLUGIN_DATA}/migrations/` — and that directory is
   deleted when you uninstall the last scope of the plugin.
2. **Write down your settings.** They do not carry over (see below). Run
   `/gutt-claude-code-plugin:gutt config` on the old install and keep the output — that
   spelling only exists if you are running 3.0 from source, which is the only way to
   have these settings at all (see the note under "Your settings reset").

   If you have already switched, you have not lost the values: the first session after
   the rename reads the old directory and reports what did not carry over, naming the
   verb that re-applies each one. It never moves or deletes anything.

### The move

```
/plugin uninstall gutt-claude-code-plugin --keep-data
/plugin install gutt-pro@gutt-plugins
```

**Use `--keep-data`.** It is not enforced, but omitting it deletes
`~/.claude/plugins/data/gutt-claude-code-plugin-<marketplace>/` outright — and if you
have ever run `migrate-memory`, the backup in that directory is the only remaining copy
of the notes the migration deleted locally. Keeping it costs nothing; it is the
difference between a recoverable mistake and an unrecoverable one.

The marketplace itself is unchanged. The GitHub repository keeps its name
(`iBrain-BVBA/gutt-claude-code-plugin`), so every existing
`/plugin marketplace add` URL still works and needs no edit.

### ⚠ Never run both at once

If the old plugin is still installed when the new one loads, both register their hooks.
The symptoms are duplicates, not errors: **two recall injections per prompt, two Stop
judges spawning two model calls per turn, two status lines.** Uninstall before you
install.

### Your settings reset

`${CLAUDE_PLUGIN_DATA}` is derived from the plugin's name, so it moves with the rename.
Nothing is migrated across. What you lose, and what to re-apply:

| Orphaned                   | What it held                              | Re-apply with                       |
| -------------------------- | ----------------------------------------- | ----------------------------------- |
| `config.json` → `enabled`  | a durable off                             | `/gutt-pro:disable`                 |
| `config.json` → `mode`     | `auto` or `hitl` capture mode             | `/gutt-pro:mode hitl`               |
| `config.json` → `snooze*`  | an active snooze                          | `/gutt-pro:off [minutes]`           |
| `config.json` → `projects` | per-project "migrated / declined" answers | nothing — you may be re-offered     |
| `sessions/`                | per-session state for live sessions       | nothing; regenerated                |
| `migrationsVersion`        | the one-time 2.x cleanup marker           | nothing; it re-runs once, see below |
| `migrations/`              | **the built-in-memory backup**            | nothing — read the warning above    |

**If you are upgrading from 2.7.1** — the last tagged release — the `config.json` rows
above do not apply to you. `enabled`, `mode` and the snooze keys were all added in the
unreleased 3.0 line, so there is nothing of yours in them. You lose `sessions/`,
`migrationsVersion` and `migrations/` only.

Three consequences worth naming:

- **The per-project migration answers are gone**, so a project where you declined the
  built-in-memory migration may be offered it again — as an `AskUserQuestion` prompt,
  not a line of prose. Declining again is one click.
- **The 2.x cleanup re-runs.** `MIGRATIONS_VERSION` resets with the data directory, so
  `gutt-core/hooks/lib/migrations.cjs` executes once more on first run. It only ever removes
  provably-dead files, so the second pass should be a no-op — but note that its
  `~/.claude/settings.json` exemption re-opens for that one run, and that the rename
  can make your `statusLine` target genuinely dead, in which case the re-run removes
  that key. It says so when it does.
- **The first session reports the orphaned directory.** A read-only probe names what
  it found there and how to re-apply it. It runs once, gated on `migrationsVersion`.

## The config commands changed shape

The `/gutt` stem is gone. There is now one command per verb, and **`off` and `disable`
swapped meanings**.

| 3.0                     | Now                         | Effect                                                 |
| ----------------------- | --------------------------- | ------------------------------------------------------ |
| `/gutt config`          | `/gutt-pro:config`          | show settings and the state they add up to             |
| `/gutt on`              | `/gutt-pro:on`              | clear a durable off and any snooze                     |
| `/gutt off`             | `/gutt-pro:disable`         | **durable** off; survives restarts, until `on`         |
| `/gutt off session`     | `/gutt-pro:off`             | off for the rest of this session (**the new default**) |
| `/gutt off 30`          | `/gutt-pro:off 30`          | off for 30 minutes (1–10080)                           |
| `/gutt off session`     | `/gutt-pro:off session`     | explicit spelling; identical to bare `off`             |
| `/gutt mode auto\|hitl` | `/gutt-pro:mode auto\|hitl` | capture mode                                           |

### Read this row twice

**`off` is no longer durable.** If you learned 3.0's `/gutt off` and type
`/gutt-pro:off`, you get a snooze that ends with the session, not a setting that
survives a restart. The durable one is `/gutt-pro:disable`.

`/gutt-pro:config` names the scope of whatever is in force — "for this session" versus
"until `/gutt-pro:on`" — so you can always check which one you have.

### The old spellings do nothing at all

`/gutt …`, `/gutt:<sub>` and `/gutt-claude-code-plugin:gutt <sub>` are not aliases and
not deprecation warnings. They stop being commands: the text reaches Claude as an
ordinary prompt and no setting changes.

That is deliberate, and it is the safer of the two failures. An alias would have been
worse than silence here, because `off` reversed meaning in the same change — the old
spelling would have quietly done something other than what you meant by it.

## Renamed skill and command ids

Everything namespaced by the plugin moved. If you have these written down in a project's
`CLAUDE.md`, a settings allowlist, or your own notes, update them:

| Was                                         | Now                          |
| ------------------------------------------- | ---------------------------- |
| `gutt-claude-code-plugin:memory-search`     | `gutt-pro:memory-search`     |
| `gutt-claude-code-plugin:memory-capture`    | `gutt-pro:memory-capture`    |
| `gutt-claude-code-plugin:migrate-memory`    | `gutt-pro:migrate-memory`    |
| `gutt-claude-code-plugin:output-style`      | `gutt-pro:output-style`      |
| `/gutt-claude-code-plugin:setup`            | `/gutt-pro:setup`            |
| `/gutt-claude-code-plugin:health`           | `/gutt-pro:health`           |
| `/gutt-claude-code-plugin:onboard`          | `/gutt-pro:onboard`          |
| `/gutt-claude-code-plugin:memory-retrieval` | `/gutt-pro:memory-retrieval` |

`memory-retrieval` was already a deprecated alias for `memory-search` (GP-856). It still
resolves under the new namespace, but the path it existed to preserve is broken by the
rename either way — prefer `gutt-pro:memory-search`.
