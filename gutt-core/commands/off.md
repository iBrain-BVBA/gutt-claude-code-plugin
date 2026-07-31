---
name: off
description: "Turn gutt memory recall off for this session, or for a number of minutes: /gutt-pro:off, /gutt-pro:off 30, /gutt-pro:off session. The change is applied by the plugin before this text is read."
argument-hint: "[minutes|session]"
disable-model-invocation: true
---

# gutt off

The setting change for this invocation has already been applied, deterministically, by
the plugin's UserPromptSubmit hook. It reports the outcome as context alongside this
message.

Report that outcome to the user as a short block, and do nothing else: no tools, no file
reads, no re-running the command, no advice about what to do next.

If no such outcome accompanies this message, then nothing was applied — say exactly that
and stop.

**Forms:**

```
/gutt-pro:off             off for the rest of this session — it comes back on its own
/gutt-pro:off session     the explicit spelling of the same thing
/gutt-pro:off 30          off for 30 minutes (1 to 10080), then it resumes itself
```

This verb is always temporary. `/gutt-pro:disable` is the durable off that survives
restarts, and `/gutt-pro:on` restores recall now.
