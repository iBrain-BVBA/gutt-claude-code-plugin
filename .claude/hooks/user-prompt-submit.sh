#!/bin/bash
# UserPromptSubmit hook script
# Logs hook invocations, outputs reminder message, and resets lesson capture state

LOG_FILE="${CLAUDE_PROJECT_DIR}/.claude/hooks/hook-invocations.log"
STATE_DIR="${CLAUDE_PROJECT_DIR}/.claude/hooks/.state"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Read JSON input from stdin
INPUT=$(cat)

# Extract prompt and session ID from JSON
PROMPT=$(echo "$INPUT" | jq -r '.prompt // .message // "unknown"' 2>/dev/null | head -c 200)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Log the hook invocation
echo "[$TIMESTAMP] Prompt: $PROMPT" >> "$LOG_FILE"

# Clear lesson capture state for this session (allows Stop hook to prompt again)
STATE_FILE="${STATE_DIR}/${SESSION_ID}.lessons-prompted"
if [ -f "$STATE_FILE" ]; then
    rm -f "$STATE_FILE"
    echo "[$TIMESTAMP] Cleared lessons-prompted state for session $SESSION_ID" >> "$LOG_FILE"
fi

# Output the reminder message
echo 'REMINDER: ALWAYS use the gutt-pro-memory agent (Task tool with subagent_type="gutt-pro-memory") to search organizational memory for relevant context, lessons learned, and decisions before starting work.'
