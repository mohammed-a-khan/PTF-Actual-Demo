import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { exportReport } from '../src/api/collectionExport';
import { importCollection } from '../src/api/collectionImport';
import { ApiCheck, ApiCollection, ApiRequest, newCollection, newRequest, allRequests } from '../src/api/model';
import { evaluateAll, extract, prepare, send, Values } from '../src/api/send';

/** An app with JSON, XML, headers and cookies. */
function app() {
    const s = http.createServer((q, r) => {
        if (q.url!.startsWith('/orders')) {
            r.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req-77', 'Set-Cookie': ['session=abc123; Path=/; HttpOnly', 'theme=dark'] });
            r.end(JSON.stringify({ customer: { id: 7, name: 'Ada Lovelace', tier: 'Gold' }, total: 30.005, created: '2026-11-20T10:15:00Z', due: '2026-12-01', items: [{ sku: 'A1', qty: 2, price: 10 }, { sku: 'B2', qty: 1, price: 10.005 }], tags: ['new', 'priority'], note: '' }));
            return;
        }
        if (q.url!.startsWith('/xml')) { r.writeHead(200, { 'Content-Type': 'application/xml' }); r.end('<Order id="9"><Customer><Name>Ada</Name></Customer><Line no="1"><Sku>A1</Sku></Line><Line no="2"><Sku>B2</Sku></Line></Order>'); return; }
        if (q.url!.startsWith('/echo')) { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ got: JSON.parse(b || '{}'), saved: q.headers['x-saved'] ?? null })); }); return; }
        r.writeHead(404); r.end();
    });
    return { s, listen: () => new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port))) };
}

const rule = (c: Partial<ApiCheck>): ApiCheck => ({ kind: 'rule', ...c } as ApiCheck);

function collection(port: number): ApiCollection {
    const c = newCollection('Parity');
    c.baseUrl = `http://127.0.0.1:${port}`;
    const orders: ApiRequest = { ...newRequest('Orders', 'orders'), url: '/orders', checks: [
        { kind: 'status', value: '200' },
        { kind: 'jsonEquals', target: '$.customer.id', value: '7' },
        { kind: 'headerContains', target: 'Content-Type', value: 'json' },
        rule({ source: 'json', target: '$.customer.name', op: 'equals', expected: { from: 'text', value: 'ada lovelace' }, ignoreCase: true }),
        rule({ source: 'json', target: '$.total', op: 'equals', expected: { from: 'text', value: '30' }, compare: 'number', tolerance: 0.01 }),
        rule({ source: 'json', target: '$.total', op: 'equals', expected: { from: 'text', value: '30' }, compare: 'number', tolerance: 0.001 }),
        rule({ source: 'json', target: '$.created', op: 'equals', expected: { from: 'text', value: '2026-11-20' }, compare: 'date' }),
        rule({ source: 'json', target: '$.due', op: 'between', expected: { from: 'text', value: '2026-11-25' }, expected2: { from: 'text', value: '2026-12-31' } }),
        rule({ source: 'json', target: '$.items[*].sku', op: 'contains', expected: { from: 'text', value: 'B2' } }),
        rule({ source: 'json', target: '$.items[?(@.qty > 1)].sku', op: 'equals', expected: { from: 'text', value: 'A1' } }),
        rule({ source: 'json', target: '$.items', op: 'count', expected: { from: 'text', value: '2' } }),
        rule({ source: 'json', target: '$.tags', op: 'type', expected: { from: 'text', value: 'array' } }),
        rule({ source: 'json', target: '$.note', op: 'empty' }),
        rule({ source: 'json', target: '$.missing', op: 'notExists' }),
        rule({ source: 'json', target: '$.customer.tier', op: 'oneOf', expected: { from: 'text', value: 'Silver, Gold' } }),
        rule({ source: 'json', target: '$.customer.name', op: 'matches', expected: { from: 'text', value: '^Ada\\s' } }),
        rule({ source: 'json', target: '$.items[0].price', op: 'greater', expected: { from: 'text', value: '20' } }),
        rule({ source: 'json', target: '$.customer.tier', op: 'equals', expected: { from: 'config', value: 'EXPECTED_TIER' } }),
        rule({ source: 'json', target: '$.customer.id', op: 'equals', expected: { from: 'data', value: 'customerId' } }),
        rule({ source: 'header', target: 'x-request-id', op: 'equals', expected: { from: 'text', value: 'req-77' } }),
        rule({ source: 'cookie', target: 'session', op: 'equals', expected: { from: 'text', value: 'abc123' } }),
        rule({ source: 'status', op: 'atMost', expected: { from: 'text', value: '299' } }),
        rule({ source: 'body', op: 'contains', expected: { from: 'text', value: 'Lovelace' } }),
        { kind: 'schema', schema: JSON.stringify({ type: 'object', required: ['customer', 'items'], properties: { items: { type: 'array', items: { type: 'object', required: ['sku', 'qty'] } } } }) },
        { kind: 'schema', schemaFile: 'order.json' },
        { kind: 'dbItems', db: { items: '$.items', query: 'ORDER_LINES', connection: 'MAIN', title: 'line', key: 'sku', fields: [] } as never },
    ], extract: [
        { from: 'json', path: '$.customer.name', variable: 'customerName' },
        { from: 'header', path: 'X-Request-Id', variable: 'requestId' },
        { from: 'cookie', path: 'session', variable: 'sessionId' },
        { from: 'status', path: '', variable: 'ordersStatus' },
        { from: 'regex', path: '"sku":"(\\w+)"', variable: 'firstSku' },
    ] };
    const xml: ApiRequest = { ...newRequest('Xml', 'xml'), url: '/xml', checks: [
        rule({ source: 'xml', target: '/Order/Customer/Name', op: 'equals', expected: { from: 'text', value: 'Ada' } }),
        rule({ source: 'xml', target: '/Order/@id', op: 'equals', expected: { from: 'text', value: '9' } }),
        rule({ source: 'xml', target: '//Line[2]/Sku', op: 'equals', expected: { from: 'text', value: 'B2' } }),
        rule({ source: 'xml', target: '/Order/Customer/Name', op: 'equals', expected: { from: 'saved', value: 'customerName' } }),
    ], extract: [{ from: 'xml', path: '/Order/@id', variable: 'orderId' }] };
    const echo: ApiRequest = { ...newRequest('Echo', 'echo'), method: 'POST', url: '/echo', headers: [{ key: 'X-Saved', value: '{{requestId}}' }], body: { mode: 'file', file: 'echo.json' }, checks: [
        rule({ source: 'json', target: '$.saved', op: 'equals', expected: { from: 'saved', value: 'requestId' } }),
        rule({ source: 'json', target: '$.got.sku', op: 'equals', expected: { from: 'saved', value: 'firstSku' } }),
    ], extract: [] };
    const ws: ApiRequest = { ...newRequest('Socket', 'ws'), url: '/ws', ws: { steps: [] } as never };
    c.items.push(orders, xml, echo, ws);
    return c;
}

test('export: every check and saved value runs in Postman (Newman) with the Studio\'s verdict; export → import gives the same collection', async () => {
    const { s, listen } = app();
    const port = await listen();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-export-'));
    try {
        fs.mkdirSync(path.join(dir, 'test-data', 'api', 'schemas'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'test-data', 'payloads'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'test-data', 'api', 'schemas', 'order.json'), JSON.stringify({ type: 'object', required: ['total'], properties: { total: { type: 'number' } } }));
        fs.writeFileSync(path.join(dir, 'test-data', 'payloads', 'echo.json'), '{"sku": "{{firstSku}}"}');
        const readFile = (rel: string) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return undefined; } };
        const c = collection(port);

        // The Studio's verdicts (as Send / the runner give them).
        const values: Values = { vars: {}, config: { EXPECTED_TIER: 'Gold' }, env: {}, row: { customerId: '7' }, readFile: (rel) => fs.readFileSync(path.join(dir, rel)) };
        const studio: boolean[][] = [];
        for (const r of allRequests(c.items).map((x) => x.request).filter((r) => !r.ws)) {
            const res = await send(prepare(c, r, values, { readFile: values.readFile }), undefined, 5000);
            for (const x of extract(r.extract, res)) if (x.found && x.value !== undefined) values.vars[x.variable] = x.value;
            studio.push((await evaluateAll(r.checks.filter((k) => k.kind !== 'dbItems'), res, values)).map((x) => x.pass));
        }
        // Sanity: the case set has both outcomes.
        assert.ok(studio.flat().includes(false) && studio.flat().filter(Boolean).length > 20, JSON.stringify(studio));

        const { collection: out, warnings } = exportReport(c, { readFile });
        assert.ok(warnings.some((w) => /"Socket": a WebSocket exchange/.test(w)));
        assert.ok(warnings.some((w) => /database check \(ORDER_LINES\)/.test(w)));
        assert.equal(warnings.length, 2, JSON.stringify(warnings));

        // Back into the Studio: the same checks and saved values (markers), the payload text inlined.
        const back = importCollection(JSON.parse(JSON.stringify(out))).collection;
        const reqs = allRequests(back.items).map((x) => x.request);
        const orig = allRequests(c.items).map((x) => x.request).filter((r) => !r.ws);
        assert.deepEqual(reqs.map((r) => r.name), orig.map((r) => r.name));
        for (let i = 0; i < orig.length; i++) {
            assert.deepEqual(reqs[i].checks, orig[i].checks, `${orig[i].name}: checks`);
            assert.deepEqual(reqs[i].extract, orig[i].extract, `${orig[i].name}: saved values`);
        }
        assert.equal(reqs[2].body.text, '{"sku": "{{firstSku}}"}');

        // In Postman's runner: the same verdict for every check.
        const newman = process.env.CS_NEWMAN;
        if (!newman || !fs.existsSync(newman)) return;
        const file = path.join(dir, 'c.json'), data = path.join(dir, 'data.json'), report = path.join(dir, 'r.json');
        fs.writeFileSync(file, JSON.stringify(out));
        fs.writeFileSync(data, JSON.stringify([{ customerId: '7' }]));
        if (process.env.CS_EXPORT_KEEP) fs.copyFileSync(file, process.env.CS_EXPORT_KEEP);
        // Asynchronously: the app answers from this process. A non-zero exit means failed assertions.
        await new Promise<void>((res) => execFile(newman, ['run', file, '-d', data, '--env-var', 'EXPECTED_TIER=Gold', '-r', 'json', '--reporter-json-export', report, '--timeout-request', '5000'], () => res()));
        const run = JSON.parse(fs.readFileSync(report, 'utf8')).run;
        const inPostman: Array<Array<boolean | 'skipped'>> = run.executions.map((e: { assertions?: Array<{ error?: unknown; skipped?: boolean }> }) => (e.assertions ?? []).map((a) => (a.skipped ? 'skipped' : !a.error)));
        assert.equal(inPostman.length, 3);
        for (let i = 0; i < 3; i++) {
            const ran = inPostman[i].filter((x) => x !== 'skipped');
            assert.deepEqual(ran, studio[i], `${orig[i].name}: Postman ${JSON.stringify(inPostman[i])} vs Studio ${JSON.stringify(studio[i])}`);
        }
        assert.equal(inPostman[0].filter((x) => x === 'skipped').length, 1, 'the database check is a skipped test');
        assert.equal(run.failures.filter((f: { error?: { name?: string } }) => f.error?.name !== 'AssertionError').length, 0, 'no script errors');
    } finally {
        s.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
