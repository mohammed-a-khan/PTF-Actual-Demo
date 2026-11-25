/**
 * Importers: Insomnia, JMeter and SoapUI files (as those tools write them) become collections whose requests are sent
 * as the original tool sends them; RAML, AsyncAPI and a GraphQL schema become requests with examples; the format of a
 * file is recognised from its content.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { detectImport, importAsyncApi, importGraphqlSchema, importInsomnia, importJmeter, importRaml, importSoapUi } from '../src/api/importers';
import { allRequests, ApiCollection, validCollection } from '../src/api/model';
import { evaluateAll, extract, prepare, send } from '../src/api/send';

const fixture = (f: string, port: number) => fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'import', f), 'utf8').replace(/PORT/g, String(port));
const fx = (f: string, port: number) => { try { return fixture(f, port); } catch { return fs.readFileSync(path.join(__dirname, 'fixtures', 'import', f), 'utf8').replace(/PORT/g, String(port)); } };

async function app() {
    const got: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
    const s = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => {
        got.push({ method: q.method!, url: q.url!, headers: q.headers, body: b });
        if (q.headers['content-type']?.includes('xml')) { r.writeHead(200, { 'Content-Type': 'text/xml' }); r.end('<Envelope><Body><status>OPEN</status></Body></Envelope>'); return; }
        if (q.url === '/orders' && q.method === 'POST') { r.writeHead(201, { 'Content-Type': 'application/json' }); r.end('{"id":"o-9"}'); return; }
        r.writeHead(200, { 'Content-Type': 'application/json' });
        r.end('{"id":"o-9","lines":[]}');
    }); });
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    return { s, port, got };
}
const vars = (c: ApiCollection) => Object.fromEntries(c.variables.map((v) => [v.key, v.value]));

test('Insomnia: folders, environment variables, bodies (JSON, form, GraphQL), sign-in; sent as Insomnia sends them', async () => {
    const a = await app();
    try {
        const { collection: c, report } = importInsomnia(JSON.parse(fx('insomnia.json', a.port)));
        validCollection(c);
        assert.equal(c.name, 'Shop API');
        assert.deepEqual(vars(c), { baseUrl: `http://127.0.0.1:${a.port}`, token: 'qa-token', sku: 'A-1' });
        assert.deepEqual([report.requests, report.folders], [4, 1]);
        assert.ok(report.warnings.some((w) => /Nested environment values/.test(w)));
        assert.ok(report.warnings.some((w) => /gRPC request is not imported/.test(w)));
        assert.ok(report.warnings.some((w) => /faker/.test(w)));
        const reqs = allRequests(c.items).map((x) => x.request);
        const v = { vars: vars(c), config: {}, env: {} };
        const create = reqs.find((r) => r.name === 'Create order')!;
        await send(prepare(c, create, v), undefined, 5000);
        assert.deepEqual([a.got[0].method, a.got[0].url, a.got[0].headers.authorization, a.got[0].headers['x-off'], JSON.parse(a.got[0].body)], ['POST', '/orders?dry=false', 'Bearer qa-token', undefined, { sku: 'A-1', qty: 2 }]);
        await send(prepare(c, reqs.find((r) => r.name === 'Login')!, v), undefined, 5000);
        assert.deepEqual([a.got[1].body, a.got[1].headers.authorization], ['user=qa&pass=pw', `Basic ${Buffer.from('svc:qa-token').toString('base64')}`]);
        const g = reqs.find((r) => r.name === 'Graph')!;
        assert.deepEqual(g.body, { mode: 'graphql', graphql: { query: '{ order(id: 1) { id } }', variables: '{\n  "x": 1\n}' } });
        assert.throws(() => importInsomnia({ a: 1 }), /Not an Insomnia export/);
    } finally { a.s.close(); }
});

test('JMeter: defaults, headers (plan and sampler), raw body, parameters, assertions, extractors; the requests chain as in JMeter', async () => {
    const a = await app();
    try {
        const { collection: c, report } = importJmeter(fx('plan.jmx', a.port));
        validCollection(c);
        assert.equal(c.name, 'Shop load');
        assert.equal(c.baseUrl, `http://127.0.0.1:${a.port}`);
        assert.deepEqual(vars(c), { sku: 'B-2' });
        assert.deepEqual(allRequests(c.items).map((x) => `${x.folders.join('/')}|${x.request.name}`), ['Shoppers/Buy|Create order', 'Shoppers/Buy|Get order'], 'thread group and transaction as folders; the disabled sampler left out');
        assert.ok(report.warnings.some((w) => /__time/.test(w)));
        assert.ok(report.warnings.some((w) => /CSV data set users\.csv/.test(w)));
        const [create, get] = allRequests(c.items).map((x) => x.request);
        assert.deepEqual(create.checks, [{ kind: 'status', value: '201' }]);
        assert.deepEqual(create.extract, [{ variable: 'orderId', from: 'json', path: '$.id' }]);
        assert.deepEqual(get.checks.map((x) => x.kind), ['status', 'bodyContains']);
        const v = { vars: vars(c), config: {}, env: {} };
        const res = await send(prepare(c, { ...create, body: { ...create.body, text: create.body.text!.replace('${__time(,)}', '1') } }, v), undefined, 5000);
        assert.ok((await evaluateAll(create.checks, res, v)).every((x) => x.pass));
        for (const x of extract(create.extract, res)) if (x.found) v.vars[x.variable] = x.value!;
        assert.deepEqual([a.got[0].headers['x-tenant'], a.got[0].headers['content-type'], JSON.parse(a.got[0].body).sku], ['eu', 'application/json', 'B-2']);
        const r2 = await send(prepare(c, get, v), undefined, 5000);
        assert.equal(a.got[1].url, '/orders/o-9?expand=lines', 'the saved id chains into the next request');
        assert.ok((await evaluateAll(get.checks, r2, v)).every((x) => x.pass));
        assert.throws(() => importJmeter('<a/>'), /Not a JMeter test plan/);
    } finally { a.s.close(); }
});

test('SoapUI: SOAP operations, REST resources and test steps (with their assertions)', async () => {
    const a = await app();
    try {
        const { collection: c, report } = importSoapUi(fx('soapui.xml', a.port));
        validCollection(c);
        assert.deepEqual(vars(c), { tenant: 'eu' });
        assert.deepEqual(allRequests(c.items).map((x) => `${x.folders.join('/')}|${x.request.method} ${x.request.name}`), [
            'OrderBinding|POST GetStatus · Request 1', 'Orders REST|GET List · All', 'Orders REST|GET Get · One', 'Regression/Status|POST Get status']);
        const [soap, list, one, step] = allRequests(c.items).map((x) => x.request);
        assert.deepEqual(soap.headers, [{ key: 'Content-Type', value: 'text/xml; charset=utf-8' }, { key: 'SOAPAction', value: '"http://shop.example/orders/GetStatus"' }]);
        assert.match(soap.body.text!, /<ord:orderId>\{\{orderId\}\}<\/ord:orderId>/);
        assert.deepEqual([soap.auth.type, soap.auth.username], ['basic', 'svc']);
        assert.deepEqual(list.query, [{ key: 'status', value: 'open' }]);
        assert.equal(one.url, `http://127.0.0.1:${a.port}/orders/{{id}}`);
        assert.deepEqual(step.checks.map((x) => x.kind), ['status', 'bodyNotContains', 'bodyContains']);
        assert.ok(report.warnings.some((w) => /XPath Match/.test(w)) && report.warnings.some((w) => /"groovy" step/.test(w)));
        const v = { vars: { orderId: '7' }, config: {}, env: {} };
        const res = await send(prepare(c, step, v), undefined, 5000);
        assert.ok((await evaluateAll(step.checks, res, v)).every((x) => x.pass), res.body);
        assert.equal(a.got[0].headers.soapaction, '"http://shop.example/orders/GetStatus"', 'the step takes its operation\'s SOAP action');
    } finally { a.s.close(); }
});

test('RAML, AsyncAPI (MQTT, Kafka; v2 and v3), GraphQL schema; formats recognised', () => {
    const raml = importRaml(`#%RAML 1.0
title: Orders
version: v2
baseUri: https://api.shop.test/{version}
securitySchemes:
  oauth: { type: OAuth 2.0 }
/orders:
  get:
    queryParameters:
      status: { type: string, required: false, example: open }
    responses: { 200: {} }
  post:
    body:
      application/json:
        example: { sku: A-1, qty: 1 }
    responses: { 201: {} }
  /{orderId}:
    get:
      displayName: Get one
      headers: { X-Tenant: { example: eu } }
    /lines:
      get:
        description: The lines
        body:
          application/json:
            type: !include types/line.raml
`);
    assert.equal(raml.collection.baseUrl, 'https://api.shop.test/v2');
    assert.deepEqual(allRequests(raml.collection.items).map((x) => `${x.request.method} ${x.request.url} ${x.request.checks.map((c) => c.value).join()}`), ['GET /orders 200', 'POST /orders 201', 'GET /orders/{{orderId}} 200', 'GET /orders/{{orderId}}/lines 200']);
    const [list, create, one] = allRequests(raml.collection.items).map((x) => x.request);
    assert.deepEqual(list.query, [{ key: 'status', value: 'open', enabled: false }]);
    assert.deepEqual(JSON.parse(create.body.text!), { sku: 'A-1', qty: 1 });
    assert.deepEqual(one.headers, [{ key: 'X-Tenant', value: 'eu' }]);
    assert.ok(raml.report.warnings.some((w) => /!include/.test(w)));
    const v2 = importAsyncApi(`asyncapi: 2.6.0
info: { title: Devices }
servers:
  prod: { url: 'broker.test:1883', protocol: mqtt }
channels:
  devices/{id}/state:
    subscribe:
      operationId: deviceState
      message: { $ref: '#/components/messages/State' }
  devices/{id}/commands:
    publish:
      operationId: sendCommand
      message:
        payload: { type: object, properties: { cmd: { type: string, enum: [reboot, off] }, at: { type: string, format: date-time } } }
components:
  messages:
    State: { payload: { type: object, properties: { on: { type: boolean } } } }
`);
    const [state, cmd] = allRequests(v2.collection.items).map((x) => x.request);
    assert.deepEqual([state.url, state.ws!.protocol, state.ws!.options, state.ws!.steps], ['mqtt://broker.test:1883', 'mqtt', { subscribe: ['devices/+/state'] }, [{ kind: 'expect', text: '', topic: 'devices/{{id}}/state', timeoutMs: 30000 }]]);
    assert.deepEqual(JSON.parse(cmd.ws!.steps[0].text), { cmd: 'reboot', at: '2026-01-31T10:00:00Z' });
    const v3 = importAsyncApi(JSON.stringify({ asyncapi: '3.0.0', info: { title: 'Orders' }, servers: { k: { host: 'kafka.test:9092', protocol: 'kafka' } },
        channels: { placed: { address: 'orders.placed', messages: { m: { payload: { type: 'object', properties: { id: { type: 'string', examples: ['o-1'] } } } } } } },
        operations: { publishOrder: { action: 'send', channel: { $ref: '#/channels/placed' } } } }));
    const k = allRequests(v3.collection.items)[0].request;
    assert.deepEqual([k.url, k.ws!.protocol, k.ws!.steps[0].topic, JSON.parse(k.ws!.steps[0].text)], ['kafka://kafka.test:9092', 'kafka', 'orders.placed', { id: 'o-1' }]);
    const gql = importGraphqlSchema('type Order { id: ID! total: Float }\ntype Query { order(id: ID!): Order }\ntype Mutation { cancel(id: ID!): Order }');
    const [q, m] = allRequests(gql.collection.items).map((x) => x.request);
    assert.deepEqual([q.name, q.body.mode, q.body.graphql!.operationName, JSON.parse(q.body.graphql!.variables!)], ['Query order', 'graphql', 'Order', { id: '1' }]);
    assert.equal(m.name, 'Mutation cancel');
    for (const [t, want] of [['#%RAML 1.0\ntitle: x', 'raml'], ['<jmeterTestPlan/>', 'jmeter'], ['<con:soapui-project xmlns:con="x"/>', 'soapui'], ['type Query { a: Int }', 'graphql'], ['{"_type":"export"}', 'insomnia'], ['asyncapi: 2.0.0', 'asyncapi'], ['openapi: 3.0.0', 'openapi'], ['{"info":{"schema":"https://schema.getpostman.com/x"},"item":[]}', 'postman'], ['{"log":{"entries":[]}}', 'har']] as const)
        assert.equal(detectImport(t), want, t);
});
