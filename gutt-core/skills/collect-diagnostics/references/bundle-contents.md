# What is in a diagnostics bundle

Every artifact the collectors write, what it answers, and what it means when it is
absent. `manifest.json` is the authoritative list for a given bundle — this file
describes the shapes, the manifest describes the run.

Read `summary.txt` first. This file is for after that, when a symptom points at
one artifact and you need to know what you are looking at.

## Bundle layout

```
<bundle>/
├── summary.txt                       triage overview — counts, states, artifact roll-up
├── manifest.json                     every artifact with status, size and reason
├── plugin-data/<install-id>/         the plugin's own runtime state, one dir per install
│   ├── hook-errors.log
│   ├── hook-invocations.log
│   ├── config.json
│   ├── statusline.cjs
│   ├── sessions-index.txt
│   ├── sessions/<session-id>.json    the newest N records
│   └── migrations-index.txt          names and sizes only — never contents
├── host/
│   ├── settings.json                 user-scope settings
│   ├── settings.local.json           user-scope local overrides
│   ├── environment.txt               versions, resolved paths, allowlisted environment
│   └── plugins/
│       ├── installed_plugins.json    what the host records as installed
│       ├── config.json               plugin host config
│       ├── cache-index.txt           one entry per installed plugin version
│       ├── marketplaces-index.txt
│       ├── repos-index.txt
│       └── data-index.txt
├── project/
│   ├── claude-settings.json          project-scope settings
│   ├── claude-settings.local.json
│   └── mcp.json                      project MCP server config
├── installed/
│   ├── hooks-N.json                  the hook manifest that is actually installed
│   └── plugin-N.json                 the plugin manifest beside it, carrying the version
└── transcripts/
    ├── index.txt                     names, sizes and times — always
    └── <session-id>.jsonl            bodies — only when explicitly requested
```

## Artifact by artifact

### `plugin-data/<install-id>/`

One directory per installed identity of the plugin found on the machine. The
`<install-id>` is the host's own name for that install, so it is evidence in its
own right: **two of these means two identities, each keeping separate state**, and
that is the answer to "my settings keep resetting" and "the counter restarts".

The whole tree missing means the plugin has never written state here. That is one
of: not installed, installed but never started, or hooks never ran.

- **`hook-errors.log`** — every error a hook swallowed rather than failing the
  session on. Each line is `timestamp [source] message`, with a stack trace on the
  following lines when one was available. The bracketed source is the hook or
  library that logged it. This is the first file to open for anything intermittent:
  hooks are written to fail quietly, so this log is often the only place a fault
  appears at all. It is bounded, so a long-running install shows recent history,
  not all of it.

- **`hook-invocations.log`** — one line per prompt and one per end-of-turn, in
  order. Its value is the timeline: whether a hook ran at all, how often, and
  whether the end-of-turn pass reached a decision. Absent or empty while the plugin
  is installed and sessions have happened is a strong signal — the hooks are
  registered and not executing.

  Prompt wording is present unless the bundle was collected with prompts omitted,
  in which case each line keeps its timestamp and kind and loses its text. The
  timeline survives either way, so a bundle with prompts omitted answers "did it
  fire" just as well.

- **`config.json`** — runtime configuration: whether the plugin is on, which mode
  it is in, whether it is snoozed and until when, and the per-project space
  recording decisions taken for a specific working directory. Open this whenever
  behaviour looks disabled rather than broken. A snooze deadline in the future
  explains silence completely.

  Being hand-editable, it is also where a hand-edit that had no effect shows up —
  a value of the wrong type reads as unset rather than as the thing it looks like.

- **`statusline.cjs`** — the generated shim the user's settings point at. Its
  presence means the HUD has been installed at least once. Absent while user
  settings still name it is precisely the broken-status-line case.

- **`sessions/<session-id>.json`** — per-session lifecycle records, newest first,
  as many as the run was asked for. One record carries when the session started
  and how it started, the connectivity and tool-availability state the HUD reads,
  and how the session ended. For "memory is not being recalled" this is the file
  that says whether the tools were ever visible.

  `sessions-index.txt` lists every record on the machine, including the ones not
  copied — so the count is available even when only a handful of bodies are.

- **`migrations-index.txt`** — names, sizes and times of the backup files the
  plugin writes before a one-time migration. **Contents are never collected**:
  those files hold the user's memory notes and a settings file verbatim, and their
  size and date answer the diagnostic question — did a migration run, when, and
  is its undo still there.

### `host/`

- **`settings.json`, `settings.local.json`** — user-scope settings. The status
  line lives here and nowhere else: the host accepts one only from the user's own
  settings, so a plugin cannot install it and a missing key here is the whole
  fault. This is also where hook and plugin enablement can be overridden.

  The host rewrites this file mid-session and drops keys it is not serialising at
  the time, so a key the user is sure they set and that is not here is a known
  shape of fault rather than a contradiction.

- **`environment.txt`** — versions of the host CLI, the runtime, and the tools
  around them; the resolved configuration and project directories; the encoded
  project name the collector derived; and the plugin-related environment
  variables, values redacted. `node NOT ON PATH` here explains every hook failing
  simultaneously, because the host spawns hooks with the runtime it finds rather
  than a bundled one.

- **`plugins/installed_plugins.json`** — what the host records as installed, with
  the path each install resolves to. Compare against `cache-index.txt`: a
  recorded install path that no cache entry matches is a stale record, and the
  version that is actually running is the one under the cache.

- **`plugins/cache-index.txt`** — one directory per installed plugin version.
  Several is normal; the host keeps a previous version on disk for a while after an
  update. What matters is which one the hook manifest in `installed/` came from.

- **`plugins/data-index.txt`** — every plugin's data directory, not just this
  plugin's. Useful for spotting a second identity, and for confirming the data
  root exists at all.

### `project/`

Project-scope settings and MCP configuration, from the directory the collector
ran in. The most common surprise in a bundle: a project-scope file overriding
something the user changed at user scope. Always compare the two rather than
assuming which one is in play.

### `installed/`

The hook manifest **as installed**, which is the one that actually fires — not the
one in a checkout of the repository. `hooks-N.json` names each registered event
and the command the host will run for it; `plugin-N.json` beside it carries the
version that manifest belongs to.

No files here means the host has no registered hooks for this plugin, which makes
every "hook not firing" question answered: there is nothing to fire. More than one
pair means more than one installed version was found; read the versions in the
`plugin-N.json` files to see which.

### `transcripts/`

- **`index.txt`** — always present: names, sizes and modification times of the
  host's session transcripts for this project. Enough to see how many sessions
  exist and when the last one was, with no conversation content.

  Empty or absent while sessions have clearly happened means the host files this
  project under a different encoded directory name than the collector derived.
  Both scripts flatten path separators, drive-letter colons, dots and underscores
  to dashes; a directory that does not round-trip through that rule will not be
  found.

- **`<session-id>.jsonl`** — full transcript bodies, present only when explicitly
  requested. A transcript is the entire conversation, including the contents of
  files that were read during it. Treat a bundle carrying these as far more
  sensitive than one without.

## What redaction does and does not cover

Applied to **every text artifact**, on both platforms, with no way to switch it
off:

- values of any JSON key, environment assignment or header whose name carries a
  credential-shaped word — token, secret, password, auth, credential, cookie,
  bearer, and the API / access / private key spellings
- `Bearer` values, and anything shaped like a signed three-part web token
- the user and password in a URL, and secret-looking query parameters
- values carrying a recognisable provider key prefix

Deliberately **not** redacted, because a support engineer needs them: file paths
(which usually contain the account name), host names and server URLs without
credentials, account and organisation identifiers, email addresses, project and
group names, version numbers.

Redaction is deliberately over-broad. A redacted value that was not a secret costs
one question; a leaked one costs a rotation. When a value you needed reads
`<redacted>`, ask for it directly rather than asking for a bundle with redaction
relaxed — there is no such bundle.

**None of this is a substitute for the user reading their own bundle.** It catches
shapes. It cannot catch a credential someone typed into a prompt as prose, or a
secret pasted into a settings field under a name nothing recognises. That is why
the collectors print a review line at the end and why rule 4 leaves sending it to
the user.
