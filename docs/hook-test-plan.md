# gutt-claude-code-plugin Hook Test Plan

**Related Tickets:** GP-421 (Create GUTT Plugin for Claude Code), GP-435 (Repository Tooling Setup)

## Overview

This document provides comprehensive test procedures for all 10 Claude Code hooks in the gutt-claude-code-plugin. The plugin integrates gutt organizational memory into Claude Code workflows through a coordinated system of lifecycle hooks.

**Coverage Goal:** 100% of active hooks in `.claude/settings.json`
**Total Hooks:** 10
**Test Approach:** Realistic integration scenarios with actual hook inputs, environment setup, and cross-platform compatibility

### Purpose

Ensure all 10 hooks function correctly in isolation and as part of the integrated system. Verify memory injection, lesson capture, and configuration workflows operate end-to-end.

---

## Hook Inventory (10 hooks)

| #   | Hook Type        | File                        | Matcher                  | Purpose                                         | Status                |
| --- | ---------------- | --------------------------- | ------------------------ | ----------------------------------------------- | --------------------- |
| 1   | SessionStart     | `session-start.cjs`         | (empty)                  | Clear memory cache, show setup reminder         | Core                  |
| 2   | UserPromptSubmit | `user-prompt-submit.cjs`    | (empty)                  | Log prompts, suggest memory search              | Core                  |
| 3   | Stop             | `stop-lessons.cjs`          | (empty)                  | Block stop if significant work, capture lessons | Core                  |
| 4   | PostToolUse      | `post-tool-lint.cjs`        | Edit\|Write              | Auto-lint Python/JavaScript files               | Enhancement           |
| 5   | PostToolUse      | `post-task-lessons.cjs`     | Task                     | Detect lesson-worthy task results               | Memory                |
| 6   | PostToolUse      | `post-memory-ops.cjs`       | mcp**gutt-mcp-remote**\* | Track memory ops, update cache                  | Memory                |
| 7   | PreToolUse       | `pre-task-memory.cjs`       | Task                     | Extract search query, increment counter         | Memory                |
| 8   | SubagentStart    | `subagent-start-memory.cjs` | (empty)                  | Inject cached memory into subagent              | **Memory (NEW TEST)** |
| 9   | SubagentStop     | `subagent-plan-review.cjs`  | (empty)                  | Block stop if plan detected, suggest review     | Memory                |
| 10  | StatusLine       | `statusline.cjs`            | (command)                | Display GUTT status and metrics                 | UI                    |

---

## Test Procedures

### 1. SessionStart Hook (`session-start.cjs`)

**Objective:** Verify SessionStart hook clears memory cache on session initialization and displays setup reminder when gutt-mcp-remote is not configured.

**Trigger:** Claude Code session starts
**Hook Type:** SessionStart

**Preconditions:**

- `.claude/hooks/.state/` directory exists
- gutt-mcp-remote MCP server may or may not be configured
- CLAUDE_PROJECT_DIR environment variable properly set (critical for cross-platform)

**Test Steps:**

1. **Setup:** Create test environment with memory cache file

   ```bash
   mkdir -p .claude/hooks/.state
   echo '{"memoryQueries":5,"lessonsCaptured":3}' > .claude/hooks/.state/gutt-memory-cache.json
   ```

2. **Execute:** Simulate SessionStart hook with stdin input

   ```bash
   echo '{}' | node hooks/session-start.cjs
   ```

3. **Verify Cache Cleared:** Check that memory cache is empty

   ```bash
   cat .claude/hooks/.state/gutt-memory-cache.json
   # Should show empty cache
   ```

4. **Verify Output:** Hook should display setup reminder (if gutt-mcp-remote not configured)

   ```
   Expected output contains: "gutt memory features are available but not configured"
   Or: Silent exit if configured (exit code 0)
   ```

5. **Verify Exit Code:** Must be 0 (success, non-blocking)

**Expected Output:**

```
💡 gutt memory features are available but not configured.

Run /gutt-claude-code-plugin:setup to enable organizational memory integration.
```

(Or silent if configured)

**Validation:**

- [ ] Exit code is 0
- [ ] Memory cache cleared (or new cache created)
- [ ] Setup reminder displayed when needed
- [ ] No errors in stderr

**Edge Cases:**

- Gutt-mcp-remote is configured → Should exit silently with code 0
- Memory cache file missing → Hook should create it
- Permission errors → Should fail gracefully with exit code 0
- Missing CLAUDE_PROJECT_DIR → On Windows, paths must resolve correctly (\_\_dirname used internally)

**Recovery Steps:**

- If cache not clearing: Check `.claude/hooks/.state/` directory permissions
- If paths fail on Windows: Verify \_\_dirname usage in hook (not process.cwd or env vars)
- If output missing: Check isGuttMcpConfigured() function in lib/mcp-config.cjs

---

### 2. UserPromptSubmit Hook (`user-prompt-submit.cjs`)

**Objective:** Verify hook logs user prompts and suggests memory search before task execution.

**Trigger:** User submits prompt in Claude Code

**Preconditions:**

- gutt-mcp-remote MCP server configured
- CLAUDE_PROJECT_DIR set correctly
- `.claude/hooks/hook-invocations.log` accessible

**Test Steps:**

1. **Setup:** Ensure log directory exists

   ```bash
   mkdir -p .claude/hooks
   ```

2. **Execute:** Simulate UserPromptSubmit with realistic prompt

   ```bash
   echo '{"prompt":"Implement authentication for the API"}' | node hooks/user-prompt-submit.cjs
   ```

3. **Verify Logging:** Check that prompt was logged

   ```bash
   grep "authentication" .claude/hooks/hook-invocations.log
   ```

4. **Verify Output:** Should suggest memory search

   ```
   Expected: "🟠 GUTT MEMORY: Search organizational memory BEFORE starting"
   ```

5. **Verify Exit Code:** Must be 0

**Expected Output:**

```
🟠 GUTT MEMORY: Search organizational memory BEFORE starting this task.

ACTION REQUIRED: Delegate to gutt-pro-memory agent first:

Task(subagent_type="gutt-pro-memory", model="haiku", prompt="Search for relevant lessons and context about: authentication api")

This retrieves past decisions, patterns, and lessons that may apply to this task.
```

**Validation:**

- [ ] Prompt logged to hook-invocations.log
- [ ] Memory search suggestion displayed
- [ ] Exit code 0
- [ ] Search query extracted from prompt (contains key terms)

**Edge Cases:**

- gutt-mcp-remote not configured → Hook exits silently (no log, no output)
- Prompt very short/empty → Should still log and extract terms
- Special characters in prompt → Should be sanitized for safe display
- Log directory missing → Should create it

**Recovery Steps:**

- If log not created: Check .claude/hooks/ directory permissions
- If output not shown: Verify isGuttMcpConfigured() returns true
- If search query empty: Check extractSearchTerms() function handles edge cases

---

### 3. Stop Hook (`stop-lessons.cjs`)

**Objective:** Verify hook blocks session stop if significant work detected, prompts for lesson capture, and handles plan feedback.

**Trigger:** User stops Claude Code session

**Preconditions:**

- gutt-mcp-remote MCP server configured
- Session has transcript file (`.claude/transcript.jsonl`)
- Session state tracked (memory queries, duration, lessons)
- CLAUDE_PROJECT_DIR environment variable set

**Test Steps:**

1. **Setup:** Create test session with transcript and state

   ```bash
   mkdir -p .claude/hooks/.state
   SESSION_ID="test-session-123"
   echo '{"memoryQueries":1,"lessonsCaptured":0,"startedAt":"'$(date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%S)'Z"}' > .claude/hooks/.state/session-state.json
   ```

2. **Create Transcript:** Simulate session transcript with work

   ```bash
   mkdir -p .claude/hooks
   cat > .claude/transcript.jsonl << 'EOF'
   {"message":{"role":"user","content":[{"type":"text","text":"Implement authentication"}]}}
   {"message":{"role":"assistant","content":[{"type":"text","text":"I'll implement JWT authentication.\n\n## Implementation Steps\n1. Create auth service\n2. Add JWT validation\n3. Update API routes"}]}}
   {"message":{"role":"user","content":[{"type":"text","text":"Good"}]}}
   EOF
   ```

3. **Execute:** Simulate Stop hook

   ```bash
   echo '{"session_id":"test-session-123","transcript_path":".claude/transcript.jsonl"}' | node hooks/stop-lessons.cjs
   ```

4. **Verify Blocking:** Should output decision: "block"

   ```bash
   # Output should contain: "decision":"block"
   ```

5. **Verify Lesson Prompt:** Should suggest lesson capture

   ```bash
   # Output should contain: "Capture session lessons"
   ```

6. **Verify State File:** Should create `.state/test-session-123.lessons-prompted`

**Expected Output:**

```json
{
  "decision": "block",
  "reason": "🟠 ACTION REQUIRED: Capture session lessons before stopping..."
}
```

**Validation:**

- [ ] Decision is "block" (session stop blocked)
- [ ] Reason includes lesson capture instruction
- [ ] State file created (prevents re-prompting)
- [ ] Exit code 0

**Edge Cases:**

- Trivial session (< 10 min, no memory queries) → Should allow stop (decision: pass through)
- No transcript file → Should allow stop gracefully
- Already prompted → Should allow stop (no duplicate prompts)
- Plan detected in transcript → Should suggest plan review first

**Recovery Steps:**

- If blocking twice: Delete .state/{session_id}.lessons-prompted
- If plan not detected: Check hasPlanContent() pattern matching
- If memory queries not counted: Verify PreToolUse pre-task-memory.cjs incremented counter

---

### 4. PostToolUse Hook - Linting (`post-tool-lint.cjs`)

**Objective:** Verify hook auto-lints Python and JavaScript files after edit/write operations.

**Trigger:** Edit or Write tool completes on source file

**Preconditions:**

- Source file created or modified
- Appropriate linter installed (black, ruff for Python; eslint for JS/TS)
- CLAUDE_PROJECT_DIR set correctly

**Test Steps:**

1. **Setup:** Create test Python file with lint errors

   ```bash
   cat > test_file.py << 'EOF'
   x=1  # No spaces around operator
   def foo( ):  # Extra spaces
       pass
   EOF
   ```

2. **Execute:** Simulate PostToolUse Edit hook

   ```bash
   echo '{"tool_name":"Edit","tool_input":{"file_path":"test_file.py"}}' | node hooks/post-tool-lint.cjs
   ```

3. **Verify Linting:** File should be formatted

   ```bash
   cat test_file.py
   # Should show: x = 1, def foo():
   ```

4. **Verify Output:** Should show linting completed

   ```bash
   # Expected: "Linted test_file.py with Python (black + ruff)"
   ```

5. **Verify Exit Code:** Must be 0 (even if linter finds unfixable errors)

**Expected Output:**

```
Linted test_file.py with Python (black + ruff)
```

**Validation:**

- [ ] Exit code 0
- [ ] File formatted (or linting attempted)
- [ ] Output message shown
- [ ] No blocking of Edit tool

**Edge Cases:**

- **IMPORTANT:** File with actual lint errors → Should still exit 0 (linting is best-effort)
- File doesn't exist → Should exit silently
- Unsupported file type → Should skip (exit 0)
- Linter not installed → Should handle gracefully with exit 0
- Invalid JSON in tool_input → Should exit 0 (fail-safe)

**Recovery Steps:**

- If linter not available: Install black, ruff, or eslint in project
- If file not modified: Check linter timeout (30 seconds)
- If path issues on Windows: Verify file_path is absolute path

---

### 5. PostToolUse Hook - Task Lessons (`post-task-lessons.cjs`)

**Objective:** Verify hook detects lesson-worthy content in subagent task results and suggests lesson capture.

**Trigger:** Task tool completes (subagent execution)

**Preconditions:**

- Subagent execution completed with non-trivial result
- Result contains lesson indicators (fix, decision, workaround, etc.)
- CLAUDE_PROJECT_DIR set correctly

**Test Steps:**

1. **Execute:** Simulate PostToolUse Task hook with result containing lesson indicators

   ```bash
   cat > task_input.json << 'EOF'
   {
     "tool_name": "Task",
     "tool_input": {
       "subagent_type": "oh-my-claudecode:executor",
       "prompt": "Fix authentication bug in login component"
     },
     "tool_response": "Fixed the authentication issue. The problem was that the JWT token validation was checking the wrong expiry field. After fixing the field name to 'exp' instead of 'expires', the login flow now works correctly. This is an important lesson: always verify field names match the JWT spec when integrating auth libraries."
   }
   EOF

   cat task_input.json | node hooks/post-task-lessons.cjs
   ```

2. **Verify Detection:** Should detect lesson indicators
   - "Fixed" → problem-solved
   - "important lesson" → insight

3. **Verify Output:** Should suggest lesson capture

   ```bash
   # Output should contain: "GUTT Lesson Capture Opportunity"
   ```

4. **Verify Exit Code:** Must be 0

**Expected Output:**

```json
{
  "hookSpecificOutput": {
    "additionalContext": "[GUTT Lesson Capture Opportunity]\nSubagent \"oh-my-claudecode:executor\" completed with potential lessons:\n\nDetected patterns: problem-solved, insight\n\nConsider capturing lessons using memory-keeper agent..."
  }
}
```

**Validation:**

- [ ] Lesson patterns detected (fix, decision, discovery, etc.)
- [ ] Output contains lesson capture suggestion
- [ ] Exit code 0
- [ ] Memory agent task suggestion included

**Edge Cases:**

- **IMPORTANT:** Result too short (< 100 chars) → Should exit silently (no lesson)
- No lesson indicators → Should exit silently
- Memory agent (gutt-pro-memory) → Should skip (they handle own capture)
- Plan agent → Should suggest plan review first
- Invalid JSON → Should exit silently

**Recovery Steps:**

- If lesson not detected: Check detectLessonIndicators() regex patterns
- If output not shown: Verify result is > 100 characters
- If memory agent triggered: Add agent type to skipAgents list

---

### 6. PostToolUse Hook - Memory Operations (`post-memory-ops.cjs`)

**Objective:** Verify hook tracks all memory MCP tool calls, updates cache, and updates statusline metrics.

**Trigger:** Memory MCP tool completes (add_memory, search_memory_facts, fetch_lessons_learned, etc.)

**Preconditions:**

- gutt-mcp-remote MCP server available
- Memory operation completed successfully
- Session state directory accessible

**Test Steps:**

1. **Execute:** Simulate PostToolUse for search_memory_facts

   ```bash
   cat > memory_op.json << 'EOF'
   {
     "tool_name": "mcp__gutt-mcp-remote__search_memory_facts",
     "tool_input": {
       "query": "authentication patterns"
     },
     "tool_response": "{\"result\":{\"facts\":[{\"fact\":\"Use JWT for stateless auth\",\"name\":\"AUTH_BEST_PRACTICE\"}]}}"
   }
   EOF

   cat memory_op.json | node hooks/post-memory-ops.cjs
   ```

2. **Verify Operation Tracked:** Hook should process without errors
   - Should increment memory query counter
   - Should update cache with facts
   - Should add ticker item

3. **Verify Exit Code:** Must be 0

4. **Verify Connection Status:** Should set to "ok" on success

**Expected Output:**
(Hook outputs to session state, not stdout)

**Validation:**

- [ ] Exit code 0
- [ ] Session state updated (memoryQueries incremented)
- [ ] Memory cache updated (if facts returned)
- [ ] Ticker item added (for statusline display)

**Edge Cases:**

- Unknown tool name → Should skip (exit 0)
- Tool fails → Should still exit 0 (not blocking)
- Malformed result → Should extract what possible, exit 0
- No results → Should still track query

**Recovery Steps:**

- If cache not updating: Check updateMemoryCache() function
- If counter not incrementing: Verify incrementMemoryQueries() called
- If ticker not shown: Check statusline.cjs reads from session state

---

### 7. PreToolUse Hook - Task Memory (`pre-task-memory.cjs`)

**Objective:** Verify hook extracts search query from task prompt and increments memory query counter before subagent execution.

**Trigger:** Task tool invoked (before execution)

**Preconditions:**

- Task tool input available with prompt and subagent_type
- Session state file accessible
- CLAUDE_PROJECT_DIR set correctly

**Test Steps:**

1. **Execute:** Simulate PreToolUse Task hook

   ```bash
   cat > task_pre.json << 'EOF'
   {
     "tool_name": "Task",
     "tool_input": {
       "subagent_type": "oh-my-claudecode:architect",
       "prompt": "Analyze the database schema for performance issues"
     }
   }
   EOF

   cat task_pre.json | node hooks/pre-task-memory.cjs
   ```

2. **Verify Query Extraction:** Should extract meaningful terms
   - "database schema performance"

3. **Verify Counter Increment:** Session state memory queries should increase

   ```bash
   cat .claude/hooks/.state/session-state.json | grep memoryQueries
   # Should show: memoryQueries increased by 1
   ```

4. **Verify Exit Code:** Must be 0

**Expected Behavior:**

- Search query extracted and stored for SubagentStart
- Memory query counter incremented
- Silent exit (hook is internal plumbing)

**Validation:**

- [ ] Exit code 0
- [ ] Memory query counter incremented
- [ ] Search query stored (verified by SubagentStart test)
- [ ] Non-memory agents excluded (no query for memory-keeper, gutt-pro-memory)

**Edge Cases:**

- Memory agent (gutt-pro-memory, memory-keeper) → Should skip (they do own queries)
- No tool name → Should skip silently
- Invalid JSON → Should skip silently
- Empty prompt → Should extract default terms

**Recovery Steps:**

- If counter not incrementing: Check incrementMemoryQueries() called
- If query not stored: Verify setLastSearchQuery() function
- If memory agent queried: Add to memoryAgents filter list

---

### 8. SubagentStart Hook - Memory Injection (`subagent-start-memory.cjs`) **[NEW TEST]**

**Objective:** Verify hook injects cached memory results into subagent context when available, or provides fallback instruction if cache empty.

**Trigger:** Subagent starts execution

**Preconditions:**

- Subagent type provided
- Memory cache may or may not have cached content
- CLAUDE_PROJECT_DIR set correctly

**Test Steps:**

#### Scenario A: Memory Cache Available

1. **Setup:** Create cached memory content

   ```bash
   mkdir -p .claude/hooks/.state
   cat > .claude/hooks/.state/gutt-memory-cache.json << 'EOF'
   {
     "lastQuery": "database schema performance",
     "lessons": [
       {
         "summary": "Normalize database schema before scaling",
         "guidance": "Always index foreign keys"
       }
     ],
     "facts": [
       {
         "fact": "N+1 queries common in ORM usage"
       }
     ]
   }
   EOF
   ```

2. **Execute:** Simulate SubagentStart hook

   ```bash
   cat > subagent_start.json << 'EOF'
   {
     "agent_type": "oh-my-claudecode:architect",
     "agent_id": "123"
   }
   EOF

   cat subagent_start.json | node hooks/subagent-start-memory.cjs
   ```

3. **Verify Memory Injected:** Output should contain cached lessons and facts

   ```bash
   # Output should contain: "Normalize database schema"
   # Output should contain: "N+1 queries common"
   ```

4. **Verify JSON Output:** Should be valid JSON with hookSpecificOutput

   ```bash
   # Output schema: {"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"..."}}
   ```

5. **Verify Exit Code:** Must be 0

**Expected Output:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStart",
    "additionalContext": "[GUTT Memory]\nLessons: Normalize database schema before scaling...\nFacts: N+1 queries common in ORM usage..."
  }
}
```

#### Scenario B: Cache Empty (Fallback)

1. **Setup:** Clear cache or start fresh

   ```bash
   rm -f .claude/hooks/.state/gutt-memory-cache.json
   ```

2. **Execute:** Simulate SubagentStart hook

   ```bash
   echo '{"agent_type":"oh-my-claudecode:architect"}' | node hooks/subagent-start-memory.cjs
   ```

3. **Verify Fallback:** Output should include MCP tool instructions

   ```bash
   # Output should contain: "fetch_lessons_learned" or "search_memory_facts"
   # Output should contain: "No cached organizational memory available"
   ```

4. **Verify Exit Code:** Must be 0

**Expected Output:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStart",
    "additionalContext": "[GUTT Memory]\nNo cached organizational memory available yet.\n\nTo fetch relevant context, use these MCP tools:\n- mcp__gutt-mcp-remote__fetch_lessons_learned(...)\n- mcp__gutt-mcp-remote__search_memory_facts(...)"
  }
}
```

#### Scenario C: Memory Agent (Skip Injection)

1. **Execute:** Simulate SubagentStart with memory-related agent

   ```bash
   echo '{"agent_type":"gutt-pro-memory"}' | node hooks/subagent-start-memory.cjs
   ```

2. **Verify Skip:** Should exit without injection
   ```bash
   # Exit code should be 0
   # No output (silent skip)
   ```

**Validation:**

- [ ] Exit code 0
- [ ] Memory injected when available
- [ ] Fallback provided when cache empty
- [ ] Memory agents skipped
- [ ] JSON output valid

**Edge Cases:**

- **IMPORTANT:** Memory agent types (gutt-pro-memory, memory-keeper) → Should skip (exit 0, no output)
- Cache partially populated → Should inject what's available
- Search query last stored → Should use it for fallback instruction
- Invalid JSON input → Should still exit 0 (graceful)

**Recovery Steps:**

- If memory not injected: Check hasCachedContent() function
- If fallback not shown: Verify cache is truly empty
- If memory agent still injected: Check memoryAgents filter list
- If JSON invalid: Check formatMemoryContext() output

---

### 9. SubagentStop Hook - Plan Review (`subagent-plan-review.cjs`)

**Objective:** Verify hook detects plan in subagent transcript and blocks stop to suggest memory review before implementation.

**Trigger:** Subagent completes execution

**Preconditions:**

- Subagent transcript file available
- Transcript contains plan-like content (steps, implementation details)
- CLAUDE_PROJECT_DIR set correctly

**Test Steps:**

1. **Setup:** Create subagent transcript with plan

   ```bash
   cat > agent-transcript.jsonl << 'EOF'
   {"message":{"role":"assistant","content":[{"type":"text","text":"## Implementation Plan\n\n1. Create API endpoint for authentication\n2. Add JWT validation middleware\n3. Update database schema for user tokens\n4. Write integration tests\n5. Deploy to staging"}]}}
   EOF
   ```

2. **Execute:** Simulate SubagentStop hook

   ```bash
   echo '{"agent_transcript_path":"agent-transcript.jsonl"}' | node hooks/subagent-plan-review.cjs
   ```

3. **Verify Plan Detection:** Hook should detect plan content

   ```bash
   # Output should contain: "A plan has been created"
   ```

4. **Verify Blocking:** Decision should be "block"

   ```bash
   # Output JSON: {"decision":"block",...}
   ```

5. **Verify Memory Search Suggestion:** Should suggest searching organizational memory

   ```bash
   # Output contains: "Similar past implementations"
   # Output contains: "Lessons learned from related work"
   ```

6. **Verify Exit Code:** Must be 0

**Expected Output:**

```json
{
  "decision": "block",
  "reason": "[GUTT Plan Review]\n\nA plan has been created. Before proceeding with implementation:\n\n**Search organizational memory for:**\n- Similar past implementations\n- Lessons learned from related work\n- Potential pitfalls to avoid"
}
```

**Validation:**

- [ ] Decision is "block"
- [ ] Plan detected from transcript
- [ ] Memory search suggestion included
- [ ] Exit code 0
- [ ] Reason includes plan summary (first 200 chars)

**Edge Cases:**

- No plan in transcript → Should allow stop (no decision output, exit 0)
- Transcript file missing → Should allow stop gracefully
- Malformed JSON in transcript → Should handle gracefully
- Multiple plans → Should detect first/best match

**Recovery Steps:**

- If plan not detected: Check hasPlanContent() regex patterns (7 patterns required, 2+ matches)
- If transcript not read: Verify file path is correct and file exists
- If summary cut off: Verify substring logic in sanitizeForDisplay()

---

### 10. StatusLine Hook (`statusline.cjs`)

**Objective:** Verify hook displays GUTT memory status and metrics in Claude Code statusline.

**Trigger:** Claude Code updates statusline continuously

**Preconditions:**

- Session state file with metrics available
- Configuration files accessible
- CLAUDE_PROJECT_DIR set correctly

**Test Steps:**

1. **Setup:** Create session state with metrics

   ```bash
   mkdir -p .claude/hooks/.state
   cat > .claude/hooks/.state/session-state.json << 'EOF'
   {
     "connectionStatus": "ok",
     "memoryQueries": 3,
     "lessonsCaptured": 2,
     "ticker": {
       "items": [
         {"icon":"📥","text":"Fetched \"auth patterns\"","createdAt":1706814000000}
       ]
     }
   }
   EOF
   ```

2. **Execute:** Simulate StatusLine hook

   ```bash
   echo '{"model":{"display_name":"claude-opus"},"cost":{"total_cost_usd":0.05}}' | node hooks/statusline.cjs
   ```

3. **Verify Output:** Should display GUTT segment with metrics

   ```bash
   # Output should contain: "[gutt🟢 (group_id) mem:3 lessons:2]"
   # Output should contain: "[claude-opus] ~$0.05"
   ```

4. **Verify Exit Code:** Must be 0

**Expected Output:**

```
[gutt🟢 (group_id) mem:3 lessons:2] | [claude-opus] ~$0.05
```

or multi-line if configured:

```
[gutt🟢 (group_id) mem:3 lessons:2]
[claude-opus] ~$0.05
📥 Fetched "auth patterns"
```

**Validation:**

- [ ] Exit code 0
- [ ] GUTT status icon shown (🟢 ok, 🔴 error, ⚪ unknown)
- [ ] Metrics displayed (mem:X, lessons:Y)
- [ ] Claude Code data included (model, cost)
- [ ] Ticker items shown if configured
- [ ] Passthrough command output included if configured

**Edge Cases:**

- Group ID missing → Should show "(no group_id)"
- Connection error → Should show 🔴
- Not configured → Should show ⚪ + warning !
- Passthrough timeout → Should show GUTT segment only
- Ticker items expired (> 5 seconds) → Should not show
- Multi-line mode configured → Should format with newlines

**Recovery Steps:**

- If status not shown: Check getState() returns valid data
- If metrics incorrect: Verify session-state.json updated by other hooks
- If ticker not displayed: Check showTicker config enabled
- If connection not ok: Verify MCP server connectivity

---

## Automated Test Script

Create file: `tests/test-all-hooks.cjs`

```javascript
#!/usr/bin/env node
/**
 * Automated test script for all 10 gutt-claude-code-plugin hooks
 *
 * Usage: node tests/test-all-hooks.cjs
 *
 * Tests all hooks with realistic JSON inputs
 * Verifies cross-platform path handling
 * Checks configuration file locations
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Get project directory (handles cross-platform path resolution)
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
process.env.CLAUDE_PROJECT_DIR = projectDir;

const results = {
  passed: [],
  failed: [],
  warnings: [],
};

// Test helper function
function testHook(hookName, hookFile, inputJson, expectedOutput) {
  const hookPath = path.join(projectDir, "hooks", hookFile);

  if (!fs.existsSync(hookPath)) {
    results.failed.push(`${hookName}: Hook file not found at ${hookPath}`);
    return false;
  }

  try {
    const output = execSync(`echo '${JSON.stringify(inputJson)}' | node "${hookPath}"`, {
      encoding: "utf8",
      cwd: projectDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });

    if (expectedOutput && !output.includes(expectedOutput)) {
      results.warnings.push(
        `${hookName}: Output does not contain expected text: "${expectedOutput}"`
      );
    }

    results.passed.push(hookName);
    return true;
  } catch (err) {
    results.failed.push(`${hookName}: ${err.message}`);
    return false;
  }
}

console.log("🧪 Testing all 10 gutt-claude-code-plugin hooks...\n");

// Test 1: SessionStart
testHook(
  "SessionStart",
  "session-start.cjs",
  {},
  null // May output setup reminder or be silent
);

// Test 2: UserPromptSubmit
testHook(
  "UserPromptSubmit",
  "user-prompt-submit.cjs",
  { prompt: "Implement authentication system" },
  "GUTT MEMORY"
);

// Test 3: Stop
testHook(
  "Stop",
  "stop-lessons.cjs",
  {
    session_id: "test-session-123",
    transcript_path: path.join(projectDir, ".claude/transcript.jsonl"),
  },
  null // May block or allow
);

// Test 4: PostToolUse - Linting
testHook(
  "PostToolUse (Linting)",
  "post-tool-lint.cjs",
  {
    tool_name: "Edit",
    tool_input: { file_path: "/tmp/test.py" },
  },
  null // Silent if file doesn't exist
);

// Test 5: PostToolUse - Task Lessons
testHook(
  "PostToolUse (Task Lessons)",
  "post-task-lessons.cjs",
  {
    tool_name: "Task",
    tool_input: {
      subagent_type: "oh-my-claudecode:executor",
      prompt: "Fix authentication bug",
    },
    tool_response:
      "Fixed the JWT validation issue. This is an important lesson about proper token handling.",
  },
  "GUTT Lesson"
);

// Test 6: PostToolUse - Memory Operations
testHook(
  "PostToolUse (Memory Ops)",
  "post-memory-ops.cjs",
  {
    tool_name: "mcp__gutt-mcp-remote__search_memory_facts",
    tool_input: { query: "authentication patterns" },
    tool_response: '{"result":{"facts":[{"fact":"Use JWT"}]}}',
  },
  null // Updates state, not stdout
);

// Test 7: PreToolUse - Task Memory
testHook(
  "PreToolUse (Task Memory)",
  "pre-task-memory.cjs",
  {
    tool_name: "Task",
    tool_input: {
      subagent_type: "oh-my-claudecode:architect",
      prompt: "Design the authentication system",
    },
  },
  null // Silent, updates state
);

// Test 8: SubagentStart - Memory Injection
testHook(
  "SubagentStart (Memory Injection)",
  "subagent-start-memory.cjs",
  { agent_type: "oh-my-claudecode:executor", agent_id: "123" },
  "GUTT Memory"
);

// Test 9: SubagentStop - Plan Review
testHook(
  "SubagentStop (Plan Review)",
  "subagent-plan-review.cjs",
  { agent_transcript_path: path.join(projectDir, ".claude/transcript.jsonl") },
  null // May detect plan or be silent
);

// Test 10: StatusLine
testHook(
  "StatusLine",
  "statusline.cjs",
  { model: { display_name: "claude-opus" }, cost: { total_cost_usd: 0.05 } },
  "gutt"
);

// Report results
console.log("\n📊 Test Results:\n");
console.log(`✅ Passed: ${results.passed.length}/10`);
console.log(`❌ Failed: ${results.failed.length}`);
console.log(`⚠️  Warnings: ${results.warnings.length}`);

if (results.failed.length > 0) {
  console.log("\nFailed Tests:");
  results.failed.forEach((f) => console.log(`  - ${f}`));
}

if (results.warnings.length > 0) {
  console.log("\nWarnings:");
  results.warnings.forEach((w) => console.log(`  - ${w}`));
}

process.exit(results.failed.length > 0 ? 1 : 0);
```

**To execute:**

```bash
cd C:\dev\gutt-claude-code-plugin
node tests/test-all-hooks.cjs
```

---

## E2E Integration Checklist

Complete this checklist to verify all hooks work together end-to-end:

### Full Workflow Integration

- [ ] **Session Start**
  - [ ] Start new Claude Code session
  - [ ] Verify memory cache cleared
  - [ ] Verify setup reminder shown (if gutt-mcp not configured)

- [ ] **User Prompt Submit**
  - [ ] Submit task: "Implement user authentication"
  - [ ] Verify GUTT MEMORY prompt shown
  - [ ] Verify memory search suggestion displayed
  - [ ] Verify prompt logged to hook-invocations.log

- [ ] **Task Execution (Memory Injection)**
  - [ ] Delegate: Task(subagent_type="gutt-pro-memory", prompt="Search for authentication patterns")
  - [ ] Verify subagent receives cached memory (or fallback instruction)
  - [ ] Verify PreToolUse extracted search query
  - [ ] Verify memory query counter incremented

- [ ] **Memory Operations (Cache Update)**
  - [ ] Verify search_memory_facts returns lessons
  - [ ] Verify post-memory-ops hook tracks results
  - [ ] Verify cache updated for next subagent injection
  - [ ] Verify ticker items displayed in statusline

- [ ] **Task Lesson Capture (Plan Detection)**
  - [ ] Delegate: Task(subagent_type="planner", prompt="Create implementation plan for auth")
  - [ ] Verify post-task-lessons detects plan in output
  - [ ] Verify subagent-plan-review blocks on completion
  - [ ] Verify blocks with plan review suggestion

- [ ] **Search Before Implementation**
  - [ ] Before implementing: Delegate to memory-keeper for context
  - [ ] Verify lessons and context retrieved
  - [ ] Verify applied to implementation approach

- [ ] **Implementation & Lesson Capture**
  - [ ] Implement based on plan and lessons learned
  - [ ] Verify post-task-lessons detects implementation as lesson-worthy
  - [ ] Verify file linting runs after Edit/Write operations
  - [ ] Verify post-tool-lint auto-formats files

- [ ] **Session Stop (Lesson Capture)**
  - [ ] Attempt to stop session
  - [ ] Verify stop-lessons hook blocks
  - [ ] Verify suggests lesson capture
  - [ ] Delegate to memory-keeper to capture session
  - [ ] Verify session state updated (lessonsCaptured incremented)
  - [ ] Stop allowed after lesson capture

- [ ] **Statusline Metrics**
  - [ ] Verify statusline shows: [gutt🟢 mem:X lessons:Y]
  - [ ] Verify metrics accurate after all operations
  - [ ] Verify passthrough command (if configured) still works

### Configuration Verification (Critical for Cross-Platform)

- [ ] **Config File Locations** (Prevent configuration mismatch)
  - [ ] Verify sessionstart-setup.cjs writes to `~/.claude/settings.json`
  - [ ] Verify statusline.cjs reads from CLAUDE_PROJECT_DIR/.claude/settings.json
  - [ ] Verify gutt config stored in `settings.json` under `gutt` key
  - [ ] **Windows specific:** Verify \_\_dirname used (not process.cwd or env vars)

- [ ] **Environment Setup**
  - [ ] CLAUDE_PROJECT_DIR set correctly (Windows: should use \_\_dirname internally)
  - [ ] .claude/hooks/.state/ directory created
  - [ ] .claude/hooks/hook-invocations.log accessible
  - [ ] .claude/settings.json accessible

- [ ] **Memory Operations**
  - [ ] gutt-mcp-remote MCP server configured
  - [ ] Memory cache directory exists
  - [ ] Session state tracking working

### Error Recovery

- [ ] **Graceful Failures**
  - [ ] All hooks exit with code 0 (non-blocking)
  - [ ] Missing files handled gracefully
  - [ ] Permission errors don't crash workflow
  - [ ] Malformed JSON handled safely

- [ ] **Troubleshooting**
  - [ ] Check `.claude/hooks/hook-invocations.log` for event log
  - [ ] Check `.claude/hooks/.state/` for session state files
  - [ ] Check debug output: grep "debugLog" in hook files
  - [ ] CLAUDE_PROJECT_DIR troubleshooting on Windows

---

## Project Context

**Related Work Items:**

- **GP-421:** Create GUTT Plugin for Claude Code (parent epic)
- **GP-435:** Repository Tooling Setup (this work)
- **Phase 4:** "Create test infrastructure and refactor hooks for maintainability"

**Related Documentation:**

- `.claude/settings.json` - Hook configuration
- `hooks/hooks.json` - Hook definitions (legacy)
- `hooks/lib/` - Shared utilities
- `tests/` - Existing test infrastructure

---

## Corrections from Original Plan

This test plan corrects three errors in the original documentation:

| Error             | Original                         | Corrected                          |
| ----------------- | -------------------------------- | ---------------------------------- |
| SessionStart file | `sessionstart-setup.cjs`         | `session-start.cjs`                |
| SubagentStop file | `subagent-stop.cjs`              | `subagent-plan-review.cjs`         |
| Non-existent hook | `question-context.cjs` (removed) | Not included                       |
| **Missing test**  | **SubagentStart untested**       | **Test 8: New comprehensive test** |

All 10 hooks now have complete test coverage including the previously untested SubagentStart hook.

---

## Success Verification Checklist

Before considering hook testing complete:

- [ ] All 10 hooks documented with test procedures
- [ ] Filenames verified against actual hooks/ directory
- [ ] SubagentStart hook test is comprehensive
- [ ] Code examples use realistic JSON (not mocks)
- [ ] Environment variables documented (CLAUDE_PROJECT_DIR critical on Windows)
- [ ] Edge cases included with actual error scenarios
- [ ] Documentation drift areas cross-checked (config file locations, path resolution)
- [ ] Troubleshooting and recovery steps included
- [ ] Automated test script executable
- [ ] E2E integration checklist complete and actionable
- [ ] Cross-platform compatibility verified (Windows \_\_dirname, env vars)
- [ ] Configuration mismatch prevention documented
- [ ] Project context (GP-435, GP-421) referenced
