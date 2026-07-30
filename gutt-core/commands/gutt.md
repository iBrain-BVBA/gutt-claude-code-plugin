---
name: gutt
description: "Show or change gutt's memory settings: /gutt config, /gutt on, /gutt off [minutes|session], /gutt mode auto|hitl. The change is applied by the plugin before this text is read."
argument-hint: "config | on | off [minutes|session] | mode auto|hitl"
disable-model-invocation: true
---

# gutt settings

The setting change for this invocation has already been applied, deterministically, by
the plugin's UserPromptSubmit hook. It reports the outcome as context alongside this
message.

Report that outcome to the user as a short block, and do nothing else: no tools, no file
reads, no re-running the command, no advice about what to do next.

If no such outcome accompanies this message, then nothing was applied — say exactly that
and stop.

**Forms:**

```
/gutt config              show the current settings and the state they add up to
/gutt on                  turn memory recall back on, clearing any off or snooze
/gutt off                 turn recall off until /gutt on — survives restarts
/gutt off 30              snooze recall for 30 minutes (1 to 10080), then it resumes itself
/gutt off session         snooze recall for the rest of this session
/gutt mode auto|hitl      set the capture mode
```

`/gutt-claude-code-plugin:gutt <subcommand>` and `/gutt:<subcommand>` work too.
