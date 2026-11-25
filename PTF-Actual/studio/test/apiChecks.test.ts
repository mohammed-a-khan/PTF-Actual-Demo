import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { checkValue, filterRows, itemsAgainstQuery, prepareValues, responseValue, same, xmlValue } from '../src/api/checks';
import { schemaErrors } from '../src/api/schema';
import { JsonPath } from '../src/api/jsonPath';
import { checkStepsText, helperText } from '../src/api/codegen/helper';
import { collectionCode, literal } from '../src/api/codegen/collection';
import { apiTestPlan, templateNames } from '../src/api/codegen/plan';
import { ruleStep, toFeature } from '../src/api/feature';
import { fillTemplate, type ApiResponse, type Values } from '../src/api/send';
import type { ApiCheck, ApiCollection, ApiRequest, DbItemsRule, Operator } from '../src/api/model';

const PKG = '@mdakhan.mak/cs-playwright-test-framework';
const q = (s: string) => (s.includes('"') ? `'${s}'` : `"${s}"`);

const body = {
    header: { channel: 'WEB', requestId: 'req-ab12' },
    orders: [
        { orderNo: 'SO-1001', orderDate: '2026-11-20', error: null, lines: [{ price: '4.321500', shipDate: '2026-11-19', createdAt: '2026-11-20T09:15:00Z' }, { price: '4.330000', shipDate: '2026-11-18', createdAt: '2026-11-20T09:15:00Z' }] },
        { orderNo: 'SO-1003', orderDate: '2026-11-20', lines: [], error: { code: '204', subCode: 'E404' } },
    ],
    total: 24.98, status: 'NEW', tags: ['qa', 'viewer'], createdAt: '2026-11-21T10:00:00Z',
};
const xml = '<?xml version="1.0"?><order id="1147"><orderNo>SO-1147</orderNo><status>NEW</status><total currency="USD">24.98</total><items><item line="1"><sku>A1</sku></item><item line="2"><sku>B2</sku></item></items></order>';
const resp = (b: unknown, extra: Partial<ApiResponse> = {}): ApiResponse => ({ status: 201, statusText: 'Created', headers: { 'content-type': 'application/json', location: '/orders/1147' }, body: typeof b === 'string' ? b : JSON.stringify(b), truncated: false, size: 300, timeMs: 42, redirects: [], ...(typeof b === 'string' ? {} : { json: b }), setCookies: ['session=s-1; Path=/; HttpOnly'], ...extra });

/** The generated helper, run with the framework's modules replaced by stand-ins. */
function loadHelper(response: { body: unknown; rawBody?: string; status?: number; headers?: Record<string, string>; duration?: number; size?: number; cookies?: Array<{ name: string; value: string }> }, vars: Record<string, unknown> = {}, rows: (sql: string, params: unknown[]) => Array<Record<string, unknown>> = () => []) {
    const js = ts.transpileModule(helperText(PKG), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const apiVars = new Map(Object.entries(vars));
    const bddVars = new Map<string, unknown>();
    const mods: Record<string, unknown> = {
        [`${PKG}/api`]: { CSJsonPath: JsonPath, CSApiContextManager: { getInstance: () => ({ getCurrentContext: () => ({ getLastResponse: () => ({ status: 200, headers: {}, duration: 10, ...response }), getVariable: (k: string) => apiVars.get(k), setVariable: (k: string, v: unknown) => apiVars.set(k, v) }) }) } },
        [`${PKG}/bdd`]: { CSBDDContext: { getInstance: () => ({ get: (k: string) => bddVars.get(k), set: (k: string, v: unknown) => bddVars.set(k, v) }) } },
        [`${PKG}/database-utils`]: { CSDBUtils: { executeQuery: async (_a: string, sql: string, params: unknown[]) => ({ rows: rows(sql, params) }) } },
        [`${PKG}/reporting`]: { CSReporter: { pass: () => undefined, info: () => undefined } },
    };
    const module = { exports: {} as Record<string, unknown> };
    new Function('require', 'module', 'exports', js)((id: string) => mods[id], module, module.exports);
    const C = module.exports.ApiResponseChecks as { getInstance(): any };
    // A fresh instance per test (the class keeps one).
    (C as any).instance = undefined;
    return { checks: C.getInstance(), apiVars, bddVars };
}

test('generated helper and the workspace agree: every operator, value source and comparison, passing and failing', () => {
    const cases: Array<[string, Operator, string?, Record<string, unknown>?]> = [
        ['$.header.channel', 'equals', 'WEB'], ['$.header.channel', 'equals', 'XYZ'],
        ['$.total', 'equals', '24.98'], ['$.total', 'equals', '24.980'], ['$.total', 'notEquals', '25'],
        ['$.total', 'greater', '20'], ['$.total', 'greater', '30'], ['$.total', 'less', '25'], ['$.total', 'atLeast', '24.98'], ['$.total', 'atMost', '24'],
        ['$.total', 'between', '20', { to: '30' }], ['$.total', 'between', '25', { to: '30' }],
        ['$.status', 'oneOf', 'NEW, PAID'], ['$.status', 'oneOf', 'SHIPPED'],
        ['$.tags', 'contains', 'qa'], ['$.tags', 'contains', 'admin'], ['$.tags', 'notContains', 'admin'], ['$.tags', 'count', '2'], ['$.tags', 'count', '3'],
        ['$.header.requestId', 'matches', '^req-[a-z0-9]+$'], ['$.header.requestId', 'matches', '^x'],
        ['$.missing', 'exists'], ['$.missing', 'notExists'], ['$.orders[1].lines', 'empty'], ['$.orders', 'notEmpty'],
        ['$.total', 'type', 'number'], ['$.tags', 'type', 'array'], ['$.orders[0].error', 'type', 'null'],
        ["$.orders[?(@.orderNo=='SO-1001')].lines[0].price", 'equals', '4.3215', { compare: 'number', tolerance: 0.0001 }],
        ["$.orders[?(@.orderNo=='SO-1001')].lines[0].price", 'equals', '4.33', { compare: 'number', tolerance: 0.0001 }],
        ['$.createdAt', 'equals', '2026-11-21', { compare: 'date' }], ['$.createdAt', 'equals', '2026-11-22', { compare: 'date' }],
        ['$.createdAt', 'greater', '2026-11-20T00:00:00Z'], ['$.header.channel', 'equals', 'web', { ignoreCase: true }],
        ['$.orders[*].orderNo', 'count', '2'], ['$.orders[*].orderNo', 'contains', 'SO-1003'],
        ['status', 'equals', '201'], ['status', 'oneOf', '200, 201'], ['header:Location', 'matches', '^/orders/\\d+$'], ['header:location', 'equals', '/orders/1147'],
        ['cookie:session', 'equals', 's-1'], ['cookie:other', 'exists'], ['time', 'less', '5000'], ['size', 'atMost', '1000'],
    ];
    const r = resp(body, { status: 201 });
    const { checks } = loadHelper({ body, status: 201, headers: { 'content-type': 'application/json', location: '/orders/1147' }, duration: 42, size: 300, cookies: [{ name: 'session', value: 's-1' }] });
    for (const [ref, op, exp, o] of cases) {
        const studio = checkValue(ref, responseValue(r, ref), op, exp, o as never);
        let helperPass = true, helperMessage = '';
        try { checks.check(ref, op, exp, o); } catch (e) { helperPass = false; helperMessage = (e as Error).message; }
        assert.equal(studio.pass, helperPass, `${ref} ${op} ${exp ?? ''}: the workspace says ${studio.pass} (${studio.message}), the test run ${helperPass} (${helperMessage})`);
        if (!helperPass) assert.equal(studio.message, helperMessage, 'the same failure message');
    }
    // XML values.
    const xr = resp(xml);
    const { checks: xc } = loadHelper({ body: { order: {} }, rawBody: xml });
    for (const [ref, want] of [['xml:/order/status', 'NEW'], ['xml:/order/@id', '1147'], ['xml:/order/total', '24.98'], ['xml://item[2]/sku', 'B2'], ['xml:/order/items/item[1]/@line', '1'], ['xml:/order/nope', undefined]] as const) {
        assert.equal(responseValue(xr, ref), want, ref);
        assert.equal(xc.value(ref), want, `helper ${ref}`);
    }
});

test('the database rule: rows matched by a field, numbers within a tolerance, dates by the day, no rows: the error the API reports', async () => {
    const rule: DbItemsRule = {
        title: 'order', items: '$.orders', connection: 'ORDERS', query: 'GET_ORDER_LINES', params: ['orderNo', 'orderDate'], rows: 'lines',
        matchBy: { field: 'shipDate', column: 'SHIP_DT' }, count: true,
        fields: [{ field: 'price', column: 'PRICE', compare: 'number', tolerance: 0.0001 }, { field: 'shipDate', column: 'SHIP_DT', compare: 'date' }, { field: 'createdAt', column: 'CREATED_AT', compare: 'datetime' }],
        whenNoRows: [{ field: 'lines.length', value: '0' }, { field: 'error.subCode', value: 'E404' }],
    };
    // Rows as a database returns them (dates as Date, numbers as numbers), oldest first: matched by date, not position.
    const db = (lines: Array<[number, string]>) => (_sql: string, params: unknown[]) => (params[0] === 'SO-1001' ? lines.map(([r, d]) => ({ PRICE: r, SHIP_DT: new Date(`${d}T00:00:00`), CREATED_AT: new Date('2026-11-20T09:15:00Z') })) : []);
    const good = db([[4.33, '2026-11-18'], [4.3215, '2026-11-19']]);
    const v: Values = { vars: {}, config: {}, env: {} };
    assert.deepEqual(await itemsAgainstQuery(rule, resp(body), v, async (_c, sql, p) => good(sql, p)), []);
    const { checks } = loadHelper({ body }, {}, good);
    await checks.checkItemsAgainstQuery(JSON.parse(JSON.stringify({ ...rule, whenNoRows: rule.whenNoRows!.map((w) => [w.field, w.value]) })));
    // A wrong price and a row the response does not have: both reported, by both.
    const bad = db([[4.33, '2026-11-17'], [4.3315, '2026-11-19']]);
    const errs = await itemsAgainstQuery(rule, resp(body), v, async (_c, sql, p) => bad(sql, p));
    assert.equal(errs.length, 2, errs.join('\n'));
    assert.match(errs[0], /lines\[0\]\.price: the database has 4\.3315 \(PRICE\), the response "4\.321500"/);
    assert.match(errs[1], /no database row with SHIP_DT = "2026-11-18"/);
    const h = loadHelper({ body }, {}, bad);
    await assert.rejects(h.checks.checkItemsAgainstQuery({ ...rule, whenNoRows: [['lines.length', '0']] }), (e: Error) => e.message.includes('2 difference(s)') && e.message.includes(errs[0]) && e.message.includes(errs[1]));
    // No rows and no expectation for that: a failure.
    const strict = await itemsAgainstQuery({ ...rule, whenNoRows: undefined }, resp(body), v, async (_c, sql, p) => good(sql, p));
    assert.match(strict.join(), /\$\.orders\[1\] \("SO-1003", "2026-11-20"\): GET_ORDER_LINES returned no rows/);
});

test('comparisons: database dates with response dates, numbers as text, nulls', () => {
    assert.ok(same('2026-11-19', new Date('2026-11-19T00:00:00')));
    assert.ok(!same('2026-11-18', new Date('2026-11-19T00:00:00')));
    assert.ok(same('2026-11-20T09:15:00Z', new Date('2026-11-20T09:15:00Z')));
    assert.ok(same('4.321500', 4.3215));
    assert.ok(same('4.3215', '4.321500', { compare: 'number' }));
    assert.ok(!same('4.3215', '4.3316', { compare: 'number', tolerance: 0.0001 }));
    assert.ok(same(null, 'null'));
    assert.ok(!same(undefined, ''));
});

test('a JSON schema written in the workspace: types, required, enums, patterns, nested items', () => {
    const schema = { type: 'object', required: ['header', 'orders'], properties: { orders: { type: 'array', minItems: 1, items: { type: 'object', required: ['orderNo'], properties: { orderNo: { type: 'string', pattern: '^SO-\\d+$' } } } }, total: { type: 'number', minimum: 0 } } };
    assert.deepEqual(schemaErrors(body, schema), []);
    const errs = schemaErrors({ header: {}, orders: [{ orderNo: 'so1' }, {}], total: -1 }, schema);
    assert.deepEqual(errs, ['$.orders[0].orderNo: must match pattern "^SO-\\d+$"', "$.orders[1]: must have required property 'orderNo'", '$.total: must be >= 0']);
    // Keywords the earlier validator ignored (it passed them): oneOf, $ref, formats, if/then; draft 2020-12.
    const refs = { $defs: { money: { type: 'object', required: ['amount', 'currency'], properties: { amount: { type: 'number' }, currency: { enum: ['USD', 'EUR'] } } } },
        type: 'object', properties: { price: { $ref: '#/$defs/money' }, id: { oneOf: [{ type: 'integer' }, { type: 'string', format: 'uuid' }] }, at: { type: 'string', format: 'date-time' }, mail: { type: 'string', format: 'email' } } };
    assert.deepEqual(schemaErrors({ price: { amount: 2, currency: 'USD' }, id: 'a5f3c1de-8b2e-4c1a-9f00-1234567890ab', at: '2026-11-23T10:00:00Z', mail: 'a@b.co' }, refs), []);
    const bad = schemaErrors({ price: { amount: '2', currency: 'GBP' }, id: 'x', at: 'yesterday', mail: 'nope' }, refs);
    for (const m of ['$.price.amount: must be number', '$.price.currency: must be equal to one of the allowed values', '$.id: must match exactly one schema in oneOf', '$.at: must match format "date-time"', '$.mail: must match format "email"']) assert.ok(bad.some((e) => e.startsWith(m)), `${m} in ${JSON.stringify(bad)}`);
    assert.deepEqual(schemaErrors([1, 'a'], { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }] }), ['$[1]: must be number']);
    assert.match(schemaErrors({}, { type: 'nonsense' })[0], /The schema is not valid/);
});

test('test data: Examples filters, payload templates, prepared defaults (a query\'s values, today, the previous business day)', async () => {
    const rows = [{ a: 'x', runFlag: 'Yes', n: '5' }, { a: 'y', runFlag: 'No', n: '10' }, { a: 'z', runFlag: 'Yes', n: '20' }];
    assert.deepEqual(filterRows(rows, 'runFlag=Yes').map((r) => r.a), ['x', 'z']);
    assert.deepEqual(filterRows(rows, 'runFlag=Yes;n>9').map((r) => r.a), ['z']);
    assert.deepEqual(filterRows(rows, 'a!=x').map((r) => r.a), ['y', 'z']);
    assert.deepEqual(filterRows(rows, '').length, 3);
    const tpl = '{"source": "{{source}}", "orderNos": {{jsonEncode(orderNos)}}, "d": "{{orderDate}}", "s": {{jsonEncode(source)}}}';
    assert.deepEqual(templateNames(tpl).sort(), ['orderDate', 'orderNos', 'source']);
    const v: Values = { vars: {}, config: {}, env: {}, row: { source: 'WEB', orderNos: '[]', orderDate: '' } };
    const notes = await prepareValues([
        { name: 'orderNos', whenEmpty: 'query', connection: 'C', query: 'CODES', column: 'CODE', list: true },
        { name: 'orderDate', whenEmpty: 'previousBusinessDay' },
        { name: 'source', whenEmpty: 'text', value: 'never used' },
    ], v, async () => [{ CODE: 'SO-1001' }, { CODE: 'SO-1002' }], new Date(2026, 10, 23)); // Monday 23 Nov 2026
    assert.equal(notes.length, 2);
    assert.equal(fillTemplate(tpl, v), '{"source": "WEB", "orderNos": ["SO-1001","SO-1002"], "d": "2026-11-20", "s": "WEB"}');
});

test('feature: a built-in step where the framework does exactly that, else the project\'s generic step', () => {
    const r = (c: Partial<ApiCheck>) => ruleStep({ kind: 'rule', ...c } as ApiCheck, q, 'x');
    assert.equal(r({ source: 'status', op: 'equals', expected: { from: 'data', value: 'expectedStatus' } }), 'the response status should be <expectedStatus>');
    assert.equal(r({ source: 'json', target: '$.a', op: 'equals', expected: { from: 'saved', value: 'id' } }), 'the response body JSON path "$.a" should be "{{id}}"');
    assert.equal(r({ source: 'json', target: '$.a', op: 'equals', compare: 'number', tolerance: 0.01, expected: { from: 'text', value: '4.3' } }), 'the response value "$.a" should be the number "4.3" within "0.01"');
    assert.equal(r({ source: 'json', target: '$.a', op: 'equals', compare: 'date', expected: { from: 'config', value: 'RUN_DATE' } }), 'the response value "$.a" should be the date "{config:RUN_DATE}"');
    assert.equal(r({ source: 'json', target: '$.items', op: 'count', expected: { from: 'text', value: '3' } }), 'response JSON path "$.items" array should have length 3');
    assert.equal(r({ source: 'json', target: '$.items', op: 'count', expected: { from: 'data', value: 'n' } }), 'the response value "$.items" should have "<n>" items');
    assert.equal(r({ source: 'xml', target: '/order/@id', op: 'equals', expected: { from: 'text', value: '1' } }), 'response XML path "/order/@id" should equal "1"');
    assert.equal(r({ source: 'xml', target: '//sku', op: 'equals', expected: { from: 'text', value: 'B2' } }), 'the response value "xml://sku" should be "B2"');
    assert.equal(r({ source: 'header', target: 'Location', op: 'matches', expected: { from: 'text', value: '^/o' } }), 'the response value "header:Location" should match "^/o"');
    assert.equal(r({ source: 'json', target: '$.t', op: 'between', expected: { from: 'text', value: '1' }, expected2: { from: 'saved', value: 'max' } }), 'the response value "$.t" should be between "1" and "{{max}}"');
    assert.equal(r({ source: 'json', target: '$.price', op: 'equals', expected: { from: 'query', value: '', query: 'GET_PRICE', connection: 'ORDERS', params: ['SO-1001', '{{orderDate}}'], column: 'PRICE' } }),
        'the response value "$.price" should be the "PRICE" of query "GET_PRICE" on "ORDERS" with parameters "SO-1001 | {{orderDate}}"');
    assert.equal(r({ source: 'json', op: 'equals', expected: { from: 'text', value: 'x' } }), null, 'no path: incomplete');
    assert.equal(r({ source: 'json', target: '$.a', op: 'between', expected: { from: 'text', value: '1' } }), null, 'between without the upper bound');
    // Every generic step the feature can write is a step of the generated steps file.
    const patterns = [...checkStepsText(PKG).matchAll(/@CSBDDStepDef\('([^']+)'\)/g)].map((m) => new RegExp(`^${m[1].replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{string\}/g, '(?:"[^"]*"|\'[^\']*\')').replace(/\{int\}/g, '-?\\d+')}$`));
    const generic = ['equals', 'notEquals', 'contains', 'notContains', 'matches', 'exists', 'notExists', 'empty', 'notEmpty', 'type', 'count', 'greater', 'less', 'atLeast', 'atMost', 'oneOf'].flatMap((op) => ['text', 'number', 'date', 'datetime'].map((compare) => r({ source: 'header', target: 'X', op: op as Operator, compare: compare as never, ignoreCase: compare === 'text', expected: { from: 'data', value: 'c' } }))).concat(r({ source: 'json', target: '$.a', op: 'between', expected: { from: 'text', value: '1' }, expected2: { from: 'text', value: '2' } }))
        .filter((s): s is string => !!s && s.startsWith('the response value'));
    assert.ok(generic.length > 20);
    for (const s of generic) assert.ok(patterns.some((p) => p.test(s)), `no generated step for: ${s}`);
});

test('a collection with data, prepared values, a payload template, a database rule: the feature and the project code', () => {
    const rule: DbItemsRule = { title: 'order', items: '$.orders', connection: 'ORDERS_DB', query: 'GET_ORDER_LINES', sql: 'SELECT * FROM lines WHERE code = ? AND day = ?', params: ['orderNo', 'orderDate'], rows: 'lines', matchBy: { field: 'shipDate', column: 'SHIP_DT' }, count: true, fields: [{ field: 'price', column: 'PRICE', compare: 'number', tolerance: 0.0001 }], whenNoRows: [{ field: 'error.subCode', value: 'E404' }] };
    const req: ApiRequest = { kind: 'request', id: 'r1', name: 'Fetch orders', method: 'POST', url: '{config:API_ENDPOINT}', query: [], headers: [], body: { mode: 'file', file: 'order-request.json' }, auth: { type: 'inherit' },
        data: { source: 'test/orders-api/data/orders.json', type: 'json', filter: 'runFlag=Yes' },
        prepare: [{ name: 'orderNos', whenEmpty: 'query', connection: 'ORDERS_DB', query: 'GET_OPEN_ORDERS', list: true }, { name: 'requestDate', whenEmpty: 'today' }],
        checks: [{ kind: 'rule', source: 'status', op: 'equals', expected: { from: 'data', value: 'expectedStatusCode' } }, { kind: 'rule', source: 'json', target: '$.header.channel', op: 'equals', expected: { from: 'data', value: 'source' } }, { kind: 'dbItems', db: rule }],
        extract: [] };
    const c: ApiCollection = { format: 'cs-studio-api/1', name: 'Order lines', baseUrl: '{config:API_BASE_URL}', variables: [], auth: { type: 'none' }, items: [req] };
    const files: Record<string, string> = { 'config/orders-api/common/orders-api-db-queries.env': '# queries\nDB_QUERY_GET_OPEN_ORDERS=SELECT 1\n' };
    const plan = apiTestPlan(c, { project: 'orders-api', featureFolder: 'test/orders-api/features', stepsFolder: 'test/orders-api/steps', pkg: '@example.org/cs-playwright-test-framework', read: (p) => files[p] ?? null,
        config: { DB_QUERY_GET_OPEN_ORDERS: 'SELECT 1' }, columns: () => ['source', 'requestDate', 'orderNos', 'orderDate', 'expectedStatusCode', 'runFlag'], templateVars: () => ['source', 'requestDate', 'orderNos', 'orderDate'] });
    assert.deepEqual(plan.files.map((f) => `${f.kind} ${f.path}`), [
        'feature test/orders-api/features/api/order-lines.feature', 'other test/orders-api/helpers/OrderLinesApiChecks.ts', 'steps test/orders-api/steps/order-lines-api.steps.ts',
        'other test/orders-api/helpers/ApiResponseChecks.ts', 'steps test/orders-api/steps/api-response-checks.steps.ts', 'config config/orders-api/common/orders-api-db-queries.env']);
    const steps = plan.text.split('\n').map((l) => l.trim());
    assert.deepEqual(steps.slice(steps.indexOf('Scenario Outline: Fetch orders') + 1, -1).filter(Boolean), [
        'Given user prepares the Fetch orders request data',
        'And user set test data "source" to "<source>"',
        'And user set test data "orderDate" to "<orderDate>"',
        'When user send a "POST" request to "{config:API_ENDPOINT}" with payload file "order-request.json"',
        'Then the response status should be <expectedStatusCode>',
        'And the response body JSON path "$.header.channel" should be "<source>"',
        'And each order should match the database',
        'Examples: {"type": "json", "source": "test/orders-api/data/orders.json", "path": "$", "filter": "runFlag=Yes"}',
    ]);
    const code = plan.files.find((f) => f.path.endsWith('OrderLinesApiChecks.ts'))!.text;
    assert.match(code, /async eachOrder\(\): Promise<void> \{\n        await this\.checks\.checkItemsAgainstQuery\(\{\n            items: '\$\.orders',\n            connection: 'ORDERS_DB',\n            query: 'GET_ORDER_LINES',/);
    assert.match(code, /whenNoRows: \[\['error\.subCode', 'E404'\]\],/);
    assert.match(code, /async prepareFetchOrders\(\)/);
    assert.match(plan.files.find((f) => f.kind === 'steps' && f.path.endsWith('order-lines-api.steps.ts'))!.text, /from '@example\.org\/cs-playwright-test-framework\/bdd'/);
    assert.match(plan.files.find((f) => f.kind === 'config')!.text, /^# queries\nDB_QUERY_GET_OPEN_ORDERS=SELECT 1\n\n# order of \$\.orders \(written by CS Test Studio\)\nDB_QUERY_GET_ORDER_LINES=SELECT \* FROM lines WHERE code = \? AND day = \?\n$/);
    // The generated TypeScript compiles (types only: the framework is not here).
    for (const f of plan.files.filter((x) => x.path.endsWith('.ts'))) {
        const out = ts.transpileModule(f.text, { reportDiagnostics: true, compilerOptions: { experimentalDecorators: true, target: ts.ScriptTarget.ES2020 } });
        assert.deepEqual(out.diagnostics ?? [], [], f.path);
    }
    // The project's own helper is never replaced.
    const again = apiTestPlan(c, { project: 'orders-api', featureFolder: 'test/orders-api/features', stepsFolder: 'test/orders-api/steps', pkg: PKG, read: (p) => (p.endsWith('ApiResponseChecks.ts') || p.endsWith('api-response-checks.steps.ts') ? '// ours' : files[p] ?? null), config: {} });
    assert.ok(!again.files.some((f) => f.path.endsWith('ApiResponseChecks.ts') || f.path.endsWith('api-response-checks.steps.ts')));
    assert.equal(literal({ a: 'it\'s', b: [1, 2], c: undefined }), "{ a: 'it\\'s', b: [1, 2] }");
    assert.equal(collectionCode({ ...c, items: [{ ...req, checks: [], prepare: [] }] }, PKG), null, 'no database checks, no prepared data: no code');
    assert.equal(toFeature(c).usesChecks, false);
});
