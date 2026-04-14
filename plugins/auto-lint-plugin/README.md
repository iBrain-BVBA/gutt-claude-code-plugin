# auto-lint-plugin

Auto-lints files after Edit/Write operations in Claude Code.

## Supported Languages

- **Python** (.py): `ruff format` + `ruff check --fix`
- **JavaScript/TypeScript** (.js, .ts, .jsx, .tsx): `eslint --fix`

## Requirements

- Linters must be installed and available on PATH
- No gutt dependency — works standalone

## Installation

Install as a Claude Code plugin. The hook triggers on every `Edit` or `Write` tool use.
