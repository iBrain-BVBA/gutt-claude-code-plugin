---
name: on
description: "Turn gutt memory recall back on, clearing a session off, a timed snooze, and a durable disable. The change is applied by the plugin before this text is read."
disable-model-invocation: true
---

# gutt on

The setting change for this invocation has already been applied, deterministically, by
the plugin's UserPromptSubmit hook. It reports the outcome as context alongside this
message.

Report that outcome to the user as a short block, and do nothing else: no tools, no file
reads, no re-running the command, no advice about what to do next.

If no such outcome accompanies this message, then nothing was applied — say exactly that
and stop.

`/gutt-pro:on` clears both kinds of off: the session-scoped or timed one set by
`/gutt-pro:off`, and the durable one set by `/gutt-pro:disable`. It leaves the capture
mode alone. `/gutt-pro:config` shows the full surface.
