<#
.SYNOPSIS
    gutt-pro diagnostics collector for Windows.

.DESCRIPTION
    Gathers the plugin's own runtime state (hook logs, session records, runtime
    config), the host's plugin and hook configuration, and an inventory of Claude
    Code's session transcripts into one directory, then archives it.

    Two rules shape every step below:

      1. Never abort on a missing artifact. A collector that stops at the first
         absent file reports nothing about the twenty that were there, and
         "absent" is itself a finding — every artifact is recorded as
         ok / missing / empty / skipped with a reason, so the bundle says what it
         does not contain.
      2. Collect the minimum that answers a diagnostic question, and nothing on
         the chance it might help. Three tiers, by who owns the file:
           - This plugin's own state is copied. We know its schema, it holds no
             credential fields, and it is the subject of the investigation.
           - Files we do not own - the user's settings at either scope, the
             host's plugin inventory, a project's MCP configuration - are never
             copied. They are reduced to their shape by summarize-json.cjs: key
             names, structure, booleans and numbers, and string values only where
             the value is itself the diagnosis. A credential under a key nobody
             thought of is withheld because everything is withheld by default.
           - Conversation content is opt-in and off: prompt wording needs
             -Prompts, transcript bodies need -Transcripts.
         Credential-shaped values are additionally redacted from everything that
         is copied. That is a second line, not the first one.

    This is the Windows half of a pair. The bash collector beside it produces the
    same bundle layout, the same manifest schema, and applies the same redaction
    list, so a support engineer reads a bundle the same way whichever platform it
    came from.

    Written for Windows PowerShell 5.1 — the version Windows ships — as well as
    PowerShell 7. No ternaries, no null-coalescing, no Join-Path with more than
    two segments.

.PARAMETER OutputPath
    Write the bundle here. Defaults to a timestamped directory under $env:TEMP.

.PARAMETER Sessions
    How many of the newest session records to include, and how many transcripts
    when -Transcripts is given. Use 0 for none, all for every one. Default 5.

.PARAMETER Prompts
    Include the text of prompts and Stop breadcrumbs. Off by default: the
    timestamps alone show whether a hook fired, which is what most faults turn on.

.PARAMETER Transcripts
    Include the bodies of Claude Code session transcripts for this project. Off by
    default — a transcript is the entire conversation, including file contents you
    opened.

.PARAMETER NoArchive
    Leave the directory as-is instead of zipping it.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\collect-diagnostics.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\collect-diagnostics.ps1 -Prompts -Sessions 10
#>
[CmdletBinding()]
param(
    # -Out as well, which is what the bash collector calls it. One option surface
    # across the pair: a reader following either set of instructions gets a script
    # that accepts what they were told to type.
    [Alias('Out')]
    [string] $OutputPath = "",
    [string] $Sessions = "5",
    [switch] $Prompts,
    [switch] $Transcripts,
    [switch] $NoArchive,
    [switch] $Help
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$ScriptVersion = "1"
$BundleSchema = "gutt-diagnostics/1"

# summarize-json.cjs sits beside this file. Resolved from $PSScriptRoot rather than
# assumed, because the plugin directory this ships in is version-scoped and moves.
$Summarizer = Join-Path $PSScriptRoot 'summarize-json.cjs'

function Show-Usage {
    # Spelled out rather than deferred to Get-Help: a script invoked as
    # `powershell -File ...` is not a discoverable command, so Get-Help has nothing
    # to look up and prints an empty template. This also keeps the documented flag
    # surface next to the bash collector's, which a parity test compares.
    Write-Host @'
Collect gutt-pro diagnostics for a support request.

  powershell -ExecutionPolicy Bypass -File .\collect-diagnostics.ps1 [options]

Options
  -OutputPath <dir>  Write the bundle here (default: a timestamped directory
                     under $env:TEMP). Also spelled -Out, which is what the
                     macOS/Linux collector calls it.
  -Sessions <n>      How many of the newest session records to include, and how
                     many transcripts when -Transcripts is given.
                     Use 0 for none, all for every one. Default 5.
  -Prompts           Include the text of prompts and Stop breadcrumbs. Off by
                     default: the timestamps alone show whether a hook fired,
                     which is what most faults turn on.
  -Transcripts       Include the bodies of Claude Code session transcripts for
                     this project. Off by default - a transcript is the entire
                     conversation, including file contents you opened.
  -NoArchive         Leave the directory as-is instead of zipping it.
  -Help              Show this help.

Files this plugin does not own are never copied - the user's settings, the host's
plugin inventory and a project's MCP configuration are reduced to key names,
structure and counts. Credential-shaped values are additionally redacted from
everything that is copied. Neither is optional and there is no flag for either.
'@
}

if ($Help) {
    Show-Usage
    exit 0
}

if ($Sessions -eq 'all') {
    $SessionLimit = [int]::MaxValue
}
elseif ($Sessions -match '^[0-9]+$') {
    $SessionLimit = [int] $Sessions
}
else {
    Write-Host "-Sessions takes a number or 'all', got: $Sessions" -ForegroundColor Red
    Write-Host ""
    Show-Usage
    exit 2
}

# ---------------------------------------------------------------------------
# Redaction
#
# One list of credential-shaped key names, one set of value patterns, applied to
# every text file that goes into the bundle. The same list appears in the bash
# collector; a parity test keeps them from drifting apart, because a pattern
# present on one platform only is a leak on the other.
#
# Deliberately over-broad. A redacted projectKey costs a support engineer one
# question; a leaked token costs a credential rotation.
#
# PowerShell's -replace is case-insensitive by default, so these are plain words
# where the bash collector has to spell out character classes.
# ---------------------------------------------------------------------------

$SecretKeyWords = @(
    'token', 'secret', 'password', 'passwd', 'auth', 'authorization',
    'credential', 'cookie', 'bearer',
    'apikey', 'api_key', 'api-key',
    'accesskey', 'access_key', 'access-key',
    'privatekey', 'private_key', 'private-key'
)

# Environment variables whose value is collected rather than just their name. Each
# is a path, a label, or a mode that a fault is diagnosed from directly; nothing
# here is a credential, and everything not named here is reported as set and no
# more. The same list is in the bash collector.
$EnvValueNames = @(
    'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_VERSION',
    'CURSOR_PROJECT_DIR', 'CURSOR_VERSION', 'GUTT_GROUP_ID'
)

function Protect-Text {
    param([string] $Text)

    if ($null -eq $Text) { return "" }

    foreach ($word in $SecretKeyWords) {
        # Any JSON key whose name contains the word: keep the key, drop the value.
        $Text = $Text -replace ('("[A-Za-z0-9_.-]*' + $word + '[A-Za-z0-9_.-]*"\s*:\s*)"[^"]*"'), '$1"<redacted>"'
        # The same name as an environment assignment or an HTTP header, which is
        # how these reach a log rather than a settings file.
        $Text = $Text -replace ('([A-Za-z0-9_.-]*' + $word + '[A-Za-z0-9_.-]*\s*[=:]\s*)[^\s,;"'']+'), '$1<redacted>'
    }

    $Text = $Text -replace '(Bearer\s+)[A-Za-z0-9._~+/=-]+', '$1<redacted>'
    $Text = $Text -replace 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+', '<redacted-jwt>'
    $Text = $Text -replace '://[^/@\s"]+:[^/@\s"]+@', '://<redacted>@'
    $Text = $Text -replace '([?&](access_token|token|code|key|api_key|apikey|secret)=)[^&"\s]+', '$1<redacted>'
    $Text = $Text -replace '(sk-|ghp_|gho_|ghs_|github_pat_|xoxb-|xoxp-)[A-Za-z0-9_-]{12,}', '<redacted>'

    if (-not $Prompts) {
        # Blank the body of every prompt/Stop breadcrumb, keeping its timestamp
        # and kind. (?m) so ^ and $ mean line, not whole file.
        $Text = $Text -replace '(?m)^(\[[0-9-]{10} [0-9:]{8}\] (Prompt|Stop): ).*', '$1<content omitted>'
    }

    return $Text
}

# ---------------------------------------------------------------------------
# Host paths
# ---------------------------------------------------------------------------

$HomeDir = $env:USERPROFILE
if ([string]::IsNullOrEmpty($HomeDir)) { $HomeDir = $HOME }

$ClaudeDir = $env:CLAUDE_CONFIG_DIR
if ([string]::IsNullOrEmpty($ClaudeDir)) { $ClaudeDir = Join-Path $HomeDir '.claude' }

$ProjectDir = $env:CLAUDE_PROJECT_DIR
if ([string]::IsNullOrEmpty($ProjectDir)) { $ProjectDir = (Get-Location).Path }

$PluginsDir = Join-Path $ClaudeDir 'plugins'
$Stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmss') + 'Z'
$NowIso = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss') + 'Z'

if ([string]::IsNullOrEmpty($OutputPath)) {
    $tempRoot = $env:TEMP
    if ([string]::IsNullOrEmpty($tempRoot)) { $tempRoot = [System.IO.Path]::GetTempPath() }
    $OutputPath = Join-Path $tempRoot "gutt-diagnostics-$Stamp"
}
$OutputPath = $OutputPath.TrimEnd('\', '/')

# Root it before anything writes. The .NET file APIs below resolve a relative path
# against the process working directory, which is not the same thing as
# PowerShell's location — so a relative -OutputPath would put the bundle somewhere
# other than where it was reported.
if (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path (Get-Location).Path $OutputPath
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)

# The plugin's data directory is not in this process's environment — only hooks
# are given ${CLAUDE_PLUGIN_DATA}. Discover it instead of assuming the id: the
# host derives that id from the plugin identifier, and which marketplace the
# plugin was installed from is part of it. Every match is collected, because two
# of them is itself the diagnosis for state that keeps resetting.
$DataDirs = @()
$dataRoot = Join-Path $PluginsDir 'data'
if (Test-Path -LiteralPath $dataRoot) {
    $DataDirs = @(Get-ChildItem -LiteralPath $dataRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*gutt*' } | Sort-Object Name)
}

try {
    New-Item -ItemType Directory -Force -Path $OutputPath -ErrorAction Stop | Out-Null
}
catch {
    Write-Error "cannot create $OutputPath : $($_.Exception.Message)"
    exit 1
}

# ---------------------------------------------------------------------------
# Manifest bookkeeping
# ---------------------------------------------------------------------------

$Records = New-Object System.Collections.ArrayList

function Add-Record {
    param([string] $Path, [string] $Status, [long] $Bytes, [string] $Note)
    $null = $Records.Add([pscustomobject]@{
            path   = $Path
            status = $Status
            bytes  = $Bytes
            note   = $Note
        })
}

function Write-Utf8 {
    param([string] $Path, [string] $Content)
    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrEmpty($dir) -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir -ErrorAction SilentlyContinue | Out-Null
    }
    # Not Set-Content or Out-File: on PowerShell 5.1 the first writes ANSI and the
    # second writes UTF-16, and a support bundle nobody can grep is no bundle.
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-FileBytes {
    param([string] $Path)
    $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($null -ne $item -and -not $item.PSIsContainer) { return [long] $item.Length }
    return [long] 0
}

# Copy one text file through the redactor. $Dest is relative to the bundle.
function Copy-TextArtifact {
    param([string] $Source, [string] $Dest, [string] $Note = "")

    $target = Join-Path $OutputPath $Dest
    if (-not (Test-Path -LiteralPath $Source)) {
        $reason = $Note
        if ([string]::IsNullOrEmpty($reason)) { $reason = "not present at $Source" }
        Add-Record -Path $Dest -Status 'missing' -Bytes 0 -Note $reason
        return
    }
    try {
        $raw = [System.IO.File]::ReadAllText($Source)
    }
    catch {
        Add-Record -Path $Dest -Status 'error' -Bytes 0 -Note "could not read $Source"
        return
    }
    Write-Utf8 -Path $target -Content (Protect-Text -Text $raw)
    $bytes = Get-FileBytes -Path $target
    if ($bytes -eq 0) {
        $reason = $Note
        if ([string]::IsNullOrEmpty($reason)) { $reason = 'source was empty' }
        Add-Record -Path $Dest -Status 'empty' -Bytes 0 -Note $reason
    }
    else {
        Add-Record -Path $Dest -Status 'ok' -Bytes $bytes -Note $Note
    }
}

# Write name/type/size/mtime for a directory's entries, without their contents.
# This is how the migration backups and the transcript store are represented:
# their existence and size answer the diagnostic question, their contents are the
# user's memory notes and conversations.
function Write-DirIndex {
    param([string] $Directory, [string] $Dest, [string] $Note = "")

    $target = Join-Path $OutputPath $Dest
    if (-not (Test-Path -LiteralPath $Directory)) {
        $prefix = ""
        if (-not [string]::IsNullOrEmpty($Note)) { $prefix = "$Note; " }
        Add-Record -Path $Dest -Status 'missing' -Bytes 0 -Note "${prefix}no directory at $Directory"
        return
    }
    $lines = New-Object System.Collections.ArrayList
    $null = $lines.Add("# $Directory")
    $null = $lines.Add("# name`ttype`tbytes`tmodified")
    $count = 0
    foreach ($entry in Get-ChildItem -LiteralPath $Directory -ErrorAction SilentlyContinue) {
        if ($entry.PSIsContainer) { $type = 'dir'; $size = 0 } else { $type = 'file'; $size = $entry.Length }
        $when = $entry.LastWriteTimeUtc.ToString('yyyy-MM-dd HH:mm:ss')
        $null = $lines.Add("$($entry.Name)`t$type`t$size`t$when")
        $count++
    }
    Write-Utf8 -Path $target -Content (($lines -join "`n") + "`n")
    $suffix = 'entries'
    if ($count -eq 1) { $suffix = 'entry' }
    $prefix = ""
    if (-not [string]::IsNullOrEmpty($Note)) { $prefix = "$Note; " }
    Add-Record -Path $Dest -Status 'ok' -Bytes (Get-FileBytes -Path $target) -Note "$prefix$count $suffix"
}

# Reduce a JSON file we do not own to its shape, via summarize-json.cjs. The raw
# file is never copied and there is no fallback that copies it: when Node is
# missing the artifact is skipped, which is the safe direction and is also, in this
# plugin, a diagnosis of its own - the host spawns every hook with `node`.
function Add-JsonShape {
    param([string] $Source, [string] $Dest, [string] $Note = "")

    $prefix = ""
    if (-not [string]::IsNullOrEmpty($Note)) { $prefix = "$Note; " }

    if (-not (Test-Path -LiteralPath $Source)) {
        Add-Record -Path $Dest -Status 'missing' -Bytes 0 -Note "${prefix}not present at $Source"
        return
    }
    if ($null -eq (Get-Command 'node' -ErrorAction SilentlyContinue)) {
        Add-Record -Path $Dest -Status 'skipped' -Bytes 0 `
            -Note 'node not on PATH; the raw file is deliberately not collected'
        return
    }
    if (-not (Test-Path -LiteralPath $Summarizer)) {
        Add-Record -Path $Dest -Status 'skipped' -Bytes 0 `
            -Note 'summarize-json.cjs not found beside this script'
        return
    }
    $target = Join-Path $OutputPath $Dest
    $out = & node $Summarizer $Source 2>$null
    $status = $LASTEXITCODE
    if ($status -eq 0) {
        Write-Utf8 -Path $target -Content (([string]::Join("`n", @($out))) + "`n")
        Add-Record -Path $Dest -Status 'ok' -Bytes (Get-FileBytes -Path $target) `
            -Note "${prefix}shape only - key names, structure and counts"
    }
    else {
        Add-Record -Path $Dest -Status 'error' -Bytes 0 `
            -Note "summarize-json.cjs exited $status for $Source"
    }
}

function Get-NewestFiles {
    param([string] $Directory, [string] $Filter, [int] $Limit)
    if ($Limit -le 0) { return @() }
    if (-not (Test-Path -LiteralPath $Directory)) { return @() }
    return @(Get-ChildItem -LiteralPath $Directory -File -Filter $Filter -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First $Limit)
}

function Get-ToolVersion {
    param([string] $Command, [string[]] $CommandArgs)
    if ($null -eq (Get-Command $Command -ErrorAction SilentlyContinue)) { return 'NOT ON PATH' }
    try {
        $out = & $Command @CommandArgs 2>$null
        if ($null -eq $out) { return 'unknown' }
        return ([string]::Join(' ', @($out))).Trim()
    }
    catch {
        return 'unknown'
    }
}

# ---------------------------------------------------------------------------
# Collect: plugin runtime state (${CLAUDE_PLUGIN_DATA})
# ---------------------------------------------------------------------------

Write-Host "Collecting gutt-pro diagnostics into $OutputPath"

if ($DataDirs.Count -eq 0) {
    Add-Record -Path 'plugin-data' -Status 'missing' -Bytes 0 `
        -Note "no directory matching *gutt* under $dataRoot"
}
else {
    foreach ($dataDir in $DataDirs) {
        $id = $dataDir.Name
        $prefix = "plugin-data/$id"
        $full = $dataDir.FullName
        Copy-TextArtifact -Source (Join-Path $full 'hook-errors.log') -Dest "$prefix/hook-errors.log"
        Copy-TextArtifact -Source (Join-Path $full 'hook-invocations.log') -Dest "$prefix/hook-invocations.log"
        Copy-TextArtifact -Source (Join-Path $full 'config.json') -Dest "$prefix/config.json"
        Copy-TextArtifact -Source (Join-Path $full 'statusline.cjs') -Dest "$prefix/statusline.cjs"
        Write-DirIndex -Directory (Join-Path $full 'migrations') -Dest "$prefix/migrations-index.txt" `
            -Note 'names and sizes only, never contents'
        $sessionsDir = Join-Path $full 'sessions'
        Write-DirIndex -Directory $sessionsDir -Dest "$prefix/sessions-index.txt"
        $picked = Get-NewestFiles -Directory $sessionsDir -Filter '*.json' -Limit $SessionLimit
        foreach ($record in $picked) {
            Copy-TextArtifact -Source $record.FullName -Dest "$prefix/sessions/$($record.Name)"
        }
        if ($picked.Count -eq 0) {
            Add-Record -Path "$prefix/sessions" -Status 'skipped' -Bytes 0 `
                -Note 'no session records, or -Sessions 0'
        }
    }
}

# ---------------------------------------------------------------------------
# Collect: host settings and plugin inventory
# ---------------------------------------------------------------------------

# Not ours, and the likeliest place on the machine to hold a credential: an `env`
# block, an apiKeyHelper, an MCP server with an authorization header. Shape only.
Add-JsonShape -Source (Join-Path $ClaudeDir 'settings.json') -Dest 'host/settings-shape.json'
Add-JsonShape -Source (Join-Path $ClaudeDir 'settings.local.json') -Dest 'host/settings-local-shape.json'
Add-JsonShape -Source (Join-Path $PluginsDir 'installed_plugins.json') -Dest 'host/plugins/installed-plugins-shape.json'
Add-JsonShape -Source (Join-Path $PluginsDir 'config.json') -Dest 'host/plugins/config-shape.json'
Write-DirIndex -Directory (Join-Path $PluginsDir 'cache') -Dest 'host/plugins/cache-index.txt' `
    -Note 'one directory per installed plugin version'
Write-DirIndex -Directory (Join-Path $PluginsDir 'marketplaces') -Dest 'host/plugins/marketplaces-index.txt'
Write-DirIndex -Directory (Join-Path $PluginsDir 'repos') -Dest 'host/plugins/repos-index.txt'
Write-DirIndex -Directory $dataRoot -Dest 'host/plugins/data-index.txt'

$projectClaude = Join-Path $ProjectDir '.claude'
Add-JsonShape -Source (Join-Path $projectClaude 'settings.json') -Dest 'project/claude-settings-shape.json'
Add-JsonShape -Source (Join-Path $projectClaude 'settings.local.json') -Dest 'project/claude-settings-local-shape.json'
# An MCP configuration is server names, transports, URLs and headers, and the last
# two are where a token lives. The names answer "is a server configured, and is it
# ours", which is the whole diagnostic value; nothing else here is collected.
Add-JsonShape -Source (Join-Path $ProjectDir '.mcp.json') -Dest 'project/mcp-shape.json'

# The hook manifest that is actually installed, which is the one that fires — not
# the one in a checkout. Found by name under the version cache.
$hookManifests = @()
if (Test-Path -LiteralPath $PluginsDir) {
    $hookManifests = @(Get-ChildItem -LiteralPath $PluginsDir -Recurse -Depth 6 -File -Filter 'hooks.json' `
            -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like '*gutt*' } | Sort-Object FullName | Select-Object -First 20)
}
if ($hookManifests.Count -eq 0) {
    Add-Record -Path 'installed/hooks.json' -Status 'missing' -Bytes 0 `
        -Note "no gutt hooks.json under $PluginsDir"
}
else {
    $n = 0
    foreach ($manifest in $hookManifests) {
        $n++
        Copy-TextArtifact -Source $manifest.FullName -Dest "installed/hooks-$n.json" -Note "from $($manifest.FullName)"
        $pluginRoot = Split-Path -Parent (Split-Path -Parent $manifest.FullName)
        $pluginJson = Join-Path (Join-Path $pluginRoot '.claude-plugin') 'plugin.json'
        Copy-TextArtifact -Source $pluginJson -Dest "installed/plugin-$n.json" -Note "manifest beside hooks-$n.json"
    }
}

# ---------------------------------------------------------------------------
# Collect: Claude Code session transcripts (inventory always, bodies on request)
# ---------------------------------------------------------------------------

# The host encodes a project directory into a single directory name by flattening
# every separator to '-': the path separators of both platforms, plus ':' so a
# Windows drive letter survives, plus '.' and '_'. The same rule is in the bash
# collector — one encoding, so a bundle from either platform names the same store.
$EncodedProject = $ProjectDir -replace '[/\\:._]', '-'
$TranscriptDir = Join-Path (Join-Path $ClaudeDir 'projects') $EncodedProject
Write-DirIndex -Directory $TranscriptDir -Dest 'transcripts/index.txt' `
    -Note "session transcripts for $ProjectDir"

if ($Transcripts) {
    $picked = Get-NewestFiles -Directory $TranscriptDir -Filter '*.jsonl' -Limit $SessionLimit
    foreach ($file in $picked) {
        Copy-TextArtifact -Source $file.FullName -Dest "transcripts/$($file.Name)"
    }
    if ($picked.Count -eq 0) {
        Add-Record -Path 'transcripts/bodies' -Status 'skipped' -Bytes 0 `
            -Note "-Transcripts given but none found in $TranscriptDir"
    }
}
else {
    Add-Record -Path 'transcripts/bodies' -Status 'skipped' -Bytes 0 `
        -Note 'not requested; pass -Transcripts to include them'
}

# ---------------------------------------------------------------------------
# Collect: environment
# ---------------------------------------------------------------------------

$nodeVersion = Get-ToolVersion -Command 'node' -CommandArgs @('--version')
$claudeVersion = Get-ToolVersion -Command 'claude' -CommandArgs @('--version')

$envLines = New-Object System.Collections.ArrayList
$null = $envLines.Add("collected            $NowIso")
$null = $envLines.Add("os                   $([System.Environment]::OSVersion.VersionString)")
$null = $envLines.Add("architecture         $env:PROCESSOR_ARCHITECTURE")
$null = $envLines.Add("powershell           $($PSVersionTable.PSVersion.ToString()) ($($PSVersionTable.PSEdition))")
$null = $envLines.Add("node                 $nodeVersion")
$null = $envLines.Add("npm                  $(Get-ToolVersion -Command 'npm' -CommandArgs @('--version'))")
$null = $envLines.Add("claude               $claudeVersion")
$null = $envLines.Add("git                  $(Get-ToolVersion -Command 'git' -CommandArgs @('--version'))")
$null = $envLines.Add("claude config dir    $ClaudeDir")
$null = $envLines.Add("project dir          $ProjectDir")
$null = $envLines.Add("encoded project      $EncodedProject")
$null = $envLines.Add("")
$null = $envLines.Add("# Plugin-related environment. Which variables are set is the diagnostic;")
$null = $envLines.Add("# a value appears only for the few whose content is itself the answer.")
$envNames = @(Get-ChildItem env: -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(CLAUDE|GUTT|ANTHROPIC)_' } | Sort-Object Name)
if ($envNames.Count -eq 0) {
    $null = $envLines.Add("(none set)")
}
else {
    foreach ($item in $envNames) {
        if ($EnvValueNames -contains $item.Name) {
            $null = $envLines.Add("$($item.Name)=$($item.Value)")
        }
        else {
            $null = $envLines.Add("$($item.Name)=(set)")
        }
    }
}
$envPath = Join-Path $OutputPath 'host/environment.txt'
Write-Utf8 -Path $envPath -Content (Protect-Text -Text (($envLines -join "`n") + "`n"))
Add-Record -Path 'host/environment.txt' -Status 'ok' -Bytes (Get-FileBytes -Path $envPath) `
    -Note 'versions and allowlisted environment'

# ---------------------------------------------------------------------------
# summary.txt — what a support engineer reads first
# ---------------------------------------------------------------------------

function Format-LogStats {
    param([string] $Path, [string] $Label)
    if (-not (Test-Path -LiteralPath $Path)) {
        return ("  {0,-22} (absent or empty)" -f $Label)
    }
    $lines = @(Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)
    if ($lines.Count -eq 0) {
        return ("  {0,-22} (absent or empty)" -f $Label)
    }
    $first = $lines[0]
    $last = $lines[$lines.Count - 1]
    if ($first.Length -gt 21) { $first = $first.Substring(0, 21) }
    if ($last.Length -gt 21) { $last = $last.Substring(0, 21) }
    return ("  {0,-22} {1} lines, first {2}, last {3}" -f $Label, $lines.Count, $first, $last)
}

$promptsLabel = 'omitted'
if ($Prompts) { $promptsLabel = 'included' }
$transcriptsLabel = 'index only'
if ($Transcripts) { $transcriptsLabel = 'included' }

$s = New-Object System.Collections.ArrayList
$null = $s.Add('gutt-pro diagnostics bundle')
$null = $s.Add('===========================')
$null = $s.Add('')
$null = $s.Add("collected      $NowIso")
$null = $s.Add("collector      collect-diagnostics.ps1 v$ScriptVersion")
$null = $s.Add("platform       $([System.Environment]::OSVersion.VersionString) $env:PROCESSOR_ARCHITECTURE")
$null = $s.Add("powershell     $($PSVersionTable.PSVersion.ToString())")
$null = $s.Add("node           $nodeVersion")
$null = $s.Add("claude         $claudeVersion")
$null = $s.Add("flags          sessions=$Sessions prompts=$promptsLabel transcripts=$transcriptsLabel")
$null = $s.Add('not copied     settings, plugin inventory and MCP config - shape only (see *-shape.json)')
$null = $s.Add('')
$null = $s.Add("Plugin data directories ($($DataDirs.Count) found)")
if ($DataDirs.Count -eq 0) {
    $null = $s.Add("  none under $dataRoot — the plugin has never written state on this machine,")
    $null = $s.Add('  or it is installed under a name with no "gutt" in it.')
}
else {
    foreach ($dataDir in $DataDirs) {
        $full = $dataDir.FullName
        $null = $s.Add("  $full")
        $null = $s.Add((Format-LogStats -Path (Join-Path $full 'hook-errors.log') -Label 'hook-errors.log'))
        $null = $s.Add((Format-LogStats -Path (Join-Path $full 'hook-invocations.log') -Label 'hook-invocations.log'))

        $invocations = @(Get-Content -LiteralPath (Join-Path $full 'hook-invocations.log') -ErrorAction SilentlyContinue)
        $promptCount = @($invocations | Where-Object { $_ -match ' Prompt: ' }).Count
        $stopCount = @($invocations | Where-Object { $_ -match ' Stop: ' }).Count
        $null = $s.Add(("  {0,-22} {1} prompt, {2} Stop breadcrumb(s)" -f 'invocation counts', $promptCount, $stopCount))

        $recordCount = @(Get-ChildItem -LiteralPath (Join-Path $full 'sessions') -File -Filter '*.json' -ErrorAction SilentlyContinue).Count
        $null = $s.Add(("  {0,-22} {1}" -f 'session records', $recordCount))

        $errors = @(Get-Content -LiteralPath (Join-Path $full 'hook-errors.log') -ErrorAction SilentlyContinue)
        $sources = @($errors | ForEach-Object {
                if ($_ -match '\[([^\]]+)\]') { $matches[1] }
            } | Group-Object | Sort-Object Count -Descending | Select-Object -First 5 |
            ForEach-Object { "$($_.Name)($($_.Count))" })
        $sourceText = 'none'
        if ($sources.Count -gt 0) { $sourceText = ($sources -join ' ') }
        $null = $s.Add(("  {0,-22} {1}" -f 'top error sources', $sourceText))
    }
}

$null = $s.Add('')
$null = $s.Add('Statusline (user settings)')
# Read here to answer one boolean, never copied into the bundle.
$userSettings = Join-Path $ClaudeDir 'settings.json'
if (Test-Path -LiteralPath $userSettings) {
    $settingsText = ""
    try { $settingsText = [System.IO.File]::ReadAllText($userSettings) } catch { $settingsText = "" }
    if ($settingsText -match '"statusLine"') {
        if ($settingsText -match 'statusline\.cjs') {
            $null = $s.Add('  a statusLine pointing at statusline.cjs is present')
        }
        else {
            $null = $s.Add('  a statusLine is present but is not the gutt HUD — leave it alone')
        }
    }
    else {
        $null = $s.Add('  no statusLine key; /gutt-pro:statusline installs one on request')
    }
}
else {
    $null = $s.Add("  no $userSettings")
}

$null = $s.Add('')
$null = $s.Add('Transcript store')
if (Test-Path -LiteralPath $TranscriptDir) {
    $tcount = @(Get-ChildItem -LiteralPath $TranscriptDir -File -ErrorAction SilentlyContinue).Count
    $null = $s.Add("  $TranscriptDir ($tcount file(s))")
}
else {
    $null = $s.Add("  none at $TranscriptDir — the project may be known to the host under another")
    $null = $s.Add('  encoded name; see host/plugins/data-index.txt and transcripts/index.txt.')
}

$null = $s.Add('')
$null = $s.Add('Artifacts (see manifest.json for the full list)')
foreach ($rec in $Records) {
    $line = ("  {0,-10} {1}" -f $rec.status, $rec.path)
    if (-not [string]::IsNullOrEmpty($rec.note)) { $line = "$line — $($rec.note)" }
    $null = $s.Add($line)
}

$summaryPath = Join-Path $OutputPath 'summary.txt'
Write-Utf8 -Path $summaryPath -Content (($s -join "`n") + "`n")
Add-Record -Path 'summary.txt' -Status 'ok' -Bytes (Get-FileBytes -Path $summaryPath) -Note 'triage overview'

# ---------------------------------------------------------------------------
# manifest.json — machine-readable index of everything above
# ---------------------------------------------------------------------------

$manifest = [ordered]@{
    schema           = $BundleSchema
    collector        = 'collect-diagnostics.ps1'
    collectorVersion = $ScriptVersion
    collectedAt      = $NowIso
    platform         = "$([System.Environment]::OSVersion.VersionString) $env:PROCESSOR_ARCHITECTURE"
    claudeConfigDir  = $ClaudeDir
    projectDir       = $ProjectDir
    options          = [ordered]@{
        sessions    = $Sessions
        prompts     = $Prompts.IsPresent
        transcripts = $Transcripts.IsPresent
    }
    redaction        = [ordered]@{
        secretsRedacted = $true
        keyWords        = $SecretKeyWords.Count
    }
    files            = @($Records)
}
Write-Utf8 -Path (Join-Path $OutputPath 'manifest.json') `
    -Content (($manifest | ConvertTo-Json -Depth 6) + "`n")

# ---------------------------------------------------------------------------
# Archive
# ---------------------------------------------------------------------------

$archive = ""
if (-not $NoArchive) {
    $candidate = "$OutputPath.zip"
    try {
        if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Force }
        # The directory itself, not its contents: an archive that unpacks as loose
        # files into whatever the recipient happened to be in is a bad thing to
        # mail someone, and the bash collector packs the folder too.
        Compress-Archive -Path $OutputPath -DestinationPath $candidate -Force -ErrorAction Stop
        $archive = $candidate
    }
    catch {
        Write-Warning "could not create $candidate : $($_.Exception.Message)"
    }
}

Write-Host ""
Write-Host "Bundle directory: $OutputPath"
if (-not [string]::IsNullOrEmpty($archive)) {
    Write-Host "Archive:          $archive"
}
Write-Host ""
Write-Host "Read summary.txt first. Settings, the plugin inventory and MCP config were not"
if ($Prompts) {
    Write-Host "copied - only their key names and counts. Prompt text IS included (-Prompts was given)."
}
else {
    Write-Host "copied - only their key names and counts. Prompt text was omitted."
}
Write-Host "Review the bundle before sending it anywhere."
