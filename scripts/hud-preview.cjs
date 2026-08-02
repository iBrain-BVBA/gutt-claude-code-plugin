#!/usr/bin/env node
/**
 * Render every HUD state side by side, against a throwaway data dir.
 *
 * Nothing here touches ~/.claude — the renderer is pointed at a temp
 * CLAUDE_PLUGIN_DATA that is deleted on exit, so this is safe to run against a
 * live install. It answers "what will the status bar look like", which is the
 * question that costs the most to answer by installing and waiting.
 *
 *   node scripts/hud-preview.cjs            # every state
 *   node scripts/hud-preview.cjs --width 60 # the same states at a narrow terminal
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RENDERER = path.join(__dirname, "..", "gutt-core", "hooks", "statusline.cjs");

const widthArg = process.argv.indexOf("--width");
const COLUMNS = widthArg === -1 ? undefined : process.argv[widthArg + 1];

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-hud-preview-"));
process.on("exit", () => fs.rmSync(sandbox, { recursive: true, force: true }));

const PAYLOAD = {
  session_id: "s1",
  model: { display_name: "Opus 5" },
  context_window: { used_percentage: 38 },
};

/** An hour from now, so the snooze deadline is always in the future. */
const SNOOZE_UNTIL = new Date(Date.now() + 60 * 60 * 1000).toISOString();

/**
 * @param {Object} state the session record the renderer reads
 * @param {Object} config the runtime config the renderer reads
 * @returns {string} the rendered status line
 */
function render(state, config) {
  const dataDir = fs.mkdtempSync(path.join(sandbox, "d-"));
  fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "sessions", "s1.json"),
    JSON.stringify({ sessionId: "s1", ...state })
  );
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config));

  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  if (COLUMNS === undefined) {
    delete env.COLUMNS;
  } else {
    env.COLUMNS = String(COLUMNS);
  }

  const result = spawnSync(process.execPath, [RENDERER], {
    input: JSON.stringify(PAYLOAD),
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    return `EXIT ${result.status}: ${result.stderr.trim()}`;
  }
  return result.stdout.trim();
}

/** A call that came back a moment ago, which is what green now requires. */
const JUST_NOW = new Date(Date.now() - 5000).toISOString();
const LONG_AGO = new Date(Date.now() - 40 * 60 * 1000).toISOString();

const CONNECTED = {
  connectionStatus: "ok",
  mcpConfigured: true,
  connectionObservedAt: JUST_NOW,
  mcpToolsAvailable: "available",
};

const CASES = [
  ["a call just succeeded", CONNECTED, {}],
  ["human-in-the-loop mode", CONNECTED, { mode: "hitl" }],
  ["recall durably disabled", CONNECTED, { enabled: false }],
  ["snoozed, with deadline", CONNECTED, { snoozeUntil: SNOOZE_UNTIL }],
  ["server dropped, awaiting auth", { ...CONNECTED, mcpToolsAvailable: "pending" }, {}],
  ["never authenticated", { mcpConfigured: true, mcpToolsAvailable: "auth" }, {}],
  ["configured, tools gone", { ...CONNECTED, mcpToolsAvailable: "absent" }, {}],
  ["a call failed, tools still there", { ...CONNECTED, connectionStatus: "error" }, {}],
  ["a call came back unauthorised", { ...CONNECTED, connectionStatus: "auth" }, {}],
  ["quiet for 40 minutes, still fine", { ...CONNECTED, connectionObservedAt: LONG_AGO }, {}],
  ["nothing observed yet", { mcpConfigured: true }, {}],
  ["no gutt MCP server configured", { mcpConfigured: false }, {}],
];

const label = COLUMNS === undefined ? "unconstrained width" : `COLUMNS=${COLUMNS}`;
process.stdout.write(`\nHUD states — ${label}\n${"─".repeat(72)}\n`);
for (const [name, state, config] of CASES) {
  process.stdout.write(`${name.padEnd(32)}${render(state, config)}\n`);
}
process.stdout.write("\n");
