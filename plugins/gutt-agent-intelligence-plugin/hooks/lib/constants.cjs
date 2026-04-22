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
const PLAN_AGENT_TYPES = new Set(["plan", "Plan"]);

/**
 * Named role constants. Preferred over inline string literals so plugins
 * that dispatch on subagent role (e.g. grounding-formatter.cjs) stay in
 * sync with MEMORY_AGENTS / LESSON_SKIP_AGENTS.
 */
const MEMORY_KEEPER_AGENT = "memory-keeper";
const GUTT_PRO_MEMORY_AGENT = "gutt-pro-memory";

module.exports = {
  MEMORY_AGENTS,
  LESSON_SKIP_AGENTS,
  PLAN_AGENT_TYPES,
  MEMORY_KEEPER_AGENT,
  GUTT_PRO_MEMORY_AGENT,
};
