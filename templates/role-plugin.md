# Role-plugin template

The scaffold every role plugin in this marketplace is generated from, plus the two review
gates a role plugin does not merge without.

A role plugin is a thin plugin that depends on the core memory plugin and adds skills tied
to one role's activities. It ships no hooks: the core plugin owns the hook surface, and a
second plugin writing hook state is how sessions break. Skills, agents, and a manifest —
nothing else.

## Scaffolding one

```bash
cp -R templates/role-plugin gutt-<role>
```

This file is not part of that copy — the scaffold directory holds only files a real plugin
ships, so the copy needs no pruning.

Then, in the copy:

1. Rename `agents/AGENT_NAME.md` and `skills/SKILL_NAME/` to their real names, and change the
   matching `name:` in each. An agent's `name:` must equal its filename without `.md`; a
   skill's `name:` must equal its directory name, and nothing at runtime reports a mismatch.
2. **Delete every paragraph marked `SCAFFOLD NOTE`.** They are addressed to you, doing this
   edit. What survives becomes a prompt an agent reads at call time, where instructions
   about renaming files are noise. The review step fails while any remain.
3. Replace every `{{PLACEHOLDER}}`. They are deliberately loud, and the review step fails
   while any survive — including the ones in `plugin.json`, whose `description` is what the
   marketplace shows a user. Two things that are **not** placeholders and stay exactly as
   written: `<scope>`, which the agent resolves where it runs, and prose stand-ins like
   `<group_id>` or `<the specific thing>`, which are the skill-writing convention for a
   value the agent fills at call time.
   Keep the `{{...}}` form if you add placeholders of your own. The `__LIKE_THIS__` form is
   markdown bold, and `npm run format` rewrites it in prose — which turns a placeholder the
   review step would have caught into ordinary emphasised text that it never will.
4. Delete `ATTRIBUTION.md` if nothing was borrowed. Keep it, filled in, if anything was.
5. Add the plugin to `.claude-plugin/marketplace.json` — `name`, `source`, `description`,
   `category`. No `version` there; the manifest is the single source of truth for that.
6. Run the review step:

```bash
npm run check:role-plugin        # the two gates below, plus the structural rules
claude plugin validate ./gutt-<role>   # the platform's own validator, when the CLI is to hand
```

Drop a skill or the agent if the role does not need one. A plugin with skills and no agent
is normal; the marketplace already ships one.

## What the manifest must carry

| Field            | Why it is not optional                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | The plugin's identity, and the namespace its skills are invoked under.                                                              |
| `version`        | Omit it and the git commit SHA becomes the version, so every commit reads as an update.                                             |
| `dependencies`   | Names the core plugin. Without it a user can enable this plugin with no memory tooling underneath and every skill degrades at once. |
| `defaultEnabled` | `true`. Every plugin in this suite is on as soon as it is installed.                                                                |
| `license`        | Stated per plugin, not inherited by assumption from the repository root.                                                            |

All component directories live at the plugin root — `agents/`, `skills/`, `commands/` —
never inside `.claude-plugin/`, which holds only the manifest. Both gates read every
markdown file under those directories, nested ones included: a fork's habits survive
longest in `references/`, because that is the half nobody re-reads.

**Why `defaultEnabled` is stated when `true` is already the platform default.** Setting `false`
ships a plugin installed-but-off, for plugins that add scope a user should opt into. There is a
real argument for a role plugin doing that. This suite has settled the other way — install it
and it works — and the field is written out so that decision is visible in the manifest rather
than implied by an absence. The review step holds every role plugin to it, so the suite cannot
end up half opt-in.

## Frontmatter, and the failure it hides

**Quote every prose scalar in frontmatter, and close the quotes cleanly.** `description` and
`whenToUse` are sentences, and sentences attract colons. When YAML rejects a frontmatter
block it does not drop the offending field — it drops the block, so the component loads with
no name, no model, and none of its preloaded skills, and nothing at runtime tells you.

Opening a quote is not on its own an escape. Three shapes all reach that outcome:

```yaml
description: a brief: with a colon # unquoted, holding a colon
description: "phrases like "this one" inside" # inner quotes end the value early
description: "a label": value # quoted, then a mapping
```

The second is the one that catches people writing agent descriptions, because naming the
phrasings a user would type is exactly what a good description does. Write them in **single**
quotes inside the double-quoted value — `'review this PR', 'is this ready'` — and the value
survives both hazards at once.

## The agent's identity block

Every agent that can write to the org graph ships with its registration convention in its
own body, under `## Agent identity`. Copy the block from the template rather than
paraphrasing it: it encodes rules that are easy to invert, and the scaffolder that owns the
canonical wording is the `agent-creator` agent in the core plugin.

Three things the review step checks, because each has been got wrong:

- **The registered name carries a `--<scope>` suffix.** Identity merges on name plus group,
  so a bare name silently joins whatever else ever registered under it, and org writes
  cannot be reassigned afterwards. Suffixing is recoverable; pooling is not.
- **`<scope>` stays unresolved in the file.** It is resolved where the agent runs, which is
  not where it was scaffolded.
- **Recall is two passes, own scope then group-wide, and the group-wide pass is never
  skipped.** An agent's own scope is empty on its first run; the group graph is not.

An agent that never writes org-side registers nothing, tags nothing, and runs no scoped
recall — it gets the read-only variant, and a registration it cannot use is a bug, not a
precaution.

## One owner per skill

The core plugin owns the memory skills. A role plugin **references them by name and never
restates their rules** — no second copy of the search ladder, the write discipline, or the
tool contracts. Where a role plugin needs the behaviour, it names the owning skill and adds
only what is specific to its own activity.

The same rule holds between role plugins. A skill name is global to a session: two installed
plugins declaring the same skill name collide, and the user cannot tell which one answered.
Before naming a skill, check every plugin in the marketplace for that name. Where two roles
genuinely need the same activity, one plugin owns the skill and the other wraps it —
duplicating it produces two definitions that drift apart and disagree.

## Gate 1 — baseline-fork licensing

Role plugins are allowed, and encouraged, to take structure from proven open-source plugins.
Every borrowing passes all of this before it merges:

- [ ] The upstream licence is **permissive** — Apache-2.0 or MIT. A non-commercial or
      no-derivatives licence is not usable here at all, and neither is a repository with no
      licence file: absent a licence, no permission was granted.
- [ ] `ATTRIBUTION.md` exists at the plugin root, names the upstream repository, the path
      within it, the licence, and the copyright holder. **The upstream's licence goes in the
      paragraph that names the upstream**, and nowhere else — the review step reads only that
      paragraph for it, because a licence token floating elsewhere in the file once satisfied
      the check on behalf of an upstream it had nothing to do with.
- [ ] It **pins the commit SHA** that was actually read. A named repository without a SHA
      records that something was borrowed but not what, which is the state the licence
      question cannot be answered from later.
- [ ] It states, per borrowing, what was **taken, replaced, dropped, and added**. If nothing
      was replaced, this is a copy rather than an adaptation, and the strict obligations
      apply — carry the upstream licence and notice, and say the file was changed.
- [ ] Anthropic-authored content comes **only from the official plugins repository**, never
      from the Claude Code product repository.
- [ ] Content derived from a baseline whose **name is trademarked ships under a renamed
      identity.** Borrow the structure, not the brand.

That last rule binds what the plugin ships as, not whether the borrowing may be described.
`ATTRIBUTION.md` is exempt from it and only from it, because the checklist above
simultaneously requires the upstream repository to be named — so applying it there would make
honest attribution impossible whenever the upstream's own name carries the mark, and the
recorded provenance would be the thing that gave way. Everything else in this gate still
applies to that file: where a baseline may come from is exactly what an attribution should be
checked on.

## Gate 2 — delivery context

These plugins are for closed-source internal and outsourced delivery. Every skill and agent
passes all of this before it merges:

- [ ] **The ticket tracker and its wiki are the system of record.** No skill proposes
      issue-tracker mechanics this organization does not use — issue templates, label
      workflows, or milestone conventions carried over from a public repository's habits.
      This is the single most common thing a fork brings with it.
- [ ] **Memory writes name their engagement scope.** The group is passed explicitly, and
      nothing learned on one client's engagement is written into another's scope.
- [ ] **No external publishing.** Nothing is posted to a tracker, a pull request, a page, or
      a chat without approval of the exact text in the session. Client-identifying detail
      never leaves the engagement's scope, and no skill suggests publishing anything
      outward.
- [ ] **Governance steps are respected, not automated away.** Estimates are input to a
      commitment a human makes, releases keep their approval gate, and reporting to a client
      is drafted for a person to send.
- [ ] **Confidentiality is the default.** Where a skill is unsure whether something is
      shareable, it does not share it and says so.

## The review step

`tests/check-role-plugin.cjs` is the executable half of both gates — the structural rules,
the licensing gate, and the delivery-context gate that can be checked mechanically. It runs
in `npm run test:all` and in CI, and it covers every plugin the marketplace lists that
depends on the core plugin, so a new role plugin is picked up by registering it in
`marketplace.json` and nowhere else.

It cannot check the judgement calls — whether what was replaced is substantial enough to be
an adaptation, whether a governance step was really preserved. Those stay human, which is
what makes the checklists above review gates rather than decoration.
