# Lint and Test Command

`/lint-test` - Run linting and tests before committing.

## Usage

```
/lint-test
/lint-test --fix    # Auto-fix lint issues
/lint-test --watch  # Watch mode for tests
```

## Workflow

### Step 1: Check Memory for Project Standards

```python
search_memory_nodes(query="coding standards linting", entity="WorkingAgreement", max_nodes=5)
```

### Step 2: Run Linting

**Python:**

```bash
# Format check
black --check src/ tests/

# Lint
flake8 src/ tests/

# Type check
mypy src/
```

**TypeScript/JavaScript:**

```bash
# Lint
npm run lint

# Type check (TypeScript)
npm run typecheck
```

### Step 3: Run Tests

**Python:**

```bash
pytest tests/ -v --tb=short
```

**TypeScript/JavaScript:**

```bash
npm test
```

### Step 4: Report Results

```
## Lint & Test Results

### Linting
- Formatter: PASS (or X files need formatting)
- Linter: PASS (or X issues found)
- Type check: PASS (or X type errors)

### Tests
- Total: X tests
- Passed: X
- Failed: X
- Skipped: X

### Verdict: READY TO COMMIT / NEEDS FIXES
```

## Auto-Fix Mode (`--fix`)

```bash
# Python
black src/ tests/
isort src/ tests/

# JavaScript/TypeScript
npm run lint -- --fix
```

## Default Commands by Language

| Language   | Lint                                    | Test            |
| ---------- | --------------------------------------- | --------------- |
| Python     | `black --check . && flake8 . && mypy .` | `pytest -v`     |
| TypeScript | `npm run lint && npm run typecheck`     | `npm test`      |
| JavaScript | `npm run lint`                          | `npm test`      |
| Go         | `go fmt ./... && go vet ./...`          | `go test ./...` |

## Pre-Commit Integration

If `.pre-commit-config.yaml` exists, run:

```bash
pre-commit run --all-files
```

## Exit Codes

- `0` - All checks pass, ready to commit
- `1` - Lint or test failures, needs fixes
