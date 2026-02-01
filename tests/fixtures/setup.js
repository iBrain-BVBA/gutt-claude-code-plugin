/**
 * Test Utilities for sessionstart-setup.cjs
 * Provides isolated test environment helpers
 */

import fs from "fs";
import path from "path";
import os from "os";

/**
 * Creates an isolated test environment with temporary directories
 * @returns {Object} Test environment with helpers
 */
export function createTestEnv() {
  // Create a unique temp directory for this test
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-test-"));
  const claudeDir = path.join(tempDir, ".claude");
  const settingsFile = path.join(claudeDir, "settings.json");
  const markerFile = path.join(claudeDir, ".gutt-statusline-configured");

  // Create .claude directory
  fs.mkdirSync(claudeDir, { recursive: true });

  return {
    /**
     * Get the temp directory path
     */
    getTempDir() {
      return tempDir;
    },

    /**
     * Get the .claude directory path
     */
    getClaudeDir() {
      return claudeDir;
    },

    /**
     * Get the settings.json file path
     */
    getSettingsFile() {
      return settingsFile;
    },

    /**
     * Get the marker file path
     */
    getMarkerFile() {
      return markerFile;
    },

    /**
     * Write settings.json with given content
     * @param {Object} settings - Settings object to write
     */
    writeSettings(settings) {
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf8");
    },

    /**
     * Read settings.json
     * @returns {Object} Parsed settings or null if doesn't exist
     */
    readSettings() {
      if (!fs.existsSync(settingsFile)) {
        return null;
      }
      const content = fs.readFileSync(settingsFile, "utf8");
      return JSON.parse(content);
    },

    /**
     * Write marker file
     * @param {Object} marker - Marker object to write
     */
    writeMarker(marker) {
      fs.writeFileSync(markerFile, JSON.stringify(marker, null, 2), "utf8");
    },

    /**
     * Read marker file
     * @returns {Object} Parsed marker or null if doesn't exist
     */
    readMarker() {
      if (!fs.existsSync(markerFile)) {
        return null;
      }
      const content = fs.readFileSync(markerFile, "utf8");
      return JSON.parse(content);
    },

    /**
     * Check if marker file exists
     * @returns {boolean}
     */
    markerExists() {
      return fs.existsSync(markerFile);
    },

    /**
     * Check if settings.json exists
     * @returns {boolean}
     */
    settingsExists() {
      return fs.existsSync(settingsFile);
    },

    /**
     * Delete the .claude directory
     */
    deleteClaudeDir() {
      if (fs.existsSync(claudeDir)) {
        fs.rmSync(claudeDir, { recursive: true, force: true });
      }
    },

    /**
     * Clean up all test files and directories
     */
    cleanup() {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },

    /**
     * Set environment variables for the test
     * @param {Object} env - Environment variables to set
     */
    setEnv(env) {
      Object.assign(process.env, env);
    },

    /**
     * Get environment setup for running the hook
     * @param {string} pluginRoot - Plugin root directory
     * @returns {Object} Environment variables
     */
    getHookEnv(pluginRoot) {
      return {
        HOME: tempDir,
        USERPROFILE: tempDir, // Windows fallback
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      };
    },
  };
}

/**
 * Run a Node.js script with custom environment
 * @param {string} scriptPath - Path to script
 * @param {Object} env - Environment variables
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
export async function runScript(scriptPath, env = {}) {
  const { spawn } = await import("child_process");

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}
