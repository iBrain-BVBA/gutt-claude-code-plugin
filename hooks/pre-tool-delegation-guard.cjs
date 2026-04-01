#!/usr/bin/env node
/**
 * PreToolUse hook — Orchestrator Delegation Guard
 *
 * Enforces the rule that the orchestrator (main Claude process) must NOT
 * directly use state-changing tools.  It should delegate to subagents via
 * Task/Agent instead.
 *
 * Blocked tools : Edit, Write, NotebookEdit, Bash (state-changing commands)
 * Allowed tools : Read, Glob, Grep, Task, Agent, AskUserQuestion, MCP tools
 * Bash nuance   : read-only commands are allowed; state-changing commands are blocked
 */

const { debugLog } = require("./lib/debug.cjs");

const HOOK_NAME = "pre-tool-delegation-guard";

// ── Blocked tools (non-Bash) ────────────────────────────────────────────────
const ALWAYS_BLOCKED = new Set(["Edit", "Write", "NotebookEdit"]);

// ── Bash: read-only command prefixes that are safe for the orchestrator ──────
const READONLY_PREFIXES = [
  // Git read commands
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git tag",
  "git remote",
  "git stash list",
  "git rev-parse",
  "git describe",
  "git shortlog",
  "git blame",
  "git ls-files",
  "git ls-tree",
  "git cat-file",
  "git config --get",
  "git config --list",
  "git reflog",
  // File system read commands
  "ls",
  "cat ",
  "head ",
  "tail ",
  "wc ",
  "file ",
  "stat ",
  "find ",
  "du ",
  "df ",
  "tree ",
  "pwd",
  "echo ",
  "printenv",
  "env",
  "which ",
  "where ",
  "type ",
  // GitHub CLI read commands
  "gh pr list",
  "gh pr view",
  "gh pr status",
  "gh pr checks",
  "gh pr diff",
  "gh issue list",
  "gh issue view",
  "gh issue status",
  "gh repo view",
  "gh run list",
  "gh run view",
  "gh api ",
  "gh auth status",
  "gh release list",
  "gh release view",
  // Node/npm read commands
  "node --check",
  "node -c ",
  "node -e ",
  "npm list",
  "npm ls",
  "npm view",
  "npm info",
  "npm outdated",
  "npm audit",
  "npx tsc --noEmit",
  // Other read-only
  "jq ",
  "grep ",
  "rg ",
  "ag ",
  "diff ",
  "sort ",
  "uniq ",
  "curl ",
  "wget ",
  "python -c ",
  "python3 -c ",
];

// ── Bash: git workflow + gh CLI commands (allowed for orchestrator) ─────────
const WORKFLOW_PREFIXES = [
  // Git workflow commands (non-destructive)
  "git commit",
  "git push",
  "git add",
  "git merge",
  "git fetch",
  "git pull",
  "git stash apply",
  // GitHub CLI write commands
  "gh pr create",
  "gh pr merge",
  "gh pr edit",
  "gh pr close",
  "gh pr reopen",
  "gh pr comment",
  "gh issue create",
  "gh issue close",
  "gh issue edit",
  "gh issue comment",
  "gh release create",
];

// ── Bash: state-changing command prefixes that must be blocked ───────────────
const WRITE_PREFIXES = [
  // Git destructive commands
  "git rm",
  "git mv",
  "git tag -d",
  "git branch -d",
  "git branch -D",
  "git stash drop",
  "git stash pop",
  "git rebase",
  "git cherry-pick",
  "git reset",
  "git checkout --",
  "git restore",
  "git clean",
  // Package managers (install/modify)
  "npm install",
  "npm i ",
  "npm ci",
  "npm uninstall",
  "npm update",
  "npm run",
  "npm exec",
  "npm init",
  "npm publish",
  "npm link",
  "npx ",
  "yarn ",
  "pnpm ",
  "pip install",
  "pip uninstall",
  "pip3 install",
  "pip3 uninstall",
  "cargo install",
  "cargo build",
  "cargo run",
  // File system write commands
  "rm ",
  "rmdir ",
  "mv ",
  "cp ",
  "mkdir ",
  "touch ",
  "chmod ",
  "chown ",
  "ln ",
  // Editors
  "sed ",
  "awk ",
  "nano ",
  "vim ",
  "vi ",
  // Build / run
  "make",
  "cmake",
  "docker ",
  "kubectl ",
  // GitHub CLI destructive commands
  "gh release delete",
];

// Exceptions to WRITE_PREFIXES — these look like writes but are actually reads
const WRITE_EXCEPTIONS = [
  "npx tsc --noEmit",
  "npm run lint",
  "npm run check",
  "npm run typecheck",
  "npm run test",
  "node --test",
  "npm run format:check",
  "npm run lint:check",
];

// ── Agent routing suggestions ───────────────────────────────────────────────
const AGENT_SUGGESTIONS = {
  Edit: "Delegate to a general-purpose executor agent for file edits.",
  Write: "Delegate to a general-purpose executor agent for creating/writing files.",
  NotebookEdit: "Delegate to a general-purpose executor agent for notebook edits.",
  Bash: "Delegate to a general-purpose executor agent for build/install commands, or a devops agent for infrastructure commands.",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a command string for prefix matching.
 * Trims whitespace, collapses runs of whitespace, and strips leading
 * env-var assignments (e.g. "FOO=bar cmd" → "cmd").
 */
function normalizeCommand(cmd) {
  if (!cmd) {
    return "";
  }
  // Trim and collapse whitespace
  let normalized = cmd.trim().replace(/\s+/g, " ");
  // Strip leading env-var assignments (e.g., FOO=bar cmd)
  normalized = normalized.replace(/^(?:[A-Z_][A-Z0-9_]*=[^\s]*\s+)+/, "");
  return normalized;
}

/**
 * Check whether a command string starts with any prefix in the list.
 */
function matchesAny(cmd, prefixes) {
  const lower = cmd.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p.toLowerCase()) || lower === p.toLowerCase());
}

/**
 * Classify a Bash command as "allow", "block", or "warn".
 */
function classifyBashCommand(rawCommand) {
  const cmd = normalizeCommand(rawCommand);
  if (!cmd) {
    return { verdict: "warn", detail: "Empty command" };
  }

  // Check write exceptions first (e.g., npx tsc --noEmit is safe)
  if (matchesAny(cmd, WRITE_EXCEPTIONS)) {
    return { verdict: "allow" };
  }

  // Git workflow + gh CLI commands → allow (non-destructive workflow commands)
  if (matchesAny(cmd, WORKFLOW_PREFIXES)) {
    return { verdict: "allow" };
  }

  // gh api with write HTTP methods → block
  if (/^gh\s+api\b/i.test(cmd)) {
    if (/(?:--method|-X)\s+(POST|PUT|PATCH|DELETE)\b/i.test(cmd)) {
      return { verdict: "block", detail: "gh api (write method)" };
    }
    return { verdict: "allow" };
  }

  // Explicit write commands → block
  if (matchesAny(cmd, WRITE_PREFIXES)) {
    return { verdict: "block", detail: cmd.split(" ").slice(0, 3).join(" ") };
  }

  // Known read-only commands → allow
  if (matchesAny(cmd, READONLY_PREFIXES)) {
    return { verdict: "allow" };
  }

  // Unknown command → allow with warning (don't block things we don't recognize)
  return { verdict: "warn", detail: cmd.split(" ").slice(0, 3).join(" ") };
}

// ── Main ────────────────────────────────────────────────────────────────────

// Only run stdin handler when executed directly (not when required for testing)
if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(input || "{}");

      // ── Subagent bypass ─────────────────────────────────────────────────
      // Subagents ARE the delegates — they need full tool access.
      // The guard only restricts the main orchestrator (no agent_id).
      if (data.agent_id) {
        debugLog(HOOK_NAME, `Subagent ${data.agent_type || data.agent_id} — bypassing guard`);
        process.exit(0);
      }

      const toolName = data.tool_name || "";
      const toolInput = data.tool_input || {};

      // ── Plan file exception ──────────────────────────────────────────────
      // Allow Write/Edit for Claude plan files (used by planning workflows)
      if (ALWAYS_BLOCKED.has(toolName)) {
        const filePath = toolInput.file_path || toolInput.path || "";
        if (filePath && /[/\\]\.claude[/\\]plans[/\\]/.test(filePath)) {
          process.exit(0);
        }
      }

      // ── Non-Bash blocked tools ──────────────────────────────────────────
      if (ALWAYS_BLOCKED.has(toolName)) {
        const suggestion = AGENT_SUGGESTIONS[toolName] || "Delegate to a subagent.";
        const result = {
          decision: "block",
          reason:
            `Orchestrator must not use ${toolName} directly. ` +
            `${suggestion} ` +
            `Use the Task tool to delegate this work to the appropriate agent.`,
        };
        process.stdout.write(JSON.stringify(result));
        process.exit(0);
      }

      // ── Bash tool — classify the command ────────────────────────────────
      if (toolName === "Bash") {
        const command = toolInput.command || "";
        const { verdict, detail } = classifyBashCommand(command);

        if (verdict === "block") {
          const suggestion = AGENT_SUGGESTIONS.Bash;
          const result = {
            decision: "block",
            reason:
              `Orchestrator must not run state-changing Bash commands directly (detected: ${detail}). ` +
              `${suggestion} ` +
              `Use the Task tool to delegate this work to the appropriate agent.`,
          };
          process.stdout.write(JSON.stringify(result));
          process.exit(0);
        }

        if (verdict === "warn") {
          // Allow but add context warning
          const result = {
            decision: "allow",
            additionalContext:
              `[delegation-guard] Unrecognized command (${detail || "unknown"}). ` +
              `If this command changes state, consider delegating to a subagent instead.`,
          };
          process.stdout.write(JSON.stringify(result));
          process.exit(0);
        }

        // verdict === "allow" — silent pass-through
        process.exit(0);
      }

      // ── All other tools — allow silently ────────────────────────────────
      process.exit(0);
    } catch (err) {
      debugLog(HOOK_NAME, err);
      // On error, don't block — fail open
      process.exit(0);
    }
  });
} // end require.main === module

// ── Exports for testing ─────────────────────────────────────────────────────
if (typeof module !== "undefined") {
  module.exports = {
    classifyBashCommand,
    normalizeCommand,
    matchesAny,
    WORKFLOW_PREFIXES,
    WRITE_PREFIXES,
    READONLY_PREFIXES,
    WRITE_EXCEPTIONS,
    ALWAYS_BLOCKED,
  };
}
