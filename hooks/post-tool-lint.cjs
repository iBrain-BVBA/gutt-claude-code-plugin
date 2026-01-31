#!/usr/bin/env node
/**
 * Post-Tool Lint Hook (Node.js - cross-platform)
 * Auto-runs linter after Edit/Write operations on source files
 *
 * Supports:
 * - Python (.py): black + ruff
 * - JavaScript/TypeScript (.js, .ts, .jsx, .tsx): eslint
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

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

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      process.exit(0);
    }

    const ext = path.extname(filePath).toLowerCase();
    let lintCommand = null;
    let linterName = null;

    // Determine linter based on extension
    switch (ext) {
      case ".py":
        linterName = "Python (black + ruff)";
        // Try black first, then ruff
        lintCommand = `black "${filePath}" 2>/dev/null; ruff check "${filePath}" --fix 2>/dev/null`;
        break;
      case ".js":
      case ".jsx":
      case ".ts":
      case ".tsx":
        linterName = "ESLint";
        lintCommand = `npx eslint "${filePath}" --fix 2>/dev/null`;
        break;
      default:
        // No linter for this file type
        process.exit(0);
    }

    if (lintCommand) {
      try {
        execSync(lintCommand, {
          stdio: "pipe",
          timeout: 30000, // 30 second timeout
          shell: true,
        });
        console.log(`Linted ${path.basename(filePath)} with ${linterName}`);
      } catch (lintError) {
        // Linter may exit non-zero for unfixable errors - that's okay
        // Only log if there's actual output
        if (lintError.stdout?.toString().trim() || lintError.stderr?.toString().trim()) {
          console.log(`Lint warnings for ${path.basename(filePath)}`);
        }
      }
    }
  } catch {
    // Silently exit on parse errors - don't block the tool
    process.exit(0);
  }
});
