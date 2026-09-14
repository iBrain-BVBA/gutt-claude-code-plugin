---
name: component-creator
description: "Design, scaffold, and validate Claude Code plugin components with a skills-first default. Creates or updates a skill for reusable workflows and adds an agent only when a separate system prompt, tool boundary, isolation, resumability, or deterministic skill preload is genuinely required. Preserves named memory identity for workflows that write to the org graph. Use when creating a plugin component, converting an agent to a skill, or deciding whether work belongs in a skill or an agent."
argument-hint: "<component purpose, plugin, and constraints>"
model: sonnet
metadata:
  memory-identity: agent-creator
---

# Component Creator

Create the smallest durable Claude Code component that owns the requested job.
The default artifact is a skill: skills are discoverable, directly invocable,
composable from the current conversation, and can opt into an isolated context
when needed. Add an agent only when the job needs an execution boundary that a
skill cannot express cleanly.

Invoke `gutt-pro:memory-search` before designing, `gutt-pro:graph-traversal` only
when a genuine multi-hop ownership question remains, `gutt-pro:memory-capture`
for a durable reusable lesson, and `gutt-pro:agent-memory-protocol` before any
identity-scoped recall or tagged org write. Skills do not accept the agent
frontmatter `skills:` field. A skill can instead explicitly invoke another skill
by its fully-qualified name; if deterministic preload is essential, that is
evidence for a custom agent.

## Memory identity

This workflow preserves the legacy creator identity as
**`agent-creator--<scope>`** even though its implementation is now a skill. The
stable identity is provenance for the capability, not a claim that an isolated
actor ran.

After resolving the authoritative org group and `<scope>` through
`agent-memory-protocol`, register before the first identity-scoped read or tagged
org write:

```
register_agent(
  name="agent-creator--<scope>",
  description="Designs and scaffolds skills-first Claude Code plugin components",
  group_id=<the resolved org group>)
```

Keep the returned node id or uuid for verification. Registration is idempotent.
If registration is hidden but the legacy identity already works, keep the scoped
calls and tags. On an unknown-identity error, re-register and retry; only then
work group-wide without `agent_id`, note the degradation once, and continue.
Never invent a group or scope.

## Hard rules

1. **Reuse before creating.** Search installed and repository components by
   purpose and trigger language. Extend an existing owner when its boundary
   already fits; two definitions of one job drift and collide.
2. **Skill first.** Choose an agent only for a concrete boundary: a distinct
   system prompt or persona, restricted tools or permissions, an isolated and
   resumable execution context, or deterministic preload of several skills.
   “This work is complex” is not such a boundary.
3. **One owner per behavior.** A component may invoke another skill, but it does
   not copy that skill's protocol. Name the owner and add only the new workflow.
4. **Write no external state without approval.** Local scaffolding requested by
   the user is in scope. Posting, publishing, installing, or changing Jira,
   pull requests, pages, or remote repositories requires the corresponding
   explicit request and approval gate.
5. **Preserve identities during migration.** If an existing memory-writing
   agent becomes a skill, keep its registered base name in
   `metadata.memory-identity`. Never create a second memory lineage merely
   because the component type changed.
6. **Personal memory is untagged.** Named identity applies to org writes only.
   A read-only or personal-only workflow declares no memory identity, does not
   register, and does not perform an identity-scoped recall.
7. **Validate what the platform loads.** Directory/file names, frontmatter,
   namespace, tool availability, and the repository's own gates all matter.
   A plausible Markdown file that is not discovered is not a component.

## Workflow

### Step 1 — establish the job and existing owner

From `$ARGUMENTS` and the repository, identify:

- the user phrasing that should trigger the component;
- the concrete artifact it returns or action it performs;
- inputs, outputs, side effects, and approval points;
- required tools, skills, data scopes, and model tier;
- neighboring jobs it must refuse;
- an existing component that already owns all or part of the behavior.

Run the Grounding Protocol. If the request leaves a material boundary undecided,
ask one focused question. Otherwise proceed with the narrowest safe assumption
and state it in the draft.

### Step 2 — choose the component shape

Use this decision table:

| Need                                                                                                   | Shape                                                             |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Reusable instructions in the current conversation                                                      | Inline skill                                                      |
| Isolation without a permanent persona                                                                  | Skill with `context: fork`                                        |
| Fixed model for a forked task                                                                          | Skill with `context: fork`, `agent: general-purpose`, and `model` |
| Interactive questions or use of conversation history                                                   | Inline skill; do not fork                                         |
| Separate system prompt, strict tool boundary, resumable specialist, or deterministic `skills:` preload | Custom agent                                                      |

For a forked skill, make the body a self-contained task prompt. Consume
`$ARGUMENTS`; do not assume conversation history; do not depend on asking the
user from inside the fork. Set `background: false` when the caller must wait for
the result or the work needs the full foreground tool set.

### Step 3 — design memory behavior

Choose exactly one:

- **No identity:** read-only or personal-only. Group-wide/personal reads as
  appropriate, no registration, no `agent_id`, personal writes untagged.
- **Named org-writing workflow:** declare
  `metadata.memory-identity: <stable-base>` in a skill, or use the agent
  filename as the base. Include an exact `## Memory identity` or
  `## Agent identity` section, register `<stable-base>--<scope>` after the
  target group and scope are resolved, recall own scope then group-wide, and
  tag every org write.

When migrating, the stable base is the old identity. It may intentionally differ
from the new skill directory name; metadata makes that continuity explicit.

### Step 4 — create or update the skill

Create `skills/<name>/SKILL.md`. `name` is kebab-case and exactly matches the
directory. Write a quoted description containing what it does, when to use it,
and meaningful trigger language. Add only the frontmatter the behavior earns:

| Field                                | Add when                                                   |
| ------------------------------------ | ---------------------------------------------------------- |
| `argument-hint`                      | Direct invocation benefits from showing the expected input |
| `model`                              | The workflow has a justified fixed model tier              |
| `context: fork`                      | It must run isolated from the current conversation         |
| `agent`                              | A fork should use a built-in or custom execution profile   |
| `background`                         | Fork scheduling must differ from the platform default      |
| `metadata.memory-identity`           | The skill is a named org-memory writer                     |
| `allowed-tools` / `disallowed-tools` | The capability needs a real tool boundary                  |

There is no `skills:` frontmatter field for skills. Refer to dependencies in the
body by fully-qualified plugin name and explicitly invoke them at the relevant
step. Keep critical safety, approval, privacy, and identity rules inline because
skill invocation is model-mediated.

The body should include: boundary and outcome; hard rules; an ordered workflow;
degradation; grounding; learning when it writes; an output contract; and one
realistic invocation. Put long examples or reference material under the skill's
own `references/` directory and route to them from `SKILL.md`.

### Step 5 — add an agent only when justified

If Step 2 found a real agent boundary, create `agents/<name>.md`. Its `name`
matches the filename, its description states proactive triggers and exclusions,
and `model` is explicit when the job earns one. Use `skills:` only for the small
set that must be loaded deterministically into the agent's context.

The body is the agent's system prompt, not a second copy of the method skill.
State the persona/boundary, invoke the owned method, and add only agent-specific
coordination, tools, and memory identity. If removing the agent would leave the
workflow equally correct as a skill or a forked skill, remove it.

### Step 6 — validate and report

Run the repository's formatting, structural, frontmatter, plugin, and test gates
in proportion to the change. At minimum verify:

- the platform discovers each component under the expected plugin namespace;
- names exactly match their file/directory;
- quoted YAML parses and supported frontmatter fields are used;
- every dependency exists and no global name collides;
- named writer skills carry metadata plus operative identity, Grounding, and
  Learning sections;
- no stale docs, examples, manifests, tests, or counts still advertise a
  removed component.

Report files created, files retired, the shape decision, identity continuity,
and checks run. Do not commit, branch, install, or publish unless requested.

## Grounding Protocol

After registration, recall in two passes. First search for prior creator
decisions and component patterns with
`agent_id="agent-creator--<scope>"`. Then search group-wide without `agent_id`
for existing components, conventions, and failures. The group-wide pass is never
skipped. Confirm the current repository layout and official platform behavior
from their sources before treating recalled guidance as current.

Minimum grounding before editing: a component inventory, its nearest existing
owner, the plugin namespace, and the reason the chosen shape is a skill or an
agent. If memory is unavailable, repository evidence is sufficient; name the
missing historical layer once.

## Learning Protocol

When the conversation holds a reusable design lesson a future component creator
could not cheaply derive from the files or the platform documentation — a naming
collision and how it was resolved, a convention gap the scaffold exposed, a
template clause that turned out wrong — capture it before finishing: invoke
`gutt-pro:memory-capture` with the resolved `group_id`,
`agent_id="agent-creator--<scope>"` and `last_n_episodes=0` on every org write.
That skill classifies, deduplicates, and applies its trust-tier gate; a gated
type waits for the human signal it requires, and nothing else waits. No visible
org write tool means no capture — say so in one line. Verify with the registered
node when it matters. Personal writes remain untagged. Routine facts such as
"created a skill" and unaccepted design opinions are not lessons.

## Output format

Lead with what was created or changed. Then list the shape decision and its
boundary, memory identity behavior, validation results, and any unresolved gap.
Use clickable repository paths when the client supports them.

## Example invocation

```text
/gutt-pro:component-creator Convert the release-triage agent into a skill while
preserving its org-memory identity and approval gates.
```
