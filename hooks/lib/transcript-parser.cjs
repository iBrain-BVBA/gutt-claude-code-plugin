#!/usr/bin/env node
/**
 * Transcript Parser Utility
 * Parses Claude Code JSONL transcript to extract session metadata
 */

const fs = require("fs");
const { debugLog } = require("./debug.cjs");

/**
 * Parse transcript JSONL and extract session metadata
 * @param {string} transcriptPath - Path to transcript file
 * @returns {object} Parsed session metadata
 */
function parseTranscript(transcriptPath) {
  const metadata = {
    firstUserMessage: null,
    filesModified: 0,
    toolCallCount: 0,
    userMessageCount: 0,
    editWriteCalls: [],
  };

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    debugLog("parseTranscript", `Transcript not found: ${transcriptPath}`);
    return metadata;
  }

  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line);

        // Extract first user message as session goal
        if (entry.type === "user_message" && !metadata.firstUserMessage && entry.content) {
          // Get text content from message
          const textContent = Array.isArray(entry.content)
            ? entry.content.find((c) => c.type === "text")?.text
            : entry.content;

          if (textContent) {
            // Truncate to first 100 chars for goal
            metadata.firstUserMessage = textContent.substring(0, 100).replace(/\n/g, " ").trim();
            metadata.userMessageCount++;
          }
        } else if (entry.type === "user_message") {
          metadata.userMessageCount++;
        }

        // Count tool calls
        if (entry.type === "tool_use") {
          metadata.toolCallCount++;

          // Track Edit/Write calls for files modified count
          if (entry.name === "Edit" || entry.name === "Write") {
            const filePath = entry.input?.file_path || entry.parameters?.file_path;
            if (filePath) {
              metadata.editWriteCalls.push({
                tool: entry.name,
                file: filePath,
              });
            }
          }
        }
      } catch (parseErr) {
        debugLog("parseTranscript", `Failed to parse line: ${parseErr.message}`);
        // Skip invalid JSON lines
        continue;
      }
    }

    // Count unique files modified
    const uniqueFiles = new Set(metadata.editWriteCalls.map((c) => c.file));
    metadata.filesModified = uniqueFiles.size;

    debugLog("parseTranscript", `Parsed transcript: ${JSON.stringify(metadata)}`);
    return metadata;
  } catch (err) {
    debugLog("parseTranscript", `Error reading transcript: ${err.message}`);
    return metadata;
  }
}

/**
 * Calculate session duration in minutes
 * @param {string} startedAt - ISO timestamp
 * @returns {number} Duration in minutes
 */
function getSessionDuration(startedAt) {
  if (!startedAt) {
    return 0;
  }

  try {
    const start = new Date(startedAt).getTime();
    const now = Date.now();
    const durationMs = now - start;
    return Math.floor(durationMs / 60000); // Convert to minutes
  } catch {
    return 0;
  }
}

/**
 * Generate summary from transcript metadata
 * @param {object} metadata - Parsed transcript metadata
 * @returns {string} Human-readable summary
 */
function generateSummary(metadata) {
  const parts = [];

  if (metadata.firstUserMessage) {
    parts.push(`Goal: ${metadata.firstUserMessage}`);
  }

  if (metadata.filesModified > 0) {
    parts.push(`Modified ${metadata.filesModified} file(s)`);
  }

  if (metadata.toolCallCount > 0) {
    parts.push(`${metadata.toolCallCount} tool calls`);
  }

  if (metadata.userMessageCount > 0) {
    parts.push(`${metadata.userMessageCount} user messages`);
  }

  return parts.length > 0 ? parts.join(", ") : "No significant activity";
}

/**
 * Parse transcript JSONL into raw array of entries
 * @param {string} transcriptPath - Path to transcript file
 * @returns {Array<object>} Array of parsed JSONL entries
 */
function parseTranscriptRaw(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    debugLog("parseTranscriptRaw", `Transcript not found: ${transcriptPath}`);
    return [];
  }

  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const entries = content
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    debugLog("parseTranscriptRaw", `Parsed ${entries.length} entries from transcript`);
    return entries;
  } catch (err) {
    debugLog("parseTranscriptRaw", `Error reading transcript: ${err.message}`);
    return [];
  }
}

module.exports = {
  parseTranscript,
  getSessionDuration,
  generateSummary,
  parseTranscriptRaw,
};
