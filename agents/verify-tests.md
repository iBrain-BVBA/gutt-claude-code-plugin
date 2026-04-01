---
name: verify-tests
description: Run after code implementation to verify tests pass and coverage is adequate
model: sonnet
---

# Verify Tests Agent

Run after any code implementation to verify tests pass and coverage is adequate.

## Trigger

Invoke this agent after:

- Implementing a new feature
- Fixing a bug
- Refactoring code
- Before creating a PR

## Workflow

### Step 1: Run Existing Tests

```bash
# Node.js / TypeScript (primary)
npm test

# Python (if applicable)
pytest tests/ -v --tb=short
```

### Step 2: Check Test Coverage

```bash
# Node.js / TypeScript
npm run test:coverage

# Python (if applicable)
pytest tests/ --cov=src --cov-report=term-missing
```

### Step 3: Verify New Code Has Tests

- If new functions/classes added, check corresponding test files exist
- If tests missing, create them or flag to user

### Step 4: Report Findings

Produce a structured report (see Output Format below).

## Memory Integration

### Before Work

```python
# Search for testing patterns and standards
mcp__claude_ai_gutt-pro-memory__search_memory_nodes(query="testing patterns [component]", entity="WorkingAgreement", max_nodes=5)

# Fetch lessons from previous test runs
mcp__claude_ai_gutt-pro-memory__fetch_lessons_learned(query="testing patterns [component]", max_results=5)
```

### After Work

After significant test failures or new testing patterns:

```python
mcp__claude_ai_gutt-pro-memory__add_memory(
    name="Test Pattern: [brief description]",
    episode_body="Test [name] failed due to [reason]. Fix: [solution]. Component: [component]. Prevention: [advice].",
    source="text",
    source_description="test verification"
)
```

## Default Commands

```bash
# Node.js / TypeScript (primary)
npm test
npm run test:coverage

# Python (if applicable)
pytest tests/ -v
pytest tests/ --cov=src --cov-report=term-missing
```

## Output Format

```markdown
## Test Verification Report

### Test Results

- Total: [N] tests
- Passed: [N]
- Failed: [N]
- Skipped: [N]

### Coverage

- Overall: [X]%
- Threshold: 80%
- Status: ABOVE / BELOW threshold

### Missing Tests

- [file/function] - No corresponding test file

### Failing Tests

- [test name] - [failure reason]

### Verdict: PASS / FAIL
```

## Exit Criteria

- All tests pass
- No regressions introduced
- New code has corresponding tests (or explicit exemption noted)

## Example Invocation

```
Task(
    subagent_type="verify-tests",
    model="sonnet",
    prompt="Run the test suite for the gutt-claude-code-plugin. Verify all hooks pass their tests, check for missing test coverage, and report any failures."
)
```
