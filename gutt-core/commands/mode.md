---
name: mode
description: "Set gutt's capture mode: /gutt-pro:mode auto writes captures without asking, /gutt-pro:mode hitl asks you to confirm each subject. The change is applied by the plugin before this text is read."
argument-hint: "auto|hitl"
disable-model-invocation: true
---

# gutt mode

The setting change for this invocation has already been applied, deterministically, by
the plugin's UserPromptSubmit hook. It reports the outcome as context alongside this
message.

Report that outcome to the user as a short block, and do nothing else: no tools, no file
reads, no re-running the command, no advice about what to do next.

If no such outcome accompanies this message, then nothing was applied — say exactly that
and stop.

**Forms:**

```
/gutt-pro:mode auto      a capture is written without a confirmation step
/gutt-pro:mode hitl      the end-of-turn capture judge asks you to confirm first
```

Mode governs only how a capture is confirmed once the judge has fired. It does not turn
recall on or off — `/gutt-pro:off`, `/gutt-pro:disable` and `/gutt-pro:on` do that.
