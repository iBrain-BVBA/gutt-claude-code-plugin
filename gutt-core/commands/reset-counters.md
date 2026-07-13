---
description: "Reset GUTT HUD counters (memoryQueries, lessonsCaptured) to zero"
---

# Reset GUTT Counters

Reset all GUTT HUD counters to zero for this session.

## What Gets Reset

| Counter          | Description                                    |
| ---------------- | ---------------------------------------------- |
| memoryQueries    | Number of GUTT memory searches → 0             |
| lessonsCaptured  | Number of lessons stored → 0                   |
| connectionStatus | Reset to "unknown" (updates on next operation) |

## Implementation

Call the `resetCounters()` function from `hooks/lib/session-state.cjs`:

```javascript
const { resetCounters } = require("./hooks/lib/session-state.cjs");
const newState = resetCounters();
```

Then report success:

```
✅ GUTT counters reset!

| Counter | Value |
|---------|-------|
| memoryQueries | 0 |
| lessonsCaptured | 0 |
| connectionStatus | unknown |
| lastReset | [timestamp] |

HUD will update on next statusline refresh.
```
