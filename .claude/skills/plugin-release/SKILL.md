---
name: plugin-release
description: "Handles the gutt-pro release process: version bump, tag creation, GitHub release, and marketplace update. Also use for diagnosing version sync issues. Triggers on: release, bump version, publish, tag, new version, ship it, cut a release, marketplace update, version mismatch, can't update, up to date but wrong version, plugin won't update, version out of sync, wrong version."
---

# Plugin Release

**Announce:** "Starting plugin release process..."

## When to Use

After merging feature/fix PRs to main, when it's time to cut a new release. This skill handles version bumping, tagging, and release creation.

## Pre-Release Checklist

Before starting, verify:

1. **All PRs merged** — no open PRs targeting main that should be included
2. **Tests pass** — run `node tests/cursor-host.test.cjs` and any other test suites
3. **No broken hooks** — quick smoke test: `node tests/test-all-hooks.cjs` should pass
4. **Changelog reviewed** — know what's in this release (check merged PRs since last tag)

```bash
# Find what changed since last release
git log v<last_version>..HEAD --oneline
```

## Step 1: Determine Version Number

Use semantic versioning (semver):

| Change Type                      | Bump  | Example       |
| -------------------------------- | ----- | ------------- |
| Bug fix, typo, small tweak       | PATCH | 1.2.6 → 1.2.7 |
| New feature, new skill, new hook | MINOR | 1.2.6 → 1.3.0 |
| Breaking change, restructure     | MAJOR | 1.2.6 → 2.0.0 |

**Ask the user** if the version isn't obvious from the changes. When in doubt, MINOR for features, PATCH for fixes.

## Step 2: Bump Version

Each plugin's `.claude-plugin/plugin.json` `"version"` is the **single source of truth** for that plugin — `marketplace.json` deliberately carries no version fields (GP-852), and the update mechanism reads `plugin.json`'s version as its cache key. The root `package.json` version tracks the **root plugin**, `gutt-core` (whose `name` is `gutt-pro`, same as `package.json`).

### Files to update:

1. **`package.json`** — top-level `"version"` (root/repo version)
2. **`gutt-core/.claude-plugin/plugin.json`** — top-level `"version"`; **must equal `package.json`**
3. Any other plugin you changed (e.g. **`gutt-mentor/.claude-plugin/plugin.json`**) — bump its own `"version"`; it is versioned independently and does **not** track `package.json`

**Do NOT** add a `"version"` to `.claude-plugin/marketplace.json` or any of its entries — `plugin.json` is the source of truth, and `npm run check:version` (Step 2b) fails if a stray version appears there.

Put the bump in a **one-commit PR against `main`** — branch, commit the changed manifests, open the PR, merge once checks are green:

```bash
git checkout -b chore/bump-vX.Y.Z main
# edit package.json + the plugin.json file(s)
git commit -am "chore: bump version to X.Y.Z"
git push -u origin chore/bump-vX.Y.Z
gh pr create --base main --title "chore: bump version to X.Y.Z"
```

**Why a PR and not a direct push.** `main` is protected: it requires a pull request plus one approving review, and the "Lint & Format Check" and "Commit Message Lint" checks. A direct push — `git push origin main`, or `mcp__github__push_files` with `branch="main"` — is refused unless you hold admin and deliberately bypass the ruleset. Do not plan the release around a bypass being available.

A bump is genuinely mechanical, so it does not need the Copilot review a feature PR does; it still needs the branch's checks to pass, and `check:version` (Step 2b) runs among them, which is the real reason this path is worth the extra minute. If you do hold admin and the review requirement is the only thing standing in the way, `gh pr merge <N> --merge --admin` closes it without a second person — still through the PR, so the change stays recorded.

## Step 2b: Verify Version Sync

Before tagging, confirm the version invariant holds:

```bash
npm run check:version
```

This is the same zero-dep guard CI runs (`tests/check-version-sync.cjs`, GP-854): it fails if `gutt-core`'s `plugin.json` version and `package.json` disagree, or if any `marketplace.json` entry carries a `version`. **Do not create the tag/release until it exits clean** — a release cut out-of-sync silently blocks users from receiving the update.

## Step 3: Create Git Tag and GitHub Release

The plugin auto-update mechanism works off **git tags**. Users with auto-update enabled get new versions when a new tag is detected.

### Tag format: `vX.Y.Z`

Examples: `v1.3.0`, `v1.2.7`, `v2.0.0`

### Creating the release:

**Option A: gh CLI (if available)**

```bash
gh release create vX.Y.Z \
  --repo iBrain-BVBA/gutt-claude-code-plugin \
  --target main \
  --title "vX.Y.Z - <Release Title>" \
  --notes "<release notes>"
```

**Option B: GitHub UI (manual fallback)**

The GitHub MCP tools do NOT include `create_release` or `create_tag`. If `gh` CLI is not available:

1. Write release notes to a file for the user
2. Direct the user to: `https://github.com/iBrain-BVBA/gutt-claude-code-plugin/releases/new`
3. Provide:
   - Tag: `vX.Y.Z`
   - Target: `main`
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
/plugin install gutt-pro@gutt-plugins
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
   /plugin install gutt-pro@gutt-plugins
   ```

4. **Capture the release in memory:**
   ```
   mcp__gutt-mcp-remote__add_memory(
     name="Plugin Release vX.Y.Z",
     episode_body="Released gutt-pro vX.Y.Z. Changes: <summary>. Tag: vX.Y.Z.",
     source="text",
     source_description="plugin-release skill",
     last_n_episodes=0
   )
   ```

## Common Mistakes

| Mistake                                            | Prevention                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Bumping package.json but not gutt-core plugin.json | Run `npm run check:version` before tagging (CI runs it too)                        |
| Adding a `version` to marketplace.json             | It carries none by design (GP-852); plugin.json is the source of truth             |
| Creating branch instead of tag                     | `mcp__github__create_branch` ≠ tag creation — use `gh release create` or GitHub UI |
| Missing `Co-Authored-By` in version bump commit    | Include if Claude authored the bump                                                |
| Not verifying after release                        | Always check `mcp__github__list_tags` and `mcp__github__get_latest_release`        |

## Troubleshooting: Version Sync Issues

If the plugin reports "up to date" but the version is wrong:

1. **Run the sync check:**
   ```bash
   npm run check:version
   ```
2. **Check by hand if needed:**
   ```bash
   grep '"version"' package.json gutt-core/.claude-plugin/plugin.json
   ```
3. **Most likely cause:** `package.json` and `gutt-core/.claude-plugin/plugin.json` drifted apart, or a new tag was never created. `plugin.json`'s version is the update cache key — if it didn't change, Claude Code reports "already up to date."
4. **Fix:** Sync the versions, commit, push, and create a new tag.

## Repository Details

- **Owner:** `iBrain-BVBA`
- **Repo:** `gutt-claude-code-plugin`
- **Default branch:** `main`
- **Version files:** `package.json`, `gutt-core/.claude-plugin/plugin.json` (+ each plugin's own `.claude-plugin/plugin.json`)
- **Tag format:** `vX.Y.Z`
- **Auto-update:** Users with Claude Code auto-update get new versions from git tags

## Integration with Other Skills

These skills live in the same repo under `skills/`:

- **github-workflow** (`skills/github-workflow/`): Handles pre-merge workflow (PRs, Copilot review). This skill picks up after merge.
- **memory-capture** (`skills/memory-capture/`): Use to record the release event in organizational memory.
- **memory-search** (`skills/memory-search/`): Search past release context before starting.

The **jira-ticket-creation** skill lives in the user's Cowork skills directory and can be used to link releases to Jira tickets (e.g., GP-530).

## Version

Version: 1.0.0
Compatible with: gutt-pro v1.2.0+
