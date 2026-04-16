---
name: reporting-logging-patterns
description: >
  Canonical patterns for reporting and logging in the target test
  framework. Covers CSReporter static methods (info, warn, debug,
  error, pass, fail), step tracking (startStep, endStep,
  startBDDStep, endBDDStep), feature and scenario lifecycle,
  screenshot attachment, custom data attachments, log level
  discipline, and forbidden patterns. Load when generating,
  auditing, or healing any code that logs or reports.
---

# Reporting and Logging Patterns

## When this skill applies

Any generated code that produces output, logs progress, or
attaches evidence to the test report. Covers step definitions,
page objects, helpers, and hooks. This skill is the canonical
reference for which `CSReporter` method to call at each layer.

## The CSReporter class

`CSReporter` is a STATIC class. Every method is called as
`CSReporter.<method>(...)`. There is no `getInstance()`, no
constructor, no instance state visible to test code.

```
import { CSReporter } from '<framework>/reporter';

CSReporter.info('Starting the test step');
CSReporter.pass('Step completed successfully');
```

The reporter routes output to:
- The HTML report (one entry per call)
- The console (if console output is enabled)
- The JSON run log
- The AI failure-analysis pipeline (for failures)
- The screenshot collector (for errors and failures)

A direct `console.log` call bypasses all of this. Never use
`console.log`, `console.error`, `console.warn`, or any other
raw logger in generated code. The audit rejects files that
import `console` or call any of its methods.

## Log level methods

### info — informational

```
CSReporter.info('Navigating to the login page');
CSReporter.info(`Searching for order ${orderId}`);
```

Use for:
- Start of a logical action
- Progress markers in multi-step flows
- Informational values (counts, IDs, filenames) that help
  diagnose failures

Info messages appear in the default run log. They're visible
to anyone reading the report.

### pass — explicit success

```
CSReporter.pass(`Logged in as ${username}`);
CSReporter.pass('All 12 verification checks passed');
```

Use for:
- End of a logical action that completed successfully
- Aggregate success reports (e.g., after running many
  assertions)

Pass messages are highlighted in green in the HTML report and
count toward the pass rate.

### debug — verbose diagnostic

```
CSReporter.debug(`Resolved config value: ${resolved}`);
CSReporter.debug(`Found ${rows.length} rows matching filter`);
```

Use for:
- Intermediate values useful only when debugging
- Helper-internal steps that are not user-facing
- Framework-level details

Debug messages appear only when debug mode is enabled (via
`DEBUG=true` in config or `--debug` command-line flag).

### warn — non-fatal issue

```
CSReporter.warn('Slow DB response: ' + duration + 'ms');
CSReporter.warn('Falling back to secondary locator for element');
```

Use for:
- Performance outliers that don't fail the test
- Fallback paths that succeeded but indicate drift
- Retry events

Warn messages appear in yellow in the HTML report.

### error — error that doesn't stop execution

```
CSReporter.error(`Failed to fetch user ${userId}: ${err.message}`);
```

Use for:
- Catchable errors where the test continues (e.g., cleanup
  failures in after hooks)
- Errors you log before rethrowing

Error messages appear in red in the HTML report and are
aggregated in the run summary.

### fail — terminal failure

```
CSReporter.fail('Expected user to exist but was null');
```

Use for:
- Final failure statement before throwing
- Assertion failures caught by try/catch that decide to report
  and rethrow

Fail messages terminate the current step as failed and trigger
screenshot capture (if configured).

## Step tracking

For pure step definitions (those decorated with
`@CSBDDStepDef` / `@When` / `@Then` / etc.), the framework
automatically starts and ends the step around the method. You
don't call `startStep` / `endStep` manually.

For nested operations inside a step — where you want the
report to show sub-steps — use manual step tracking:

```
@When('I run the full order creation flow')
async runFullOrderFlow(): Promise<void> {
    CSReporter.startStep('Create customer');
    const customerId = await CustomerApiHelper.create(profile);
    CSReporter.endStep('pass');

    CSReporter.startStep('Create order');
    const orderId = await OrderApiHelper.create(customerId, items);
    CSReporter.endStep('pass');

    CSReporter.startStep('Submit order');
    await OrderApiHelper.submit(orderId);
    CSReporter.endStep('pass');

    this.context.set('createdOrderId', orderId);
}
```

Manual step tracking exposes a tree structure in the HTML
report, making long flows easier to read.

Methods:
- `CSReporter.startStep(name)` — begin a sub-step
- `CSReporter.endStep(status)` — end the current sub-step
  (`'pass'` / `'fail'` / `'skip'`)
- `CSReporter.passStep(duration?)` — shortcut for successful
  end
- `CSReporter.failStep(error, duration?)` — shortcut for failed
  end with error message
- `CSReporter.skipStep()` — mark as skipped

## Feature and scenario lifecycle

The framework handles feature and scenario lifecycle
automatically via the BDD runner. You do NOT call `startFeature`
/ `endFeature` / `startScenario` / `endScenario` manually in
normal test code. They exist for custom runners only.

## Screenshots

Screenshots are captured automatically when:
- A test fails (configured via `BROWSER_SCREENSHOT_ON_FAILURE`)
- An assertion in `assertWithScreenshot` fails
- A page object method explicitly calls `this.takeScreenshot(...)`

For on-demand screenshots inside a test:

```
// On the page object (full page)
await this.takeScreenshot('after-login');

// On an element (just that element)
const buffer = await this.buttonSubmit.screenshot();
```

Screenshots taken via the framework are automatically attached
to the current step in the report. Never use `page.screenshot(...)`
directly — the raw call doesn't attach to the report.

## Custom data attachments

For attaching structured data to the report (API responses,
database query results, JSON payloads), use the framework's
attach helpers if exposed. Otherwise log the data as a JSON
string at debug or info level:

```
CSReporter.debug(`API response: ${JSON.stringify(response.body, null, 2)}`);
```

For large attachments (files, long JSON), save them to the
test results directory and log the path:

```
const artifactPath = path.join(
    this.config.getString('RESULTS_DIR'),
    `response-${orderId}.json`
);
fs.writeFileSync(artifactPath, JSON.stringify(response.body, null, 2));
CSReporter.info(`Response saved to: ${artifactPath}`);
```

## Secret masking

The framework's `CSSecretMasker` automatically masks values in
log output whose key or surrounding context matches common
secret patterns:

- `*password*`
- `*secret*`
- `*token*`
- `*apikey*` / `*api_key*`
- `*privateKey*`

You don't need to manually mask these — the reporter handles
it. But don't defeat the mask by logging the raw value through
string concatenation:

```
// Risky — the mask may not catch the value
CSReporter.info(`User token: ${token}`);

// Safer — rely on key-based masking
CSReporter.info('User authenticated', { token });
```

When in doubt, don't log the value at all. Log that the
operation succeeded and skip the value.

## Logging discipline by layer

Different code layers log at different levels to keep the
report readable:

- **Step definitions** — `info` at the start of a step action,
  `pass` at the end. One of each per logical step.
- **Page objects** — `info` once per business action (not once
  per click / fill). Detailed element interactions are the
  framework's responsibility.
- **Helpers** — mostly `debug`, with `info` only for operations
  that materially change state (created, deleted, uploaded).
- **Hooks** — `info` at the start, `pass` at the end for hooks
  that run per scenario.
- **Assertions** — never log; `CSAssert` handles its own
  reporting. Logging around an assertion just duplicates output.

## Report output locations

The framework writes to:
- `REPORTER_OUTPUT_DIR` — HTML and JSON report root (default:
  `./results`)
- `REPORTER_SCREENSHOT_PATH` — screenshot directory
- `REPORTER_TRACE_PATH` — Playwright trace files
- `REPORTER_VIDEO_PATH` — video recordings

These are resolved from config at framework initialisation.
Test code never writes directly to these directories — it
calls `CSReporter` methods and lets the framework route.

## Forbidden patterns

Never do any of these in reporting code:

- Use `console.log`, `console.error`, `console.warn`,
  `console.info`, `console.debug`, or `console.trace`
- Import `debug` or any third-party logger
- Use raw `page.screenshot(...)` — use
  `this.takeScreenshot(...)` from `CSBasePage` or
  `element.screenshot(...)`
- Log raw secret values (passwords, tokens, keys)
- Log huge payloads inline — save to file and log the path
- Call `startStep` / `endStep` inside a step method that's
  already a BDD step (the framework wraps it automatically)
- Call `startFeature` / `endFeature` / `startScenario` /
  `endScenario` manually in test code
- Use `CSReporter.info` for every element interaction — once
  per logical action is enough
- Use `CSReporter.fail` without throwing afterwards — fail
  implies terminal failure, not a hint
- Log the same message at two levels (e.g., info AND debug)

## Self-check before returning reporter code

- [ ] No `console.*` calls anywhere
- [ ] No third-party logger imports
- [ ] `CSReporter` methods used at the right level for each
      layer
- [ ] `info` at step start, `pass` at step end (one each per
      logical action)
- [ ] `debug` for helper-internal steps, not visible by default
- [ ] `warn` for non-fatal drift or retries
- [ ] `error` for catchable errors before rethrowing
- [ ] `fail` only immediately before a throw
- [ ] Screenshots via `takeScreenshot` or element `screenshot`,
      never raw `page.screenshot`
- [ ] No raw secret values logged
- [ ] No manual `startFeature` / `endFeature` / `startScenario`
- [ ] No duplicate messages at multiple levels

If any item fails, fix it before returning. The audit checklist
tool enforces most of these rules.
