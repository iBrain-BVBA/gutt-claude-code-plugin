---
name: config
description: "Show gutt's memory settings and the state they add up to. Read-only. The plugin has already gathered the answer before this text is read."
disable-model-invocation: true
---

# gutt settings

The settings for this invocation have already been read, deterministically, by the
plugin's UserPromptSubmit hook. It reports them as context alongside this message.

Report that outcome to the user as a short block, and do nothing else: no tools, no file
reads, no re-running the command, no advice about what to do next.

If no such outcome accompanies this message, then nothing was read — say exactly that
and stop.

**The command surface:**

```
/gutt-pro:config             show the current settings and the state they add up to
/gutt-pro:on                 turn memory recall back on, clearing an off or a disable
/gutt-pro:off                turn recall off for the rest of this session
/gutt-pro:off session        the explicit spelling of the same thing
/gutt-pro:off 30             turn recall off for 30 minutes (1 to 10080), then it resumes
/gutt-pro:disable            turn recall off until /gutt-pro:on — survives restarts
/gutt-pro:mode auto|hitl     set the capture mode
```
