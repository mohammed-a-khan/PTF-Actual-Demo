/** OpenAPI design checks: the specification (with the line of each problem), the team's rules and their settings, YAML and JSON. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isOpenApiText, lintOpenApi } from '../src/api/openapiLint';

const YAML = `openapi: 3.0.3
info:
  title: Orders
  version: 1.0.0
servers:
  - url: http://api.shop.test
paths:
  /orders/{orderId}/LineItems/:
    get:
      operationId: getLines
      responses:
        '200':
          description: ok
          content:
            application/json: {}
  /orders:
    post:
      operationId: getLines
      summary: Create
      tags: [orders]
      requestBody:
        content:
          application/json:
            schema: { type: object }
      responses:
        '400':
          description: bad
    get:
      summary: List
      tags: [orders]
      operationId: listOrders
      responses:
        '200':
          descriptionx: oops
components:
  schemas:
    Unused: { type: string }
`;

test('the specification and the design rules, each on its line', async () => {
    assert.ok(isOpenApiText(YAML) && isOpenApiText('{"swagger":"2.0"}') && !isOpenApiText('name: x'));
    const p = await lintOpenApi(YAML);
    const by = (rule: string) => p.filter((x) => x.rule === rule).map((x) => `${x.line}: ${x.message}`);
    assert.deepEqual(by('spec'), ["33: Not valid OpenAPI: paths › /orders › get › responses › 200 must have required property 'description'", '34: Not valid OpenAPI: paths › /orders › get › responses › 200 must NOT have additional properties (descriptionx)']);
    assert.deepEqual(by('path-params-defined'), ['9: GET /orders/{orderId}/LineItems/: {orderId} is in the path but not declared as a path parameter.']);
    assert.deepEqual(by('path-no-trailing-slash'), ['8: /orders/{orderId}/LineItems/ ends with /.']);
    assert.deepEqual(by('path-kebab-case'), ['8: /orders/{orderId}/LineItems/: use lower case with words joined by - (e.g. /order-lines).']);
    assert.deepEqual(by('operation-operationId-unique'), ['10: The operationId "getLines" is used 2 times.', '18: The operationId "getLines" is used 2 times.']);
    assert.deepEqual(by('operation-success-response'), ['25: POST /orders has no success (2xx or 3xx) response.']);
    assert.deepEqual(by('operation-summary'), ['9: GET /orders/{orderId}/LineItems/ has no summary.']);
    assert.deepEqual(by('response-schema'), ['12: GET /orders/{orderId}/LineItems/ 200: the JSON response has no schema.']);
    assert.deepEqual(by('request-body-example'), ['21: POST /orders: the request body has no example.']);
    assert.deepEqual(by('servers-https'), ['6: The server http://api.shop.test is not https.']);
    assert.deepEqual(by('no-unused-components'), ['37: The schema Unused is not used.']);
    assert.equal(by('security-defined').length, 1);
    assert.deepEqual(p.find((x) => x.rule === 'spec')!.severity, 'error');
    // Settings: off and stricter.
    const q = await lintOpenApi(YAML, { 'path-kebab-case': 'error', 'no-unused-components': 'off', 'spec': 'off' });
    assert.equal(q.find((x) => x.rule === 'path-kebab-case')!.severity, 'error');
    assert.ok(!q.some((x) => x.rule === 'no-unused-components' || x.rule === 'spec'));
    // JSON, Swagger 2; a clean document.
    const clean = JSON.stringify({ swagger: '2.0', info: { title: 'x', version: '1', contact: { name: 'Team' } }, host: 'api.test', schemes: ['https'], security: [], paths: { '/items/{id}': { get: { operationId: 'getItem', summary: 'One', tags: ['items'], parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }], responses: { 200: { description: 'ok', schema: { type: 'object' } } } } } } }, null, 2);
    assert.deepEqual(await lintOpenApi(clean), []);
    const broken = await lintOpenApi('openapi: 3.0.0\ninfo: [\n');
    assert.equal(broken[0].rule, 'spec');
    assert.match(broken[0].message, /^YAML:/);
});
