/**
 * Text utility functions for GUTT hooks
 * Shared across multiple hooks to avoid duplication
 */

/**
 * Sanitize text for safe display in JSON output
 * Removes problematic characters that could break JSON or cause issues
 * @param {string} text - Input text to sanitize
 * @returns {string} Sanitized text safe for display
 */
function sanitizeForDisplay(text) {
  if (!text || typeof text !== "string") {
    return "";
  }
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { sanitizeForDisplay };
