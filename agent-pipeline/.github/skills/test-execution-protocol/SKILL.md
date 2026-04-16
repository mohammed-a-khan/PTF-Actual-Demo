---
name: test-execution-protocol
description: >
  Canonical protocol for invoking the project's test runner via
  run_in_terminal, interpreting stdout/stderr/exit codes,
  classifying failures by severity (LOW / MEDIUM / HIGH),
  locating run artifacts on disk, and routing results through
  the healing loop. Load when executing generated tests and when
  interpreting validation report status.
---

# Test Execution Protocol

## When this skill applies

The healer agent uses this skill to execute generated tests and
interpret results. The protocol defines how to invoke the
project's test runner through Copilot's `run_in_terminal` tool,
how to read its output, how to classify failures, and how to
feed failure information back into the healing loop.

There is no dedicated MCP test-runner tool. The project's own
test runner CLI (e.g., `npx eeeeeeeeee-playwright-test`) is invoked
directly via `run_in_terminal`, and its stdout / stderr / exit
code plus any result files it produces on disk become the
healer's input.

## Invocation via run_in_terminal

The healer calls `run_in_terminal` with a command of this shape:

```
npx eeeeeeeeee-playwright-test --project=<project> --features=<path> --env=<env>
```

Typical options the runner accepts (read the project's runner
documentation for the authoritative list):

- `--project=<name>` — selects the test project under `test/<name>/`
- `--features=<path>` — feature file, directory, or glob
- `--tags="@smoke and @orders"` — tag expression filter
- `--env=<name>` — environment name (`dev`, `sit`, `uat`)
- `--headed` — visible browser (default headless)
- `--scenarios="<exact name>"` — run specific scenarios only
- `--timeout=<ms>` — override per-scenario timeout

## What the healer captures

From the `run_in_terminal` call:

- **Exit code** — `0` means all scenarios passed, non-zero
  indicates failures or infrastructure problems.
- **stdout** — human-readable scenario-by-scenario status
  printed by the runner.
- **stderr** — error output and stack traces.

From the project filesystem (read after the run completes, via
`read_file` / `file_search`):

- **JSON report** — most runners write a structured report (the
  path is runner-specific; common locations are
  `results/report.json`, `test-results/results.json`). Parse this
  for per-scenario details.
- **Screenshots** — typically under `results/screenshots/`
- **Traces** — typically under `results/traces/`
- **Videos** — typically under `results/videos/`
- **Logs** — typically under `results/logs/`

The healer extracts scenario names, pass/fail status, error
messages, and stack traces from the JSON report when available.
If no structured report is emitted, the healer parses the stdout
lines for scenario-by-scenario results.

## Example invocations

### Full suite run

```
npx eeeeeeeeee-playwright-test --project=<project> --features=test/<project>/features/ --env=<env>
```

Set a longer timeout for full-suite runs (e.g., `--timeout=1800000`
for 30 minutes) if the suite is large.

### Single feature run

```
npx eeeeeeeeee-playwright-test --project=<project> --features=test/<project>/features/user-login.feature --env=<env>
```

### Tag-filtered run

```
npx eeeeeeeeee-playwright-test --project=<project> --features=test/<project>/features/ --tags="@smoke and @orders" --env=<env>
```

### Re-run only failing scenarios

After a heal cycle, rerun only the previously failing scenarios,
not the whole suite. Most runners support filtering by scenario
name or by test ID tag:

```
npx eeeeeeeeee-playwright-test --project=<project> --scenarios="Login as admin" --env=<env>
```

This is much faster than re-running the whole suite and gives
immediate feedback on whether the heal worked.

## Interpreting exit codes

- `0` — all scenarios passed
- `1` — at least one scenario failed
- `2` — test runner error (config problem, no tests found,
  compilation error)
- `3` — environment error (browser launch failure, DB
  connection failure)
- Other non-zero — framework or runner crash

The healer treats exit codes 2 and 3 as HIGH-risk escalations
— they're not typical test failures; they're infrastructure
problems that need human attention.

## Failure classification

For every failed scenario, classify the failure by category
before deciding whether to heal or escalate.

### LOW-risk failures (auto-heal with high confidence)

- **Locator drift** — element not found, but a similar element
  exists at the same logical location in the accessibility
  tree. Fix: replace the stale locator with a role-based
  selector from the live tree.
- **Timing flake** — element found after a retry, or a wait
  that resolved slowly. Fix: increase timeout or wait for a
  more specific state.
- **Import path typo** — a module doesn't resolve but the
  correct path is obvious. Fix: correct the import path.
- **Minor typo** — a generated string literal has a
  one-character mistake. Fix: correct the literal.

### MEDIUM-risk failures (auto-heal with caution)

- **Missing step definition** — a feature step has no matching
  step def. Fix: generate the missing step or update the
  feature to use an existing step's phrase.
- **Wrong assertion verb** — expected `assertVisible` but the
  element is disabled, or vice versa. Fix: change the verb to
  match the live state if the canonical spec agrees.
- **Data shape mismatch** — a scenario expects a field the
  data file doesn't provide. Fix: add the field or update the
  feature.
- **Locator type confusion** — a button is actually a link, or
  vice versa. Fix: update the element declaration.
- **Test data missing** — expected row not found in the
  database. Fix: add the row in a `@CSBefore` hook.

### HIGH-risk failures (escalate, do not retry)

- **Test design flaw** — the test expects behaviour the
  application does not provide
- **Application unreachable** — the UI is down, the DB is
  unreachable, auth is broken
- **Missing business context** — the legacy source referred
  to state that isn't in the canonical spec
- **Persistent failure** — same failure after three heal
  cycles
- **Cascade failure** — a heal fix broke previously passing
  scenarios
- **Security or authorisation failure** — test cannot run
  because credentials are missing or expired
- **Infrastructure error** — browser launch failed, DB
  connection refused, certificate expired

Classification is deterministic. If you can't confidently
classify a failure as LOW or MEDIUM, treat it as HIGH.

## Error category signatures

The classification step looks at the error message and stack
to decide category. Common signatures:

- `locator.waitForSelector: Timeout 15000ms exceeded` →
  locator drift (LOW) or page structure change (MEDIUM)
- `Expected: true Received: false` on an `assertVisible` →
  wrong assertion verb (MEDIUM) or element missing (LOW)
- `No step definition found for: ...` → missing step def
  (MEDIUM)
- `Cannot find module ...` → import path typo (LOW)
- `TypeError: undefined is not a function` → API mismatch
  (MEDIUM)
- `Connection refused` on DB → infrastructure (HIGH)
- `Navigation timeout exceeded` → app unreachable (HIGH)
- `401 Unauthorized` on API → auth problem (HIGH)

The healer's classification logic consults these signatures
first. If none match, fall back to MEDIUM and let the
generic heal path attempt a fix.

## Capturing and using artifacts

Every run produces artifacts. Use them during healing:

- **Screenshots** — for failed scenarios, read the failure
  screenshot via `read_file` and include the path in the
  entry in `.agent-runs/correction-patterns.md`. Future runs
  can show the visual context.
- **Traces** — Playwright trace files contain the full action
  sequence. Useful for debugging cascade failures but too
  large to send through the agent loop directly. Log the path
  in the validation report.
- **Videos** — only if `BROWSER_VIDEO_ENABLED=true`. Same
  rules as traces: log the path, don't stream the content.
- **Logs** — the JSON run log has one entry per step with
  timestamps and status. Parse for diagnostic context.

## Heal retry protocol

The healer's retry loop:

1. Run the failing scenarios only
2. Parse the results
3. For each still-failing scenario:
   a. Classify the error
   b. If LOW or MEDIUM, query memory for prior fixes
   c. Apply the fix
   d. Record the attempt in the validation report
4. Re-run the failing scenarios
5. If new failures appeared from the fix (cascade), revert
   the fix and try a different approach
6. If all previously failing scenarios now pass, move to the
   final full-suite run
7. If after three heal cycles the same scenarios are still
   failing, escalate as HIGH-risk

## Run cascade handling

After applying a fix and re-running, check whether any
scenarios that previously passed are now failing. If yes:

- The fix introduced a regression
- Revert the fix
- Record the failed fix attempt in the validation report with
  category `cascade-failure`
- Try a more conservative fix (a different memory hit, or
  leave the element alone and use an `alternativeLocators`
  fallback instead of replacing the primary)

Cascade handling is what makes the healer safe. Without it,
aggressive fixing breaks tests that were fine.

## When to run the full suite

- After the healer believes all failures are resolved, run
  the full suite one final time to confirm no cascade
- Before the healer declares the run green and returns the
  validation report to the planner (the final verification)
- NOT during the heal retry loop — re-run only failing
  scenarios during heals for speed

## Reporting requirements

Every run produces a validation report entry:

```
{
    run_id: string,
    test_path: string,
    started_at: ISO8601,
    duration: number,
    total_scenarios: number,
    passed: number,
    failed: number,
    skipped: number,
    failures: [
        {
            scenario: string,
            category: string,
            message: string,
            stack: string,
            screenshot_path: string,
            heal_attempted: boolean,
            heal_succeeded: boolean
        }
    ]
}
```

## Forbidden practices

Never do any of these in test execution code:

- Claim a test passed without an actual green exit code from
  the project's test runner via `run_in_terminal`
- Re-run the full suite during a heal cycle (slow and wasteful)
- Retry a HIGH-risk failure
- Mark a scenario passed because it was skipped
- Swallow a test runner error (exit code 2 or 3) as a test
  failure
- Apply a fix without re-running to verify
- Record a memory pattern for a fix that didn't verify green
- Skip the final full-suite run before declaring the run green
