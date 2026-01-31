#!/usr/bin/env node
/**
 * UserPromptSubmit hook script (Node.js - cross-platform)
 * Logs hook invocations and outputs reminder message
 */

const fs = require('fs');
const path = require('path');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const logFile = path.join(projectDir, '.claude', 'hooks', 'hook-invocations.log');
const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

// Read JSON input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let prompt = 'unknown';
  try {
    const data = JSON.parse(input);
    prompt = (data.prompt || data.message || 'unknown').substring(0, 200);
  } catch {
    // Ignore parse errors
  }

  // Ensure log directory exists
  const logDir = path.dirname(logFile);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Log the hook invocation
  fs.appendFileSync(logFile, `[${timestamp}] Prompt: ${prompt}\n`);

  // Output the reminder message
  console.log('REMINDER: Use gutt-pro-memory agent to search organizational memory before starting work.');
});
