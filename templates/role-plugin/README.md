# {{PLUGIN_NAME}}

{{WHAT_THIS_PLUGIN_IS_FOR_IN_TWO_SENTENCES}}

```
claude plugin install {{PLUGIN_NAME}}@gutt-plugins
```

It depends on `gutt-pro`, which installs and enables with it.

SCAFFOLD NOTE: this README is for users. Plain words, no ticket keys, no history. Give the
plugin a row in the main README's plugin table, linked to this file, and add its install
command to `docs/team-onboarding.md` first, then copy it here and into the main README.
`npm run check:doc-pointers` fails until all three agree.

## Try it

- "{{A_REALISTIC_REQUEST_A_USER_WOULD_TYPE}}"

## Skills

| Skill            | What it does                       |
| ---------------- | ---------------------------------- |
| `{{SKILL_NAME}}` | {{WHAT_THIS_SKILL_DOES_IN_A_LINE}} |

SCAFFOLD NOTE: every skill, command and agent the plugin ships has a row in a `## Skills`,
`## Commands` or `## Agents` table here, and nothing else does. If you add an agent, add an
`## Agents` table with its name in backticks in the first column.

## What it writes

{{WHAT_IT_WRITES_AND_WHAT_WAITS_FOR_APPROVAL}}
