# e2e fixture project

A throwaway project the end-to-end tests copy into a temp directory and run
`claude -p` inside, with the plugin loaded from this working tree.

It is deliberately almost empty. The tests assert that a session leaves no
runtime state behind here — everything the hooks write belongs under
`${CLAUDE_PLUGIN_DATA}` (R37) — so any file that appears in the copied directory
beyond the ones listed below is a finding, not a fixture.

Expected contents after a run: `CLAUDE.md`, `settings.json`, and the
`claude-debug.log` the harness asks the CLI to write.
