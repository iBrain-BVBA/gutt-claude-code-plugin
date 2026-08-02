---
name: statusline
description: "Install, remove, or check the gutt HUD in your Claude Code status bar: /gutt-pro:statusline, /gutt-pro:statusline off, /gutt-pro:statusline status. The change is applied by the plugin before this text is read."
argument-hint: "[off|status]"
disable-model-invocation: true
---

# gutt statusline

The setting change for this invocation has already been applied, deterministically, by
the plugin's UserPromptSubmit hook. It reports the outcome as context alongside this
message.

Report that outcome to the user as a short block, and do nothing else: no tools, no file
reads, no re-running the command, no editing settings yourself.

If no such outcome accompanies this message, then nothing was applied — say exactly that
and stop.

**Forms:**

```
/gutt-pro:statusline          install the HUD in ~/.claude/settings.json
/gutt-pro:statusline off      remove it again
/gutt-pro:statusline status   report whether it is installed
```

A plugin cannot put a status line in place on its own — Claude Code accepts one only from
your own settings file — so this command is the only way the gutt HUD appears, and it
never runs unless you type it. The original settings file is backed up before either
change.

What it installs points at a stable path rather than at the plugin's versioned directory,
so upgrading gutt does not break it. If the HUD disappears on its own, that is Claude Code
dropping the key while rewriting settings; the next session puts it back.
