---
name: api-testing-patterns
description: >
  Canonical patterns for API testing in the target test framework.
  Covers CSAPIClient instantiation and methods (get, post, put,
  patch, delete, head, options, builder), authentication types
  (basic, bearer, api-key, oauth2, jwt, certificate, custom),
  request building, response validation, retry policy, SOAP
  separation via CSSoapClient, and forbidden patterns. Load when
  generating, auditing, or healing any code that calls a REST or
  SOAP service.
---

# API Testing Patterns

## When this skill applies

Any generated code that calls a REST or SOAP service — typically
step definitions for API-only tests, helper methods that fetch
expected data from an upstream service, or test setup that
seeds state via an API instead of the database.

## The CSAPIClient class

`CSAPIClient` is the framework's HTTP client. Instantiate per
test or per helper, configure with a base URL and authentication,
then call REST verb methods.

```
import { CSAPIClient } from '<framework>/api';

const client = new CSAPIClient({
    baseUrl: this.config.getString('API_BASE_URL'),
    timeout: this.config.getNumber('API_REQUEST_TIMEOUT', 30000),
});
```

Configuration options at construction:

- `baseUrl` — base URL for relative paths
- `timeout` — request timeout in ms
- `defaultHeaders` — headers applied to every request
- `auth` — authentication configuration (see below)
- `retryPolicy` — retry rules (see below)
- `proxy` — proxy server settings if needed

## REST verb methods

All methods are async and return `Promise<CSResponse<T>>`.

```
const response = await client.get<UserRecord>('/users/123');
const created = await client.post<UserRecord>('/users', userBody);
const updated = await client.put<UserRecord>('/users/123', updatedBody);
const patched = await client.patch<UserRecord>('/users/123', { status: 'active' });
const deleted = await client.delete('/users/123');
const headers = await client.head('/users/123');
const allowed = await client.options('/users');
```

Each verb method takes:

- `url` — relative path (combined with `baseUrl`) or absolute URL
- `body` — request body for POST/PUT/PATCH (object, string, or
  Buffer)
- `options` — per-request overrides (headers, query, timeout,
  auth)

The type parameter `T` is the expected response body shape.
Define an interface in the same file as the helper that uses
the API.

## CSResponse shape

The returned `CSResponse<T>` object has:

- `status` — HTTP status code (number)
- `statusText` — HTTP status text
- `headers` — response headers (object)
- `body` — parsed response body, typed as `T`
- `raw` — raw response body string
- `duration` — request duration in ms

```
const response = await client.get<UserRecord>('/users/123');
if (response.status === 200) {
    const user: UserRecord = response.body;
    CSReporter.info(`Found user: ${user.email}`);
}
```

Always check the status before assuming the body is the success
shape. For not-found cases, the body may carry an error envelope
instead of the expected type.

## Builder pattern for complex requests

For requests with many headers, query parameters, or body
transformations, use the builder API:

```
const response = await client.builder('/orders')
    .header('Content-Type', 'application/json')
    .header('X-Request-Id', requestId)
    .query('status', 'OPEN')
    .query('limit', 50)
    .auth({ type: 'bearer', token: bearerToken })
    .body(orderBody)
    .timeout(60000)
    .execute<OrderRecord[]>();
```

The builder is fluent — every method returns the builder. Call
`.execute<T>()` to fire the request and get a typed response.

Use the builder when:
- Many headers or query parameters need to be set conditionally
- Per-request auth or timeout differs from the client default
- Building reusable request templates in helpers

Use the direct verb methods (`get`, `post`, etc.) for one-off
calls.

## Authentication types

`CSAPIClient` supports multiple authentication methods via the
`auth` configuration. Each takes a different shape.

### Basic auth

```
const client = new CSAPIClient({
    baseUrl: apiUrl,
    auth: {
        type: 'basic',
        username: this.config.getString('API_USERNAME'),
        password: this.config.getString('API_PASSWORD'),
    },
});
```

### Bearer token

```
auth: {
    type: 'bearer',
    token: bearerToken,
}
```

### API key

```
auth: {
    type: 'apikey',
    key: this.config.getString('API_KEY_PAYMENT'),
    in: 'header', // 'header' | 'query'
    name: 'X-API-Key',
}
```

### OAuth2

```
auth: {
    type: 'oauth2',
    grantType: 'client_credentials',
    tokenUrl: this.config.getString('OAUTH_TOKEN_URL'),
    clientId: this.config.getString('OAUTH_CLIENT_ID'),
    clientSecret: this.config.getString('OAUTH_CLIENT_SECRET'),
    scope: 'read write',
}
```

The framework caches the token until expiry and refreshes
automatically.

### JWT

```
auth: {
    type: 'jwt',
    token: jwtToken,
}
```

### Certificate

```
auth: {
    type: 'certificate',
    certPath: this.config.getString('CLIENT_CERT_PATH'),
    keyPath: this.config.getString('CLIENT_KEY_PATH'),
    passphrase: this.config.getString('CLIENT_KEY_PASSPHRASE'),
}
```

### Custom

For non-standard auth schemes, use `custom` with a function:

```
auth: {
    type: 'custom',
    handler: async (request) => {
        const signature = computeSignature(request);
        request.headers['X-Signature'] = signature;
    },
}
```

## SOAP services — use CSSoapClient

REST APIs use `CSAPIClient`. SOAP services use a separate
`CSSoapClient` class. Never try to call SOAP through
`CSAPIClient` — the request envelope and namespace handling
are different.

```
import { CSSoapClient } from '<framework>/api';

const soapClient = new CSSoapClient({
    wsdlUrl: this.config.getString('SOAP_WSDL_URL'),
    auth: {
        type: 'wsSecurity',
        tokenType: 'UsernameToken',
        username: this.config.getString('SOAP_USERNAME'),
        password: this.config.getString('SOAP_PASSWORD'),
    },
});

const response = await soapClient.call(
    'getOrderStatus',
    { orderId: '12345' }
);
```

WS-Security token types supported:
- `UsernameToken`
- `BinarySecurityToken`
- `SAMLAssertion`
- `Timestamp`
- `Signature`

## Retry policy

For flaky upstream services, configure retries at client
construction:

```
const client = new CSAPIClient({
    baseUrl: apiUrl,
    retryPolicy: {
        maxAttempts: 3,
        retryOn: [429, 500, 502, 503, 504],
        backoff: 'exponential',
        initialDelay: 1000,
    },
});
```

Options:
- `maxAttempts` — total attempts including the first try
- `retryOn` — array of status codes that trigger a retry
- `backoff` — `'fixed'`, `'linear'`, or `'exponential'`
- `initialDelay` — first retry delay in ms
- `maxDelay` — cap on exponential backoff in ms

Per-request retry override is supported via the builder:

```
.retry({ maxAttempts: 5 })
```

## Response validation

After the call, validate the response shape and content:

```
const response = await client.get<OrderRecord>('/orders/123');

await CSAssert.getInstance().assertEqual(response.status, 200,
    'Order GET should return 200');
await CSAssert.getInstance().assertNotNull(response.body,
    'Response body should not be null');
await CSAssert.getInstance().assertEqual(response.body.orderId, '123',
    'Returned order ID should match the requested ID');
```

For complex schema validation, use a JSON Schema validator
helper or the framework's response parser if exposed.

## Where to call the API client from

### Step definitions

The most common location for API tests:

```
@When('I create an order via the API with payload {string}')
async createOrderViaApi(payloadKey: string): Promise<void> {
    const payload = TestDataHelper.getOrderPayload(payloadKey);
    const response = await this.apiClient.post<OrderRecord>(
        '/orders', payload);
    this.context.set('createdOrderId', response.body.orderId);
    CSReporter.info(`Created order ${response.body.orderId} via API`);
}
```

### Helpers

For API operations reused across many step definitions, extract
into a helper class:

```
export class OrderApiHelper {
    private static client = new CSAPIClient({
        baseUrl: CSConfigurationManager.getInstance()
            .getString('API_BASE_URL'),
        auth: {
            type: 'bearer',
            token: CSConfigurationManager.getInstance()
                .getString('API_BEARER_TOKEN'),
        },
    });

    public static async createOrder(payload: OrderPayload): Promise<OrderRecord> {
        const response = await this.client.post<OrderRecord>(
            '/orders', payload);
        if (response.status !== 201) {
            throw new Error(`Create order failed: ${response.status}`);
        }
        return response.body;
    }
}
```

### NEVER from page objects

Page objects are for DOM interaction only. They never make HTTP
calls. The audit rejects any page object that imports
`CSAPIClient`.

## Authentication refresh

When the API uses short-lived tokens, the framework's OAuth2
support handles refresh automatically. For manual token
refresh:

```
await client.refreshAuth();
```

Use this when your test simulates a token expiry scenario.

## Forbidden patterns

Never do any of these in API code:

- Hardcode API URLs, credentials, tokens, or API keys
- Call APIs from inside a page object class
- Use Node's `fetch`, `http`, or `https` modules directly —
  always go through `CSAPIClient`
- Call SOAP services through `CSAPIClient` — use `CSSoapClient`
- Build request bodies via string concatenation — pass an object
- Disable TLS verification (no `rejectUnauthorized: false` for
  production endpoints)
- Skip status code checks before reading response body
- Catch and swallow API errors silently
- Hardcode timeouts — resolve from config
- Share auth tokens across users by storing in module state
- Use `console.log` for request/response logging — the framework
  reporter handles it

## Self-check before returning API code

- [ ] Every API call uses `CSAPIClient` (REST) or `CSSoapClient`
      (SOAP)
- [ ] Base URL, credentials, and tokens come from config
- [ ] Response status is checked before reading the body
- [ ] Response body is typed via the generic parameter
- [ ] Errors are reported and rethrown, not swallowed
- [ ] API calls live in step definitions or helpers, never in
      page objects
- [ ] Auth type matches the API's actual auth scheme
- [ ] Retry policy is configured for known-flaky upstreams
- [ ] No hardcoded URLs, credentials, or tokens
- [ ] No raw Node HTTP modules used
- [ ] No string-concatenated JSON request bodies

If any item fails, fix it before returning. The audit checklist
tool enforces most of these rules.
