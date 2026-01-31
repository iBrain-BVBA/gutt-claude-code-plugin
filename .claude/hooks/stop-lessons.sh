#!/bin/bash
# Stop hook script for capturing lessons learned
# Blocks first stop attempt to prompt lesson capture, allows subsequent attempts

LOG_FILE="${CLAUDE_PROJECT_DIR}/.claude/hooks/hook-invocations.log"
STATE_DIR="${CLAUDE_PROJECT_DIR}/.claude/hooks/.state"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Read JSON input from stdin
INPUT=$(cat)

# Extract session ID for state tracking
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)
STATE_FILE="${STATE_DIR}/${SESSION_ID}.lessons-prompted"

# Ensure directories exist
mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$STATE_DIR"

# Check if we've already prompted this session
if [ -f "$STATE_FILE" ]; then
    # Already prompted - allow stop
    echo "[$TIMESTAMP] Stop hook: Session $SESSION_ID already prompted, allowing stop" >> "$LOG_FILE"
    # Output nothing or empty JSON to allow stop
    exit 0
fi

# First stop attempt - create state file and block
touch "$STATE_FILE"
echo "[$TIMESTAMP] Stop hook: Blocking first stop for session $SESSION_ID to prompt lessons" >> "$LOG_FILE"

# Block Claude from stopping and provide reason
cat << 'EOF'
{
  "decision": "block",
  "reason": "Before completing, consider if this work warrants capturing lessons learned. If significant work was done (implementation decisions, bug fixes, patterns discovered, challenges solved), use the memory-keeper agent (Task tool with subagent_type=\"memory-keeper\") to capture insights. If the work was trivial, you may proceed - you will not be blocked again."
}
EOF
