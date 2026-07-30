#!/usr/bin/env python3
"""Finished turns, each with the fired verdict that lands on top of it.

Every case is a turn that has already produced its answer. The model receives that answer as
its own previous message and then the Stop hook's feedback, and what is scored is the
*continuation* — which is the only thing the real defect is visible in.

Two constraints on the cases, both learned from the sibling suites:

**Self-contained, no tools.** Judge calls run with `--allowedTools ""` from a scratch
directory, so a case whose continuation needs a file read draws "please provide more
details" and scores as a style failure that is really a harness failure. Each `answer` below
therefore carries every fact the closing summary could need.

**The answer must be long enough for a verbatim echo to be a temptation.** The story's whole
worry is that "re-emit the answer" collapses into pasting the reply back down. On a
three-line answer that costs nothing and no variant will do it, so the failure the suite
exists to detect would never appear. The answers here run long on purpose.

Fields per case:

  id              short label
  prompt          what the user originally asked
  answer          the assistant's completed reply, before Stop fired
  reason          the judge's fired reason — the payload the platform feeds back
  capture_result  what running the capture returned, as the model would be holding it
  work            terms that only appear if the closing summary is about the *work*
  bookkeeping     terms that appear when the text is about the capture instead
  confident       is the label unarguable? judgement calls are reported separately

`capture_result` is not decoration. It is what gives the reply something to bury the work
*under*, and it is written the way a real dedup-then-write actually reads — near-matches,
ids, a queued-not-verified caveat. A terse "written OK" would leave nothing to be tempted by
and the suite would score every variant the same. See the suite docstring.
"""

SKILL_LINE = "Run the `gutt-claude-code-plugin:memory-capture` skill."


def build():
    return [
        {
            "id": "flaky-test",
            "confident": True,
            "prompt": "The auth integration test fails maybe one run in ten. Can you find out why?",
            "answer": (
                "Found it. `auth.spec.ts:42` fails intermittently because the fixture's "
                "teardown closes the connection pool before the last in-flight request has "
                "drained.\n\n"
                "The sequence: the test issues a token refresh, asserts on the 200, and "
                "returns. Teardown runs immediately and calls `pool.end()`. But the refresh "
                "handler fires a background audit write after it has already responded, so "
                "on a slow run that write is still queued when the pool closes. The retry "
                "wrapper then reconnects, gets a dead socket, and surfaces a 401 — which is "
                "why the failure looks like an auth bug rather than a teardown bug.\n\n"
                "It reproduces about one run in nine on my machine with "
                "`--repeat-each=20`, and every failure has the same signature: a 401 with "
                "no corresponding request in the server log.\n\n"
                "The fix is one line, but it belongs in the fixture rather than the test — "
                "`await pool.drain()` before `pool.end()`. Putting it in the test would fix "
                "this case and leave the other nineteen files sharing the fixture exposed. "
                "I have made that change and the suite passes 40 consecutive runs.\n\n"
                "Three other suites use the same fixture and I have not re-run them."
            ),
            "reason": (
                f"{SKILL_LINE}\n"
                "- Insight: teardown closes pool before background audit write drains"
            ),
            "capture_result": (
                "Dedup pass (search_memory_nodes + search_memory_facts, 'pool teardown "
                "race integration test'): 2 near-matches, neither a duplicate —\n"
                "  - Insight:Flaky-auth-suite-retries (2026-05-14) — about the retry "
                "wrapper, not the pool lifecycle\n"
                "  - Lesson:Close-pools-in-teardown (2026-03-02) — asserts the opposite "
                "ordering and predates the audit write\n"
                "Wrote 1 episode, type Insight, name "
                "'Insight: fixture teardown closes pool before background audit write "
                "drains', group gutt_pro_v2, last_n_episodes=0, previous_episodes=["
                "'a41c…', 'd90b…'].\n"
                "Response: queued. Extraction is asynchronous, so this is enqueued and not "
                "yet confirmed present in the graph."
            ),
            "work": r"teardown|pool|drain|401|fixture|auth\.spec|flak",
            "bookkeeping": r"captur|episode|memory|dedup|graph|Insight:|record(ed|ing)",
        },
        {
            "id": "cache-regression",
            "confident": True,
            "prompt": "Why did the p99 on the search endpoint jump after Tuesday's deploy?",
            "answer": (
                "Tuesday's deploy changed the cache key, and the change silently disabled "
                "caching for logged-in users.\n\n"
                "The key used to be built from the query string alone. The new one appends "
                "the viewer's locale so that translated results are not served across "
                "locales — reasonable on its own. But for authenticated requests the locale "
                "is resolved from the user record, which is loaded lazily, and at "
                "key-construction time it is still `undefined`. So every authenticated "
                "request builds a key ending in `:undefined`, and `undefined` is not "
                "stable across processes — each worker writes its own entry and never reads "
                "anyone else's.\n\n"
                "That gives an effective hit rate near zero for signed-in traffic, which is "
                "about 70% of the endpoint's volume. Anonymous traffic still hits cache "
                "normally, which is why the median barely moved and the p99 doubled.\n\n"
                "The fix is to resolve the locale before building the key, not to drop it "
                "from the key. I have not made the change — it touches the request "
                "middleware and wants a second opinion on where the resolution should sit."
            ),
            "reason": (
                f"{SKILL_LINE}\n"
                "- Insight: lazy locale resolves undefined inside cache key construction"
            ),
            "capture_result": (
                "Dedup pass ('cache key locale authenticated miss rate'): 1 near-match, not "
                "a duplicate —\n"
                "  - Insight:Cache-key-includes-locale (2026-07-21) — records the key change "
                "itself, says nothing about the lazy resolution\n"
                "Wrote 1 episode, type Insight, name 'Insight: lazy locale resolution "
                "yields undefined during cache key construction', group gutt_pro_v2, "
                "last_n_episodes=0, previous_episodes=['7f22…'].\n"
                "Response: queued, not yet verified in the graph."
            ),
            "work": r"cache|locale|p99|hit rate|undefined|key",
            "bookkeeping": r"captur|episode|memory|dedup|graph|Insight:|record(ed|ing)",
        },
        {
            "id": "migration-incident",
            "confident": True,
            "prompt": "The nightly job wrote 40k duplicate rows. What happened?",
            "answer": (
                "The job ran twice and the upsert it relies on cannot deduplicate the rows "
                "it was given.\n\n"
                "Two things had to be true. First, the scheduler retried: the 02:00 run "
                "exceeded its 20-minute deadline, the supervisor killed it at 02:20, and "
                "the retry policy started a fresh run at 02:25 — the first run had already "
                "committed about 40k rows by then. Second, the upsert keys on "
                "`(source_id, imported_at)`, and `imported_at` is set per run rather than "
                "per record, so the retry's rows have a different key and insert cleanly "
                "instead of conflicting.\n\n"
                "So the retry was working as designed and the conflict target was wrong. "
                "Nothing about the data changed; the same import on any other night would "
                "have done this if it had timed out.\n\n"
                "Cleanup: the duplicates are identifiable by `imported_at > 02:25` paired "
                "with an earlier row sharing `source_id`. I have written the delete but not "
                "run it — it wants a backup first, and the table is 200M rows.\n\n"
                "The real fix is to key on `source_id` alone, which needs a migration."
            ),
            "reason": (
                f"{SKILL_LINE}\n"
                "- Incident: retry after timeout duplicated 40k rows\n"
                "- Insight: upsert keyed on per-run timestamp cannot dedupe a retry"
            ),
            "capture_result": (
                "Dedup pass ('nightly import duplicate rows upsert conflict target'): no "
                "near-matches for either subject.\n"
                "Wrote 2 episodes, group gutt_pro_v2, last_n_episodes=0 —\n"
                "  - Incident: nightly import retry after 02:20 timeout wrote ~40k "
                "duplicate rows\n"
                "  - Insight: upsert conflict target (source_id, imported_at) cannot "
                "deduplicate a retry because imported_at is per-run\n"
                "Response: both queued. Verification search returned 0 of 2 so far, which at "
                "this delay means not-yet-processed rather than lost."
            ),
            "work": r"upsert|retry|source_id|imported_at|duplicat|40k|timeout",
            "bookkeeping": r"captur|episode|memory|dedup(?!upe)|graph|Insight:|Incident:|record(ed|ing)",
        },
        {
            # A turn whose answer is a recommendation rather than a fix. Included because
            # "what was delivered" is easy to write about a code change and awkward about
            # advice, and a wording that only works on the former would score well on the
            # three cases above and fail in practice.
            "id": "advice-turn",
            "confident": False,
            "prompt": "Should we put the rate limiter in the gateway or in the service?",
            "answer": (
                "Gateway, with one exception.\n\n"
                "The argument for the gateway is that a limiter exists to stop work before "
                "it costs anything. In the service, a rejected request has already paid for "
                "TLS, routing, deserialization and usually a connection from the pool — so "
                "under exactly the load the limiter is for, the limiter is part of the "
                "problem. The gateway also sees all traffic for a tenant, where each "
                "service instance sees a shard of it, so per-tenant quotas in the service "
                "are approximations that drift as you scale out.\n\n"
                "The argument against is that the gateway does not know what a request "
                "costs. A cheap read and a report generation both look like one request.\n\n"
                "So: coarse per-tenant limits at the gateway, and a cost-based limit in the "
                "service only for the handful of endpoints where one request can consume "
                "seconds of CPU. Two mechanisms, deliberately, rather than one that has to "
                "be both cheap and cost-aware.\n\n"
                "What I would not do is start with the service and move it later. The "
                "gateway config is the easy half; the hard half is deciding the quotas, and "
                "that work transfers either way."
            ),
            "reason": (
                f"{SKILL_LINE}\n"
                "- Insight: gateway limiter cannot see per-request cost, service one cannot see tenant total"
            ),
            "capture_result": (
                "Dedup pass ('rate limiter placement gateway service tenant quota'): 1 "
                "near-match, not a duplicate —\n"
                "  - Decision:Gateway-owns-ingress (2026-01-30) — about TLS termination and "
                "routing, does not reach limiting\n"
                "Wrote 1 episode, type Insight, name 'Insight: a gateway limiter cannot see "
                "per-request cost and a service limiter cannot see the tenant total', group "
                "gutt_pro_v2, last_n_episodes=0, previous_episodes=['c17e…'].\n"
                "Response: queued, not yet verified."
            ),
            "work": r"gateway|limiter|tenant|quota|per-request cost|coarse",
            "bookkeeping": r"captur|episode|memory|dedup|graph|Insight:|record(ed|ing)",
        },
    ]
