# gutt-subagent-hooks-plugin

Subagent memory injection and orchestration hooks for gutt.

## What It Does

- **PreToolUse (Task|Agent)**: Extracts search queries from task prompts for memory injection
- **SubagentStart**: Injects cached memory results and agent-specific grounding into subagents
- **PostToolUse (Task|Agent)**: Captures lessons and patterns from subagent results
- **SubagentStop**: Reviews subagent plans for quality and completeness

## Requirements

- gutt memory MCP server must be configured and accessible
- Works with Claude Code only (not Cursor — these hook events are Claude Code-specific)

## Installation

Install as a Claude Code plugin alongside the main gutt-claude-code-plugin.
