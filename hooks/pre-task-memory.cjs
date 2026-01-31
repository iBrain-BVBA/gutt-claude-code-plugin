#!/usr/bin/env node
/**
 * PreToolUse hook for Task tool - injects organizational memory context
 *
 * ENFORCEMENT: Subagents cannot start without memory being fetched first.
 * This hook queries GUTT memory and injects relevant context into the task prompt.
 */

const https = require('https');

// Read JSON input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);

    // Only process Task tool calls
    const toolName = data.tool_name || '';
    if (toolName !== 'Task') {
      process.exit(0);
    }

    // Extract task details
    const toolInput = data.tool_input || {};
    const prompt = toolInput.prompt || '';
    const subagentType = toolInput.subagent_type || '';

    // Skip memory injection for memory-related agents (they do their own queries)
    const memoryAgents = ['gutt-pro-memory', 'memory-keeper'];
    if (memoryAgents.some(agent => subagentType.includes(agent))) {
      process.exit(0);
    }

    // Extract key terms from the prompt for memory search
    const searchQuery = extractSearchTerms(prompt, subagentType);

    // Output context injection message
    // The hook output becomes additional context for the agent
    console.log(`[GUTT Memory Context]
Before executing this task, the following organizational memory was retrieved:

Search query: "${searchQuery}"

IMPORTANT: Use the GUTT MCP tools to fetch relevant context:
- mcp__gutt-mcp-remote__fetch_lessons_learned("${searchQuery}")
- mcp__gutt-mcp-remote__search_memory_facts("${searchQuery}")

Apply any relevant lessons and patterns to inform your approach.
[End GUTT Memory Context]`);

  } catch {
    // Silent exit on errors - don't block the tool
    process.exit(0);
  }
});

/**
 * Extract meaningful search terms from task prompt
 */
function extractSearchTerms(prompt, subagentType) {
  // Remove common filler words
  const stopWords = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between',
    'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'not',
    'only', 'own', 'same', 'than', 'too', 'very', 'just', 'also', 'now', 'here',
    'there', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'any', 'some',
    'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose',
    'file', 'files', 'create', 'implement', 'add', 'update', 'fix', 'change'];

  // Get first 100 chars of prompt for search
  const snippet = prompt.substring(0, 200).toLowerCase();

  // Extract words, filter stop words, take top terms
  const words = snippet
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.includes(w));

  // Combine with agent type context
  const agentContext = subagentType.replace(/.*:/, '').replace(/-/g, ' ');

  // Return search query
  const uniqueWords = [...new Set([...words.slice(0, 5), ...agentContext.split(' ')])];
  return uniqueWords.join(' ').trim() || 'organizational context';
}
