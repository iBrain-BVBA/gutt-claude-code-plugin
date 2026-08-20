# Collecting diagnostics for a support request

When the plugin misbehaves, the evidence is spread across four places: the
plugin's own hook logs and runtime state, the host's plugin and hook
configuration, your settings at two scopes, and Claude Code's session
transcripts. This page is how to gather all of it into one archive you can attach
to a support request, on macOS and on Windows.

A collector script does the gathering. It redacts credential-shaped values on the
way out, records every artifact it could and could not find, and writes a
`summary.txt` that a support engineer reads first.

## The fastest path: ask Claude Code

In a session with the plugin installed:

```
/gutt-pro:collect-diagnostics
```

It asks what content you are willing to include, runs the right collector for
your platform, then reads the bundle back and tells you what it found — often
enough to close the question without a support request at all. Everything below
is the same thing done by hand.

## macOS and Linux

The script is `collect-diagnostics.sh`, shipped inside the plugin. Its directory
is version-scoped, so find it rather than typing a path:

```bash
find ~/.claude/plugins -path '*collect-diagnostics/scripts/collect-diagnostics.sh' 2>/dev/null | sort | tail -1
```

Then run it from your project directory — the collector reads the project's own
settings and transcript inventory, so where you run it matters:

```bash
cd /path/to/your/project
bash "$(find ~/.claude/plugins -path '*collect-diagnostics/scripts/collect-diagnostics.sh' 2>/dev/null | sort | tail -1)"
```

It prints the bundle directory and the archive path on the last two lines.

If you moved Claude Code's configuration directory with `CLAUDE_CONFIG_DIR`,
search there instead of `~/.claude` — the script itself honours the variable
automatically.

### Options

| Option           | Effect                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-prompts`   | Replace the text of every prompt and end-of-turn breadcrumb with a placeholder. Timestamps stay, so the "did the hook fire" evidence survives.           |
| `--transcripts`  | Include full session transcript bodies. Off by default: a transcript is the whole conversation, including the contents of files that were read.          |
| `--sessions <n>` | How many of the newest session records to include, and how many transcripts when `--transcripts` is given. `0` for none, `all` for every one. Default 5. |
| `--out <dir>`    | Write the bundle here instead of a timestamped directory under `$TMPDIR`.                                                                                |
| `--no-archive`   | Leave the directory as-is instead of zipping it.                                                                                                         |
| `--help`         | The current option list, straight from the script.                                                                                                       |

Common case — the plugin misbehaves and you would rather not send prompt wording:

```bash
bash .../collect-diagnostics.sh --no-prompts
```

`zip` is used when present, `tar` otherwise. Neither installed means no archive;
the directory is still there and you can compress it yourself.

## Windows

The script is `collect-diagnostics.ps1`. It runs on Windows PowerShell 5.1 — the
version Windows ships, reachable as `powershell` — and on PowerShell 7, reachable
as `pwsh`. Either works.

Find it:

```powershell
Get-ChildItem "$env:USERPROFILE\.claude\plugins" -Recurse -Filter 'collect-diagnostics.ps1' -ErrorAction SilentlyContinue |
  Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName
```

Then run it from your project directory:

```powershell
cd C:\path\to\your\project
$script = Get-ChildItem "$env:USERPROFILE\.claude\plugins" -Recurse -Filter 'collect-diagnostics.ps1' -ErrorAction SilentlyContinue |
  Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName
powershell -ExecutionPolicy Bypass -File $script
```

`-ExecutionPolicy Bypass` applies to that one invocation only and changes nothing
about your machine. Without it, a default Windows execution policy refuses to run
a script file at all.

### Options

| Option              | Effect                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-NoPrompts`        | Replace the text of every prompt and end-of-turn breadcrumb with a placeholder. Timestamps stay, so the "did the hook fire" evidence survives.          |
| `-Transcripts`      | Include full session transcript bodies. Off by default: a transcript is the whole conversation, including the contents of files that were read.         |
| `-Sessions <n>`     | How many of the newest session records to include, and how many transcripts when `-Transcripts` is given. `0` for none, `all` for every one. Default 5. |
| `-OutputPath <dir>` | Write the bundle here instead of a timestamped directory under `$env:TEMP`.                                                                             |
| `-NoArchive`        | Leave the directory as-is instead of zipping it.                                                                                                        |
| `-Help`             | The current option list, straight from the script.                                                                                                      |

Common case:

```powershell
powershell -ExecutionPolicy Bypass -File $script -NoPrompts
```

**Git Bash users:** the bash collector works there too, and produces an
identical bundle. Use whichever shell you already have open.

## What ends up in the bundle

| Section         | Contents                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summary.txt`   | Counts and states: hook invocations, error sources, session records, status-line state, transcript inventory.                                                         |
| `manifest.json` | Every artifact with `ok` / `empty` / `missing` / `skipped` / `error` and a reason. Absence is recorded, not hidden.                                                   |
| `plugin-data/`  | The plugin's hook error log, invocation log, runtime config, generated status-line shim, and the newest session records. One directory per installed identity found.  |
| `host/`         | Your user-scope settings, the host's plugin inventory and version cache listing, and an environment report — tool versions, resolved paths, plugin-related variables. |
| `project/`      | The project's own settings and MCP configuration.                                                                                                                     |
| `installed/`    | The hook manifest as installed, which is the one that actually fires, plus the plugin version it belongs to.                                                          |
| `transcripts/`  | An inventory — names, sizes, times — of Claude Code's session transcripts for this project. Bodies only if you asked for them.                                        |

Two things are deliberately never collected: the contents of the plugin's
migration backups (those hold your memory notes verbatim — only their names,
sizes and dates are recorded), and transcript bodies unless you pass the flag.

## What is redacted, and what is not

Applied to every text file in the bundle, on both platforms, with no way to turn
it off:

- values of any JSON key, environment assignment, or header whose name carries a
  credential-shaped word — token, secret, password, auth, credential, cookie,
  bearer, and the API / access / private key spellings
- `Bearer` values and anything shaped like a signed three-part web token
- the user and password in a URL, and secret-looking query parameters
- values carrying a recognisable provider key prefix

Left alone, because support needs them to diagnose anything: file paths (which
usually contain your account name), host names and server URLs without
credentials, account and organisation identifiers, email addresses, project and
group names, version numbers.

Redaction is deliberately over-broad — a redacted value that was not a secret
costs one follow-up question, a leaked one costs a credential rotation.

**It catches shapes, not everything.** A credential typed into a prompt as prose,
or pasted into a settings field under a name nothing recognises, will not be
caught. Skim `summary.txt` and, if prompt text is included,
`plugin-data/*/hook-invocations.log` before you attach the archive anywhere. The
collector prints a reminder to do exactly that when it finishes.

## Sending it

Attach the archive to your support request, alongside: what you expected, what
happened, and roughly when — a timestamp lets support find the right lines in the
logs immediately.

Nothing is uploaded for you. The collector writes to your disk and stops there.

## When you would rather not send anything

Several faults are diagnosable in-session, with no bundle:

- `/gutt-pro:health` — MCP connectivity, registered hooks, status-line state,
  agent count, in one report.
- `/gutt-pro:config` — the runtime configuration as stored, including a
  hand-edited value that is having no effect.
- `/gutt-pro:statusline` — status-line state, and reinstalling it when the host
  has dropped the key.

The [Troubleshooting section of the README](../README.md#troubleshooting) covers
the three faults that account for most reports: hooks not firing, MCP connection
failures, and memory searches returning nothing.

## If the collector will not run

Then that is itself worth reporting, with the error. Meanwhile, the two files
support will ask for first are the plugin's hook logs. Find them with:

```bash
# macOS / Linux
ls -la ~/.claude/plugins/data/*gutt*/
```

```powershell
# Windows
Get-ChildItem "$env:USERPROFILE\.claude\plugins\data" -Filter '*gutt*' | ForEach-Object { Get-ChildItem $_.FullName }
```

`hook-errors.log` and `hook-invocations.log` are in there. **Read them before
sending them** — collected by hand, they carry no redaction at all, and the
invocation log contains your prompts verbatim.
