#!/usr/bin/env node
/**
 * Shared IDE environment detection for hooks
 *
 * Detects whether we're running under Claude Code or Cursor
 * and provides IDE-agnostic paths for state, logs, and config.
 */

const path = require("path");
const os = require("os");

/** Plugin root directory (set by the host IDE) */
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || process.env.CURSOR_PLUGIN_ROOT;

/** Project directory (set by the host IDE) */
const PROJECT_DIR =
  process.env.CLAUDE_PROJECT_DIR || process.env.CURSOR_PROJECT_DIR || process.cwd();

/** Which IDE is running this hook: 'claude' or 'cursor' */
const IDE =
  process.env.CLAUDE_PLUGIN_ROOT || process.env.CLAUDE_PROJECT_DIR
    ? "claude"
    : process.env.CURSOR_PLUGIN_ROOT || process.env.CURSOR_PROJECT_DIR || process.env.CURSOR_VERSION
      ? "cursor"
      : "claude";

/** IDE-specific dot-directory name (.claude or .cursor) */
const STATE_DIR_NAME = IDE === "claude" ? ".claude" : ".cursor";

/** Home directory (cross-platform) */
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();

/** IDE state directory within the project (e.g. <project>/.claude or <project>/.cursor) */
const PROJECT_STATE_DIR = path.join(PROJECT_DIR, STATE_DIR_NAME);

/** User-scope IDE config directory (e.g. ~/.claude or ~/.cursor) */
const USER_CONFIG_DIR = path.join(HOME_DIR, STATE_DIR_NAME);

module.exports = {
  PLUGIN_ROOT,
  PROJECT_DIR,
  IDE,
  STATE_DIR_NAME,
  HOME_DIR,
  PROJECT_STATE_DIR,
  USER_CONFIG_DIR,
};
