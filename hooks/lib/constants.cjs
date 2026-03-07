#!/usr/bin/env node
/**
 * Shared constants for GUTT hooks
 */

/**
 * Agents that handle their own memory queries — skip memory injection for these.
 * Used by: pre-task-memory.cjs, subagent-start-memory.cjs
 */
const MEMORY_AGENTS = ["gutt-pro-memory", "memory-keeper", "gutt-mcp"];

/**
 * Agents that handle their own lesson capture — skip auto-capture for these.
 * Used by: post-task-lessons.cjs
 */
const LESSON_SKIP_AGENTS = ["gutt-pro-memory", "memory-keeper", "memory-capture"];

/**
 * Plan agent types handled by SubagentStop hook (subagent-plan-review.cjs).
 * Skipped in post-task-lessons.cjs to avoid duplicate prompts.
 */
const PLAN_AGENT_TYPES = new Set(["plan", "oh-my-claudecode:plan", "oh-my-claudecode:planner"]);

module.exports = {
  MEMORY_AGENTS,
  LESSON_SKIP_AGENTS,
  PLAN_AGENT_TYPES,
};
