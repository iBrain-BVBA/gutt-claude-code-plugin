---
name: agent-scope
description: "Bind this working directory's agent scope, the label agents suffix their registered name with: /gutt-pro:agent-scope project|team|individual <name>, or show to see what is in force. The change is applied by the plugin before this text is read."
argument-hint: "show | project <name> | team <name> | individual <name>"
disable-model-invocation: true
---

# gutt agent scope

The read or change for this invocation has already been applied, deterministically, by
the plugin's UserPromptSubmit hook. It reports the outcome as context alongside this
message.

Read the outcome and take **exactly one** of the three branches below, in this order.

## 1. No outcome accompanies this message

Then whether anything was applied is **unknown** — not "nothing happened". The write and
the report are separate steps, so a missing report does not mean a missing write. Say
that, tell the user to run `/gutt-pro:agent-scope show` before retrying, and stop. Do not
re-run the command and do not guess.

## 2. The outcome contains the phrase `no argument given`

Only then, help the user choose one. Check this **before** branch 3 — an outcome with no
argument also reports what is in force, so testing for that first would swallow this case.

1. **Find the labels already in use**, so a team converges on one instead of each person
   inventing their own. Search the graph for existing agent identities and collect the
   part after `--` in the names you find. Read-only — register nothing, write nothing.
   Search registered names; if what comes back is node IDs, the `--` has been collapsed
   to a single `-` and the label cannot be split out reliably — say the survey was
   inconclusive rather than guessing where a name ends.
2. **Check what the candidate would collide with.** A registered name is permanent:
   registration merges on name and group, so reusing a label that belongs to another
   context silently joins that context's memory to this one, and it cannot be undone or
   separated afterwards. If a label you are about to suggest already has agents whose
   work is plainly someone else's, say so and steer away from it.
3. **Ask, using AskUserQuestion** — the scope type and the name. Offer the labels from
   step 1 as options where any exist, and say what each already appears to cover. A team
   label is the one to prefer when several directories are genuinely one product; a
   project label when this one should keep its own memory.
4. **Tell the user the exact line to type.** You cannot apply it yourself — this
   command's effect comes from the hook that sees the typed prompt, and a command you
   invoke never reaches that hook. End with the line, filling in the type and name that
   were actually chosen, and nothing after it:

   ```
   /gutt-pro:agent-scope <type> <name>
   ```

If the graph is unreachable, skip steps 1 and 2, say the collision check could not run,
and still ask. An unchecked label is a risk worth naming; refusing to help is not.

## 3. Any other outcome

A scope was set, a scope was reported, or the command was refused. Relay the outcome to
the user as a short block and do nothing else — no tools, no file reads, no re-running
the command. The outcome is already the whole answer.

**Forms:**

```
/gutt-pro:agent-scope                        report what is in force, then help choose
/gutt-pro:agent-scope show                   report what is in force and where it came from
/gutt-pro:agent-scope project <name>         bind a label for this directory alone
/gutt-pro:agent-scope team <name>            bind a label several directories share on purpose
/gutt-pro:agent-scope individual <name>      bind a label for one person's own context
```

The label becomes the suffix on every agent name registered from here, so an agent named
`<agent-name>` registers as `<agent-name>--<label>`. Directories bound to the same label
share one agent identity and one pool of agent-scoped memory; different labels are
isolated. With nothing bound, an agent derives a label instead — from the git remote's
owner/repo, or the working folder's name when there is no remote.

The binding is keyed on the working directory, not on the repository. A second checkout
of the same project, or a session started from a subdirectory, is a separate binding.

Rebinding does not rename anything. Agents registered under the old label keep that
identity and their memory stays with it; new registrations use the new one.
