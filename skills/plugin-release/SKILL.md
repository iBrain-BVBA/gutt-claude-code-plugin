---
name: plugin-release
description: "Handles the gutt-claude-code-plugin release process: version bump, tag creation, GitHub release, and marketplace update. Use when releasing a new plugin version. Triggers on: release, bump version, publish, tag, new version, ship it, cut a release, marketplace update."
---

# Plugin Release

**Announce:** "Starting plugin release process..."

## When to Use

After merging feature/fix PRs to master, when it's time to cut a new release. This skill handles version bumping, tagging, and release creation.

## Pre-Release Checklist

Before starting, verify:

1. **All PRs merged** — no open PRs targeting master that should be included
2. **Tests pass** — run `node tests/cowork-hooks.test.cjs` and any other test suites
3. **No broken hooks** — quick smoke test: `node hooks/stop-lessons.cjs < /dev/null` should exit cleanly
4. **Changelog reviewed** — know what's in this release (check merged PRs since last tag)

```bash
# Find what changed since last release
git log v<last_version>..HEAD --oneline
```

## Step 1: Determine Version Number

Use semantic versioning (semver):

| Change Type | Bump | Example |
|---|---|---|
| Bug fix, typo, small tweak | PATCH | 1.2.6 → 1.2.7 |
| New feature, new skill, new hook | MINOR | 1.2.6 → 1.3.0 |
| Breaking change, restructure | MAJOR | 1.2.6 → 2.0.0 |

**Ask the user** if the version isn't obvious from the changes. When in doubt, MINOR for features, PATCH for fixes.

## Step 2: Bump Version in 3 Files

**CRITICAL:** All 3 files must have the same version. This is the most common release mistake.

### Files to update:

1. **`package.json`** — top-level `"version"` field
2. **`.claude-plugin/plugin.json`** — top-level `"version"` field
3. **`.claude-plugin/marketplace.json`** — `plugins[0].version` field (NOT the top-level `version` which is the marketplace schema version `1.0.0`)

### How to bump:

```javascript
// package.json
{ "version": "X.Y.Z" }  // ← Update this

// .claude-plugin/plugin.json
{ "version": "X.Y.Z" }  // ← Update this

// .claude-plugin/marketplace.json
{
  "version": "1.0.0",  // ← DO NOT CHANGE (marketplace schema version)
  "plugins": [{
    "version": "X.Y.Z"  // ← Update this
  }]
}
```

Use `mcp__github__push_files` to update all 3 in a single commit to master:

```
mcp__github__push_files(
  owner="iBrain-BVBA",
  repo="gutt-claude-code-plugin",
  branch="master",
  message="chore: bump version to X.Y.Z",
  files=[...all 3 files with updated version...]
)
```

**NOTE:** Version bump commits go directly to master. This is an intentional exception to the PR workflow — version bumps are mechanical (no code logic changes) and happen after all feature PRs are already merged and reviewed. The github-workflow skill's "no direct pushes to master" rule does not apply to version bump commits.

## Step 3: Create Git Tag and GitHub Release

The plugin auto-update mechanism works off **git tags**. Users with auto-update enabled get new versions when a new tag is detected.

### Tag format: `vX.Y.Z`

Examples: `v1.3.0`, `v1.2.7`, `v2.0.0`

### Creating the release:

**Option A: gh CLI (if available)**
```bash
gh release create vX.Y.Z \
  --repo iBrain-BVBA/gutt-claude-code-plugin \
  --target master \
  --title "vX.Y.Z - <Release Title>" \
  --notes "<release notes>"
```

**Option B: GitHub UI (manual fallback)**

The GitHub MCP tools do NOT include `create_release` or `create_tag`. If `gh` CLI is not available:

1. Write release notes to a file for the user
2. Direct the user to: `https://github.com/iBrain-BVBA/gutt-claude-code-plugin/releases/new`
3. Provide:
   - Tag: `vX.Y.Z`
   - Target: `master`
   - Title: `vX.Y.Z - <Release Title>`
   - Release notes (pre-written)

**NOTE:** This is a known limitation. The GitHub MCP (as of Feb 2026) supports reading releases/tags but not creating them.

## Step 4: Write Release Notes

Use this template:

````markdown
## What's New

### <Feature/Fix Title> (GP-XXX)

<2-3 sentence summary of the change>

#### New Files
- **`path/to/file`** — brief description

#### Modified Files
- **`path/to/file`** — what changed

### Other Changes
- <bullet points for minor changes>

## Upgrade
Users with auto-update enabled will receive this version automatically. Manual install:
```
/plugin install gutt-claude-code-plugin@gutt-plugins
```
````

For the release title, use a concise description of the main feature:
- `v1.3.0 - Cowork Automatic Lesson Capture`
- `v1.2.7 - Fix hook output format`
- `v2.0.0 - Breaking: New hook architecture`

## Step 5: Post-Release Verification

After the release is created:

1. **Verify tag exists:**
   ```
   mcp__github__list_tags(owner="iBrain-BVBA", repo="gutt-claude-code-plugin", perPage=3)
   ```

2. **Verify release exists:**
   ```
   mcp__github__get_latest_release(owner="iBrain-BVBA", repo="gutt-claude-code-plugin")
   ```

3. **Test install:**
   ```
   /plugin install gutt-claude-code-plugin@gutt-plugins
   ```

4. **Capture the release in memory:**
   ```
   mcp__gutt-mcp-remote__add_memory(
     name="Plugin Release vX.Y.Z",
     episode_body="Released gutt-claude-code-plugin vX.Y.Z. Changes: <summary>. Tag: vX.Y.Z.",
     source="text",
     source_description="plugin-release skill",
     last_n_episodes=0
   )
   ```

## Common Mistakes

| Mistake | Prevention |
|---|---|
| Forgetting one of the 3 version files | Always use `mcp__github__push_files` with all 3 in one commit |
| Bumping marketplace.json top-level version | That's `1.0.0` (schema version) — don't touch it |
| Creating branch instead of tag | `mcp__github__create_branch` ≠ tag creation — use `gh release create` or GitHub UI |
| Missing `Co-Authored-By` in version bump commit | Include if Claude authored the bump |
| Not verifying after release | Always check `mcp__github__list_tags` and `mcp__github__get_latest_release` |

## Repository Details

- **Owner:** `iBrain-BVBA`
- **Repo:** `gutt-claude-code-plugin`
- **Default branch:** `master`
- **Version files:** `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- **Tag format:** `vX.Y.Z`
- **Auto-update:** Users with Claude Code auto-update get new versions from git tags

## Integration with Other Skills

These skills live in the same repo under `skills/`:

- **github-workflow** (`skills/github-workflow/`): Handles pre-merge workflow (PRs, Copilot review). This skill picks up after merge.
- **memory-capture** (`skills/memory-capture/`): Use to record the release event in organizational memory.
- **memory-retrieval** (`skills/memory-retrieval/`): Search past release context before starting.

The **jira-ticket-creation** skill lives in the user's Cowork skills directory and can be used to link releases to Jira tickets (e.g., GP-530).

## Version

Version: 1.0.0
Compatible with: gutt-claude-code-plugin v1.2.0+
