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
    const data = JSON.parse(input);

    // Only process Edit and Write tool results
    const toolName = data.tool_name || data.tool || "";
    if (!["Edit", "Write"].includes(toolName)) {
      process.exit(0);
    }

    // Extract file path from tool input
    const filePath = data.tool_input?.file_path || data.input?.file_path || "";
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
        linterName = "Python (black + ruff)";
        // Run black and ruff separately with array arguments
        linters = [
          { cmd: "black", args: [filePath] },
          { cmd: "ruff", args: ["check", filePath, "--fix"] },
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
      if (linted) {
        console.log(`Linted ${path.basename(filePath)} with ${linterName}`);
      }
    }
  } catch {
    // Silently exit on parse errors - don't block the tool
    process.exit(0);
  }
});
