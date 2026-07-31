---
name: disable
description: "Turn gutt memory recall off durably, until /gutt-pro:on. Survives restarts. The change is applied by the plugin before this text is read."
disable-model-invocation: true
---

# gutt disable

The setting change for this invocation has already been applied, deterministically, by
the plugin's UserPromptSubmit hook. It reports the outcome as context alongside this
message.

Report that outcome to the user as a short block, and do nothing else: no tools, no file
reads, no re-running the command, no advice about what to do next.

If no such outcome accompanies this message, then nothing was applied — say exactly that
and stop.

`/gutt-pro:disable` takes no argument and does not lapse: recall stays off across
restarts until `/gutt-pro:on`. For a temporary off use `/gutt-pro:off` (this session) or
`/gutt-pro:off <minutes>`.
