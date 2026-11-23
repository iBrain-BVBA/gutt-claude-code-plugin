# Contributing

This repository is the `gutt-plugins` marketplace. Each plugin lives in its own directory and is
listed in `.claude-plugin/marketplace.json`:

| Directory         | Plugin           |
| ----------------- | ---------------- |
| `gutt-core/`      | `gutt-pro`       |
| `gutt-developer/` | `gutt-developer` |
| `gutt-product/`   | `gutt-product`   |
| `gutt-mentor/`    | `gutt-mentor`    |
| `gutt-vaults/`    | `gutt-vaults`    |

The core plugin's directory is `gutt-core/` and its name is `gutt-pro`; they differ on purpose.
`CLAUDE.md` holds the conventions for writing skills, hooks and role plugins.

## Set up

```bash
nvm use          # Node.js 24, from .nvmrc
npm ci           # dev tools and git hooks (commitlint, lint-staged)
```

To run your working tree as the installed plugin, register this checkout as a directory
marketplace in your Claude Code settings. A directory source loads in place, so an uncommitted
edit runs on the next session with no reinstall. To test what an end user gets, install from the
GitHub marketplace instead.

## Before you push

```bash
npm run lint           # ESLint
npm run format:check   # Prettier; npm run format fixes it
npm run test:all       # unit tests, hook smoke tests and every guard below
```

`npm run test:e2e` runs the end-to-end hook tests against a real `claude` CLI; see
`tests/e2e/README.md`.

`test:all` and CI run these guards:

| Script                       | Fails when                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `npm run check:no-symlinks`  | a file is committed as a symlink (they break every hook on Windows)                                |
| `npm run check:state`        | a hook writes runtime state outside the plugin's data directory                                    |
| `npm run check:version`      | `gutt-pro`'s `plugin.json` version differs from `package.json`, or the marketplace lists a version |
| `npm run check:role-plugin`  | a role plugin breaks the licensing, delivery-context, identity or one-owner-per-skill rules        |
| `npm run check:doc-pointers` | the docs drift from what ships; see below                                                          |
| `npm run check:evals`        | the eval bench's offline self-checks break                                                         |

## Keeping the docs true

`npm run check:doc-pointers` fails CI when:

- a plugin in `marketplace.json` has no `README.md` in its directory, no row in the main
  README's plugin table linking that file, or no install command for it in the main README;
- the plugin table links a plugin the marketplace does not list;
- a skill directory, command file or agent file is not listed in the first column of its
  plugin README's `## Skills`, `## Commands` or `## Agents` table;
- one of those tables lists a skill, command or agent the plugin no longer ships;
- a `claude plugin` command in a README or in this file is not written the same way in
  `docs/team-onboarding.md`;
- a backticked slash command in the docs or in a skill resolves to nothing the plugins ship.

So when you add, rename or remove a skill, command or agent, update its plugin's README in the
same change. When an install step changes, change `docs/team-onboarding.md` first and copy the
command from there.

READMEs are for users: plain words, no ticket keys, no history. History goes in `CHANGELOG.md`.

## Adding a role plugin

Scaffold it from `templates/role-plugin/` and follow `templates/role-plugin.md`. Copying a
sibling plugin instead is how conventions drift. Register it in `marketplace.json`, give it a row
in the main README's plugin table and fill in its `README.md`.

## Evals

`evals/` scores the parts of the plugin whose behaviour is decided by prose: the Stop judge
prompt, the injected pointers, the skills. A round makes real `claude -p` calls and is run by
hand:

```bash
python3 evals/run.py --list
```

The offline self-checks make no model calls and run in `test:all` as `npm run check:evals`.

## Commits and pull requests

[Conventional Commits](https://www.conventionalcommits.org/) with a lowercase subject, enforced
by commitlint on commit. Open a pull request against `main`; CI runs lint, format, the guards
and the tests on Linux and Windows, plus the hook smoke tests on the Node.js version
`package.json` declares as the floor.

## Releasing

1. Bump each changed plugin's version in its `.claude-plugin/plugin.json`. A plugin's
   `plugin.json` is the only place its version lives; Claude Code uses it to decide whether an
   installed copy is stale. Never add a `version` to `marketplace.json`.
2. When `gutt-pro` changes, set the same version in `package.json`. `npm run check:version`
   enforces it.
3. Move the `[Unreleased]` notes in `CHANGELOG.md` under the new version and date.
4. After the release is merged, tag it on `main` as `v<version>` of `gutt-pro`.

Users get the release on `claude plugin marketplace update gutt-plugins`, or on their next
install with the full `name@marketplace` spelling.
