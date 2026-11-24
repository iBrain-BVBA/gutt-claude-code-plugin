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

- "Which vaults can I read?" / "Ask the coding-agents vault which vendors price per outcome."
- "Start a vault on open-source coding agents: steer it to releases, pricing and outcomes."
- "Run the daily research for the coding-agents vault."
- "Commit my approvals on the coding-agents vault." / "Write its brief for this week."
- "Preview the vault's Brief page before it goes out."

Every skill that runs or reads a vault takes the vault's slug first; there is no default vault.

## Reading a vault

Anyone signed in with a personal gutt login can read a public vault. Install the plugin, then
authorise the gutt connector: in Claude Code, `/mcp` → `gutt-mcp-remote` → Authorise; in the
Claude app, the gutt-pro plugin's page → Connectors → add `gutt-mcp-remote`. Authorising signs
a new user up. `/gutt-vaults:vault-list` shows the vaults you can read, and
`/gutt-vaults:vault-ask <slug> "<question>"` answers from a vault's committed findings, with a
source and date for every claim. A team login reads only its team's vaults.

## Skills

| Skill            | What it does                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vault-list`     | Lists the vaults your login can read and marks your own; says why an expected vault is missing                                                                                       |
| `vault-ask`      | Answers a question from one vault's committed findings only, every claim cited with its source URL and date; says when the vault doesn't cover it                                    |
| `vault-steer`    | Creates a vault (on a server with vaults), its charter (scope, beats, source rules, review policy) and its Console, and turns your instructions into steering                        |
| `vault-curate`   | The daily run: assembles the charter, sends one scout per beat, verifies every source, writes rows to the Console, runs the reviewer                                                 |
| `vault-review`   | The reviewer's policy: precedent matching against your past verdicts, and the autonomy ladder it climbs per class                                                                    |
| `vault-commit`   | The only writer of vault knowledge: your decided rows become Finding, Conflict, RoleCard, Verdict, Steering, Config and Brief episodes; an approved brief republishes the Brief page |
| `vault-brief`    | The weekly brief and LinkedIn draft from committed findings only, the reviewer's calibration, and the republished Graph and Timelapse                                                |
| `vault-pages`    | Exports the vault's memory to the Graph and Timelapse data, checks every page's data, publishes and previews the pages                                                               |
| `vault-routines` | Sets up the four scheduled routines that run a vault, attaching only the gutt connector, and proves them with a read-only preflight; also lists, retimes, pauses and runs them       |

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
  only from rows you (or the reviewer, at the stage it has earned) decided. `vault-steer`
  writes the charter and your steering. `vault-brief` writes the reviewer's weekly
  Calibration. `vault-curate`, `vault-brief` and `vault-steer` also write their own runs,
  insights and procedures. The reviewer and the scouts write nothing themselves.
- **Pages:** the Console's rows, and the Brief, Graph and Timelapse pages as artifacts.

No hooks.

## Where it runs

Claude Code in the terminal, the desktop app's Code tab, Cowork and cloud routines. A routine
sees only the plugins installed on its owner's claude.ai account, not the repository's
`enabledPlugins`: install `gutt-pro` and `gutt-vaults` there, give the routine the gutt
connector, and put the vault's slug in its prompt. `/gutt-vaults:vault-routines` sets up the
four routines and checks them.
