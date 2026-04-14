#!/usr/bin/env node
/**
 * Post-Tool Lint Hook (Node.js - cross-platform)
 * Auto-runs linter after Edit/Write operations on source files
 *
 * Supports:
 * - Python (.py): black + ruff
 * - JavaScript/TypeScript (.js, .ts, .jsx, .tsx): eslint
 */

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { isCursor } = require("./lib/platform-detect.cjs");
const { debugLog } = require("./lib/debug.cjs");

/**
 * Validate file path to prevent command injection
 * Rejects paths containing shell metacharacters
 */
function isValidFilePath(filePath) {
  // Reject paths with shell metacharacters that could be used for injection
  const dangerousChars = /[`$(){}|;&<>!\n\r]/;
  if (dangerousChars.test(filePath)) {
    return false;
  }
  // Ensure path is absolute and normalized
  const normalized = path.normalize(filePath);
  return path.isAbsolute(normalized);
}

// Read JSON input from stdin
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim());
    debugLog("post-tool-lint", "Invoked for tool: " + (data.tool_name || data.tool || "unknown"));

    // In Claude Code: only process Edit and Write tool results
    // In Cursor: afterFileEdit fires only for file edits, no tool_name filtering needed
    const toolName = data.tool_name || data.tool || "";
    const isCursorHook = !toolName && data.file_path;
    if (!isCursorHook && !["Edit", "Write"].includes(toolName)) {
      process.exit(0);
    }

    // Extract file path: Cursor sends top-level file_path, Claude Code nests it
    const filePath = data.file_path || data.tool_input?.file_path || data.input?.file_path || "";
    if (!filePath) {
      process.exit(0);
    }

    // Validate file path to prevent command injection
    if (!isValidFilePath(filePath)) {
      process.exit(0);
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      process.exit(0);
    }

    const ext = path.extname(filePath).toLowerCase();
    let linters = null;
    let linterName = null;

    // Determine linter based on extension
    // Using array format to prevent command injection (no shell interpolation)
    switch (ext) {
      case ".py":
        linterName = "Python (ruff)";
        linters = [
          { cmd: "ruff", args: ["format", filePath] },
          { cmd: "ruff", args: ["check", filePath, "--fix", "--unfixable", "F401"] },
        ];
        break;
      case ".js":
      case ".jsx":
      case ".ts":
      case ".tsx":
        linterName = "ESLint";
        linters = [{ cmd: "npx", args: ["eslint", filePath, "--fix"] }];
        break;
      default:
        // No linter for this file type
        process.exit(0);
    }

    if (linters) {
      let linted = false;
      for (const { cmd, args } of linters) {
        try {
          execFileSync(cmd, args, {
            stdio: "pipe",
            timeout: 30000, // 30 second timeout
          });
          linted = true;
        } catch (lintError) {
          // Linter may exit non-zero for unfixable errors or not be installed - that's okay
          // Only log if there's actual output indicating warnings
          if (lintError.stdout?.toString().trim() || lintError.stderr?.toString().trim()) {
            linted = true; // Still consider it "linted" if it ran
          }
        }
      }
      if (linted && !isCursor()) {
        console.log(`Linted ${path.basename(filePath)} with ${linterName}`);
      }
    }
  } catch {
    // Silently exit on parse errors - don't block the tool
    process.exit(0);
  }
});
