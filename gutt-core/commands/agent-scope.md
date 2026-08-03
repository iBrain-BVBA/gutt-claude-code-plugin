---
name: agent-scope
description: "Bind this repo's agent scope, the label agents suffix their registered name with: /gutt-pro:agent-scope project|team|individual <name>, or show to see what is in force. The change is applied by the plugin before this text is read."
argument-hint: "show | project <name> | team <name> | individual <name>"
disable-model-invocation: true
---

# gutt agent scope

The read or change for this invocation has already been applied, deterministically, by
the plugin's UserPromptSubmit hook. It reports the outcome as context alongside this
message.

If no such outcome accompanies this message, then nothing was applied — say exactly that
and stop.

**When the outcome reports a scope was set, or reports what is in force:** relay it to
the user as a short block and do nothing else. No tools, no file reads, no re-running the
command.

**When the outcome says the invocation carried no argument**, and only then, help the
user choose one:

1. **Find the labels already in use**, so a team converges on one instead of each person
   inventing their own. Search the graph for existing agent identities and collect the
   part after `--` in the names you find. Read-only — register nothing, write nothing.
2. **Check what the candidate would collide with.** A registered name is permanent:
   registration merges on name and group, so reusing a label that belongs to another
   repo's agents silently joins that repo's memory to this one, and it cannot be undone
   or separated afterwards. If a label you are about to suggest already has agents whose
   work is plainly some other repo's, say so and steer away from it.
3. **Ask, using AskUserQuestion** — the scope type (project, team or individual) and the
   name. Offer the labels from step 1 as options where any exist, and say which repos
   each is already used by. A team label is the one to prefer when several repos are
   genuinely one product; a project label when this repo should keep its own memory.
4. **Tell the user the exact command to run.** You cannot apply it yourself — this
   command's effect comes from the hook that sees the typed prompt, and a command you
   invoke never reaches that hook. End with the line to type, and nothing after it:

   ```
   /gutt-pro:agent-scope project acme
   ```

If the graph is unreachable, skip steps 1 and 2, say the collision check could not run,
and still ask. An unchecked label is a risk worth naming; refusing to help is not.

**Forms:**

```
/gutt-pro:agent-scope                        report what is in force, then help choose
/gutt-pro:agent-scope show                   report what is in force and where it came from
/gutt-pro:agent-scope project <name>         bind a per-repo label
/gutt-pro:agent-scope team <name>            bind a label several repos share on purpose
/gutt-pro:agent-scope individual <name>      bind a label for one person's own context
```

The label becomes the suffix on every agent name registered from this repo, so
`pr-reviewer` becomes `pr-reviewer--<name>`. Repos bound to the same label share one
agent identity and one pool of agent-scoped memory; different labels are isolated. With
nothing bound, an agent falls back to the git remote's owner/repo, and to the working
folder's name when there is no remote.

Rebinding does not rename anything. Agents registered under the old label keep that
identity and their memory stays with it; new registrations use the new one.
