#!/usr/bin/env bash
#
# gutt-pro diagnostics collector — macOS, Linux, and Git Bash on Windows.
#
# Gathers the plugin's own runtime state (hook logs, session records, runtime
# config), the host's plugin and hook configuration, and an inventory of Claude
# Code's session transcripts into one directory, then archives it.
#
# Two rules shape every step below:
#
#   1. Never abort on a missing artifact. A collector that stops at the first
#      absent file reports nothing about the twenty that were there, and "absent"
#      is itself a finding — every artifact is recorded as ok / missing / empty /
#      skipped with a reason, so the bundle says what it does not contain.
#   2. Collect the minimum that answers a diagnostic question, and nothing on the
#      chance it might help. Three tiers, by who owns the file:
#        - This plugin's own state is copied. We know its schema, it holds no
#          credential fields, and it is the subject of the investigation.
#        - Files we do not own — the user's settings at either scope, the host's
#          plugin inventory, a project's MCP configuration — are never copied.
#          They are reduced to their shape by summarize-json.cjs: key names,
#          structure, booleans and numbers, and string values only where the value
#          is itself the diagnosis. A credential under a key nobody thought of is
#          withheld because everything is withheld by default.
#        - Conversation content is opt-in and off: prompt wording needs --prompts,
#          transcript bodies need --transcripts.
#      Credential-shaped values are additionally redacted from everything that is
#      copied. That is a second line, not the first one.
#
# Keep this bash 3.2 compatible — that is what macOS ships. No associative
# arrays, no `mapfile`, no `${var,,}`, no globstar.

set -uo pipefail

SCRIPT_VERSION="1"
BUNDLE_SCHEMA="gutt-diagnostics/1"

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------

OUT_DIR=""
SESSIONS="5"
INCLUDE_PROMPTS="0"
INCLUDE_TRANSCRIPTS="0"
MAKE_ARCHIVE="1"

# summarize-json.cjs sits beside this file. Resolved from $0 rather than assumed,
# because the plugin directory this ships in is version-scoped and moves.
SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
SUMMARIZER="$SCRIPT_DIR/summarize-json.cjs"

usage() {
  cat <<'USAGE'
Collect gutt-pro diagnostics for a support request.

  bash collect-diagnostics.sh [options]

Options
  --out <dir>        Write the bundle here (default: a timestamped directory
                     under $TMPDIR). Also spelled --output-path, which is what
                     the Windows collector calls it.
  --sessions <n>     How many of the newest session records to include, and how
                     many transcripts when --transcripts is given.
                     Use 0 for none, all for every one. Default 5.
  --prompts          Include the text of prompts and Stop breadcrumbs. Off by
                     default: the timestamps alone show whether a hook fired,
                     which is what most faults turn on.
  --transcripts      Include the bodies of Claude Code session transcripts for
                     this project. Off by default — a transcript is the entire
                     conversation, including file contents you opened.
  --no-archive       Leave the directory as-is instead of zipping it.
  -h, --help         Show this help.

Files this plugin does not own are never copied — the user's settings, the host's
plugin inventory and a project's MCP configuration are reduced to key names,
structure and counts. Credential-shaped values are additionally redacted from
everything that is copied. Neither is optional and there is no flag for either.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out | --output-path)
      # `shift 2` on a lone flag fails, and swallowing that failure would leave the
      # same argument at $1 forever. Refuse instead of spinning.
      if [ $# -lt 2 ]; then
        printf -- '%s needs a directory\n' "$1" >&2
        exit 2
      fi
      OUT_DIR="$2"
      shift 2
      ;;
    --out=* | --output-path=*)
      OUT_DIR="${1#*=}"
      shift
      ;;
    --sessions)
      if [ $# -lt 2 ]; then
        printf -- '%s needs a number or "all"\n' "$1" >&2
        exit 2
      fi
      SESSIONS="$2"
      shift 2
      ;;
    --sessions=*)
      SESSIONS="${1#*=}"
      shift
      ;;
    --prompts)
      INCLUDE_PROMPTS="1"
      shift
      ;;
    --transcripts)
      INCLUDE_TRANSCRIPTS="1"
      shift
      ;;
    --no-archive)
      MAKE_ARCHIVE="0"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$SESSIONS" in
  all) SESSION_LIMIT="999999" ;;
  '' | *[!0-9]*)
    printf -- '--sessions takes a number or "all", got: %s\n' "$SESSIONS" >&2
    exit 2
    ;;
  *) SESSION_LIMIT="$SESSIONS" ;;
esac

# ---------------------------------------------------------------------------
# Redaction
#
# One list of credential-shaped key names, one set of value patterns, applied to
# every text file that goes into the bundle. The same list appears in the
# PowerShell collector; a parity test keeps them from drifting apart, because a
# pattern present on one platform only is a leak on the other.
#
# Deliberately over-broad. A redacted `projectKey` costs a support engineer one
# question; a leaked token costs a credential rotation.
# ---------------------------------------------------------------------------

SECRET_KEY_WORDS="token secret password passwd auth authorization credential cookie bearer apikey api_key api-key accesskey access_key access-key privatekey private_key private-key"

# Render a lower-case word as a case-insensitive ERE ("token" -> "[Tt][Oo]...").
# sed's case-insensitive flag is a GNU extension, so the classes are spelled out
# rather than relying on it.
ci_pattern() {
  local word="$1" out="" i char upper
  i=0
  while [ "$i" -lt "${#word}" ]; do
    char="${word:$i:1}"
    case "$char" in
      [a-z])
        upper=$(printf '%s' "$char" | tr 'a-z' 'A-Z')
        out="$out[$upper$char]"
        ;;
      *) out="$out$char" ;;
    esac
    i=$((i + 1))
  done
  printf '%s' "$out"
}

SED_ARGS=()
for word in $SECRET_KEY_WORDS; do
  pattern=$(ci_pattern "$word")
  # Any JSON key whose name contains the word: keep the key, drop the value.
  SED_ARGS+=(-e "s/(\"[A-Za-z0-9_.-]*${pattern}[A-Za-z0-9_.-]*\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"/\\1\"<redacted>\"/g")
  # The same name as a shell/env assignment or an HTTP header, which is how these
  # reach a log rather than a settings file.
  SED_ARGS+=(-e "s/([A-Za-z0-9_.-]*${pattern}[A-Za-z0-9_.-]*[[:space:]]*[=:][[:space:]]*)[^[:space:],;\"']+/\\1<redacted>/g")
done
SED_ARGS+=(
  -e 's/([Bb]earer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1<redacted>/g'
  -e 's/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/<redacted-jwt>/g'
  -e 's|://[^/@[:space:]"]+:[^/@[:space:]"]+@|://<redacted>@|g'
  -e 's/([?\&](access_token|token|code|key|api_key|apikey|secret)=)[^\&"[:space:]]+/\1<redacted>/g'
  -e 's/(sk-|ghp_|gho_|ghs_|github_pat_|xoxb-|xoxp-)[A-Za-z0-9_-]{12,}/<redacted>/g'
)

# Blank the body of every prompt/Stop breadcrumb, keeping its timestamp and kind.
PROMPT_SED='s/^(\[[0-9-]{10} [0-9:]{8}\] (Prompt|Stop): ).*/\1<content omitted>/'

# Environment variables whose value is collected rather than just their name. Each
# is a path, a label, or a mode that a fault is diagnosed from directly; nothing
# here is a credential, and everything not named here is reported as set and no
# more. The same list is in the PowerShell collector.
ENV_VALUE_NAMES="CLAUDE_CONFIG_DIR CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT CLAUDE_PLUGIN_DATA CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_VERSION CURSOR_PROJECT_DIR CURSOR_VERSION GUTT_GROUP_ID"

redact() {
  if [ "$INCLUDE_PROMPTS" = "0" ]; then
    sed -E "${SED_ARGS[@]}" | sed -E "$PROMPT_SED"
  else
    sed -E "${SED_ARGS[@]}"
  fi
}

# ---------------------------------------------------------------------------
# Host paths
# ---------------------------------------------------------------------------

HOME_DIR="${HOME:-${USERPROFILE:-}}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME_DIR/.claude}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
PLUGINS_DIR="$CLAUDE_DIR/plugins"
STAMP=$(date -u '+%Y%m%dT%H%M%SZ')
NOW_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

if [ -z "$OUT_DIR" ]; then
  OUT_DIR="${TMPDIR:-/tmp}/gutt-diagnostics-$STAMP"
fi
OUT_DIR="${OUT_DIR%/}"

# The plugin's data directory is not in this process's environment — only hooks
# are given ${CLAUDE_PLUGIN_DATA}. Discover it instead of assuming the id: the
# host derives that id from the plugin identifier, and which marketplace the
# plugin was installed from is part of it. Every match is collected, because two
# of them is itself the diagnosis for state that keeps resetting.
DATA_DIRS=""
if [ -d "$PLUGINS_DIR/data" ]; then
  DATA_DIRS=$(find "$PLUGINS_DIR/data" -maxdepth 1 -type d -name '*gutt*' 2>/dev/null | sort)
fi

mkdir -p "$OUT_DIR" || {
  printf 'cannot create %s\n' "$OUT_DIR" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Manifest bookkeeping
# ---------------------------------------------------------------------------

REC_PATH=()
REC_STATUS=()
REC_BYTES=()
REC_NOTE=()

record() {
  REC_PATH+=("$1")
  REC_STATUS+=("$2")
  REC_BYTES+=("$3")
  REC_NOTE+=("$4")
}

file_size() {
  if [ -f "$1" ]; then
    wc -c <"$1" 2>/dev/null | tr -d ' \t\n'
  else
    printf '0'
  fi
}

# GNU and BSD stat share no flags, so try each. Trimmed to 19 characters: the
# sub-second precision GNU reports is noise in a support bundle.
file_mtime() {
  local raw
  raw=$(stat -c '%y' "$1" 2>/dev/null || stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$1" 2>/dev/null)
  if [ -n "$raw" ]; then
    printf '%s' "$raw" | cut -c1-19
  else
    printf 'unknown'
  fi
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g'
}

# Copy one text file through the redactor. `dest` is relative to the bundle.
copy_text() {
  local src="$1" dest="$2" note="${3:-}"
  local target="$OUT_DIR/$dest"
  if [ ! -e "$src" ]; then
    record "$dest" "missing" "0" "${note:-not present at $src}"
    return
  fi
  mkdir -p "$(dirname "$target")" 2>/dev/null
  if redact <"$src" >"$target" 2>/dev/null; then
    local bytes
    bytes=$(file_size "$target")
    if [ "$bytes" = "0" ]; then
      record "$dest" "empty" "0" "${note:-source was empty}"
    else
      record "$dest" "ok" "$bytes" "$note"
    fi
  else
    rm -f "$target"
    record "$dest" "error" "0" "could not read $src"
  fi
}

# Write name/size/mtime for a directory's entries, without their contents. This
# is how the migration backups and the transcript store are represented: their
# existence and size answer the diagnostic question, their contents are the
# user's memory notes and conversations.
list_dir() {
  local dir="$1" dest="$2" note="${3:-}"
  local target="$OUT_DIR/$dest" entry count=0
  if [ ! -d "$dir" ]; then
    record "$dest" "missing" "0" "${note:+$note; }no directory at $dir"
    return
  fi
  mkdir -p "$(dirname "$target")" 2>/dev/null
  printf '# %s\n# name\ttype\tbytes\tmodified\n' "$dir" >"$target"
  for entry in "$dir"/*; do
    [ -e "$entry" ] || continue
    printf '%s\t%s\t%s\t%s\n' "$(basename "$entry")" \
      "$([ -d "$entry" ] && printf 'dir' || printf 'file')" \
      "$(file_size "$entry")" "$(file_mtime "$entry")" >>"$target"
    count=$((count + 1))
  done
  record "$dest" "ok" "$(file_size "$target")" "${note:+$note; }$count entr$([ "$count" = "1" ] && printf 'y' || printf 'ies')"
}

# Reduce a JSON file we do not own to its shape, via summarize-json.cjs. The raw
# file is never copied and there is no fallback that copies it: when Node is
# missing the artifact is skipped, which is the safe direction and is also, in this
# plugin, a diagnosis of its own — the host spawns every hook with `node`.
summarize_json() {
  local src="$1" dest="$2" note="${3:-}"
  local target="$OUT_DIR/$dest" status
  if [ ! -e "$src" ]; then
    record "$dest" "missing" "0" "${note:+$note; }not present at $src"
    return
  fi
  if ! command -v node >/dev/null 2>&1; then
    record "$dest" "skipped" "0" "node not on PATH; the raw file is deliberately not collected"
    return
  fi
  if [ ! -f "$SUMMARIZER" ]; then
    record "$dest" "skipped" "0" "summarize-json.cjs not found beside this script"
    return
  fi
  mkdir -p "$(dirname "$target")" 2>/dev/null
  node "$SUMMARIZER" "$src" >"$target" 2>/dev/null
  status=$?
  if [ "$status" = "0" ]; then
    record "$dest" "ok" "$(file_size "$target")" "${note:+$note; }shape only — key names, structure and counts"
  else
    rm -f "$target"
    record "$dest" "error" "0" "summarize-json.cjs exited $status for $src"
  fi
}

# The newest `limit` entries of a directory matching a glob, newest first.
newest_in() {
  local dir="$1" pattern="$2" limit="$3"
  [ -d "$dir" ] || return 0
  [ "$limit" -gt 0 ] || return 0
  # Session ids and transcript names carry no spaces, so ls -t is safe here.
  (cd "$dir" 2>/dev/null && ls -1t $pattern 2>/dev/null | head -n "$limit") || true
}

# ---------------------------------------------------------------------------
# Collect: plugin runtime state (${CLAUDE_PLUGIN_DATA})
# ---------------------------------------------------------------------------

printf 'Collecting gutt-pro diagnostics into %s\n' "$OUT_DIR"

DATA_DIR_COUNT=0
if [ -z "$DATA_DIRS" ]; then
  record "plugin-data" "missing" "0" "no directory matching *gutt* under $PLUGINS_DIR/data"
else
  while IFS= read -r data_dir; do
    [ -n "$data_dir" ] || continue
    DATA_DIR_COUNT=$((DATA_DIR_COUNT + 1))
    id=$(basename "$data_dir")
    prefix="plugin-data/$id"
    copy_text "$data_dir/hook-errors.log" "$prefix/hook-errors.log"
    copy_text "$data_dir/hook-invocations.log" "$prefix/hook-invocations.log"
    copy_text "$data_dir/config.json" "$prefix/config.json"
    copy_text "$data_dir/statusline.cjs" "$prefix/statusline.cjs"
    list_dir "$data_dir/migrations" "$prefix/migrations-index.txt" "names and sizes only, never contents"
    list_dir "$data_dir/sessions" "$prefix/sessions-index.txt"
    session_count=0
    for name in $(newest_in "$data_dir/sessions" '*.json' "$SESSION_LIMIT"); do
      copy_text "$data_dir/sessions/$name" "$prefix/sessions/$name"
      session_count=$((session_count + 1))
    done
    if [ "$session_count" = "0" ]; then
      record "$prefix/sessions" "skipped" "0" "no session records, or --sessions 0"
    fi
  done <<EOF
$DATA_DIRS
EOF
fi

# ---------------------------------------------------------------------------
# Collect: host settings and plugin inventory
# ---------------------------------------------------------------------------

# Not ours, and the likeliest place on the machine to hold a credential: an `env`
# block, an apiKeyHelper, an MCP server with an authorization header. Shape only.
summarize_json "$CLAUDE_DIR/settings.json" "host/settings-shape.json"
summarize_json "$CLAUDE_DIR/settings.local.json" "host/settings-local-shape.json"
summarize_json "$PLUGINS_DIR/installed_plugins.json" "host/plugins/installed-plugins-shape.json"
summarize_json "$PLUGINS_DIR/config.json" "host/plugins/config-shape.json"
list_dir "$PLUGINS_DIR/cache" "host/plugins/cache-index.txt" "one directory per installed plugin version"
list_dir "$PLUGINS_DIR/marketplaces" "host/plugins/marketplaces-index.txt"
list_dir "$PLUGINS_DIR/repos" "host/plugins/repos-index.txt"
list_dir "$PLUGINS_DIR/data" "host/plugins/data-index.txt"

summarize_json "$PROJECT_DIR/.claude/settings.json" "project/claude-settings-shape.json"
summarize_json "$PROJECT_DIR/.claude/settings.local.json" "project/claude-settings-local-shape.json"
# An MCP configuration is server names, transports, URLs and headers, and the last
# two are where a token lives. The names answer "is a server configured, and is it
# ours", which is the whole diagnostic value; nothing else here is collected.
summarize_json "$PROJECT_DIR/.mcp.json" "project/mcp-shape.json"

# The hook manifest that is actually installed, which is the one that fires —
# not the one in a checkout. Found by name under the version cache.
HOOK_MANIFESTS=$(find "$PLUGINS_DIR" -maxdepth 6 -path '*gutt*' -name 'hooks.json' 2>/dev/null | sort | head -n 20)
if [ -z "$HOOK_MANIFESTS" ]; then
  record "installed/hooks.json" "missing" "0" "no gutt hooks.json under $PLUGINS_DIR"
else
  n=0
  while IFS= read -r manifest; do
    [ -n "$manifest" ] || continue
    n=$((n + 1))
    copy_text "$manifest" "installed/hooks-$n.json" "from $manifest"
    plugin_json=$(dirname "$(dirname "$manifest")")/.claude-plugin/plugin.json
    copy_text "$plugin_json" "installed/plugin-$n.json" "manifest beside hooks-$n.json"
  done <<EOF
$HOOK_MANIFESTS
EOF
fi

# ---------------------------------------------------------------------------
# Collect: Claude Code session transcripts (inventory always, bodies on request)
# ---------------------------------------------------------------------------

# The host encodes a project directory into a single directory name by flattening
# every separator to `-`: the path separators of both platforms, plus `:` so a
# Windows drive letter survives, plus `.` and `_`. The same rule is in the
# PowerShell collector — one encoding, so a bundle from either platform names the
# same store.
ENCODED_PROJECT=$(printf '%s' "$PROJECT_DIR" | sed -e 's/[\/\\:._]/-/g')
TRANSCRIPT_DIR="$CLAUDE_DIR/projects/$ENCODED_PROJECT"
list_dir "$TRANSCRIPT_DIR" "transcripts/index.txt" "session transcripts for $PROJECT_DIR"

if [ "$INCLUDE_TRANSCRIPTS" = "1" ]; then
  t=0
  for name in $(newest_in "$TRANSCRIPT_DIR" '*.jsonl' "$SESSION_LIMIT"); do
    copy_text "$TRANSCRIPT_DIR/$name" "transcripts/$name"
    t=$((t + 1))
  done
  if [ "$t" = "0" ]; then
    record "transcripts/bodies" "skipped" "0" "--transcripts given but none found in $TRANSCRIPT_DIR"
  fi
else
  record "transcripts/bodies" "skipped" "0" "not requested; pass --transcripts to include them"
fi

# ---------------------------------------------------------------------------
# Collect: environment
# ---------------------------------------------------------------------------

ENV_REL="host/environment.txt"
ENV_FILE="$OUT_DIR/$ENV_REL"
mkdir -p "$(dirname "$ENV_FILE")"
{
  printf 'collected            %s\n' "$NOW_ISO"
  printf 'uname                %s\n' "$(uname -a 2>/dev/null || printf 'unknown')"
  printf 'shell                %s\n' "${SHELL:-unknown}"
  printf 'bash                 %s\n' "${BASH_VERSION:-unknown}"
  printf 'node                 %s\n' "$(node --version 2>/dev/null || printf 'NOT ON PATH')"
  printf 'npm                  %s\n' "$(npm --version 2>/dev/null || printf 'NOT ON PATH')"
  printf 'claude               %s\n' "$(claude --version 2>/dev/null || printf 'NOT ON PATH')"
  printf 'git                  %s\n' "$(git --version 2>/dev/null || printf 'NOT ON PATH')"
  printf 'claude config dir    %s\n' "$CLAUDE_DIR"
  printf 'project dir          %s\n' "$PROJECT_DIR"
  printf 'encoded project      %s\n' "$ENCODED_PROJECT"
  printf '\n# Plugin-related environment. Which variables are set is the diagnostic;\n'
  printf '# a value appears only for the few whose content is itself the answer.\n'
  env_names=$(env 2>/dev/null | sed -n 's/^\(\(CLAUDE\|GUTT\|ANTHROPIC\)_[A-Za-z0-9_]*\)=.*/\1/p' | sort -u)
  if [ -z "$env_names" ]; then
    printf '(none set)\n'
  else
    printf '%s\n' "$env_names" | while IFS= read -r name; do
      case " $ENV_VALUE_NAMES " in
        *" $name "*) printf '%s=%s\n' "$name" "$(printenv "$name" 2>/dev/null)" ;;
        *) printf '%s=(set)\n' "$name" ;;
      esac
    done | redact
  fi
} >"$ENV_FILE" 2>/dev/null
record "$ENV_REL" "ok" "$(file_size "$ENV_FILE")" "versions and allowlisted environment"

# ---------------------------------------------------------------------------
# summary.txt — what a support engineer reads first
# ---------------------------------------------------------------------------

log_stats() {
  local file="$1" label="$2"
  if [ ! -s "$file" ]; then
    printf '  %-22s (absent or empty)\n' "$label"
    return
  fi
  printf '  %-22s %s lines, first %s, last %s\n' "$label" \
    "$(grep -c '' "$file" 2>/dev/null | tr -d ' ')" \
    "$(head -n 1 "$file" 2>/dev/null | cut -c1-21)" \
    "$(tail -n 1 "$file" 2>/dev/null | cut -c1-21)"
}

SUMMARY_REL="summary.txt"
SUMMARY="$OUT_DIR/$SUMMARY_REL"
{
  printf 'gutt-pro diagnostics bundle\n'
  printf '===========================\n\n'
  printf 'collected      %s\n' "$NOW_ISO"
  printf 'collector      collect-diagnostics.sh v%s\n' "$SCRIPT_VERSION"
  printf 'platform       %s\n' "$(uname -srm 2>/dev/null || printf 'unknown')"
  printf 'node           %s\n' "$(node --version 2>/dev/null || printf 'NOT ON PATH')"
  printf 'claude         %s\n' "$(claude --version 2>/dev/null || printf 'NOT ON PATH')"
  printf 'flags          sessions=%s prompts=%s transcripts=%s\n' \
    "$SESSIONS" "$([ "$INCLUDE_PROMPTS" = 1 ] && printf 'included' || printf 'omitted')" \
    "$([ "$INCLUDE_TRANSCRIPTS" = 1 ] && printf 'included' || printf 'index only')"
  printf 'not copied     settings, plugin inventory and MCP config — shape only (see *-shape.json)\n'
  printf '\nPlugin data directories (%s found)\n' "$DATA_DIR_COUNT"
  if [ -z "$DATA_DIRS" ]; then
    printf '  none under %s/data — the plugin has never written state on this machine,\n' "$PLUGINS_DIR"
    printf '  or it is installed under a name with no "gutt" in it.\n'
  else
    while IFS= read -r data_dir; do
      [ -n "$data_dir" ] || continue
      printf '  %s\n' "$data_dir"
      log_stats "$data_dir/hook-errors.log" "hook-errors.log"
      log_stats "$data_dir/hook-invocations.log" "hook-invocations.log"
      printf '  %-22s %s prompt, %s Stop breadcrumb(s)\n' "invocation counts" \
        "$(grep -c ' Prompt: ' "$data_dir/hook-invocations.log" 2>/dev/null || printf 0)" \
        "$(grep -c ' Stop: ' "$data_dir/hook-invocations.log" 2>/dev/null || printf 0)"
      printf '  %-22s %s\n' "session records" \
        "$(find "$data_dir/sessions" -maxdepth 1 -name '*.json' 2>/dev/null | grep -c '' || printf 0)"
      printf '  %-22s %s\n' "top error sources" \
        "$(sed -n 's/^[^[]*\[\([^]]*\)\].*/\1/p' "$data_dir/hook-errors.log" 2>/dev/null |
          sort | uniq -c | sort -rn | head -n 5 | awk '{printf "%s(%s) ", $2, $1}' || printf 'none')"
    done <<EOF
$DATA_DIRS
EOF
  fi
  printf '\nStatusline (user settings)\n'
  if [ -f "$CLAUDE_DIR/settings.json" ]; then
    if grep -q '"statusLine"' "$CLAUDE_DIR/settings.json" 2>/dev/null; then
      if grep -q 'statusline.cjs' "$CLAUDE_DIR/settings.json" 2>/dev/null; then
        printf '  a statusLine pointing at statusline.cjs is present\n'
      else
        printf "  a statusLine is present but is not the gutt HUD — leave it alone\n"
      fi
    else
      printf '  no statusLine key; /gutt-pro:statusline installs one on request\n'
    fi
  else
    printf '  no %s\n' "$CLAUDE_DIR/settings.json"
  fi
  printf '\nTranscript store\n'
  if [ -d "$TRANSCRIPT_DIR" ]; then
    printf '  %s (%s file(s))\n' "$TRANSCRIPT_DIR" \
      "$(find "$TRANSCRIPT_DIR" -maxdepth 1 -type f 2>/dev/null | grep -c '' || printf 0)"
  else
    printf '  none at %s — the project may be known to the host under another\n' "$TRANSCRIPT_DIR"
    printf '  encoded name; see host/plugins/data-index.txt and transcripts/index.txt.\n'
  fi
  printf '\nArtifacts (see manifest.json for the full list)\n'
  i=0
  while [ "$i" -lt "${#REC_PATH[@]}" ]; do
    printf '  %-10s %s%s\n' "${REC_STATUS[$i]}" "${REC_PATH[$i]}" \
      "$([ -n "${REC_NOTE[$i]}" ] && printf ' — %s' "${REC_NOTE[$i]}")"
    i=$((i + 1))
  done
} >"$SUMMARY" 2>/dev/null
record "$SUMMARY_REL" "ok" "$(file_size "$SUMMARY")" "triage overview"

# ---------------------------------------------------------------------------
# manifest.json — machine-readable index of everything above
# ---------------------------------------------------------------------------

MANIFEST_REL="manifest.json"
MANIFEST="$OUT_DIR/$MANIFEST_REL"
{
  printf '{\n'
  printf '  "schema": "%s",\n' "$BUNDLE_SCHEMA"
  printf '  "collector": "collect-diagnostics.sh",\n'
  printf '  "collectorVersion": "%s",\n' "$SCRIPT_VERSION"
  printf '  "collectedAt": "%s",\n' "$NOW_ISO"
  printf '  "platform": "%s",\n' "$(json_escape "$(uname -srm 2>/dev/null || printf 'unknown')")"
  printf '  "claudeConfigDir": "%s",\n' "$(json_escape "$CLAUDE_DIR")"
  printf '  "projectDir": "%s",\n' "$(json_escape "$PROJECT_DIR")"
  printf '  "options": { "sessions": "%s", "prompts": %s, "transcripts": %s },\n' \
    "$SESSIONS" \
    "$([ "$INCLUDE_PROMPTS" = 1 ] && printf 'true' || printf 'false')" \
    "$([ "$INCLUDE_TRANSCRIPTS" = 1 ] && printf 'true' || printf 'false')"
  printf '  "redaction": { "secretsRedacted": true, "keyWords": %s },\n' "$(printf '%s' "$SECRET_KEY_WORDS" | awk '{print NF}')"
  printf '  "files": [\n'
  i=0
  while [ "$i" -lt "${#REC_PATH[@]}" ]; do
    printf '    { "path": "%s", "status": "%s", "bytes": %s, "note": "%s" }' \
      "$(json_escape "${REC_PATH[$i]}")" "${REC_STATUS[$i]}" \
      "${REC_BYTES[$i]:-0}" "$(json_escape "${REC_NOTE[$i]}")"
    i=$((i + 1))
    if [ "$i" -lt "${#REC_PATH[@]}" ]; then printf ',\n'; else printf '\n'; fi
  done
  printf '  ]\n'
  printf '}\n'
} >"$MANIFEST" 2>/dev/null

# ---------------------------------------------------------------------------
# Archive
# ---------------------------------------------------------------------------

ARCHIVE=""
if [ "$MAKE_ARCHIVE" = "1" ]; then
  parent=$(dirname "$OUT_DIR")
  base=$(basename "$OUT_DIR")
  if command -v zip >/dev/null 2>&1; then
    (cd "$parent" && zip -rq "$base.zip" "$base") && ARCHIVE="$parent/$base.zip"
  elif command -v tar >/dev/null 2>&1; then
    (cd "$parent" && tar -czf "$base.tar.gz" "$base") && ARCHIVE="$parent/$base.tar.gz"
  fi
fi

printf '\n'
printf 'Bundle directory: %s\n' "$OUT_DIR"
if [ -n "$ARCHIVE" ]; then
  printf 'Archive:          %s\n' "$ARCHIVE"
elif [ "$MAKE_ARCHIVE" = "1" ]; then
  printf 'Archive:          not created (neither zip nor tar found)\n'
fi
printf '\nRead summary.txt first. Settings, the plugin inventory and MCP config were not\n'
printf 'copied — only their key names and counts. %s\n' \
  "$([ "$INCLUDE_PROMPTS" = 1 ] && printf 'Prompt text IS included (--prompts was given).' || printf 'Prompt text was omitted.')"
printf 'Review the bundle before sending it anywhere.\n'
