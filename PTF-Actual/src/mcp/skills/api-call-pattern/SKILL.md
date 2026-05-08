---
name: api-call-pattern
description: Use when a step or page object makes an HTTP API call (REST, SOAP, JSON, XML). Always go through CSAPIClient — never import axios, fetch, node-fetch, or got directly. Pairs with audit rule API200.
---

# Pattern: API call

## When to use

The scenario verifies a backend state via API, sets up test data via
an admin endpoint, or asserts that a UI action produced the right
HTTP traffic. The framework's `CSAPIClient` wraps Playwright's
`APIRequestContext` plus auth, retry, OAuth, AWS signing, response
validators, and template-variable resolution — all the cross-cutting
concerns that raw `fetch` / `axios` make you reinvent.

## Working example — simple GET / POST

```typescript
import {
    CSBasePage, CSReporter, CSAPIClient, CSValueResolver,
} from '@mdakhan.mak/cs-playwright-test-framework';

export class OrdersApiHelper {
    private static client: CSAPIClient | undefined;

    /** Lazy-init with project base URL from config. */
    private static getClient(): CSAPIClient {
        if (!OrdersApiHelper.client) {
            OrdersApiHelper.client = new CSAPIClient();
            OrdersApiHelper.client.setBaseUrl(
                CSValueResolver.resolve('{config:API_BASE_URL}'),
            );
            OrdersApiHelper.client.setDefaultHeader('Accept', 'application/json');
        }
        return OrdersApiHelper.client;
    }

    public static async getOrderById(orderId: string): Promise<{ id: string; status: string; total: number }> {
        const resp = await OrdersApiHelper.getClient().get<{ id: string; status: string; total: number }>(
            `/orders/${orderId}`,
            { timeout: 30000 },
        );
        if (resp.status !== 200) {
            CSReporter.fail(`GET /orders/${orderId} returned ${resp.status}`);
            throw new Error(`Order fetch failed: ${resp.status}`);
        }
        return resp.body;
    }

    public static async createOrder(payload: { sku: string; quantity: number }): Promise<string> {
        const resp = await OrdersApiHelper.getClient().post<{ id: string }>('/orders', payload, {
            timeout: 30000,
        });
        if (resp.status !== 201) {
            CSReporter.fail(`POST /orders returned ${resp.status}: ${JSON.stringify(resp.body)}`);
            throw new Error(`Order create failed: ${resp.status}`);
        }
        CSReporter.pass(`Created order ${resp.body.id}`);
        return resp.body.id;
    }
}
```

## Working example — fluent builder for complex requests

```typescript
import { CSAPIClient, CSReporter } from '@mdakhan.mak/cs-playwright-test-framework';

const client = new CSAPIClient();
client.setBaseUrl('{config:API_BASE_URL}');

const resp = await client.builder('/payments/search')
    .withMethod('POST')
    .withHeader('Authorization', 'Bearer {input:apiToken}')
    .withQueryParam('page', '1')
    .withQueryParam('pageSize', '50')
    .withJsonBody({ status: 'completed', dateRange: 'last30d' })
    .withTimeout(45000)
    .execute();

if (resp.status === 200) {
    CSReporter.pass(`Found ${resp.body.results.length} payments`);
}
```

## Step definition with response assertion

```typescript
import { CSBDDStepDef, CSReporter, StepDefinitions, Page, CSAPIClient } from '@mdakhan.mak/cs-playwright-test-framework';

@StepDefinitions
export class OrderApiSteps {
    @CSBDDStepDef('the API returns order {string} with status {string}')
    async verifyOrderStatus(orderId: string, expectedStatus: string): Promise<void> {
        const order = await OrdersApiHelper.getOrderById(orderId);
        if (order.status !== expectedStatus) {
            CSReporter.fail(`Order ${orderId} status: expected ${expectedStatus}, got ${order.status}`);
            throw new Error(`Status mismatch`);
        }
        CSReporter.pass(`Order ${orderId} has status ${expectedStatus}`);
    }
}
```

## CSAPIClient cheat sheet

| Need | Call |
|---|---|
| Simple GET / POST / PUT / PATCH / DELETE | `client.get(url)`, `client.post(url, body)`, etc. |
| Fluent builder | `client.builder(url).withMethod(...).withHeader(...).execute()` |
| Default headers | `client.setDefaultHeader('Authorization', '...')` |
| Auth (basic / bearer / OAuth2 / AWS) | `client.setAuth({ type: 'bearer', token })` |
| Proxy | `client.setProxy({ url: 'http://proxy:8080' })` |
| File upload | `client.uploadFile(url, filePath, fieldName)` |
| File download | `client.downloadFile(url, destPath)` |
| Connection test | `await client.testConnection(url, 5000)` |
| Health check | `await client.healthCheck(url, 200)` |
| Variables (template substitution) | `client.setVariable('orderId', '12345')` then `'/orders/{var:orderId}'` |
| Extract response field for next call | `client.extractFromResponse('lastResp', '$.id', 'lastOrderId')` |

## Auth flows handled out-of-the-box

- **Basic** — `setAuth({ type: 'basic', username, password })`
- **Bearer** — `setAuth({ type: 'bearer', token })`
- **OAuth 2.0 client-credentials / authorization-code** — `setAuth({ type: 'oauth2', tokenUrl, clientId, clientSecret })` (auto-refresh + cache)
- **AWS signature v4** — `setAuth({ type: 'aws', region, service, accessKey, secretKey })`
- **Ping (ping-am)** — `setAuth({ type: 'ping', ... })`

## Forbidden patterns (audit rule API200 fails the file)

```typescript
// ❌ NEVER
import axios from 'axios';
import { fetch } from 'node-fetch';
import got from 'got';
import { request } from 'undici';
import superagent from 'superagent';
const fetch = require('node-fetch');
```

The framework's API client provides:
- Consistent error wrapping (no need to remember which lib throws on
  4xx vs returns it)
- Auto-retry with backoff for transient 5xx
- Auth refresh
- Request / response logging into `CSReporter`
- Network capture for the test report

Direct imports skip all of this and fail audit `API200`.

## Common gotchas

1. **Don't reuse client across scenarios** unless explicitly intended.
   Stateful headers / cookies leak. Either pass `freshContext: true`
   per call, or instantiate a new `CSAPIClient` per scenario.
2. **Timeout default is 30s.** For long-running async APIs, override
   per call: `client.post(url, body, { timeout: 60000 })`.
3. **Response body parsing** — `CSResponse<T>` returns parsed JSON
   when `Content-Type: application/json`. For other types, use
   `client.parseResponse(resp, 'application/xml')` or read
   `resp.text()`.
4. **Don't put real PATs in code.** Use `{config:KEY}` or `{input:KEY}`
   placeholders so the resolver pulls from env / SecretStorage.
