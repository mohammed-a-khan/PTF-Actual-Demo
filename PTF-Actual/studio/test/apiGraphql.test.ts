/**
 * GraphQL in the API workspace against a real GraphQL server (graphql-js): the schema read by introspection, the
 * explorer outline, a starting operation, queries checked against the schema, the request sent with variables, and
 * the same request in Postman's format and in the framework feature.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { buildSchema, graphql } from 'graphql';
import { INTROSPECTION_QUERY, introspectionOf, operationFor, outline, schemaOf, validateQuery } from '../src/api/graphql';
import { prepare, send } from '../src/api/send';
import { importCollection } from '../src/api/collectionImport';
import { exportReport } from '../src/api/collectionExport';
import { toFeature } from '../src/api/feature';
import { allRequests, ApiCollection, ApiRequest } from '../src/api/model';

const SDL = `
"An order of the shop"
type Order { id: ID!  total: Float!  status: Status!  customer: Customer  lines(first: Int = 5): [Line!]! }
type Customer { id: ID!  name: String! }
type Line { sku: String!  qty: Int! }
enum Status { OPEN SHIPPED }
input NewOrder { customerId: ID!  note: String }
type Query { order(id: ID!): Order  orders(status: Status, first: Int): [Order!]! }
type Mutation { placeOrder(input: NewOrder!): Order! }
`;
const schema = buildSchema(SDL);
const orders = [{ id: '1', total: 30, status: 'OPEN', customer: { id: 'c1', name: 'Ada' }, lines: [{ sku: 'A', qty: 1 }] }];
const root = { order: ({ id }: { id: string }) => orders.find((o) => o.id === id) ?? null, orders: () => orders, placeOrder: ({ input }: { input: { customerId: string } }) => ({ id: '2', total: 0, status: 'OPEN', customer: { id: input.customerId, name: 'New' }, lines: [] }) };

function server() {
    return http.createServer((q, r) => {
        let b = ''; q.on('data', (c) => (b += c));
        q.on('end', async () => {
            if (q.headers.authorization !== 'Bearer gql-token') { r.writeHead(401); r.end('{"errors":[{"message":"sign in"}]}'); return; }
            const j = JSON.parse(b);
            const out = await graphql({ schema, source: j.query, variableValues: j.variables, operationName: j.operationName, rootValue: root });
            r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(out));
        });
    });
}

test('GraphQL: introspection, outline, starting operation, checks against the schema, sending with variables; Postman and framework formats', async () => {
    const s = server();
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    try {
        const c: ApiCollection = { format: 'cs-studio-api/1', name: 'Shop', baseUrl: `http://127.0.0.1:${port}`, variables: [{ key: 'orderId', value: '1' }], auth: { type: 'bearer', token: 'gql-token' } as ApiCollection['auth'], items: [] };
        const values = { vars: { orderId: '1' }, config: {}, env: {} };
        // Introspection with the request's sign-in.
        const intro: ApiRequest = { kind: 'request', id: 'i', name: 'i', method: 'POST', url: '/graphql', query: [], headers: [], auth: { type: 'inherit' } as ApiRequest['auth'], checks: [], extract: [], body: { mode: 'graphql', graphql: { query: INTROSPECTION_QUERY } } };
        const res = await send(prepare(c, intro, values), undefined, 5000);
        const sch = schemaOf(introspectionOf(res.body));
        const o = outline(sch);
        assert.deepEqual([o.query, o.mutation, o.subscription], ['Query', 'Mutation', undefined]);
        const order = o.types.find((t) => t.name === 'Order')!;
        assert.equal(order.description, 'An order of the shop');
        assert.deepEqual(order.fields.find((f) => f.name === 'lines')!.args, [{ name: 'first', type: 'Int', defaultValue: '5' }]);
        assert.deepEqual(o.types.find((t) => t.name === 'Status')!.values, ['OPEN', 'SHIPPED']);
        // A starting operation: arguments as variables with sample values, fields selected; valid against the schema.
        const op = operationFor(sch, 'mutation', 'placeOrder');
        assert.equal(op.operationName, 'PlaceOrder');
        assert.deepEqual(JSON.parse(op.variables), { input: { customerId: '1' } });
        assert.deepEqual(validateQuery(sch, op.query), []);
        const q1 = operationFor(sch, 'query', 'order');
        assert.match(q1.query, /query Order\(\$id: ID!\) \{\n {2}order\(id: \$id\) \{\n {4}id\n {4}total\n {4}status\n {4}customer \{/);
        // Problems the server would report, with where they are.
        assert.deepEqual(validateQuery(sch, '{ order(id: "1") { id price } }'), [{ message: 'Cannot query field "price" on type "Order".', line: 1, column: 23 }]);
        assert.match(validateQuery(sch, '{ orders { id }')[0].message, /Syntax Error/);
        assert.match(validateQuery(sch, '{ order { id } }')[0].message, /argument "id" of type "ID!" is required/);
        // Sent: {{orderId}} filled inside the variables.
        const r: ApiRequest = { ...intro, id: 'o', name: 'Order', body: { mode: 'graphql', graphql: { query: 'query Order($id: ID!) { order(id: $id) { id total customer { name } } }', variables: '{ "id": "{{orderId}}" }' } } };
        const p = prepare(c, r, values);
        assert.equal(p.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(String(p.body)), { query: r.body.graphql!.query, variables: { id: '1' } });
        assert.deepEqual(JSON.parse((await send(p, undefined, 5000)).body), { data: { order: { id: '1', total: 30, customer: { name: 'Ada' } } } });
        // Postman: exported as a GraphQL body and imported back as one.
        const full = { ...c, items: [r] };
        const pm = exportReport(full, {}).collection as { item: Array<{ request: { body: { mode: string; graphql: { query: string; variables: string } } } }> };
        assert.equal(pm.item[0].request.body.mode, 'graphql');
        assert.equal(pm.item[0].request.body.graphql.variables, '{ "id": "{{orderId}}" }');
        const back = allRequests(importCollection(pm).collection.items)[0].request;
        assert.deepEqual(back.body, r.body);
        // The framework feature sends the JSON it is.
        const f = toFeature(full).text;
        assert.match(f, /"query": "query Order\(\$id: ID!\)/);
        assert.match(f, /"variables": \{\n\s+"id": "\{\{orderId\}\}"\n\s+\}/);
    } finally { s.close(); }
});
