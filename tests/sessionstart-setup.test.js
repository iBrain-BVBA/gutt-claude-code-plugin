/**
 * Tests for sessionstart-setup.cjs hook
 * Verifies auto-configuration behavior
 */

import { strict as assert } from "assert";
import { test } from "node:test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createTestEnv, runScript } from "./fixtures/setup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, "..", "hooks", "sessionstart-setup.cjs");

test("Fresh install - no settings.json", async () => {
  const env = createTestEnv();
  try {
    // Delete settings.json to simulate fresh install
    const settingsFile = env.getSettingsFile();
    if (fs.existsSync(settingsFile)) {
      fs.unlinkSync(settingsFile);
    }

    const pluginRoot = path.join(__dirname, "..");
    const result = await runScript(HOOK_PATH, env.getHookEnv(pluginRoot));

    // Hook should exit 0
    assert.equal(result.exitCode, 0, "Hook should exit 0");

    // Marker should be created
    assert.ok(env.markerExists(), "Marker file should exist");

    // Settings.json should be created with statusline
    assert.ok(env.settingsExists(), "Settings file should exist");
    const settings = env.readSettings();
    assert.ok(settings.statusLine, "Statusline should be configured");
    assert.ok(
      settings.statusLine.command.includes("statusline.cjs"),
      "Statusline should point to statusline.cjs"
    );

    // No passthrough statusline (nothing to preserve)
    assert.equal(
      settings.gutt?.statusline?.passthroughCommand,
      undefined,
      "No passthrough statusline expected"
    );

    // Marker should have timestamp and version
    const marker = env.readMarker();
    assert.ok(marker.configuredAt, "Marker should have timestamp");
    assert.ok(marker.version, "Marker should have version");
  } finally {
    env.cleanup();
  }
});

test("Existing settings.json without statusline", async () => {
  const env = createTestEnv();
  try {
    // Create settings.json with some existing config
    env.writeSettings({
      theme: "dark",
      model: "claude-opus-4",
    });

    const pluginRoot = path.join(__dirname, "..");
    const result = await runScript(HOOK_PATH, env.getHookEnv(pluginRoot));

    assert.equal(result.exitCode, 0, "Hook should exit 0");

    // Settings should preserve existing config
    const settings = env.readSettings();
    assert.equal(settings.theme, "dark", "Existing theme should be preserved");
    assert.equal(settings.model, "claude-opus-4", "Existing model should be preserved");

    // Statusline should be added
    assert.ok(settings.statusLine, "Statusline should be configured");
    assert.ok(
      settings.statusLine.command.includes("statusline.cjs"),
      "Statusline should point to statusline.cjs"
    );

    // No passthrough (no existing statusline)
    assert.equal(
      settings.gutt?.statusline?.passthroughCommand,
      undefined,
      "No passthrough statusline expected"
    );
  } finally {
    env.cleanup();
  }
});

test("Existing settings.json with statusline - passthrough stored", async () => {
  const env = createTestEnv();
  try {
    // Create settings.json with existing statusline (as object, like Claude Code uses)
    const existingStatusline = "echo 'Custom Status'";
    env.writeSettings({
      statusLine: {
        type: "command",
        command: existingStatusline,
      },
      theme: "light",
    });

    const pluginRoot = path.join(__dirname, "..");
    const result = await runScript(HOOK_PATH, env.getHookEnv(pluginRoot));

    assert.equal(result.exitCode, 0, "Hook should exit 0");

    // Settings should have GUTT statusline
    const settings = env.readSettings();
    assert.ok(settings.statusLine, "Statusline should exist");
    assert.ok(
      settings.statusLine.command.includes("statusline.cjs"),
      "Statusline should be GUTT statusline"
    );

    // Existing statusline should be stored as passthrough
    assert.equal(
      settings.gutt?.statusline?.passthroughCommand,
      existingStatusline,
      "Passthrough statusline should match original"
    );

    // Other settings preserved
    assert.equal(settings.theme, "light", "Theme should be preserved");
  } finally {
    env.cleanup();
  }
});

test("Marker already exists - skip setup", async () => {
  const env = createTestEnv();
  try {
    // Create marker file to indicate already configured
    env.writeMarker({
      configuredAt: "2024-01-01T00:00:00.000Z",
      version: "1.0.0",
    });

    // Create settings with existing statusline
    const existingStatusline = "echo 'Existing'";
    env.writeSettings({
      statusLine: {
        type: "command",
        command: existingStatusline,
      },
    });

    const pluginRoot = path.join(__dirname, "..");
    const result = await runScript(HOOK_PATH, env.getHookEnv(pluginRoot));

    assert.equal(result.exitCode, 0, "Hook should exit 0");

    // Settings should remain unchanged
    const settings = env.readSettings();
    assert.equal(
      settings.statusLine.command,
      existingStatusline,
      "Statusline should not be modified"
    );
    assert.equal(
      settings.gutt?.statusline?.passthroughCommand,
      undefined,
      "No passthrough should be added"
    );
  } finally {
    env.cleanup();
  }
});

test("Invalid JSON in settings.json - handle gracefully", async () => {
  const env = createTestEnv();
  try {
    // Write invalid JSON to settings.json
    const settingsFile = env.getSettingsFile();
    fs.writeFileSync(settingsFile, "{ invalid json }", "utf8");

    const pluginRoot = path.join(__dirname, "..");
    const result = await runScript(HOOK_PATH, env.getHookEnv(pluginRoot));

    // Should still exit 0 (fail-safe)
    assert.equal(result.exitCode, 0, "Hook should exit 0 even with invalid JSON");

    // Marker should be created
    assert.ok(env.markerExists(), "Marker file should exist");

    // Settings should be overwritten with valid JSON
    const settings = env.readSettings();
    assert.ok(settings, "Settings should be valid JSON");
    assert.ok(settings.statusLine, "Statusline should be configured");
  } finally {
    env.cleanup();
  }
});

test("Missing ~/.claude directory - create it", async () => {
  const env = createTestEnv();
  try {
    // Delete the .claude directory
    env.deleteClaudeDir();
    assert.ok(!fs.existsSync(env.getClaudeDir()), ".claude dir should not exist");

    const pluginRoot = path.join(__dirname, "..");
    const result = await runScript(HOOK_PATH, env.getHookEnv(pluginRoot));

    assert.equal(result.exitCode, 0, "Hook should exit 0");

    // .claude directory should be created
    assert.ok(fs.existsSync(env.getClaudeDir()), ".claude dir should be created");

    // Settings and marker should exist
    assert.ok(env.settingsExists(), "Settings file should exist");
    assert.ok(env.markerExists(), "Marker file should exist");
  } finally {
    env.cleanup();
  }
});

test("Permission errors - fail-safe, still exit 0", async () => {
  const env = createTestEnv();
  try {
    // Create a read-only .claude directory to simulate permission error
    const claudeDir = env.getClaudeDir();

    // On Windows, we need to use a different approach
    // Make the directory read-only
    if (process.platform === "win32") {
      // Windows: use attrib command
      const { execSync } = await import("child_process");
      try {
        execSync(`attrib +r "${claudeDir}"`, { stdio: "ignore" });
      } catch {
        // Skip test if we can't set readonly (requires admin)
        console.log("Skipping permission test on Windows (requires admin)"); // eslint-disable-line no-console
        return;
      }
    } else {
      // Unix: chmod
      fs.chmodSync(claudeDir, 0o444);
    }

    const pluginRoot = path.join(__dirname, "..");
    const result = await runScript(HOOK_PATH, env.getHookEnv(pluginRoot));

    // Should exit 0 even on permission error (fail-safe)
    assert.equal(result.exitCode, 0, "Hook should exit 0 on permission error");

    // Restore permissions for cleanup
    if (process.platform === "win32") {
      const { execSync } = await import("child_process");
      try {
        execSync(`attrib -r "${claudeDir}"`, { stdio: "ignore" });
      } catch {
        // ignore
      }
    } else {
      try {
        fs.chmodSync(claudeDir, 0o755);
      } catch {
        // ignore
      }
    }
  } finally {
    env.cleanup();
  }
});

test("Concurrent execution - atomic writes", async () => {
  const env = createTestEnv();
  try {
    const pluginRoot = path.join(__dirname, "..");
    const hookEnv = env.getHookEnv(pluginRoot);

    // Run hook twice in parallel
    const [result1, result2] = await Promise.all([
      runScript(HOOK_PATH, hookEnv),
      runScript(HOOK_PATH, hookEnv),
    ]);

    // Both should exit 0
    assert.equal(result1.exitCode, 0, "First run should exit 0");
    assert.equal(result2.exitCode, 0, "Second run should exit 0");

    // Should have marker file
    assert.ok(env.markerExists(), "Marker file should exist");

    // Settings should be valid (not corrupted by concurrent writes)
    const settings = env.readSettings();
    assert.ok(settings, "Settings should be valid");
    assert.ok(settings.statusLine, "Statusline should be configured");

    // Marker should be valid
    const marker = env.readMarker();
    assert.ok(marker, "Marker should be valid");
    assert.ok(marker.configuredAt, "Marker should have timestamp");
  } finally {
    env.cleanup();
  }
});
