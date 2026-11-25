/** Checks suggested from a response pass on that response, leave out what changes between runs, and the schema catches a changed shape. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { schemaOf, suggestChecks } from '../src/api/suggest';
import { evaluateAll } from '../src/api/send';

const body = { id: 42, status: 'OPEN', createdAt: '2026-03-01T10:00:00Z', token: 'eyJhbGciOiJIUzI1NiJ9.eyJ4IjoxfQ.sig', customer: { name: 'Ada', email: 'ada@example.test', tier: 'gold' },
    lines: [{ sku: 'A', qty: 1, note: null }, { sku: 'B', qty: 2 }], total: 30.5, paid: false };
const res = { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), json: body as unknown, truncated: false, size: 100, timeMs: 5, redirects: [] };

test('suggestions: status, type, schema, stable values; volatile ones only checked to be there', async () => {
    const s = suggestChecks(res);
    const t = s.map((x) => `${x.check.kind} ${x.check.target ?? ''} ${x.check.kind === 'schema' ? '' : x.check.value ?? ''}`.trim());
    assert.ok(t.includes('status  201'));
    assert.ok(t.includes('headerContains Content-Type application/json'));
    assert.ok(t.includes('jsonEquals $.status OPEN'));
    assert.ok(t.includes('jsonEquals $.id 42'));
    assert.ok(t.includes('jsonExists $.createdAt') && t.includes('jsonExists $.token'), 'times and tokens: only that they are there');
    assert.ok(!t.some((x) => x.includes('2026-03-01') || x.includes('eyJ')));
    assert.ok(t.includes('jsonEquals $.lines.length 2'));
    assert.ok(t.includes('jsonEquals $.customer.tier gold'));
    // Every suggestion passes on the response it came from.
    const v = await evaluateAll(s.map((x) => x.check), res, { vars: {}, config: {}, env: {} });
    assert.deepEqual(v.filter((x) => !x.pass).map((x) => x.message), []);
    // The schema: a list's fields present in every item are required; mixed types allowed; a changed shape fails.
    const sch = schemaOf(body) as { properties: { lines: { items: { required: string[]; properties: { note: { type: unknown } } } }; createdAt: { format: string } } };
    assert.deepEqual(sch.properties.lines.items.required, ['sku', 'qty']);
    assert.equal(sch.properties.createdAt.format, 'date-time');
    const schemaCheck = s.find((x) => x.check.kind === 'schema')!.check;
    const bad = { ...body, id: 'forty-two', lines: [{ qty: 1 }] };
    const changed = { ...res, body: JSON.stringify(bad), json: bad as unknown };
    const w = await evaluateAll([schemaCheck], changed, { vars: {}, config: {}, env: {} });
    assert.equal(w[0].pass, false);
    // Already there: not suggested again.
    assert.ok(!suggestChecks(res, [{ kind: 'status', value: '201' }]).some((x) => x.check.kind === 'status'));
    assert.deepEqual(suggestChecks({ ...res, headers: { 'content-type': 'text/plain' }, body: 'pong' }).map((x) => x.check.kind), ['status', 'headerContains', 'bodyContains']);
});
