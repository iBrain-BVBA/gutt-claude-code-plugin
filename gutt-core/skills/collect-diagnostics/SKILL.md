---
name: collect-diagnostics
description: "Collect a redacted diagnostics bundle for a support request — hook invocation and error logs, plugin runtime state, the installed hook manifest, host and project settings, and a transcript inventory — then read it and name the fault. Use when the plugin misbehaves and evidence is needed, or when support asks for logs. Triggers on: collect diagnostics, diagnostics bundle, support bundle, send logs, hook logs, hooks not firing, hook errors, plugin not working, memory not being recalled, statusline missing, nothing is being captured, troubleshoot the plugin, debug info for support."
---

# Collect diagnostics

Two jobs, in order: produce a bundle that is safe to send, then read it and say
what is wrong. The bundle is the deliverable the user can forward; the reading is
what makes running this better than telling them to zip a folder.

A collector script does the gathering — one for macOS and Linux, one for Windows.
Both write the same layout and apply the same redaction, so everything below is
platform-independent once the right one has run.

## Hard rules (non-negotiable — read first)

1. **Run the script; never gather by hand.** No `cat` of a settings file into the
   conversation, no reading a log and quoting it back, no `cp` of a plugin data
   directory. The collectors reduce every file the plugin does not own to its key
   names and counts, and redact credential-shaped values from the rest; a file you
   read yourself arrives whole, in a transcript, and cannot be unsent. This holds
   even when the shape file does not answer your question — a settings file that
   the shape says has an `env` block is not an invitation to go and read it.
2. **Run with the defaults, and do not widen speculatively.** Prompt wording and
   transcript bodies are both off. Do not turn either on to make your own
   diagnosis easier, and do not offer them at the start as though the choice were
   routine. If a default bundle genuinely cannot answer the question, use
   **AskUserQuestion** then, naming the one flag you need and the one fault it
   would settle.
3. **Never paste the bundle into the conversation.** Report the path, and report
   your findings in your own words. A bundle quoted back into a transcript
   defeats the point of writing it to a file.
4. **You do not send it anywhere.** Tell the user where it is and what is in it;
   they attach it. Uploading, mailing, or posting it to an issue is theirs to do.
5. **Read `summary.txt` before any other file.** It carries the counts and the
   states most faults show up in. Only then open the specific artifact the
   symptom points at.
6. **A withheld value is not a gap to route around.** The shape files carry key
   names, structure, booleans and counts, and withhold string values except where
   the value is the diagnosis. When the one you wanted reads `<string:44>`, ask the
   user for that single value directly. Never ask them to send the raw file, and
   never offer to relax the rule — there is no flag for it and adding one would be
   the wrong fix.
7. **An absent artifact is a finding, not a gap.** Every file is recorded in
   `manifest.json` as `ok`, `empty`, `missing`, `skipped` or `error` with a
   reason. "The hook manifest is missing" and "the log is empty" are diagnoses.
   Report them as such rather than re-running to try to fill them in.
8. **Report what the bundle shows, including nothing.** If it is healthy, say so
   and say which fault classes that rules out. Do not assemble a likely story out
   of an empty log.

## How to invoke the collector (get this right before step 1)

**The Bash tool inherits neither `CLAUDE_PLUGIN_ROOT` nor `CLAUDE_PLUGIN_DATA`.**
Only hooks are given those; a command you run is a different process with a
different environment, and both expand to nothing there. Resolve the one value you
need from what you were handed directly:

- **`<SKILL_DIR>`** — the "Base directory for this skill" line in your skill
  preamble.

The scripts do not need the data directory passed in. They find it by looking
under the host's plugin data root for every directory whose name carries this
plugin's, and collect all of them — because more than one is itself the diagnosis
for state that keeps resetting.

**macOS and Linux** (also Git Bash on Windows):

```bash
bash "<SKILL_DIR>/scripts/collect-diagnostics.sh" [options]
```

**Windows** (PowerShell, either edition):

```powershell
powershell -ExecutionPolicy Bypass -File "<SKILL_DIR>\scripts\collect-diagnostics.ps1" [options]
```

Choose by the platform the session is on, not by which shell you prefer. Pass
`--help` / `-Help` if you need the current option list rather than trusting the
table below.

| Intent                                  | bash            | PowerShell          |
| --------------------------------------- | --------------- | ------------------- |
| Default bundle, zipped — start here     | _(no options)_  | _(no options)_      |
| Include prompt and Stop breadcrumb text | `--prompts`     | `-Prompts`          |
| Include full transcript bodies          | `--transcripts` | `-Transcripts`      |
| More or fewer session records           | `--sessions 20` | `-Sessions 20`      |
| Write somewhere specific                | `--out <dir>`   | `-OutputPath <dir>` |
| Skip the archive                        | `--no-archive`  | `-NoArchive`        |

The last four are routine. The first two are the ones rule 2 governs: they add the
user's conversation to a file they are about to send someone.

Both print the bundle directory and the archive path on the last two lines. Read
those from the output rather than reconstructing them.

## The flow

1. **Run.** One invocation, no flags. A non-zero exit with no bundle directory
   printed means the collector could not create its output directory — report that
   and stop; there is nothing to read.
2. **Read `summary.txt`.** Whole, once. It is a few dozen lines.
3. **Triage.** Take the user's symptom to the table below and open the one or two
   artifacts it names. `references/bundle-contents.md` describes every artifact,
   what it means when it is missing, and which tier it was collected under.
4. **Widen only if you must.** If the default bundle cannot settle it, rule 2's
   **AskUserQuestion** goes here — one flag, one named fault — not at the start.
5. **Report.** The archive path, the fault you can name, and the evidence line
   that names it. Then what to do: a fix if the bundle shows one, otherwise the
   path to attach to a support request.

## Triage — symptom to artifact

| Symptom                                            | Look at                                                              | What it means                                                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing the plugin does happens at all             | `plugin-data` row in `manifest.json`                                 | `missing` means the plugin has never written state on this machine: not installed, installed but never started, or the host never ran its hooks.     |
| Hooks not firing                                   | `installed/hooks-*.json`, then `hook-invocations.log`                | No installed manifest → the host has no hooks registered. Manifest present but no prompt breadcrumbs → the hooks are registered and not running.     |
| Hooks firing but erroring                          | `hook-errors.log`, and the `top error sources` line of `summary.txt` | The bracketed name on each line is the hook or lib that logged it. A repeated `MODULE_NOT_FOUND` points at a path that moved under the plugin.       |
| `node` errors, or hooks dead right after an update | `host/environment.txt`                                               | `node NOT ON PATH` explains every hook failing at once. The host spawns hooks with whatever `node` the user has, not a bundled one.                  |
| Memory never recalled, or the HUD shows no server  | newest file under `plugin-data/*/sessions/`                          | The connectivity and tool-availability fields recorded there are what the HUD renders. A record with none of them means connectivity never resolved. |
| End-of-turn capture never happens                  | `Stop` breadcrumb count in `summary.txt`, then `config.json`         | No Stop lines at all → the Stop hook is not running. Stop lines saying suppressed → the plugin is off or snoozed; `config.json` says which.          |
| Statusline missing or showing a stale path         | `Statusline` section of `summary.txt`, then `host/settings.json`     | The host accepts a status line only from user settings, and drops the key when it rewrites the file. `/gutt-pro:statusline` reinstalls it.           |
| Settings changes not taking effect                 | `host/settings.json` vs `project/claude-settings.json`               | Two scopes, and the project one is often the surprise. Compare rather than assuming which one the user edited.                                       |
| State resets between sessions                      | `plugin-data/` directory count, `host/plugins/cache-index.txt`       | Two plugin data directories means two installed identities each keeping their own state. Several cache directories is normal — one per version.      |
| A session's history seems gone                     | `transcripts/index.txt`                                              | Empty or absent means the host is filing this project's transcripts under a different encoded directory name than the collector derived.             |

`/gutt-pro:health` answers several of these live and without a bundle. Prefer it
when the user wants an answer rather than an attachment, and use this skill when
the fault needs evidence someone else can read.

## What the bundle withholds, and what to do about it

Three tiers, by who owns the file:

- **This plugin's own state is copied.** Its schema is known, it carries no
  credential fields, and it is the subject of the investigation.
- **Files the plugin does not own are reduced to a shape** — the user's settings at
  either scope, the host's plugin inventory, a project's MCP configuration. Key
  names, structure, booleans and counts survive; string values do not, except the
  few where the value is the diagnosis (a `command`, a version, an install path).
  So a `*-shape.json` tells you an `env` block exists and which variables are in
  it, never what they hold; that an MCP server is configured and under what name,
  never its URL or headers.
- **Conversation content is off** unless a flag turned it on.

Read a shape file for what it does say. "The project scope defines `permissions`
and the user scope does not" is a complete finding, and it needed no values.

## Reporting

Give them, in this order:

1. **The archive path**, exactly as the collector printed it.
2. **One sentence naming the fault**, or naming its absence.
3. **The evidence** — the artifact and the line, not a paraphrase of the whole
   bundle.
4. **What is in it**: that files the plugin does not own were reduced to key names
   and counts rather than copied, and whether any content flag was used. Tell them
   to skim `summary.txt` before attaching it anywhere; it is their data and the
   review is theirs.

If the bundle is healthy and the symptom persists, say that plainly, name what it
rules out, and hand them the archive for support. A clean bundle with the symptom
still live is a useful report; a guess dressed as a finding is not.
