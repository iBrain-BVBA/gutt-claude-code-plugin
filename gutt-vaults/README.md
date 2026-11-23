# gutt-vaults

Public research vaults on gutt memory. A vault answers one question about a public topic, such
as which agents a company could hire for which roles. Scouts research it on the open web every
day, a librarian checks every claim against its source, and you decide what enters the vault
on a Console page. A reviewer learns from your decisions and takes over the routine calls only
as far as your own record shows it would agree with you. Each week the vault publishes a brief,
a graph and a timelapse you can share.

```
claude plugin install gutt-vaults@gutt-plugins
```

It depends on `gutt-pro`, which installs and enables with it. Each vault keeps its memory in
its own group, `vault_<slug>`, on the gutt server `gutt-pro` connects to.

## Try it

- "Start a vault on open-source coding agents: steer it to releases, pricing and outcomes."
- "Run the daily research for the coding-agents vault."
- "Commit my approvals on the coding-agents vault." / "Write its brief for this week."
- "Preview the vault's Brief page before it goes out."

Every skill that runs a vault takes the vault's slug first; there is no default vault.

## Skills

| Skill          | What it does                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault-steer`  | Creates a vault's charter (scope, beats, source rules, review policy) and turns your instructions into steering                                             |
| `vault-curate` | The daily run: assembles the charter, sends one scout per beat, verifies every source, writes rows to the Console, runs the reviewer                        |
| `vault-review` | The reviewer's policy: precedent matching against your past verdicts, and the autonomy ladder it climbs per class                                           |
| `vault-commit` | The only writer of vault knowledge: your decided rows become Finding, Conflict, Verdict and Steering episodes; an approved brief republishes the Brief page |
| `vault-brief`  | The weekly brief and LinkedIn draft from committed findings only, the reviewer's calibration, and the republished Graph and Timelapse                       |
| `vault-pages`  | Exports the vault's memory to the Graph and Timelapse data, checks every page's data, publishes and previews the pages                                      |

## Agents

| Agent            | What it does                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `vault-scout`    | Researches one beat on the open web and returns candidate findings; no memory and no write tools |
| `vault-reviewer` | Judges pending rows from your verdicts and returns approve, reject or escalate; read-only memory |

Both are spawned by `vault-curate`, never on their own.

## The pages

| Page      | What it shows                                                              | Updated                            |
| --------- | -------------------------------------------------------------------------- | ---------------------------------- |
| Console   | Your inbox of rows to decide, the reviewer's record, settings and steering | Live, by every run                 |
| Brief     | The week's committed findings with their sources, and the open conflicts   | After you approve the week's brief |
| Graph     | Every node and fact in the vault, searchable, with superseded facts dashed | Weekly, with the brief             |
| Timelapse | The vault being built, fact by fact, by each of its agents                 | Weekly, with the brief             |

The pages are copies of the templates in `templates/`, published as Claude artifacts. They are
private until you share them. `vault-pages` previews any of them on your own machine first.

## What it writes

- **Memory:** only into the vault's own group. `vault-commit` writes what the vault knows, and
  only from rows you (or the reviewer, at the stage it has earned) decided. `vault-curate`,
  `vault-brief` and `vault-steer` write their own runs, insights and procedures. The reviewer
  and the scouts write nothing themselves.
- **Pages:** the Console's rows, and the Brief, Graph and Timelapse pages as artifacts.

No hooks.

## Where it runs

Claude Code in the terminal, the desktop app's Code tab, Cowork and cloud routines. A routine
needs `gutt-vaults@gutt-plugins` in the repository's `enabledPlugins` (see the main README),
the gutt connector authorised, and the vault's slug in its prompt.
