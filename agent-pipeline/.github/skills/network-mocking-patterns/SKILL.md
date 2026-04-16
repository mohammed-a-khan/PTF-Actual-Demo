---
name: network-mocking-patterns
description: >
  Canonical patterns for network interception and mocking in the
  target test framework. Covers CSNetworkInterceptor, mock rule
  registration, request/response recording, URL blocking,
  throttle profiles, HAR record/replay, passthrough vs intercept
  decisions, and forbidden patterns. Load when generating,
  auditing, or healing code that stubs, records, or throttles
  network traffic.
---

# Network Mocking Patterns

## When this skill applies

Any generated code that intercepts HTTP requests the browser
makes during a test — typically to:
- Stub third-party services (maps, analytics, payment
  processors) for deterministic tests
- Simulate error responses (500, 404, timeout) to exercise
  error paths
- Throttle connections to test slow-network behaviour
- Record network traffic for replay in offline tests
- Block unwanted tracking or telemetry calls

Network interception applies only to requests the BROWSER
makes, not to API calls your test makes via `CSAPIClient`.
Those are direct and uninterceptable.

## The CSNetworkInterceptor singleton

`CSNetworkInterceptor.getInstance()` returns the singleton
interceptor. Initialise it with the current page before
adding rules:

```
import { CSNetworkInterceptor } from '<framework>/network';

const interceptor = CSNetworkInterceptor.getInstance();
await interceptor.initialize(this.browserManager.getPage());
```

The interceptor hooks into the page's request pipeline. Rules
added after initialisation apply to subsequent requests; they
do not retroactively apply to already-loaded resources.

## Mock rule registration

Add a rule via `addMockRule`:

```
interceptor.addMockRule({
    url: /\/api\/payment\//,
    method: 'POST',
    response: {
        status: 200,
        body: { transactionId: 'mock-txn-123', status: 'approved' },
        headers: { 'Content-Type': 'application/json' }
    }
});
```

Rule fields:
- `url` — string (exact match) or RegExp (pattern match) to
  target specific endpoints
- `method` — HTTP method filter (optional; matches all methods
  if omitted)
- `response` — the stubbed response (status, body, headers)
- `delay` — optional delay in ms before responding
- `times` — optional; stub only the first N matching requests
- `condition` — optional predicate function for complex
  filters (inspect query params, request body, etc.)

The response body can be:
- A JavaScript object (serialised to JSON)
- A string (raw body)
- A Buffer (binary content)
- A function that computes the response dynamically from the
  incoming request

### Dynamic response

```
interceptor.addMockRule({
    url: /\/api\/users\/\d+/,
    method: 'GET',
    response: (request) => {
        const match = request.url().match(/\/users\/(\d+)/);
        const userId = match ? match[1] : '0';
        return {
            status: 200,
            body: { id: userId, name: `Mock user ${userId}` }
        };
    }
});
```

Use dynamic responses for endpoints with many variants — one
rule, different outputs per request.

## Removing mock rules

Remove a rule when the test no longer needs it:

```
interceptor.removeMockRule(/\/api\/payment\//);
```

Prefer removing rules explicitly between scenarios over
letting them accumulate. Stale rules from previous scenarios
can mask genuine bugs.

Hook-based cleanup:

```
@CSAfter({ tags: ['@mocks-payment-api'] })
async removePaymentMock(): Promise<void> {
    CSNetworkInterceptor.getInstance()
        .removeMockRule(/\/api\/payment\//);
}
```

## Recording and replay

For tests that need to replay a captured network session, use
the record/stop API:

```
// Start recording
interceptor.startRecording();

// Run the scenario that produces requests
await this.orderPage.loadWithLiveData();

// Stop and inspect
interceptor.stopRecording();
const requests = interceptor.getRecordedRequests();
const responses = interceptor.getRecordedResponses();

// Save or inspect
fs.writeFileSync(
    path.join(resultsDir, 'recorded-traffic.json'),
    JSON.stringify({ requests, responses }, null, 2)
);
```

Use recording for:
- Capturing a known-good session to convert to mock rules
- Debugging network-related flakiness
- Verifying that a scenario makes the expected requests (as
  an assertion layer)

For full HAR record/replay, the framework may expose HAR
utilities via the browser context — check the browser manager
`saveStorageState`/`loadStorageState` pattern or a dedicated
HAR helper.

## URL blocking

To block specific URLs entirely (no response, just dropped):

```
interceptor.blockUrl(/\/analytics\.js$/);
interceptor.blockUrl(/tracker\.example\.test/);
```

Use to:
- Eliminate noise from analytics and tracking pixels
- Prevent tests from hitting third-party services the CI
  environment can't reach
- Simulate a network outage for a specific endpoint

Remove with `unblockUrl` when the test no longer needs the
block.

## Throttle profiles

Simulate slow network conditions with a predefined profile:

```
interceptor.setThrottleProfile('slow-3g');
```

Predefined profiles (generic names, specific rates
framework-defined):
- `offline` — no traffic flows
- `slow-2g`, `fast-2g`
- `slow-3g`, `fast-3g`
- `slow-4g`, `fast-4g`
- `wifi`

Use for performance tests or to verify spinner behaviour on
slow connections. Remove the throttle explicitly at scenario
end — leaked throttle settings slow every subsequent test.

## Passthrough vs intercept

Not every request needs a rule. The interceptor by default
lets unmatched requests pass through to the real network. Add
rules only for:

- Endpoints you're specifically stubbing
- Endpoints you're blocking
- Endpoints you're recording

Leave everything else as passthrough. Never add catch-all
rules that intercept unknown traffic — they introduce silent
behaviour changes.

## When to use mocking

### Good use cases

- Third-party services that are flaky, slow, or cost money
  per call (payment gateways, SMS providers, maps APIs)
- Error paths that are hard to trigger with the real service
  (500 responses, timeouts, rate limits)
- Tests that must run offline (CI environments without
  external network access)
- Deterministic tests that depend on a specific response
  shape (e.g., "the grid shows exactly three items")

### Bad use cases

- Mocking the application's own backend — you lose integration
  coverage, which defeats the purpose of end-to-end testing
- Mocking to speed up tests that are actually slow for
  legitimate reasons (fix the slowness instead)
- Mocking to work around a bug you don't want to file
- Replacing real data fixtures with mocked responses for
  every scenario (fragile, drifts from production behaviour)

## Where to set up mocks

### In a before hook (per scenario)

Use `@CSBefore({ tags: ['@mocks-xxx'] })` for mocks that
apply to specific scenarios. Tag-scoped hooks keep the
mocking intent visible in the feature file:

```
@CSBefore({ tags: ['@mocks-payment-api'] })
async stubPaymentApi(): Promise<void> {
    const interceptor = CSNetworkInterceptor.getInstance();
    await interceptor.initialize(this.browserManager.getPage());
    interceptor.addMockRule({
        url: /\/api\/payment/,
        method: 'POST',
        response: {
            status: 200,
            body: { status: 'approved', transactionId: 'mock-txn' }
        }
    });
}

@CSAfter({ tags: ['@mocks-payment-api'] })
async removePaymentMock(): Promise<void> {
    CSNetworkInterceptor.getInstance()
        .removeMockRule(/\/api\/payment/);
}
```

Feature file:

```
@mocks-payment-api
Scenario: Successful checkout with a mocked payment
  When I complete the checkout flow
  Then I should see the success confirmation
```

### In a helper class

For complex mock setups reused across many scenarios:

```
export class PaymentMockHelper {
    public static async stubSuccess(): Promise<void> {
        const interceptor = CSNetworkInterceptor.getInstance();
        await interceptor.initialize(
            CSBrowserManager.getInstance().getPage());
        interceptor.addMockRule({ /* ... */ });
    }

    public static async stubDecline(): Promise<void> {
        // ... stub with 402 Payment Required
    }

    public static async stubTimeout(): Promise<void> {
        // ... stub with artificial delay
    }

    public static cleanup(): void {
        CSNetworkInterceptor.getInstance()
            .removeMockRule(/\/api\/payment/);
    }
}
```

The step definition calls the helper:

```
@CSBefore({ tags: ['@stub-payment-success'] })
async stubPayment(): Promise<void> {
    await PaymentMockHelper.stubSuccess();
}
```

## Forbidden patterns

Never do any of these in network mocking code:

- Add mocks without tag-scoping or cleanup (they leak across
  scenarios)
- Mock the application's own backend endpoints (lose integration
  coverage)
- Use `page.route(...)` directly — use `CSNetworkInterceptor`
- Use raw `context.on('request', ...)` — use the interceptor
- Hardcode mock response bodies that duplicate production data
  (extract to test data files instead)
- Leave throttle profiles set at scenario end
- Use record mode in production CI (bandwidth cost, flakiness)
- Share recorded traffic files across environments
- Add catch-all rules that intercept unknown URLs
- Use mocking to work around a known flake — fix the flake

## Self-check before returning mocking code

- [ ] Mocks go through `CSNetworkInterceptor`, not raw
      `page.route`
- [ ] Interceptor is initialised with the current page before
      adding rules
- [ ] Every rule has explicit cleanup in a matching
      `@CSAfter` hook or helper cleanup method
- [ ] Tag scoping ties mocks to specific scenarios
- [ ] Mocks target third-party or error-path endpoints, not
      the application's own backend
- [ ] Throttle profiles are removed before scenario end
- [ ] No raw `context.on('request', ...)` or `page.route(...)`
- [ ] No hardcoded response bodies that duplicate production
      data
- [ ] Helpers exist for reused mock setups
- [ ] Tag names on scenarios make the mocking intent obvious
      (`@mocks-payment`, `@stub-payment-success`, etc.)

If any item fails, fix it before returning. The audit checklist
tool enforces most of these rules.
